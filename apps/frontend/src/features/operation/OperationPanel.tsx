import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronLeft, ChevronRight, CircleAlert, ExternalLink, GitBranch, GitMerge, GitPullRequest, RefreshCw, Redo2, RotateCcw, SkipForward, Square, Trash2, Undo2, X } from 'lucide-react'
import { ConflictCodeEditor, type ConflictCodeEditorHandle } from './ConflictCodeEditor'
import { ThreePaneMergeView } from './ThreePaneMergeView'
import { abortRepositoryOperation, continueRepositoryOperation, launchConflictMergetool, loadConflictFile, resolveConflictFile, skipRepositoryOperation, type ConflictFileContent, type RepositorySnapshot } from '../../repository'
import { Button } from '../../components/Button'
import { useConfirmDialog } from '../../components/ConfirmDialog'
import { acquireOperationLock, releaseOperationLock } from './operationLock'
import { asPanelKind, canSkipOperation, continueActionLabel, showsStepRoute, stepRouteLabel } from './operationKind'
import { hasConflictMarkers, isDraftDirty, isSideAvailable, normalizeConflictDraft, parseConflictBlocks, resolveConflictBlockInText, type ResolutionStrategy } from './conflictDraft'
import { canRedoDraft, canUndoDraft, createDraftHistory, pushDraftHistory, redoDraftHistory, undoDraftHistory, type DraftChangeReason, type DraftHistory } from './draftHistory'
import { paneLabels, resolveAllBlocks } from './threePane'

type OperationPanelProps = {
  repository: RepositorySnapshot
  onSnapshot: (snapshot: RepositorySnapshot) => void
  onNotice: (message: string) => void
  initialPath?: string | null
  onReturnToChanges: () => void
  onClose?: () => void
}

const resolutionLabels: Record<ResolutionStrategy, string> = {
  current: '采用当前更改',
  incoming: '采用传入的更改',
  both: '保留双方更改',
}

const wholeFileLabels: Record<string, string> = {
  current: '采用当前一侧',
  incoming: '采用对方一侧',
  delete: '删除文件',
  mergetool: '调用外部合并工具',
}

export function OperationPanel({ repository, onSnapshot, onNotice, initialPath, onReturnToChanges, onClose }: OperationPanelProps) {
  const operation = repository.operation
  const conflicts = operation?.conflicts ?? []
  const [selectedPath, setSelectedPath] = useState<string | null>(conflicts[0] ?? null)
  const [file, setFile] = useState<ConflictFileContent | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const [activeBlock, setActiveBlock] = useState(0)
  const [lastResolution, setLastResolution] = useState<{ block: number; strategy: ResolutionStrategy; from: number; to: number } | null>(null)
  const [resolvedRanges, setResolvedRanges] = useState<Array<{ from: number; to: number }>>([])
  const { confirm, confirmDialog } = useConfirmDialog()
  const editorRef = useRef<ConflictCodeEditorHandle>(null)
  const operationLock = useRef(false)
  const unsavedDrafts = useRef(new Map<string, string>())
  // 草稿历史栈：块操作 / 批量选边 / 恢复冲突 / 手工编辑共享一条撤销链（纯函数见 draftHistory.ts）。
  const historyRef = useRef<DraftHistory>(createDraftHistory(''))
  const [, setHistoryVersion] = useState(0)
  const [viewMode, setViewMode] = useState<'three' | 'inline'>('three')
  const [showBase, setShowBase] = useState(true)

  const commitDraft = (text: string, reason: DraftChangeReason) => {
    const next = pushDraftHistory(historyRef.current, text, reason)
    if (next === historyRef.current) return
    historyRef.current = next
    setHistoryVersion((value) => value + 1)
    setDraft(text)
  }

  useEffect(() => {
    if (initialPath && conflicts.includes(initialPath)) setSelectedPath(initialPath)
  }, [conflicts, initialPath])

  useEffect(() => {
    if (!selectedPath || !conflicts.includes(selectedPath)) setSelectedPath(conflicts[0] ?? null)
  }, [conflicts, selectedPath])

  useEffect(() => {
    if (!selectedPath) {
      setFile(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setActiveBlock(0)
    setLastResolution(null)
    setResolvedRanges([])
    loadConflictFile(repository.path, selectedPath)
      .then((value) => {
        if (cancelled) return
        setFile(value)
        const disk = normalizeConflictDraft(value.result)
        const pending = unsavedDrafts.current.get(value.path)
        // 切走再切回不能丢手改：优先恢复未保存的草稿，其次才是磁盘内容。
        // 换文件同时重置撤销栈——撤销绝不能跨文件。
        const initial = pending !== undefined && pending !== disk ? pending : disk
        historyRef.current = createDraftHistory(initial)
        setHistoryVersion((current) => current + 1)
        setDraft(initial)
      })
      .catch((error) => {
        if (!cancelled) onNotice(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [onNotice, reloadToken, repository.path, selectedPath])

  // 按文件记住未保存的草稿；文件离开冲突列表（已解决/已暂存）就把它的草稿丢掉。
  useEffect(() => {
    for (const path of [...unsavedDrafts.current.keys()]) {
      if (!conflicts.includes(path)) unsavedDrafts.current.delete(path)
    }
  }, [conflicts])

  useEffect(() => {
    if (!file || !conflicts.includes(file.path)) return
    const disk = normalizeConflictDraft(file.result)
    if (draft === disk) unsavedDrafts.current.delete(file.path)
    else unsavedDrafts.current.set(file.path, draft)
  }, [conflicts, draft, file])

  const runOperation = async (action: () => Promise<RepositorySnapshot>, success: string): Promise<RepositorySnapshot | null> => {
    if (!acquireOperationLock(operationLock)) return null
    setLoading(true)
    try {
      const snapshot = await action()
      onSnapshot(snapshot)
      setReloadToken((value) => value + 1)
      onNotice(snapshot.operation ? `${snapshot.operation.label}：${snapshot.operation.conflicts.length ? `还有 ${snapshot.operation.conflicts.length} 个冲突` : '可以继续操作'}` : success)
      return snapshot
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
      return null
    } finally {
      releaseOperationLock(operationLock)
      setLoading(false)
    }
  }

  const dirty = isDraftDirty(draft, file)
  // rebase 语义下两侧含义会翻转，侧栏与提示一律消费后端下发的 currentLabel/incomingLabel。
  const mergeLabels = paneLabels(file)
  const blockActionLabels: Record<ResolutionStrategy, string> = {
    current: `采用「${mergeLabels.current}」一侧`,
    incoming: `采用「${mergeLabels.incoming}」一侧`,
    both: '保留双方更改',
  }

  // 整侧采用/删除/外部合并工具都会重写磁盘文件，基于草稿之外的内容；
  // 用户手改还没保存时必须先确认，绝不能静默丢掉编辑。
  const discardDraftIfNeeded = async (action: string): Promise<boolean> => {
    if (!dirty) return true
    return await confirm({
      title: '有未保存的手动编辑',
      message: `${action}会覆盖编辑器里尚未保存的改动。建议先点“${blocks.length ? '保存结果' : '标记已解决'}”把草稿写回文件。确定要继续吗？`,
      confirmLabel: '仍然继续',
      variant: 'danger',
    })
  }

  const resolveFile = (strategy: ResolutionStrategy | 'delete' | 'result') => {
    if (!selectedPath) return
    const target = selectedPath
    const label = wholeFileLabels[strategy] ?? '该操作'
    void (async () => {
      if (strategy !== 'result' && !(await discardDraftIfNeeded(label))) return
      // 结果里还带冲突标记时只是阶段性保存，Git 仍然认为该文件未解决。
      const partialSave = strategy === 'result' && hasConflictMarkers(draft)
      if (strategy !== 'result') unsavedDrafts.current.delete(target)
      const snapshot = await runOperation(
        () => resolveConflictFile(repository.path, target, strategy, strategy === 'result' ? draft : undefined),
        partialSave ? `已保存草稿：${target}` : `已解决并落暂存：${target}`,
      )
      if (!snapshot) return
      const stillConflicted = snapshot.operation?.conflicts.includes(target) ?? false
      if (stillConflicted) {
        onNotice(partialSave ? `${target}：仍有冲突标记，处理完再点“标记已解决”` : `${target}：仍未解决，请检查冲突块`)
        return
      }
      onReturnToChanges()
    })()
  }
  const blocks = useMemo(() => parseConflictBlocks(draft), [draft])
  // 块操作只在当前草稿上做字符串替换：绝不回读磁盘，手改不会被覆盖。
  // 结果统一留在草稿里，由“保存结果 / 标记已解决”一次性写盘并落暂存。
  const resolveBlock = (blockIndex: number, strategy: ResolutionStrategy) => {
    if (!selectedPath || loading) return
    const currentTarget = blocks[blockIndex]
    if (!currentTarget) {
      onNotice(`未找到第 ${blockIndex + 1} 个冲突块，请重新读取文件`)
      return
    }
    const outcome = resolveConflictBlockInText(draft, blockIndex, strategy)
    if (!outcome) {
      onNotice(`未找到第 ${blockIndex + 1} 个冲突块，请重新读取文件`)
      return
    }
    const nextDraft = outcome.text.replace(/\r\n/g, '\n')
    const nextBlocks = parseConflictBlocks(nextDraft)
    const nextIndex = nextBlocks.length ? Math.min(blockIndex, nextBlocks.length - 1) : 0
    // Keep the viewport anchored to the resolved block; the result may be shorter than its markers.
    const focusOffset = Math.min(currentTarget.offset, nextDraft.length)
    const resolvedTo = Math.min(outcome.span.to, nextDraft.length)
    const delta = nextDraft.length - draft.length
    const mappedRanges = resolvedRanges.map((range) => {
      if (range.to <= currentTarget.offset) return range
      if (range.from >= currentTarget.endOffset) return { from: range.from + delta, to: range.to + delta }
      return { from: Math.min(range.from, currentTarget.offset), to: Math.min(range.to, currentTarget.offset + (resolvedTo - focusOffset)) }
    })
    commitDraft(nextDraft, 'block')
    setActiveBlock(nextIndex)
    setLastResolution({ block: blockIndex, strategy, from: focusOffset, to: resolvedTo })
    setResolvedRanges([...mappedRanges, { from: focusOffset, to: resolvedTo }])
    onNotice(nextBlocks.length
      ? `已应用第 ${blockIndex + 1} 个冲突块：${resolutionLabels[strategy]}（还有 ${nextBlocks.length} 处，保存后才落暂存）`
      : `已应用第 ${blockIndex + 1} 个冲突块：${resolutionLabels[strategy]}（点“标记已解决”写盘并落暂存）`)
  }

  // 撤销/重做以草稿历史栈为唯一事实源；范围高亮不随文本回滚，回退时直接清空更诚实。
  const applyHistoryStep = (direction: 'undo' | 'redo') => {
    const next = direction === 'undo' ? undoDraftHistory(historyRef.current) : redoDraftHistory(historyRef.current)
    if (!next) {
      onNotice(direction === 'undo' ? '没有可撤销的合并操作' : '没有可重做的合并操作')
      return
    }
    historyRef.current = next
    setHistoryVersion((value) => value + 1)
    setDraft(next.present.text)
    setLastResolution(null)
    setResolvedRanges([])
    const remaining = parseConflictBlocks(next.present.text)
    setActiveBlock((current) => (remaining.length ? Math.min(current, remaining.length - 1) : 0))
  }

  const handlePanelKeyDown = (event: React.KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return
    const target = event.target as HTMLElement | null
    // 原生输入框（如编辑器内搜索框）保留浏览器自己的撤销，不去动草稿。
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
    event.preventDefault()
    applyHistoryStep(event.shiftKey ? 'redo' : 'undo')
  }

  // 批量处理：对草稿里剩余所有块统一选边，作为单条“batch”历史入栈，可整体撤销。
  const resolveRemaining = (strategy: ResolutionStrategy) => {
    if (!blocks.length) return
    const outcome = resolveAllBlocks(draft, strategy)
    commitDraft(outcome.text.replace(/\r\n/g, '\n'), 'batch')
    setResolvedRanges([])
    setActiveBlock(0)
    onNotice(`已对剩余 ${outcome.resolved} 个冲突块统一${resolutionLabels[strategy]}（可撤销；点“标记已解决”才会写盘并落暂存）`)
  }

  // 恢复冲突状态：放弃本文件所有手工结果、回到磁盘上的原始冲突标记；同样可撤销。
  const restoreConflictState = () => {
    if (!file) return
    const original = normalizeConflictDraft(file.result)
    if (draft === original) {
      onNotice('草稿已经是原始冲突状态')
      return
    }
    void (async () => {
      if (!(await confirm({
        title: '恢复冲突状态',
        message: '将丢弃本文件所有手工处理结果，回到磁盘上的原始冲突标记。此操作可以撤销（Ctrl/Cmd+Z）。',
        confirmLabel: '恢复冲突',
        variant: 'danger',
      }))) return
      commitDraft(original, 'restore')
      setResolvedRanges([])
      setLastResolution(null)
      setActiveBlock(0)
      onNotice(`已恢复原始冲突状态（${parseConflictBlocks(original).length} 个冲突块，可撤销）`)
    })()
  }

  const jumpBlock = (direction: -1 | 1) => {
    if (!blocks.length) return
    const next = (activeBlock + direction + blocks.length) % blocks.length
    const target = blocks[next]
    setActiveBlock(next)
    requestAnimationFrame(() => editorRef.current?.focusBlock(target.offset, target.endOffset))
  }
  const jumpFile = (direction: -1 | 1) => {
    if (!conflicts.length) return
    const current = Math.max(0, conflicts.indexOf(selectedPath ?? conflicts[0]))
    // 切换文件是安全的：未保存的草稿按路径记住了，切回来还在。
    setSelectedPath(conflicts[(current + direction + conflicts.length) % conflicts.length])
  }

  const currentStep = operation?.currentStep ?? 0
  const totalSteps = operation?.totalSteps ?? 0
  const completedSteps = useMemo(() => operation?.steps.filter((step) => step.status === 'applied').length ?? 0, [operation?.steps])

  if (!operation) return <section className="workspace-empty"><Check size={36}/><strong>没有待处理的 Git 操作</strong><span>合并、变基、还原或 Cherry-pick 产生冲突后，会在这里逐文件处理。</span></section>

  // kind 字符串由后端下发；revert（任务 #24）经本地超集收敛后再比较，保持编译期安全。
  const kind = asPanelKind(operation.kind)

  const canUndo = canUndoDraft(historyRef.current)
  const canRedo = canRedoDraft(historyRef.current)
  const originalText = normalizeConflictDraft(file?.result ?? '')

  // 中间可编辑结果栏：单栏模式直接渲染，三栏模式作为 resultPane 注入 ThreePaneMergeView。
  const resultPane = file && !file.binary ? <div className={`conflict-result${viewMode === 'three' ? ' tp-result-inner' : ''}`}>
    <div className="conflict-result-heading">
      <div><strong>合并结果</strong><span>{lastResolution ? `刚刚已应用第 ${lastResolution.block + 1} 个冲突块：${resolutionLabels[lastResolution.strategy]}${blocks.length ? `，还剩 ${blocks.length} 处` : '，全部处理完待保存'}` : blocks.length ? `第 ${Math.min(activeBlock + 1, blocks.length)} / ${blocks.length} 个冲突块` : dirty ? '草稿已无冲突标记，点“标记已解决”写盘并落暂存' : '没有未处理的冲突标记'}</span></div>
      <div className="conflict-navigation"><button onClick={() => jumpBlock(-1)} disabled={!blocks.length} title="上一处冲突"><ChevronLeft size={14}/></button><span>{blocks.length ? `${activeBlock + 1} / ${blocks.length}` : '0 / 0'}</span><button onClick={() => jumpBlock(1)} disabled={!blocks.length} title="下一处冲突"><ChevronRight size={14}/></button></div>
      <div className="conflict-navigation" role="group" aria-label="撤销与重做"><button onClick={() => applyHistoryStep('undo')} disabled={!canUndo} title="撤销（Ctrl/Cmd+Z）" aria-label="撤销合并操作"><Undo2 size={14}/></button><button onClick={() => applyHistoryStep('redo')} disabled={!canRedo} title="重做（Shift+Ctrl/Cmd+Z）" aria-label="重做合并操作"><Redo2 size={14}/></button></div>
      {blocks.length > 0 && <div className="conflict-active-actions"><Button variant="secondary" onClick={() => resolveBlock(activeBlock, 'current')} disabled={loading} title={blockActionLabels.current}>采用当前更改</Button><Button variant="secondary" onClick={() => resolveBlock(activeBlock, 'incoming')} disabled={loading} title={blockActionLabels.incoming}>采用传入的更改</Button><Button variant="secondary" onClick={() => resolveBlock(activeBlock, 'both')} disabled={loading}>保留双方更改</Button><Button variant="secondary" onClick={() => { const target = blocks[activeBlock]; if (target) requestAnimationFrame(() => editorRef.current?.focusBlock(target.offset, target.endOffset)) }} disabled={loading} title="在中间结果栏里手工组合两侧内容（直接编辑即可）">手工组合</Button></div>}
    </div>
    <div className="tp-batch-bar" role="group" aria-label="批量处理冲突块">
      {blocks.length > 1 && <><Button variant="secondary" onClick={() => resolveRemaining('current')} disabled={loading} title={`把剩余所有冲突块统一替换为「${mergeLabels.current}」一侧`}>剩余全部采用当前</Button><Button variant="secondary" onClick={() => resolveRemaining('incoming')} disabled={loading} title={`把剩余所有冲突块统一替换为「${mergeLabels.incoming}」一侧`}>剩余全部采用传入</Button><Button variant="secondary" onClick={() => resolveRemaining('both')} disabled={loading}>剩余全部保留双方</Button></>}
      <Button variant="secondary" onClick={restoreConflictState} disabled={loading || draft === originalText} title="丢弃本文件所有手工结果，回到磁盘上的原始冲突标记（可撤销）"><RotateCcw size={13}/>恢复冲突状态</Button>
    </div>
    <ConflictCodeEditor ref={editorRef} value={draft} filePath={file.path} blocks={blocks} activeBlock={activeBlock} resolvedRanges={resolvedRanges} disabled={loading} onChange={(value) => { commitDraft(value, 'edit'); if (value !== draft) setLastResolution(null) }} onResolveBlock={resolveBlock} onSave={() => resolveFile('result')} saveLabel={blocks.length ? '保存结果' : '标记已解决'}/>
  </div> : null

  return <section className={`operation-page workspace-page ${loading ? 'operation-busy' : ''}`} aria-busy={loading} onKeyDown={handlePanelKeyDown}>
    <div className="operation-heading operation-statusbar">
      <div className="operation-heading-title">
        <span className={`operation-kind operation-kind-${operation.kind}`}>{kind === 'rebase' ? <GitPullRequest size={15}/> : kind === 'merge' ? <GitMerge size={15}/> : kind === 'revert' ? <RotateCcw size={15}/> : <CircleAlert size={15}/>}</span>
        <strong>{operation.label}</strong>
        <span className="operation-status-meta">{kind === 'rebase' ? `${completedSteps} / ${operation.steps.length || totalSteps} 个提交` : kind === 'revert' && totalSteps > 1 ? `还原第 ${currentStep} / ${totalSteps} 步 · ${conflicts.length} 个冲突文件` : `${conflicts.length} 个冲突文件`}</span>
      </div>
      <div className="operation-actions">
        <Button variant="secondary" onClick={() => void runOperation(() => continueRepositoryOperation(repository.path), '操作已继续')} disabled={loading || conflicts.length > 0 || kind === 'conflict'}>{loading ? <RefreshCw className="spin" size={14}/> : <ChevronRight size={14}/>} {loading ? '正在继续…' : continueActionLabel(kind)}</Button>
        {canSkipOperation(kind) && <Button variant="secondary" onClick={() => void runOperation(() => skipRepositoryOperation(repository.path), '已跳过当前提交')} disabled={loading}><SkipForward size={14}/>跳过提交</Button>}
        <Button variant="danger" onClick={() => void (async () => { if (await confirm({ title: '中止 Git 操作', message: '确定中止当前 Git 操作？未完成的合并、变基或还原将被撤销。', confirmLabel: '中止', variant: 'danger' })) await runOperation(() => abortRepositoryOperation(repository.path), '已中止 Git 操作') })()} disabled={loading || kind === 'conflict'}><Square size={13}/>中止</Button>
        {onClose && <Button variant="icon" onClick={onClose} disabled={loading} title="返回提交图谱"><X size={15}/></Button>}
      </div>
    </div>

    {showsStepRoute(kind) && operation.steps.length > 0 && <details className="rebase-route"><summary><GitBranch size={13}/>{stepRouteLabel(kind)} <span>{currentStep && totalSteps ? `第 ${currentStep} / ${totalSteps} 步` : '准备中'}</span></summary><div className="rebase-steps">{operation.steps.map((step) => <div className={`rebase-step ${step.status}`} key={step.hash}><span className="rebase-step-line"/><span className="rebase-step-dot"/><div><strong>{step.title}</strong><small>{step.shortHash} · {step.author}</small></div><span className="rebase-step-status">{step.status === 'applied' ? '已完成' : step.status === 'current' ? '当前冲突' : '待处理'}</span></div>)}</div></details>}

    <div className={`conflict-workspace${viewMode === 'three' ? ' tp-workspace-wide' : ''}`}>
      <div className="conflict-editor inline-resolution">
        <div className="conflict-editor-toolbar"><strong>{file?.path ?? '没有待处理的冲突文件'}</strong>{dirty && <span className="operation-status-meta">草稿有未保存的修改</span>}<div className="tp-mode-switch" role="group" aria-label="冲突视图模式"><button type="button" className={viewMode === 'three' ? 'active' : ''} aria-pressed={viewMode === 'three'} onClick={() => setViewMode('three')}>三栏对照</button><button type="button" className={viewMode === 'inline' ? 'active' : ''} aria-pressed={viewMode === 'inline'} onClick={() => setViewMode('inline')}>单栏结果</button>{file?.base != null && !file.binary && <button type="button" className={showBase ? 'active' : ''} aria-pressed={showBase} onClick={() => setShowBase((value) => !value)} title="显示/隐藏 diff3 共同祖先基线栏">基线</button>}</div><div className="conflict-navigation"><button onClick={() => jumpFile(-1)} disabled={!conflicts.length} title="上一个冲突文件"><ChevronLeft size={14}/></button><span>{conflicts.length ? `${Math.max(0, conflicts.indexOf(selectedPath ?? conflicts[0]) + 1)} / ${conflicts.length}` : '0 / 0'}</span><button onClick={() => jumpFile(1)} disabled={!conflicts.length} title="下一个冲突文件"><ChevronRight size={14}/></button></div><div className="conflict-navigation"><button onClick={() => jumpBlock(-1)} disabled={!blocks.length} title="上一处冲突"><ChevronLeft size={14}/></button><span>{blocks.length ? `${activeBlock + 1} / ${blocks.length}` : '0 / 0'}</span><button onClick={() => jumpBlock(1)} disabled={!blocks.length} title="下一处冲突"><ChevronRight size={14}/></button></div><button className="icon-tool-button" onClick={() => { if (file) void (async () => { if (!(await discardDraftIfNeeded(wholeFileLabels.mergetool))) return; unsavedDrafts.current.delete(file.path); await runOperation(() => launchConflictMergetool(repository.path, file.path), '外部合并工具已完成') })() }} disabled={!file || loading} title="使用已配置的 Git 外部合并工具"><ExternalLink size={14}/></button></div>
        {!file && <div className="conflict-editor-empty"><AlertTriangle size={30}/><strong>{conflicts.length ? '请从工作区变更的“冲突”分组打开文件' : '所有冲突已解决'}</strong><span>{conflicts.length ? '也可使用上方按钮在冲突文件之间切换。' : '点击“继续”让 Git 进入下一步。'}</span></div>}
        {file?.binary && <div className="conflict-binary"><AlertTriangle size={28}/><strong>{file.gitlink ? '此文件是 Gitlink / Submodule 引用' : '此文件包含二进制内容'}</strong><span>无法进行文本编辑，不进入三栏合并视图；请选择一侧、删除文件或使用外部合并工具；选侧会直接写入暂存区。</span><div><Button variant="secondary" onClick={() => resolveFile('current')} disabled={loading || !isSideAvailable(file, 'current')} title={file.gitlink ? '按索引里当前侧的子模块引用记录解决' : '取工作区内当前侧的二进制内容（git checkout --ours）'}><RotateCcw size={13}/>采用当前</Button><Button variant="secondary" onClick={() => resolveFile('incoming')} disabled={loading || !isSideAvailable(file, 'incoming')} title={file.gitlink ? '按索引里对方侧的子模块引用记录解决' : '取工作区内对方侧的二进制内容（git checkout --theirs）'}><GitPullRequest size={13}/>采用对方</Button><Button variant="danger" onClick={() => resolveFile('delete')} disabled={loading}><Trash2 size={13}/>删除文件</Button></div></div>}
        {file && !file.binary && (viewMode === 'three'
          ? <ThreePaneMergeView
              file={file}
              draft={draft}
              blocks={blocks}
              activeBlock={activeBlock}
              showBase={showBase}
              onActivateBlock={(index) => {
                setActiveBlock(index)
                const target = blocks[index]
                if (target) requestAnimationFrame(() => editorRef.current?.focusBlock(target.offset, target.endOffset))
              }}
              onAdoptActive={(strategy) => resolveBlock(activeBlock, strategy)}
              resultPane={resultPane}
            />
          : resultPane)}
      </div>
    </div>
    {confirmDialog}
  </section>
}
