import { useI18n } from '../../i18n'
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
  const { t } = useI18n()
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
    return window.confirm(`${options.title ?? t('flow.confirmTitle')}\n\n${options.message}`)
  }

  const saveConfig = async () => {
    if (!draft) return
    const errors = validateGitflowConfig(draft, t)
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
      notify(t('flow.configSaved'))
      await reload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

  const submitStart = async () => {
    if (!startDialog || !config) return
    const invalid = validateGitflowLeafName(config, startDialog.kind, startDialog.name, t)
    if (invalid) {
      setError(invalid)
      return
    }
    const base = startDialog.base.trim()
    if (base) {
      const baseError = validateGitflowBranchName(base, t)
      if (baseError) {
        setError(t('flow.baseBranchError', { error: baseError }))
        return
      }
    }
    setBusy('start')
    setError('')
    try {
      const report = await startGitflowBranch(repositoryPath, startDialog.kind, startDialog.name, base || null)
      notify(t('flow.createdAndSwitched', { branch: report.branch, base: report.base }))
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
      const tagError = validateGitflowTagName(config, finishDialog.name, t)
      if (tagError) {
        setError(t('flow.tagError', { error: tagError }))
        return
      }
    }
    const target = gitflowTagName(config, finishDialog.name)
    const accepted = await ask({
      title: t('flow.finishDialogTitle', { kind: gitflowKindLabel(kind, t), name: finishDialog.name }),
      message: `${t('flow.finishBody', { name: finishDialog.name, target: kind === 'feature' ? ' develop' : t('flow.finishMainDevelopNote'), tagNote: tagEnabled ? t('flow.finishTagSuffix', { target }) : '' })}${kind === 'release' || kind === 'hotfix' ? t('flow.finishConflictNote') : ''}`,
      confirmLabel: t('flow.startMerge'),
      variant: 'primary',
    })
    if (!accepted) {
      notify(t('flow.cancelled'))
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
      notify(finishReportHeadline(nextReport, t))
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
    return <section className="workspace-empty"><GitMerge size={34}/><strong>{t('flow.panelTitle')}</strong><span>{t('flow.requiresRepository')}</span></section>
  }

  const groups = gitflowGroups(branches, config ?? {
    mainBranch: 'main',
    developBranch: 'develop',
    featurePrefix: 'feature/',
    releasePrefix: 'release/',
    hotfixPrefix: 'hotfix/',
    supportPrefix: 'support/',
    tagPrefix: '',
  }, t)
  const configErrors = draft ? validateGitflowConfig(draft, t) : []
  const startInvalid = startDialog && config ? validateGitflowLeafName(config, startDialog.kind, startDialog.name, t) : null
  const tagInvalid = finishDialog && config && canTagGitflow(finishDialog.kind) && tag
    ? validateGitflowTagName(config, finishDialog.name, t)
    : null
  const disabled = loading || busy !== null
  const reportTone = report ? finishReportTone(report) : null
  const counts = report ? finishReportStepCounts(report) : null

  return <section className="structure-panel workspace-page flow-panel">
    <div className="workspace-page-heading">
      <div>
        <span className="eyebrow">{t('flow.branchWorkflow')}</span>
        <h2>Gitflow</h2>
        <p>{t('flow.summaryLine', { main: config?.mainBranch ?? '—', develop: config?.developBranch ?? '—' })}</p>
      </div>
      <div className="structure-actions">
        <Button variant="secondary" disabled={disabled} onClick={() => void reload()}><RefreshCw size={14} className={loading ? 'spin' : ''}/>{loading ? t('hosting.loadingList') : t('flow.refresh')}</Button>
      </div>
    </div>

    {error && <div className="lfs-error" role="alert"><AlertTriangle size={14}/><span>{error}</span><Button variant="icon" onClick={() => setError('')} title={t('flow.close')}><X size={14}/></Button></div>}

    <div className="flow-grid">
      <article className="structure-detail-card flow-config-card">
        <h3><Settings size={15}/>{t('flow.configSection')}</h3>
        <p className="lfs-card-hint">{t('flow.configNotePrefix')}f-format{t('flow.configNoteSuffix')}</p>
        {draft && <>
          <div className="flow-field-grid">
            {([
              ['mainBranch', t('flow.mainBranch')],
              ['developBranch', t('flow.developBranch')],
              ['featurePrefix', t('flow.featurePrefix')],
              ['releasePrefix', t('flow.releasePrefix')],
              ['hotfixPrefix', t('flow.hotfixPrefix')],
              ['supportPrefix', t('flow.supportPrefix')],
              ['tagPrefix', t('flow.tagPrefix')],
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
            <span className={configErrors.length ? 'error' : ''}>{configErrors.length ? configErrors[0] : t('flow.configWriteNote')}</span>
            <Button variant="primary" disabled={disabled || configErrors.length > 0} onClick={() => void saveConfig()}>
              <Save size={14}/>{busy === 'save' ? t('flow.savingConfig') : t('flow.saveConfig')}
            </Button>
          </div>
        </>}
      </article>

      <article className="structure-detail-card flow-start-card">
        <h3><GitBranch size={15}/>{t('flow.startNewBranch')}</h3>
        <p className="lfs-card-hint">{t('flow.startBranchHint')} based main。</p>
        <div className="flow-start-kinds">
          {GITFLOW_KINDS.map((kind) => <Button
            key={kind}
            variant="secondary"
            disabled={disabled || !config}
            onClick={() => { setStartDialog({ kind, name: '', base: '' }); setFinishDialog(null); setError('') }}
          ><Plus size={13}/>{gitflowKindLabel(kind, t)}</Button>)}
        </div>
      </article>
    </div>

    <div className="flow-groups">
      {groups.map((group) => <article key={group.kind} className={`structure-detail-card flow-group flow-group-${group.kind}`}>
        <div className="flow-group-heading">
          <div><h3><GitBranch size={15}/>{group.label}<span className="flow-count">{group.branches.length}</span></h3><p>{group.note}</p></div>
          <Button variant="secondary" disabled={disabled || !config} onClick={() => { setStartDialog({ kind: group.kind, name: '', base: '' }); setFinishDialog(null) }}><Plus size={13}/>{t('flow.new')}</Button>
        </div>
        {group.branches.length === 0
          ? <p className="lfs-empty">{t('flow.none')}{group.label}。</p>
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
                }}><GitMerge size={13}/>{t('flow.finishAction')}</Button>
                : <span className="flow-long-lived">{t('flow.longLived')}</span>}
            </li>)}
          </ul>}
      </article>)}
    </div>

    {report && <article className={`structure-detail-card flow-report flow-report-${reportTone}`}>
      <div className="flow-report-heading">
        <h3>{reportTone === 'success' ? <CheckCircle2 size={15}/> : <AlertTriangle size={15}/>}{finishReportHeadline(report, t)}</h3>
        {counts && <span className="flow-report-counts">{t('flow.finishCounts', counts)}</span>}
        <Button variant="icon" title={t('flow.closeReport')} onClick={() => setReport(null)}><X size={15}/></Button>
      </div>
      <ul className="flow-report-steps">
        {report.steps.map((step, index) => <li key={`${step.action}:${index}`} className={`flow-step-${step.status}`}>
          <span>{stepStatusLabel(step.status, t)}</span><code>{step.action}</code>{step.detail && <small>{step.detail}</small>}
        </li>)}
      </ul>
      {report.guidance && <p className="flow-guidance"><AlertTriangle size={14}/>{report.guidance}</p>}
      <p className="flow-report-hashes"><code>HEAD {report.headBefore.slice(0, 10)} → {report.headAfter.slice(0, 10)}</code></p>
    </article>}

    {startDialog && config && <div className="modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) setStartDialog(null) }}>
      <section className="branch-dialog flow-dialog" role="dialog" aria-modal="true" aria-labelledby="flow-start-title" onPointerDown={(event) => event.stopPropagation()}>
        <div className="branch-dialog-heading">
          <span className="branch-dialog-icon"><GitBranch size={17}/></span>
          <div><h2 id="flow-start-title">{t('flow.new')} {gitflowKindLabel(startDialog.kind, t)}</h2><p>{t('flow.startBranchBased')} <strong>{gitflowDefaultBase(config, startDialog.kind)}</strong>{t('flow.startBranchBaseHint')}</p></div>
          <Button variant="icon" onClick={() => setStartDialog(null)} disabled={busy !== null} title={t('flow.close')}><X size={16}/></Button>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); void submitStart() }}>
          <label>{t('flow.shortNameLabel')}</label>
          <div className={startInvalid ? 'branch-name-input invalid' : 'branch-name-input'}>
            <input autoFocus value={startDialog.name} spellCheck={false} placeholder={t('flow.shortNamePlaceholder')} onChange={(event) => setStartDialog({ ...startDialog, name: event.target.value })}/>
          </div>
          <p className="branch-dialog-hint">{startInvalid ?? t('flow.willCreate', { full: `${gitflowPrefix(config, startDialog.kind)}${gitflowLeafName(config, startDialog.kind, startDialog.name) || '…'}` })}</p>
          <label>{t('flow.baseBranchLabel')}</label>
          <div className={startDialog.base && validateGitflowBranchName(startDialog.base, t) ? 'branch-name-input invalid' : 'branch-name-input'}>
            <input value={startDialog.base} spellCheck={false} placeholder={gitflowDefaultBase(config, startDialog.kind)} onChange={(event) => setStartDialog({ ...startDialog, base: event.target.value })}/>
          </div>
          <p className="branch-dialog-hint">{t('flow.baseBranchNote')}</p>
          <div className="branch-dialog-actions">
            <Button variant="secondary" type="button" onClick={() => setStartDialog(null)} disabled={busy !== null}>{t('common.cancel')}</Button>
            <Button variant="primary" type="submit" disabled={busy !== null || Boolean(startInvalid) || !startDialog.name.trim()}>{busy === 'start' ? t('flow.creating') : t('flow.createAndSwitch')}</Button>
          </div>
        </form>
      </section>
    </div>}

    {finishDialog && config && <div className="modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) setFinishDialog(null) }}>
      <section className="branch-dialog flow-dialog" role="dialog" aria-modal="true" aria-labelledby="flow-finish-title" onPointerDown={(event) => event.stopPropagation()}>
        <div className="branch-dialog-heading">
          <span className="branch-dialog-icon"><GitMerge size={17}/></span>
          <div><h2 id="flow-finish-title">{t('flow.finishAction')} {gitflowKindLabel(finishDialog.kind, t)}</h2><p><strong>{finishDialog.name}</strong> {t('flow.finishNote')}</p></div>
          <Button variant="icon" onClick={() => setFinishDialog(null)} disabled={busy !== null} title={t('flow.close')}><X size={16}/></Button>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); void submitFinish() }}>
          {canTagGitflow(finishDialog.kind) && <label className="flow-tag-toggle"><span><strong>{t('flow.tagAfterMerge')}</strong><small>{t('flow.tagNameLabel')}{gitflowTagName(config, finishDialog.name)}</small></span><input type="checkbox" checked={tag} onChange={(event) => setTag(event.target.checked)}/></label>}
          {canTagGitflow(finishDialog.kind) && tag && <>
            <label>{t('flow.tagMessageLabel')}</label>
            <div className={tagInvalid ? 'branch-name-input invalid' : 'branch-name-input'}><input value={tagMessage} placeholder={t('flow.tagMessagePlaceholder')} onChange={(event) => setTagMessage(event.target.value)}/></div>
            <p className="branch-dialog-hint">{tagInvalid ?? t('flow.tagMessageNote')}</p>
          </>}
          <p className="branch-dialog-hint">{t('flow.conflictKeepNote')}</p>
          <div className="branch-dialog-actions">
            <Button variant="secondary" type="button" onClick={() => setFinishDialog(null)} disabled={busy !== null}>{t('common.cancel')}</Button>
            <Button variant="primary" type="submit" disabled={busy !== null || Boolean(tagInvalid)}>{busy === 'finish' ? t('flow.executing') : <><GitMerge size={13}/>{t('flow.startMergeAction')}</>}</Button>
          </div>
        </form>
      </section>
    </div>}
  </section>
}
