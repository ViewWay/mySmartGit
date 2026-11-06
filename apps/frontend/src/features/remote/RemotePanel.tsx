import { useI18n } from '../../i18n'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Cloud, GitBranch, Link2, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import {
  addRepositoryRemote,
  loadRepositoryRemotes,
  removeRepositoryRemote,
  renameRepositoryBranch,
  renameRepositoryRemote,
  setRepositoryBranchUpstream,
  setRepositoryRemoteUrl,
  type RemoteOperationReport,
  type RepositoryRemoteDetail,
  type RepositorySnapshot,
} from '../../repository'
import { Button } from '../../components/Button'
import { CompactSelect } from '../../components/CompactSelect'
import { useConfirmDialog } from '../../components/ConfirmDialog'
import { fetchUrlText, pushUrlText, upstreamCandidates } from './remotePanelState'
import { useReportedAction } from './useReportedAction'

type EditMode = 'rename' | 'fetch' | 'push'
type Editing = { remote: string; mode: EditMode } | null

const modeKeys: Record<EditMode, string> = { rename: 'repository.remote.renameTitle', fetch: 'repository.remote.changeFetch', push: 'repository.remote.changePush' }

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>
}

/**
 * 远程管理面板：远程增删改名、fetch/push 地址分离设置，以及本地分支的上游跟踪与改名。
 *
 * 删除远程、重命名远程、改写地址、重命名分支都必须先经后端预览：
 * `report.executed === false` 时仓库未被改动，确认框里逐条列出 warnings 与 affected，
 * 用户确认后才以 `confirm=true` 重新调用；面板不会替用户按下确认。
 */
export function RemotePanel({ repository, onSnapshot, onNotice }: {
  repository: RepositorySnapshot | null
  onSnapshot: (snapshot: RepositorySnapshot) => void
  onNotice: (message: string) => void
}) {
  const { t } = useI18n()
  const [remotes, setRemotes] = useState<RepositoryRemoteDetail[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [fetchNow, setFetchNow] = useState(true)
  const [editing, setEditing] = useState<Editing>(null)
  const [draft, setDraft] = useState('')
  const [upstreamChoice, setUpstreamChoice] = useState<Record<string, string>>({})
  const [renaming, setRenaming] = useState<{ branch: string; target: string } | null>(null)
  const { confirm, confirmDialog } = useConfirmDialog()
  const run = useReportedAction({ confirm, onSnapshot, onNotice })

  const refresh = useCallback(async () => {
    if (!repository) return
    setLoading(true)
    try {
      setRemotes(await loadRepositoryRemotes(repository.path))
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [onNotice, repository?.path])

  useEffect(() => { setRemotes([]); void refresh() }, [refresh])

  const applyReport = (report: RemoteOperationReport | null) => {
    if (!report) return
    setRemotes(report.remotes)
  }

  const localBranches = useMemo(
    // branchTracking 的键来自 refs/heads，正好是本地分支集合。
    () => Object.keys(repository?.branchTracking ?? {}).sort((left, right) => left.localeCompare(right)),
    [repository?.branchTracking],
  )
  const candidates = useMemo(() => upstreamCandidates(repository?.remoteBranches ?? []), [repository?.remoteBranches])

  if (!repository) return <section className="workspace-empty"><Cloud size={34}/><strong>{t('repository.remote.title')}</strong><span>{t('repository.remote.requiresRepository')}</span></section>

  const guard = async (key: string, action: (confirmFlag: boolean) => Promise<RemoteOperationReport>, title: string, done: string) => {
    setBusy(key)
    applyReport(await run(action, title, done))
    setBusy(null)
    setEditing(null)
  }

  const submitAdd = () => {
    const name = newName.trim()
    const url = newUrl.trim()
    if (!name || !url) { onNotice(t('repository.remote.nameAndUrlRequired')); return }
    // 添加远程不是破坏性动作，后端一次调用即执行，不需要 confirm 轮次。
    void guard('add', () => addRepositoryRemote(repository.path, name, url, fetchNow), t('repository.remote.addTitle'), `已添加远程：${name}`)
      .then(() => { setAdding(false); setNewName(''); setNewUrl('') })
  }

  const submitEdit = (remote: RepositoryRemoteDetail) => {
    if (!editing) return
    const value = draft.trim()
    if (!value) { onNotice(t('repository.remote.nameOrUrlRequired')); return }
    if (editing.mode === 'rename') {
      if (value === remote.name) { onNotice(t('repository.remote.sameName')); return }
      void guard(`rename:${remote.name}`, (confirmFlag) => renameRepositoryRemote(repository.path, remote.name, value, confirmFlag), t('repository.remote.renameTitle'), t('repository.remote.renamed', { name: value }))
      return
    }
    void guard(`url:${editing.mode}:${remote.name}`, (confirmFlag) => setRepositoryRemoteUrl(repository.path, remote.name, value, editing.mode === 'push', confirmFlag), t(modeKeys[editing.mode]), t('repository.remote.urlUpdated', { name: remote.name, mode: editing.mode }))
  }

  const submitBranchRename = (branch: string) => {
    const value = (renaming?.target ?? '').trim()
    if (!value) { onNotice(t('repository.remote.newBranchNameRequired')); return }
    if (value === branch) { onNotice(t('repository.remote.sameBranchName')); return }
    void guard(`branch-rename:${branch}`, (confirmFlag) => renameRepositoryBranch(repository.path, branch, value, confirmFlag), t('repository.remote.renameLocalBranchTitle'), `已把 ${branch} 重命名为 ${value}`)
      .then(() => setRenaming(null))
  }

  return <section className="structure-panel workspace-page remote-panel-workspace">
    <div className="workspace-page-heading">
      <div><span className="eyebrow">{t('repository.remote.andTags')}</span><h2>{t('repository.remote.title')}</h2><p>{`当前分支 ${repository.branch || t('repository.remote.detachedHead')}；地址中的凭据在展示前已脱敏。`}</p></div>
      <div className="structure-actions">
        <Button variant="secondary" disabled={loading || busy !== null} onClick={() => void refresh()}><RefreshCw size={14} className={loading ? 'spin' : ''}/>{loading ? t('repository.tree.reading') : t('repository.remote.refresh')}</Button>
        <Button variant="primary" className="structure-heading-action" onClick={() => setAdding((value) => !value)}><Plus size={14}/>{t('repository.remote.addTitle')}</Button>
      </div>
    </div>

    {adding && <div className="structure-detail-grid">
      <article className="structure-detail-card">
        <h3>{t('repository.remote.addSubtitle')}</h3>
        <div className="branch-name-input"><input autoFocus placeholder={t('repository.remote.namePlaceholder')} value={newName} onChange={(event) => setNewName(event.target.value)}/></div>
        <div className="branch-name-input"><input placeholder={t('repository.remote.urlPlaceholder')} value={newUrl} onChange={(event) => setNewUrl(event.target.value)}/></div>
        <label className="auto-fetch-toggle"><span><strong>{t('repository.remote.fetchAfterAdd')}</strong><small>{t('repository.remote.fetchFailureHint')}</small></span><input type="checkbox" checked={fetchNow} onChange={(event) => setFetchNow(event.target.checked)}/><span className="toggle-track" aria-hidden="true"><span/></span></label>
        <div className="branch-dialog-hint">{t('repository.remote.validationHint')}</div>
        <div className="structure-actions">
          <Button variant="primary" disabled={busy !== null} onClick={submitAdd}><Cloud size={14}/>{busy === 'add' ? t('repository.remote.adding') : t('repository.remote.addTitle')}</Button>
          <Button variant="secondary" onClick={() => { setAdding(false); setNewName(''); setNewUrl('') }}><X size={14}/>{t('common.cancel')}</Button>
        </div>
      </article>
    </div>}

    {remotes.length === 0 && !loading && <div className="workspace-hint"><Cloud size={26}/><strong>{t('repository.remote.noneYet')}</strong><span>{t('repository.remote.noneYetHint')}</span></div>}

    {remotes.length > 0 && <div className="structure-detail-grid">
      {remotes.map((remote) => {
        // 先把 editing 按当前卡片收窄成模式，避免在 JSX 里反复判空。
        const editMode = editing && editing.remote === remote.name ? editing.mode : null
        return <article className="structure-detail-card" key={remote.name}>
        <span className="structure-icon"><Cloud size={18}/></span>
        <h3>{remote.name}</h3>
        <dl>
          <DetailField label={t('repository.remote.fetchUrls')}><code>{fetchUrlText(remote, t)}</code></DetailField>
          <DetailField label={t('repository.remote.pushUrls')}><code>{pushUrlText(remote, t)}</code></DetailField>
          <DetailField label={t('repository.remote.fetchRefspec')}>{remote.fetchRefspecs.length ? <code>{remote.fetchRefspecs.join(' ')}</code> : t('repository.remote.fetchRefspecMissing')}</DetailField>
          <DetailField label={t('repository.remote.pushRefspec')}>{remote.pushRefspecs.length ? <code>{remote.pushRefspecs.join(' ')}</code> : t('repository.remote.pushRefspecDefault')}</DetailField>
          <DetailField label={t('repository.remote.remoteHead')}>{remote.headBranch ?? t('repository.remote.remoteHeadUnknown')}</DetailField>
          <DetailField label={t('repository.remote.cachedRemoteBranches')}>{remote.cachedBranchCount}</DetailField>
          <DetailField label={t('repository.remote.trackingBranches')}>{remote.trackingBranches.length ? remote.trackingBranches.join('、') : t('repository.remote.none')}</DetailField>
          {remote.credentialsRedacted && <DetailField label={t('repository.remote.credentialsTitle')}><span className="tag-row-risk">{t('repository.remote.credentialsRedacted')}</span></DetailField>}
        </dl>
        <div className="structure-actions">
          {(['rename', 'fetch', 'push'] as EditMode[]).map((mode) => <Button key={mode} variant="secondary" disabled={busy !== null} onClick={() => { setEditing({ remote: remote.name, mode }); setDraft(mode === 'rename' ? remote.name : mode === 'fetch' ? (remote.fetchUrls[0] ?? '') : (remote.pushUrls[0] ?? '')) }}><Pencil size={13}/>{t(modeKeys[mode])}</Button>)}
          <Button variant="danger" disabled={busy !== null} onClick={() => void guard(`remove:${remote.name}`, (confirmFlag) => removeRepositoryRemote(repository.path, remote.name, confirmFlag), t('repository.remote.deleteTitle'), `已删除远程：${remote.name}`)}><Trash2 size={13}/>{busy === `remove:${remote.name}` ? t('repository.remote.deleting') : t('repository.remote.deleteTitle')}</Button>
        </div>
        {editMode && <div className="structure-actions remote-edit-row">
          <div className="branch-name-input"><input autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={editMode === 'rename' ? t('repository.remote.newName') : t('repository.remote.newUrl')}/></div>
          <Button variant="primary" disabled={busy !== null} onClick={() => submitEdit(remote)}><Link2 size={14}/>{t('repository.remote.submit')}</Button>
          <Button variant="secondary" onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
          <span className="tag-row-risk">{t(modeKeys[editMode])}{t('repository.remote.directionWarning')}</span>
        </div>}
      </article>
      })}
    </div>}

    <div className="structure-detail-grid">
      <article className="structure-detail-card">
        <span className="structure-icon"><GitBranch size={18}/></span>
        <h3>{t('repository.remote.branchTracking')}</h3>
        <div className="branch-dialog-hint">{t('repository.remote.trackingHint')}</div>
        {localBranches.length === 0 && <div className="workspace-hint"><GitBranch size={24}/><strong>{t('repository.remote.noLocalBranches')}</strong></div>}
        <div className="structure-list">
          {localBranches.map((branch) => {
            const upstream = repository.branchTracking[branch]?.upstream ?? ''
            const choice = upstreamChoice[branch] ?? upstream
            return <div className="tag-row" key={branch}>
              <span className="structure-icon"><GitBranch size={15}/></span>
              <span>
                <strong>{branch}</strong>
                <small>{upstream ? `跟踪 ${upstream} · 领先 ${repository.branchTracking[branch]?.ahead ?? 0} · 落后 ${repository.branchTracking[branch]?.behind ?? 0}` : t('repository.remote.noUpstream')}</small>
                {renaming?.branch === branch && <input className="branch-rename-input" autoFocus value={renaming.target} onChange={(event) => setRenaming({ branch, target: event.target.value })} placeholder={t('repository.remote.newBranchName')}/>}
              </span>
              {candidates.length > 0
                ? <CompactSelect className="upstream-select" value={choice} options={[{ value: '', label: t('repository.remote.untracked') }, ...candidates.map((item) => ({ value: item, label: item }))]} onChange={(value) => setUpstreamChoice((current) => ({ ...current, [branch]: value }))} ariaLabel={`选择 ${branch} 的上游分支`}/>
                : <span className="tag-row-risk">{t('repository.remote.noRemoteBranchOptions')}</span>}
              <span className="branch-upstream-actions">
                <Button variant="secondary" size="compact" disabled={busy !== null} onClick={() => void guard(`upstream:${branch}`, (confirmFlag) => setRepositoryBranchUpstream(repository.path, branch, choice.trim() || null), t('repository.remote.setUpstream'), `已更新 ${branch} 的上游跟踪`)}>{choice.trim() ? t('repository.remote.setUnterminatedUpstream') : t('repository.remote.clearUpstream')}</Button>
                {renaming?.branch === branch
                  ? <Button variant="primary" size="compact" disabled={busy !== null} onClick={() => submitBranchRename(branch)}>{t('repository.remote.rename')}</Button>
                  : <Button variant="secondary" size="compact" disabled={busy !== null} onClick={() => setRenaming({ branch, target: branch })}>{t('repository.remote.renameShort')}</Button>}
              </span>
            </div>
          })}
        </div>
      </article>
    </div>
    {confirmDialog}
  </section>
}
