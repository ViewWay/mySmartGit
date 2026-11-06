import { useCallback, useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import {
  AlertTriangle,
  Ban,
  ClipboardPaste,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Save,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '../../components/Button'
import {
  cancelPipelineCommand,
  closeTerminalSession,
  loadPipelineCommands,
  readTerminalOutput,
  resizeTerminal,
  runPipelineCommand,
  savePipelineCommands,
  startTerminalSession,
  writeTerminal,
  type CommandRunReport,
  type PipelineCommand,
  type TerminalSessionInfo,
} from '../../repository'
import {
  builtinPipelineCommands,
  clampTerminalSize,
  commandRunSummary,
  commandRunTone,
  createPipelineRunId,
  draftFromPipelineCommand,
  emptyPipelineDraft,
  formatCommandRunExit,
  formatRunDuration,
  formatTerminalExit,
  nextPipelineCommandId,
  parsePipelineArgs,
  pipelineCommandFromDraft,
  pipelineCommandPreview,
  pipelineCommandsSummary,
  pipelineCwdSafetyNote,
  terminalExitTone,
  terminalPasteData,
  terminalShellLabel,
  terminalTruncatedNotice,
  validatePipelineCwd,
  validatePipelineDraft,
  type PipelineDraft,
} from './terminalModel'

/**
 * 内置终端 + 自定义命令流水线（W4-2）。
 *
 * 只依赖 repositoryPath 与 onNotice：
 * - 终端使用真实 PTY（后端 portable-pty），输出按 100ms 轮询增量拉取；
 * - 命令流水线使用「程序 + 参数数组」，前端不拼 shell 字符串；
 * - 所有提示通过 onNotice / 内联错误展示，不使用 alert；
 * - 切换页签时终端会话保持（两个页签都挂载，仅隐藏非活动页）。
 */
export type TerminalPanelProps = {
  repositoryPath: string
  onNotice?: (message: string) => void
}

function describeError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

export function TerminalPanel({ repositoryPath, onNotice }: TerminalPanelProps) {
  const [tab, setTab] = useState<'terminal' | 'pipeline'>('terminal')

  if (!repositoryPath) {
    return (
      <section className="workspace-empty">
        <SquareTerminal size={34} />
        <strong>内置终端</strong>
        <span>请先打开本地仓库，再启动终端或运行自定义命令。</span>
      </section>
    )
  }

  return (
    <section className="terminal-panel workspace-page">
      <div className="workspace-page-heading">
        <div>
          <span className="eyebrow">仓库工具</span>
          <h2>终端与命令流水线</h2>
          <p>终端在仓库目录启动真实 PTY；自定义命令按参数数组执行，不经过 shell。</p>
        </div>
      </div>

      <div className="terminal-tabs" role="tablist" aria-label="终端与命令流水线">
        <button
          type="button"
          role="tab"
          id="terminal-tab-terminal"
          aria-controls="terminal-tab-panel-terminal"
          aria-selected={tab === 'terminal'}
          className={tab === 'terminal' ? 'active' : ''}
          onClick={() => setTab('terminal')}
        >
          <SquareTerminal size={14} />终端
        </button>
        <button
          type="button"
          role="tab"
          id="terminal-tab-pipeline"
          aria-controls="terminal-tab-panel-pipeline"
          aria-selected={tab === 'pipeline'}
          className={tab === 'pipeline' ? 'active' : ''}
          onClick={() => setTab('pipeline')}
        >
          <Play size={14} />命令流水线
        </button>
      </div>

      <div
        className="terminal-tab-body"
        role="tabpanel"
        id="terminal-tab-panel-terminal"
        aria-labelledby="terminal-tab-terminal"
        hidden={tab !== 'terminal'}
      >
        <TerminalTab repositoryPath={repositoryPath} onNotice={onNotice} visible={tab === 'terminal'} />
      </div>

      <div
        className="terminal-tab-body"
        role="tabpanel"
        id="terminal-tab-panel-pipeline"
        aria-labelledby="terminal-tab-pipeline"
        hidden={tab !== 'pipeline'}
      >
        <PipelineTab repositoryPath={repositoryPath} onNotice={onNotice} />
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// 终端页签
// ---------------------------------------------------------------------------

type TerminalPhase = 'connecting' | 'running' | 'exited' | 'error'

function TerminalTab({
  repositoryPath,
  onNotice,
  visible,
}: {
  repositoryPath: string
  onNotice?: (message: string) => void
  visible: boolean
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const sessionTokenRef = useRef<object | null>(null)
  const offsetRef = useRef(0)
  const pollTimerRef = useRef<number | null>(null)
  const finalTimerRef = useRef<number | null>(null)
  const fitTimerRef = useRef<number | null>(null)
  const pollBusyRef = useRef(false)
  const truncatedNotifiedRef = useRef(false)
  const noticeRef = useRef(onNotice)
  noticeRef.current = onNotice

  const [session, setSession] = useState<TerminalSessionInfo | null>(null)
  const [phase, setPhase] = useState<TerminalPhase>('connecting')
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
    if (finalTimerRef.current !== null) {
      window.clearTimeout(finalTimerRef.current)
      finalTimerRef.current = null
    }
  }, [])

  const pollOnce = useCallback(
    async (sessionId: string, token: object) => {
      if (pollBusyRef.current) return
      if (sessionTokenRef.current !== token || sessionIdRef.current !== sessionId) return
      pollBusyRef.current = true
      try {
        const output = await readTerminalOutput(sessionId, offsetRef.current)
        if (sessionTokenRef.current !== token || sessionIdRef.current !== sessionId) return
        if (output.data) terminalRef.current?.write(output.data)
        offsetRef.current = output.nextOffset
        setExitCode(output.exitCode ?? null)
        if (output.truncated && !truncatedNotifiedRef.current) {
          truncatedNotifiedRef.current = true
          const notice = terminalTruncatedNotice(true)
          if (notice) noticeRef.current?.(notice)
        }
        if (!output.alive) {
          stopPolling()
          // 子进程已退出时让读线程再补一次尾部输出。
          finalTimerRef.current = window.setTimeout(() => {
            finalTimerRef.current = null
            void readTerminalOutput(sessionId, offsetRef.current)
              .then((finalOutput) => {
                if (sessionTokenRef.current !== token || sessionIdRef.current !== sessionId) return
                if (finalOutput.data) terminalRef.current?.write(finalOutput.data)
                offsetRef.current = finalOutput.nextOffset
                setExitCode(finalOutput.exitCode ?? null)
                sessionIdRef.current = null
                setPhase('exited')
              })
              .catch(() => {
                if (sessionTokenRef.current === token) {
                  sessionIdRef.current = null
                  setPhase('exited')
                }
              })
          }, 120)
        }
      } catch (reason) {
        if (sessionTokenRef.current === token) {
          setError(describeError(reason))
          setPhase('error')
          sessionIdRef.current = null
          stopPolling()
        }
      } finally {
        pollBusyRef.current = false
      }
    },
    [stopPolling],
  )

  const startPolling = useCallback(
    (sessionId: string, token: object) => {
      stopPolling()
      pollTimerRef.current = window.setInterval(() => {
        void pollOnce(sessionId, token)
      }, 100)
    },
    [pollOnce, stopPolling],
  )

  const beginSession = useCallback(
    async (token: object) => {
      const terminal = terminalRef.current
      if (!terminal) return
      setPhase('connecting')
      setError('')
      const size = clampTerminalSize({ cols: terminal.cols, rows: terminal.rows })
      try {
        const info = await startTerminalSession(repositoryPath, null, size.cols, size.rows)
        if (sessionTokenRef.current !== token) {
          void closeTerminalSession(info.sessionId).catch(() => undefined)
          return
        }
        sessionIdRef.current = info.sessionId
        offsetRef.current = 0
        truncatedNotifiedRef.current = false
        setSession(info)
        setExitCode(null)
        setPhase('running')
        startPolling(info.sessionId, token)
      } catch (reason) {
        if (sessionTokenRef.current === token) {
          setError(describeError(reason))
          setPhase('error')
        }
      }
    },
    [repositoryPath, startPolling],
  )

  const fitAndResize = useCallback(() => {
    const terminal = terminalRef.current
    const fit = fitRef.current
    const container = containerRef.current
    if (!terminal || !fit || !container) return
    // 面板隐藏或宽度为 0 时 FitAddon 会算出异常尺寸，跳过以免误 resize PTY。
    if (container.clientWidth <= 0 || container.clientHeight <= 0) return
    try {
      fit.fit()
    } catch {
      return
    }
    const size = clampTerminalSize({ cols: terminal.cols, rows: terminal.rows })
    const sessionId = sessionIdRef.current
    if (sessionId) {
      void resizeTerminal(sessionId, size.cols, size.rows).catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const token = {}
    sessionTokenRef.current = token

    const terminal = new XTerm({
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      cursorBlink: true,
      convertEol: false,
      allowProposedApi: false,
      theme: {
        background: '#0d1117',
        foreground: '#d7dde5',
        cursor: '#58a6ff',
        selectionBackground: '#264f78',
        black: '#0d1117',
        brightBlack: '#6e7681',
      },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    terminalRef.current = terminal
    fitRef.current = fit
    try {
      fit.fit()
    } catch {
      // 容器尚未布局时忽略，ResizeObserver 会再次触发。
    }

    const dataSubscription = terminal.onData((data) => {
      const sessionId = sessionIdRef.current
      if (!sessionId || !data) return
      // 键盘输入保留 ESC 等控制序列（方向键依赖它们），只做长度上限保护。
      const payload = data.length > 64 * 1024 ? data.slice(0, 64 * 1024) : data
      void writeTerminal(sessionId, payload).catch((reason) => {
        if (sessionTokenRef.current === token) setError(describeError(reason))
      })
    })

    const scheduleFit = () => {
      if (fitTimerRef.current !== null) window.clearTimeout(fitTimerRef.current)
      fitTimerRef.current = window.setTimeout(() => {
        fitTimerRef.current = null
        fitAndResize()
      }, 120)
    }
    const observer = new ResizeObserver(scheduleFit)
    observer.observe(container)

    void beginSession(token)

    return () => {
      if (sessionTokenRef.current === token) sessionTokenRef.current = null
      const sessionId = sessionIdRef.current
      sessionIdRef.current = null
      stopPolling()
      if (fitTimerRef.current !== null) {
        window.clearTimeout(fitTimerRef.current)
        fitTimerRef.current = null
      }
      dataSubscription.dispose()
      observer.disconnect()
      if (sessionId) void closeTerminalSession(sessionId).catch(() => undefined)
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [beginSession, fitAndResize, repositoryPath, stopPolling])

  useEffect(() => {
    if (!visible) return
    const timer = window.setTimeout(() => fitAndResize(), 40)
    return () => window.clearTimeout(timer)
  }, [fitAndResize, visible])

  const reconnect = async () => {
    const token = sessionTokenRef.current
    if (!token || busy) return
    setBusy(true)
    stopPolling()
    const previous = sessionIdRef.current
    sessionIdRef.current = null
    if (previous) {
      try {
        await closeTerminalSession(previous)
      } catch {
        // 会话可能已自然退出。
      }
    }
    terminalRef.current?.reset()
    offsetRef.current = 0
    truncatedNotifiedRef.current = false
    setSession(null)
    setExitCode(null)
    setError('')
    await beginSession(token)
    setBusy(false)
  }

  const killSession = async () => {
    const sessionId = sessionIdRef.current
    if (!sessionId || busy) return
    setBusy(true)
    stopPolling()
    sessionIdRef.current = null
    try {
      await closeTerminalSession(sessionId)
    } catch (reason) {
      setError(describeError(reason))
    }
    setPhase('exited')
    noticeRef.current?.('终端会话已关闭')
    setBusy(false)
  }

  const pasteFromClipboard = async () => {
    const sessionId = sessionIdRef.current
    if (!sessionId) return
    try {
      const text = await navigator.clipboard.readText()
      const payload = terminalPasteData(text).slice(0, 64 * 1024)
      if (payload) await writeTerminal(sessionId, payload)
    } catch {
      noticeRef.current?.('无法读取剪贴板，请使用系统快捷键粘贴')
    }
  }

  const tone = phase === 'connecting'
    ? 'running'
    : phase === 'error'
      ? 'failure'
      : terminalExitTone({ alive: phase === 'running', exitCode })
  const statusLabel = phase === 'connecting'
    ? '正在启动…'
    : phase === 'running'
      ? '运行中'
      : phase === 'error'
        ? '连接失败'
        : formatTerminalExit({ alive: false, exitCode })

  return (
    <div className="terminal-shell">
      <div className="terminal-toolbar">
        <div className="terminal-session-meta">
          <span className={`terminal-status terminal-status-${tone}`}>{statusLabel}</span>
          {session && (
            <>
              <code className="terminal-shell-name">{terminalShellLabel(session.shell)}</code>
              <span className="terminal-cwd" title={session.cwd}>{session.cwd}</span>
            </>
          )}
        </div>
        <div className="terminal-actions">
          <Button variant="secondary" size="compact" disabled={!sessionIdRef.current || busy} onClick={() => void pasteFromClipboard()} title="把剪贴板内容粘贴到终端">
            <ClipboardPaste size={13} />粘贴
          </Button>
          <Button variant="secondary" size="compact" disabled={busy} onClick={() => void reconnect()}>
            {busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}重连
          </Button>
          <Button variant="danger" size="compact" disabled={!sessionIdRef.current || busy} onClick={() => void killSession()}>
            <Ban size={13} />关闭终端
          </Button>
        </div>
      </div>

      {error && (
        <div className="terminal-error" role="alert">
          <AlertTriangle size={14} />
          <span>{error}</span>
          <Button variant="icon" title="关闭提示" onClick={() => setError('')}><X size={13} /></Button>
        </div>
      )}

      <div className="terminal-screen-wrap">
        <div ref={containerRef} className="terminal-screen" aria-label="终端输出" />
      </div>
      <p className="terminal-hint">
        在仓库目录启动真实 PTY。关闭面板页签或离开仓库会结束会话；输出超过 256 KiB 时只保留最近的尾部内容。
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 命令流水线页签
// ---------------------------------------------------------------------------

function PipelineTab({
  repositoryPath,
  onNotice,
}: {
  repositoryPath: string
  onNotice?: (message: string) => void
}) {
  const [commands, setCommands] = useState<PipelineCommand[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [draft, setDraft] = useState<PipelineDraft>(emptyPipelineDraft)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<CommandRunReport | null>(null)
  const [formError, setFormError] = useState('')
  const [runError, setRunError] = useState('')
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const runIdRef = useRef<string | null>(null)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const noticeRef = useRef(onNotice)
  noticeRef.current = onNotice

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFormError('')
    setRunError('')
    setReport(null)
    loadPipelineCommands()
      .then((result) => {
        if (cancelled) return
        setCommands(result.commands)
        setSelectedId((previous) => (
          previous && result.commands.some((item) => item.id === previous)
            ? previous
            : result.commands[0]?.id ?? ''
        ))
      })
      .catch((reason) => {
        if (!cancelled) setFormError(describeError(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [repositoryPath])

  const persist = async (next: PipelineCommand[]) => {
    setSaving(true)
    setFormError('')
    try {
      const saved = await savePipelineCommands({ commands: next })
      setCommands(saved.commands)
      setSelectedId((previous) => (
        previous && saved.commands.some((item) => item.id === previous)
          ? previous
          : saved.commands[0]?.id ?? ''
      ))
      setDraft(emptyPipelineDraft())
      setEditingId(null)
      noticeRef.current?.('命令流水线已保存')
    } catch (reason) {
      setFormError(describeError(reason))
    } finally {
      setSaving(false)
    }
  }

  const saveDraft = async () => {
    const invalid = validatePipelineDraft(draft)
    if (invalid) {
      setFormError(invalid)
      return
    }
    const id = editingId ?? nextPipelineCommandId(commands)
    const item = pipelineCommandFromDraft(draft, id)
    const next = editingId
      ? commands.map((command) => (command.id === editingId ? item : command))
      : [...commands, item]
    await persist(next)
  }

  const editCommand = (command: PipelineCommand) => {
    setEditingId(command.id)
    setSelectedId(command.id)
    setDraft(draftFromPipelineCommand(command))
    setFormError('')
    nameInputRef.current?.focus()
  }

  const removeCommand = async (command: PipelineCommand) => {
    await persist(commands.filter((item) => item.id !== command.id))
    if (editingId === command.id) {
      setEditingId(null)
      setDraft(emptyPipelineDraft())
    }
    noticeRef.current?.(`已删除命令：${command.name}`)
  }

  const runCommand = async (command: PipelineCommand) => {
    if (running) return
    const runId = createPipelineRunId()
    runIdRef.current = runId
    setActiveRunId(runId)
    setRunning(true)
    setRunError('')
    setReport(null)
    try {
      const result = await runPipelineCommand(repositoryPath, command.id, null, runId)
      setReport(result)
      noticeRef.current?.(commandRunSummary(result))
    } catch (reason) {
      setRunError(describeError(reason))
    } finally {
      runIdRef.current = null
      setActiveRunId(null)
      setRunning(false)
    }
  }

  const cancelRun = async () => {
    const runId = runIdRef.current
    if (!runId) return
    try {
      const accepted = await cancelPipelineCommand(runId)
      noticeRef.current?.(accepted ? '已请求取消命令…' : '命令已结束，无需取消')
    } catch (reason) {
      setRunError(describeError(reason))
    }
  }

  const applyBuiltin = (item: PipelineCommand) => {
    setEditingId(null)
    setDraft(draftFromPipelineCommand(item))
    setFormError('')
    nameInputRef.current?.focus()
  }

  const selected = commands.find((command) => command.id === selectedId) ?? null
  const builtins = builtinPipelineCommands()

  return (
    <div className="pipeline-shell">
      <div className="pipeline-grid">
        <article className="pipeline-card pipeline-list-card">
          <div className="pipeline-card-heading">
            <h3>自定义命令</h3>
            <span className="pipeline-count">{commands.length}</span>
          </div>
          <p className="pipeline-card-hint">{pipelineCommandsSummary(commands)}</p>
          {loading ? (
            <p className="pipeline-empty"><Loader2 size={14} className="spin" />正在读取命令配置…</p>
          ) : commands.length === 0 ? (
            <p className="pipeline-empty">还没有命令。可在右侧新建，或从内置示例填入编辑器。</p>
          ) : (
            <ul className="pipeline-list">
              {commands.map((command) => (
                <li key={command.id} className={command.id === selectedId ? 'selected' : ''}>
                  <button
                    type="button"
                    className="pipeline-list-main"
                    aria-pressed={command.id === selectedId}
                    onClick={() => setSelectedId(command.id)}
                  >
                    <strong>{command.name}</strong>
                    <span className="pipeline-list-description">{command.description || '未填写描述'}</span>
                    <code>{pipelineCommandPreview(command)}</code>
                    {command.cwdRelative && <span className="pipeline-cwd-badge">cwd: {command.cwdRelative}</span>}
                  </button>
                  <div className="pipeline-list-actions">
                    <Button
                      variant="primary"
                      size="compact"
                      disabled={running || saving}
                      onClick={() => void runCommand(command)}
                      title={`运行 ${command.name}`}
                    >
                      <Play size={12} />运行
                    </Button>
                    <Button variant="icon" title={`编辑 ${command.name}`} disabled={saving} onClick={() => editCommand(command)}>
                      <Save size={13} />
                    </Button>
                    <Button
                      variant="icon"
                      title={`删除 ${command.name}`}
                      disabled={saving || running}
                      onClick={() => void removeCommand(command)}
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="pipeline-builtins">
            <h4>内置示例（填入编辑器后保存）</h4>
            <div className="pipeline-builtin-list">
              {builtins.map((item) => (
                <button key={item.id} type="button" onClick={() => applyBuiltin(item)}>
                  <Play size={11} />{item.name}
                  <code>{pipelineCommandPreview(item)}</code>
                </button>
              ))}
            </div>
          </div>
        </article>

        <article className="pipeline-card pipeline-editor-card">
          <div className="pipeline-card-heading">
            <h3>{editingId ? '编辑命令' : '新建命令'}</h3>
            {editingId && <span className="pipeline-cwd-badge">id: {editingId}</span>}
          </div>
          <div className="pipeline-form">
            <label htmlFor="pipeline-name">名称</label>
            <input
              id="pipeline-name"
              ref={nameInputRef}
              value={draft.name}
              placeholder="例如：查看状态"
              disabled={saving}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />

            <label htmlFor="pipeline-description">描述（可选）</label>
            <input
              id="pipeline-description"
              value={draft.description}
              placeholder="例如：git status --short"
              disabled={saving}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />

            <label htmlFor="pipeline-program">程序</label>
            <input
              id="pipeline-program"
              value={draft.program}
              placeholder="例如：git（不经过 shell）"
              spellCheck={false}
              disabled={saving}
              onChange={(event) => setDraft({ ...draft, program: event.target.value })}
            />

            <label htmlFor="pipeline-args">参数（一行一个，按字面值传递）</label>
            <textarea
              id="pipeline-args"
              value={draft.argsText}
              rows={5}
              placeholder={'status\n--short\n--branch'}
              spellCheck={false}
              disabled={saving}
              onChange={(event) => setDraft({ ...draft, argsText: event.target.value })}
            />
            <p className="pipeline-arg-count">
              已解析 {parsePipelineArgs(draft.argsText).length} 个参数；空行会被忽略。
            </p>

            <label htmlFor="pipeline-cwd">工作目录（相对仓库根目录，可选）</label>
            <input
              id="pipeline-cwd"
              value={draft.cwdRelative}
              placeholder="例如：packages/app"
              spellCheck={false}
              disabled={saving}
              onChange={(event) => setDraft({ ...draft, cwdRelative: event.target.value })}
            />
            <p className={validatePipelineCwd(draft.cwdRelative) ? 'pipeline-form-error' : 'pipeline-form-note'}>
              {pipelineCwdSafetyNote(draft.cwdRelative)}
            </p>

            {formError && <div className="pipeline-form-error" role="alert"><AlertTriangle size={14} />{formError}</div>}

            <div className="pipeline-form-actions">
              <Button variant="primary" disabled={saving} onClick={() => void saveDraft()}>
                {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
                {editingId ? '保存修改' : '添加命令'}
              </Button>
              <Button
                variant="secondary"
                disabled={saving}
                onClick={() => {
                  setEditingId(null)
                  setDraft(emptyPipelineDraft())
                  setFormError('')
                }}
              >
                <Plus size={14} />清空
              </Button>
            </div>
          </div>
        </article>
      </div>

      <article className="pipeline-card pipeline-run-card">
        <div className="pipeline-card-heading">
          <h3>运行结果</h3>
          <div className="pipeline-run-actions">
            {running ? (
              <Button variant="danger" size="compact" onClick={() => void cancelRun()}>
                <Ban size={13} />取消运行
              </Button>
            ) : (
              <Button variant="primary" size="compact" disabled={!selected || saving} onClick={() => selected && void runCommand(selected)}>
                <Play size={13} />运行选中命令
              </Button>
            )}
          </div>
        </div>
        {!selected && !running && !report && <p className="pipeline-empty">选择一条命令后运行。</p>}
        {running && (
          <p className="pipeline-running">
            <Loader2 size={14} className="spin" />
            正在运行{selected ? `：${selected.name}` : '…'}
            {activeRunId && <code>{activeRunId}</code>}
          </p>
        )}
        {runError && <div className="pipeline-form-error" role="alert"><AlertTriangle size={14} />{runError}</div>}
        {report && (
          <div className="pipeline-report">
            <div className={`pipeline-run-badge pipeline-run-${commandRunTone(report)}`}>
              {formatCommandRunExit(report)}
            </div>
            <span className="pipeline-run-duration">用时 {formatRunDuration(report.durationMs)}</span>
            <span className="pipeline-run-id">run: {report.runId}</span>
            {report.truncated && (
              <span className="pipeline-run-truncated"><AlertTriangle size={12} />输出超过 256 KiB，已截断</span>
            )}
            <div className="pipeline-output-grid">
              <div className="pipeline-output-pane">
                <h4>stdout</h4>
                <pre>{report.stdout || '（stdout 为空）'}</pre>
              </div>
              <div className="pipeline-output-pane">
                <h4>stderr</h4>
                <pre>{report.stderr || '（stderr 为空）'}</pre>
              </div>
            </div>
          </div>
        )}
        {!report && !running && !runError && <p className="pipeline-card-hint">输出会按 UTF-8 显示；stdout / stderr 各保留 256 KiB。</p>}
      </article>
    </div>
  )
}
