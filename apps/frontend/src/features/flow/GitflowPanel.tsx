import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, GitBranch, GitMerge, Plus, RefreshCw, Save, Settings, Tag, X } from 'lucide-react'
import type { ConfirmDialogOptions } from '../../components/ConfirmDialog'
import { Button } from '../../components/Button'
import {
  finishGitflowBranch,
  listGitflowBranches,
  loadGitflowConfig,
  saveGitflowConfig,
  startGitflowBranch,
  type GitflowBranches,
  type GitflowConfig,
  type GitflowFinishReport,
  type GitflowKind,
} from '../../repository'
import {
  GITFLOW_KINDS,
  canFinishGitflow,
  canTagGitflow,
  finishReportHeadline,
  finishReportStepCounts,
  finishReportTone,
  gitflowDefaultBase,
  gitflowGroups,
  gitflowKindLabel,
  gitflowKindNote,
  gitflowLeafName,
  gitflowPrefix,
  gitflowTagName,
  stepStatusLabel,
  validateGitflowBranchName,
  validateGitflowConfig,
  validateGitflowLeafName,
  validateGitflowTagName,
} from './flowModel'

/**
 * Gitflow 工作流面板（W3-4）。
 *
 * 只接收 repositoryPath 与回调，不依赖 App 全局状态：
 * - 配置编辑写本地 gitflow.* 键，保存前用与后端同一套规则做前置校验；
 * - 分支按 feature/release/hotfix/support 分组，start 默认从 develop / main 起；
 * - finish 的冲突报告不会自动 abort：guidance 直接展示，用户可去「操作」页继续或中止；
 * - 所有操作只在本仓库执行，绝不 push（后端 finish 不包含任何推送命令）。
 */
export type GitflowPanelProps = {
  repositoryPath: string
  onNotice?: (message: string) => void
  confirm?: (options: ConfirmDialogOptions) => Promise<boolean>
  /** start / finish / 配置保存后通知父级刷新仓库快照。 */
  onChanged?: () => void
}

type StartDialog = { kind: GitflowKind; name: string; base: string }
type FinishDialog = { kind: GitflowKind; name: string }

export function GitflowPanel({ repositoryPath, onNotice, confirm, onChanged }: GitflowPanelProps) {
  const [config, setConfig] = useState<GitflowConfig | null>(null)
  const [draft, setDraft] = useState<GitflowConfig | null>(null)
  const [branches, setBranches] = useState<GitflowBranches | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [startDialog, setStartDialog] = useState<StartDialog | null>(null)
  const [finishDialog, setFinishDialog] = useState<FinishDialog | null>(null)
  const [tag, setTag] = useState(false)
  const [tagMessage, setTagMessage] = useState('')
  const [report, setReport] = useState<GitflowFinishReport | null>(null)

  const notify = useCallback((message: string) => onNotice?.(message), [onNotice])

  const reload = useCallback(async () => {
    if (!repositoryPath) return
    setLoading(true)
    setError('')
    try {
      const [nextConfig, nextBranches] = await Promise.all([
        loadGitflowConfig(repositoryPath),
        listGitflowBranches(repositoryPath),
      ])
      setConfig(nextConfig)
      setDraft(nextConfig)
      setBranches(nextBranches)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [repositoryPath])

  useEffect(() => {
    setConfig(null)
    setDraft(null)
    setBranches(null)
    setReport(null)
    setStartDialog(null)
    setFinishDialog(null)
    void reload()
  }, [reload])

  const ask = async (options: ConfirmDialogOptions): Promise<boolean> => {
    if (confirm) return confirm(options)
    return window.confirm(`${options.title ?? '请确认'}\n\n${options.message}`)
  }

  const saveConfig = async () => {
    if (!draft) return
    const errors = validateGitflowConfig(draft)
    if (errors.length) {
      setError(errors.join('；'))
      return
    }
    setBusy('save')
    setError('')
    try {
      const saved = await saveGitflowConfig(repositoryPath, draft)
      setConfig(saved)
      setDraft(saved)
      notify('Gitflow 配置已写入本地 git config')
      await reload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

  const submitStart = async () => {
    if (!startDialog || !config) return
    const invalid = validateGitflowLeafName(config, startDialog.kind, startDialog.name)
    if (invalid) {
      setError(invalid)
      return
    }
    const base = startDialog.base.trim()
    if (base) {
      const baseError = validateGitflowBranchName(base)
      if (baseError) {
        setError(`基础分支：${baseError}`)
        return
      }
    }
    setBusy('start')
    setError('')
    try {
      const report = await startGitflowBranch(repositoryPath, startDialog.kind, startDialog.name, base || null)
      notify(`已创建并切换到 ${report.branch}（基于 ${report.base}）`)
      setStartDialog(null)
      await reload()
      onChanged?.()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

  const submitFinish = async () => {
    if (!finishDialog || !config) return
    const kind = finishDialog.kind
    const tagEnabled = canTagGitflow(kind) && tag
    if (tagEnabled) {
      const tagError = validateGitflowTagName(config, finishDialog.name)
      if (tagError) {
        setError(`标签：${tagError}`)
        return
      }
    }
    const target = gitflowTagName(config, finishDialog.name)
    const accepted = await ask({
      title: `完成 ${gitflowKindLabel(kind)} ${finishDialog.name}`,
      message: `将把 ${finishDialog.name} 以 --no-ff 合并到${kind === 'feature' ? ' develop' : ' main 与 develop'}${tagEnabled ? `，并创建标签 ${target}` : ''}，最后删除本地分支。不会推送远端。${kind === 'release' || kind === 'hotfix' ? '发生冲突时会保留合并状态，需要你手动继续或中止。' : ''}`,
      confirmLabel: '开始合并',
      variant: 'primary',
    })
    if (!accepted) {
      notify('已取消，仓库未发生改动')
      return
    }
    setBusy('finish')
    setError('')
    try {
      const nextReport = await finishGitflowBranch(repositoryPath, kind, gitflowLeafName(config, kind, finishDialog.name), {
        tag: tagEnabled,
        tagMessage: tagEnabled && tagMessage.trim() ? tagMessage.trim() : null,
      })
      setReport(nextReport)
      const tone = finishReportTone(nextReport)
      notify(finishReportHeadline(nextReport))
      if (tone === 'success') {
        setFinishDialog(null)
        setTag(false)
        setTagMessage('')
      }
      await reload()
      onChanged?.()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

  if (!repositoryPath) {
    return <section className="workspace-empty"><GitMerge size={34}/><strong>Gitflow 工作流</strong><span>请先打开本地仓库，再管理 feature / release / hotfix 分支。</span></section>
  }

  const groups = gitflowGroups(branches, config ?? {
    mainBranch: 'main',
    developBranch: 'develop',
    featurePrefix: 'feature/',
    releasePrefix: 'release/',
    hotfixPrefix: 'hotfix/',
    supportPrefix: 'support/',
    tagPrefix: '',
  })
  const configErrors = draft ? validateGitflowConfig(draft) : []
  const startInvalid = startDialog && config ? validateGitflowLeafName(config, startDialog.kind, startDialog.name) : null
  const tagInvalid = finishDialog && config && canTagGitflow(finishDialog.kind) && tag
    ? validateGitflowTagName(config, finishDialog.name)
    : null
  const disabled = loading || busy !== null
  const reportTone = report ? finishReportTone(report) : null
  const counts = report ? finishReportStepCounts(report) : null

  return <section className="structure-panel workspace-page flow-panel">
    <div className="workspace-page-heading">
      <div>
        <span className="eyebrow">分支工作流</span>
        <h2>Gitflow</h2>
        <p>{`主干 ${config?.mainBranch ?? '—'} · develop ${config?.developBranch ?? '—'}；所有操作只在本地执行，不会 push。`}</p>
      </div>
      <div className="structure-actions">
        <Button variant="secondary" disabled={disabled} onClick={() => void reload()}><RefreshCw size={14} className={loading ? 'spin' : ''}/>{loading ? '读取中…' : '刷新'}</Button>
      </div>
    </div>

    {error && <div className="lfs-error" role="alert"><AlertTriangle size={14}/><span>{error}</span><Button variant="icon" onClick={() => setError('')} title="关闭"><X size={14}/></Button></div>}

    <div className="flow-grid">
      <article className="structure-detail-card flow-config-card">
        <h3><Settings size={15}/>工作流配置</h3>
        <p className="lfs-card-hint">保存写入本地 git config 的 gitflow.* 键；分支名与前缀会先经 check-ref-format 规则校验。</p>
        {draft && <>
          <div className="flow-field-grid">
            {([
              ['mainBranch', '主干分支'],
              ['developBranch', 'develop 分支'],
              ['featurePrefix', 'feature 前缀'],
              ['releasePrefix', 'release 前缀'],
              ['hotfixPrefix', 'hotfix 前缀'],
              ['supportPrefix', 'support 前缀'],
              ['tagPrefix', '标签前缀（可空）'],
            ] as [keyof GitflowConfig, string][]).map(([key, label]) => (
              <label key={key} className="flow-config-field">
                <span>{label}</span>
                <div className="branch-name-input"><input
                  value={draft[key]}
                  spellCheck={false}
                  onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                /></div>
              </label>
            ))}
          </div>
          <div className="flow-config-footer">
            <span className={configErrors.length ? 'error' : ''}>{configErrors.length ? configErrors[0] : '配置将被立即写入仓库本地配置。'}</span>
            <Button variant="primary" disabled={disabled || configErrors.length > 0} onClick={() => void saveConfig()}>
              <Save size={14}/>{busy === 'save' ? '保存中…' : '保存配置'}
            </Button>
          </div>
        </>}
      </article>

      <article className="structure-detail-card flow-start-card">
        <h3><GitBranch size={15}/>开始新分支</h3>
        <p className="lfs-card-hint">feature 默认基于 develop，release / hotfix / support 默认基于 main。</p>
        <div className="flow-start-kinds">
          {GITFLOW_KINDS.map((kind) => <Button
            key={kind}
            variant="secondary"
            disabled={disabled || !config}
            onClick={() => { setStartDialog({ kind, name: '', base: '' }); setFinishDialog(null); setError('') }}
          ><Plus size={13}/>{gitflowKindLabel(kind)}</Button>)}
        </div>
      </article>
    </div>

    <div className="flow-groups">
      {groups.map((group) => <article key={group.kind} className={`structure-detail-card flow-group flow-group-${group.kind}`}>
        <div className="flow-group-heading">
          <div><h3><GitBranch size={15}/>{group.label}<span className="flow-count">{group.branches.length}</span></h3><p>{group.note}</p></div>
          <Button variant="secondary" disabled={disabled || !config} onClick={() => { setStartDialog({ kind: group.kind, name: '', base: '' }); setFinishDialog(null) }}><Plus size={13}/>新建</Button>
        </div>
        {group.branches.length === 0
          ? <p className="lfs-empty">暂无{group.label}。</p>
          : <ul className="flow-branch-list">
            {group.branches.map((branch) => <li key={branch.full}>
              <code>{branch.full}</code>
              {canFinishGitflow(group.kind)
                ? <Button variant="primary" disabled={disabled} onClick={() => {
                  setFinishDialog({ kind: group.kind, name: branch.name })
                  setStartDialog(null)
                  setTag(false)
                  setTagMessage('')
                  setReport(null)
                  setError('')
                }}><GitMerge size={13}/>完成</Button>
                : <span className="flow-long-lived">长期维护</span>}
            </li>)}
          </ul>}
      </article>)}
    </div>

    {report && <article className={`structure-detail-card flow-report flow-report-${reportTone}`}>
      <div className="flow-report-heading">
        <h3>{reportTone === 'success' ? <CheckCircle2 size={15}/> : <AlertTriangle size={15}/>}{finishReportHeadline(report)}</h3>
        {counts && <span className="flow-report-counts">{`完成 ${counts.completed} · 跳过 ${counts.skipped} · 冲突 ${counts.conflict} · 失败 ${counts.failed}`}</span>}
        <Button variant="icon" title="关闭报告" onClick={() => setReport(null)}><X size={15}/></Button>
      </div>
      <ul className="flow-report-steps">
        {report.steps.map((step, index) => <li key={`${step.action}:${index}`} className={`flow-step-${step.status}`}>
          <span>{stepStatusLabel(step.status)}</span><code>{step.action}</code>{step.detail && <small>{step.detail}</small>}
        </li>)}
      </ul>
      {report.guidance && <p className="flow-guidance"><AlertTriangle size={14}/>{report.guidance}</p>}
      <p className="flow-report-hashes"><code>HEAD {report.headBefore.slice(0, 10)} → {report.headAfter.slice(0, 10)}</code></p>
    </article>}

    {startDialog && config && <div className="modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) setStartDialog(null) }}>
      <section className="branch-dialog flow-dialog" role="dialog" aria-modal="true" aria-labelledby="flow-start-title" onPointerDown={(event) => event.stopPropagation()}>
        <div className="branch-dialog-heading">
          <span className="branch-dialog-icon"><GitBranch size={17}/></span>
          <div><h2 id="flow-start-title">新建{gitflowKindLabel(startDialog.kind)}</h2><p>默认基于 <strong>{gitflowDefaultBase(config, startDialog.kind)}</strong>；留空使用默认基础分支。</p></div>
          <Button variant="icon" onClick={() => setStartDialog(null)} disabled={busy !== null} title="关闭"><X size={16}/></Button>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); void submitStart() }}>
          <label>分支名（短名）</label>
          <div className={startInvalid ? 'branch-name-input invalid' : 'branch-name-input'}>
            <input autoFocus value={startDialog.name} spellCheck={false} placeholder="例如 login" onChange={(event) => setStartDialog({ ...startDialog, name: event.target.value })}/>
          </div>
          <p className="branch-dialog-hint">{startInvalid ?? `将创建 ${gitflowPrefix(config, startDialog.kind)}${gitflowLeafName(config, startDialog.kind, startDialog.name) || '…'}`}</p>
          <label>基础分支（可选）</label>
          <div className={startDialog.base && validateGitflowBranchName(startDialog.base) ? 'branch-name-input invalid' : 'branch-name-input'}>
            <input value={startDialog.base} spellCheck={false} placeholder={gitflowDefaultBase(config, startDialog.kind)} onChange={(event) => setStartDialog({ ...startDialog, base: event.target.value })}/>
          </div>
          <p className="branch-dialog-hint">基础分支必须已存在；创建不会推送远端。</p>
          <div className="branch-dialog-actions">
            <Button variant="secondary" type="button" onClick={() => setStartDialog(null)} disabled={busy !== null}>取消</Button>
            <Button variant="primary" type="submit" disabled={busy !== null || Boolean(startInvalid) || !startDialog.name.trim()}>{busy === 'start' ? '创建中…' : '创建并切换'}</Button>
          </div>
        </form>
      </section>
    </div>}

    {finishDialog && config && <div className="modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) setFinishDialog(null) }}>
      <section className="branch-dialog flow-dialog" role="dialog" aria-modal="true" aria-labelledby="flow-finish-title" onPointerDown={(event) => event.stopPropagation()}>
        <div className="branch-dialog-heading">
          <span className="branch-dialog-icon"><GitMerge size={17}/></span>
          <div><h2 id="flow-finish-title">完成{gitflowKindLabel(finishDialog.kind)}</h2><p><strong>{finishDialog.name}</strong> 将以 --no-ff 合并，完成后删除本地分支；不会 push。</p></div>
          <Button variant="icon" onClick={() => setFinishDialog(null)} disabled={busy !== null} title="关闭"><X size={16}/></Button>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); void submitFinish() }}>
          {canTagGitflow(finishDialog.kind) && <label className="flow-tag-toggle"><span><strong>合并到 main 后打标签</strong><small>标签名：{gitflowTagName(config, finishDialog.name)}</small></span><input type="checkbox" checked={tag} onChange={(event) => setTag(event.target.checked)}/></label>}
          {canTagGitflow(finishDialog.kind) && tag && <>
            <label>标签说明（可选）</label>
            <div className={tagInvalid ? 'branch-name-input invalid' : 'branch-name-input'}><input value={tagMessage} placeholder="例如：首个正式版本" onChange={(event) => setTagMessage(event.target.value)}/></div>
            <p className="branch-dialog-hint">{tagInvalid ?? '留空创建轻量标签；填写后创建注释标签。'}</p>
          </>}
          <p className="branch-dialog-hint">冲突时后端保留 MERGE_HEAD 状态，不会自动 abort；可到「操作」页继续或中止。</p>
          <div className="branch-dialog-actions">
            <Button variant="secondary" type="button" onClick={() => setFinishDialog(null)} disabled={busy !== null}>取消</Button>
            <Button variant="primary" type="submit" disabled={busy !== null || Boolean(tagInvalid)}>{busy === 'finish' ? '执行中…' : <><GitMerge size={13}/>开始合并</>}</Button>
          </div>
        </form>
      </section>
    </div>}
  </section>
}
