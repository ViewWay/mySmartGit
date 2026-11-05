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

const modeLabels: Record<EditMode, string> = { rename: '重命名远程', fetch: '改 fetch 地址', push: '改 push 地址' }

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

  if (!repository) return <section className="workspace-empty"><Cloud size={34}/><strong>远程管理</strong><span>请先打开本地仓库，再配置远程与标签。</span></section>

  const guard = async (key: string, action: (confirmFlag: boolean) => Promise<RemoteOperationReport>, title: string, done: string) => {
    setBusy(key)
    applyReport(await run(action, title, done))
    setBusy(null)
    setEditing(null)
  }

  const submitAdd = () => {
    const name = newName.trim()
    const url = newUrl.trim()
    if (!name || !url) { onNotice('请填写远程名称与地址'); return }
    // 添加远程不是破坏性动作，后端一次调用即执行，不需要 confirm 轮次。
    void guard('add', () => addRepositoryRemote(repository.path, name, url, fetchNow), '添加远程', `已添加远程：${name}`)
      .then(() => { setAdding(false); setNewName(''); setNewUrl('') })
  }

  const submitEdit = (remote: RepositoryRemoteDetail) => {
    if (!editing) return
    const value = draft.trim()
    if (!value) { onNotice('名称或地址不能为空'); return }
    if (editing.mode === 'rename') {
      if (value === remote.name) { onNotice('新旧远程名称相同'); return }
      void guard(`rename:${remote.name}`, (confirmFlag) => renameRepositoryRemote(repository.path, remote.name, value, confirmFlag), '重命名远程', `已把远程重命名为 ${value}`)
      return
    }
    void guard(`url:${editing.mode}:${remote.name}`, (confirmFlag) => setRepositoryRemoteUrl(repository.path, remote.name, value, editing.mode === 'push', confirmFlag), modeLabels[editing.mode], `已更新 ${remote.name} 的 ${editing.mode} 地址`)
  }

  const submitBranchRename = (branch: string) => {
    const value = (renaming?.target ?? '').trim()
    if (!value) { onNotice('新分支名不能为空'); return }
    if (value === branch) { onNotice('新旧分支名相同'); return }
    void guard(`branch-rename:${branch}`, (confirmFlag) => renameRepositoryBranch(repository.path, branch, value, confirmFlag), '重命名本地分支', `已把 ${branch} 重命名为 ${value}`)
      .then(() => setRenaming(null))
  }

  return <section className="structure-panel workspace-page remote-panel-workspace">
    <div className="workspace-page-heading">
      <div><span className="eyebrow">远程与标签</span><h2>远程管理</h2><p>{`当前分支 ${repository.branch || '（游离 HEAD）'}；地址中的凭据在展示前已脱敏。`}</p></div>
      <div className="structure-actions">
        <Button variant="secondary" disabled={loading || busy !== null} onClick={() => void refresh()}><RefreshCw size={14} className={loading ? 'spin' : ''}/>{loading ? '读取中…' : '刷新'}</Button>
        <Button variant="primary" className="structure-heading-action" onClick={() => setAdding((value) => !value)}><Plus size={14}/>添加远程</Button>
      </div>
    </div>

    {adding && <div className="structure-detail-grid">
      <article className="structure-detail-card">
        <h3>新增远程</h3>
        <div className="branch-name-input"><input autoFocus placeholder="远程名称，例如 origin" value={newName} onChange={(event) => setNewName(event.target.value)}/></div>
        <div className="branch-name-input"><input placeholder="https://host/org/repo.git 或 git@host:org/repo.git" value={newUrl} onChange={(event) => setNewUrl(event.target.value)}/></div>
        <label className="auto-fetch-toggle"><span><strong>添加后立即 Fetch</strong><small>抓取失败只提示，不回滚已添加的远程</small></span><input type="checkbox" checked={fetchNow} onChange={(event) => setFetchNow(event.target.checked)}/><span className="toggle-track" aria-hidden="true"><span/></span></label>
        <div className="branch-dialog-hint">名称与地址会先经本地规则与 git check-ref-format 校验；以 - 开头或含空白、控制字符的输入一律拒绝。</div>
        <div className="structure-actions">
          <Button variant="primary" disabled={busy !== null} onClick={submitAdd}><Cloud size={14}/>{busy === 'add' ? '添加中…' : '添加远程'}</Button>
          <Button variant="secondary" onClick={() => { setAdding(false); setNewName(''); setNewUrl('') }}><X size={14}/>取消</Button>
        </div>
      </article>
    </div>}

    {remotes.length === 0 && !loading && <div className="workspace-hint"><Cloud size={26}/><strong>还没有远程仓库</strong><span>添加远程后才能推送标签、设置上游跟踪分支。</span></div>}

    {remotes.length > 0 && <div className="structure-detail-grid">
      {remotes.map((remote) => {
        // 先把 editing 按当前卡片收窄成模式，避免在 JSX 里反复判空。
        const editMode = editing && editing.remote === remote.name ? editing.mode : null
        return <article className="structure-detail-card" key={remote.name}>
        <span className="structure-icon"><Cloud size={18}/></span>
        <h3>{remote.name}</h3>
        <dl>
          <DetailField label="Fetch 地址"><code>{fetchUrlText(remote)}</code></DetailField>
          <DetailField label="Push 地址"><code>{pushUrlText(remote)}</code></DetailField>
          <DetailField label="抓取引用规格">{remote.fetchRefspecs.length ? <code>{remote.fetchRefspecs.join(' ')}</code> : '未配置（不会自动更新远程引用）'}</DetailField>
          <DetailField label="推送引用规格">{remote.pushRefspecs.length ? <code>{remote.pushRefspecs.join(' ')}</code> : '默认按 refspec 推送'}</DetailField>
          <DetailField label="远端 HEAD">{remote.headBranch ?? '未知（执行一次 Fetch 可自动识别）'}</DetailField>
          <DetailField label="本地缓存远程分支">{remote.cachedBranchCount}</DetailField>
          <DetailField label="跟踪该远程的本地分支">{remote.trackingBranches.length ? remote.trackingBranches.join('、') : '无'}</DetailField>
          {remote.credentialsRedacted && <DetailField label="凭据提示"><span className="tag-row-risk">URL 内嵌凭据，已显示为 [redacted]；建议改用凭据管理器或 SSH</span></DetailField>}
        </dl>
        <div className="structure-actions">
          {(['rename', 'fetch', 'push'] as EditMode[]).map((mode) => <Button key={mode} variant="secondary" disabled={busy !== null} onClick={() => { setEditing({ remote: remote.name, mode }); setDraft(mode === 'rename' ? remote.name : mode === 'fetch' ? (remote.fetchUrls[0] ?? '') : (remote.pushUrls[0] ?? '')) }}><Pencil size={13}/>{modeLabels[mode]}</Button>)}
          <Button variant="danger" disabled={busy !== null} onClick={() => void guard(`remove:${remote.name}`, (confirmFlag) => removeRepositoryRemote(repository.path, remote.name, confirmFlag), '删除远程', `已删除远程：${remote.name}`)}><Trash2 size={13}/>{busy === `remove:${remote.name}` ? '删除中…' : '删除远程'}</Button>
        </div>
        {editMode && <div className="structure-actions remote-edit-row">
          <div className="branch-name-input"><input autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={editMode === 'rename' ? '新的远程名称' : '新的地址'}/></div>
          <Button variant="primary" disabled={busy !== null} onClick={() => submitEdit(remote)}><Link2 size={14}/>提交</Button>
          <Button variant="secondary" onClick={() => setEditing(null)}>取消</Button>
          <span className="tag-row-risk">{modeLabels[editMode]}属于改动仓库去向的操作，提交后会先给出预览与警告。</span>
        </div>}
      </article>
      })}
    </div>}

    <div className="structure-detail-grid">
      <article className="structure-detail-card">
        <span className="structure-icon"><GitBranch size={18}/></span>
        <h3>本地分支与上游跟踪</h3>
        <div className="branch-dialog-hint">设置上游需要该远程分支已在本地缓存（先 Fetch）；这些操作不会改写远端分支。</div>
        {localBranches.length === 0 && <div className="workspace-hint"><GitBranch size={24}/><strong>没有本地分支</strong></div>}
        <div className="structure-list">
          {localBranches.map((branch) => {
            const upstream = repository.branchTracking[branch]?.upstream ?? ''
            const choice = upstreamChoice[branch] ?? upstream
            return <div className="tag-row" key={branch}>
              <span className="structure-icon"><GitBranch size={15}/></span>
              <span>
                <strong>{branch}</strong>
                <small>{upstream ? `跟踪 ${upstream} · 领先 ${repository.branchTracking[branch]?.ahead ?? 0} · 落后 ${repository.branchTracking[branch]?.behind ?? 0}` : '未设置上游跟踪'}</small>
                {renaming?.branch === branch && <input className="branch-rename-input" autoFocus value={renaming.target} onChange={(event) => setRenaming({ branch, target: event.target.value })} placeholder="新的分支名"/>}
              </span>
              {candidates.length > 0
                ? <CompactSelect className="upstream-select" value={choice} options={[{ value: '', label: '不跟踪' }, ...candidates.map((item) => ({ value: item, label: item }))]} onChange={(value) => setUpstreamChoice((current) => ({ ...current, [branch]: value }))} ariaLabel={`选择 ${branch} 的上游分支`}/>
                : <span className="tag-row-risk">无可选远程分支</span>}
              <span className="branch-upstream-actions">
                <Button variant="secondary" size="compact" disabled={busy !== null} onClick={() => void guard(`upstream:${branch}`, (confirmFlag) => setRepositoryBranchUpstream(repository.path, branch, choice.trim() || null), '设置上游跟踪', `已更新 ${branch} 的上游跟踪`)}>{choice.trim() ? '设置上游' : '清除上游'}</Button>
                {renaming?.branch === branch
                  ? <Button variant="primary" size="compact" disabled={busy !== null} onClick={() => submitBranchRename(branch)}>重命名</Button>
                  : <Button variant="secondary" size="compact" disabled={busy !== null} onClick={() => setRenaming({ branch, target: branch })}>改名</Button>}
              </span>
            </div>
          })}
        </div>
      </article>
    </div>
    {confirmDialog}
  </section>
}
