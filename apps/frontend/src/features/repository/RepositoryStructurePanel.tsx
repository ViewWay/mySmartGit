import { useState } from 'react'
import { Box, Check, FolderGit2, GitFork, Lock, LockOpen, Plus, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import {
  addRepositorySubmodule,
  createRepositoryWorktree,
  deinitializeRepositorySubmodule,
  initializeRepositorySubmodule,
  pruneRepositoryWorktrees,
  removeRepositoryWorktree,
  setRepositoryWorktreeLock,
  syncRepositorySubmodules,
  updateRepositorySubmodule,
  type RepositorySnapshot,
} from '../../repository'
import { CreateWorktreeDialog } from './CreateWorktreeDialog'
import { SubmoduleAddDialog } from './SubmoduleAddDialog'
import { SubmodulePointerDiffPanel } from './SubmodulePointerDiffPanel'
import { TagManagementPanel } from '../remote/TagManagementPanel'
import { needsSubmoduleConfirmation, submoduleConfirmationText, type SubmoduleAddDraft } from './submoduleAddForm'
import { submoduleAbsolutePath, type RepositoryStructureSelection } from './repositoryTree'
import { Button } from '../../components/Button'
import { useConfirmDialog } from '../../components/ConfirmDialog'
import { useI18n } from '../../i18n'

export type StructureView = 'structure' | 'tags'

const statusKeys: Record<string, string> = { ok: 'repository.structure.statusOk', modified: 'repository.structure.statusModified', uninitialized: 'repository.structure.statusUninitialized', missing: 'repository.structure.statusMissing' }
const samePath = (left: string, right: string | null | undefined) => Boolean(right) && left.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() === right!.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>
}

export function RepositoryStructurePanel({ repository, activePath, view, query = '', selection, onOpenPath, onOpenTag, onSnapshot, onNotice }: {
  repository: RepositorySnapshot | null
  // The repository currently open in the workspace, which can differ from the structure repository.
  activePath: string | null
  view: StructureView
  query?: string
  selection: RepositoryStructureSelection
  onOpenPath: (path: string, kind: 'worktree' | 'submodule') => void
  onOpenTag: (tag: string) => void
  onSnapshot: (snapshot: RepositorySnapshot) => void
  onNotice: (message: string) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [addBusy, setAddBusy] = useState(false)
  const { t } = useI18n()
  const statusLabels = (status: string) => t(statusKeys[status] ?? 'repository.details.statusUnknown')
  const { confirm, confirmDialog } = useConfirmDialog()
  if (!repository) return <section className="workspace-empty"><FolderGit2 size={34}/><strong>{t('repository.tree.title')}</strong><span>{t('repository.structure.openFirst')}</span></section>

  const normalizedQuery = query.trim().toLocaleLowerCase()
  // 标签页已升级为完整的管理面板（明细 + 注释/签名标签 + 推送与删除），
  // 仍然沿用同一入口与同一套仓库快照/通知回调，不改动其他视图。
  if (view === 'tags') return <TagManagementPanel repository={repository} query={normalizedQuery} onOpenTag={onOpenTag} onSnapshot={onSnapshot} onNotice={onNotice}/>

  const run = async (key: string, action: () => Promise<RepositorySnapshot>, notice: string) => {
    setBusy(key)
    try {
      const snapshot = await action()
      onSnapshot(snapshot)
      onNotice(notice)
      return true
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setBusy(null)
    }
  }
  const worktree = selection.kind === 'worktree' ? repository.worktrees.find((item) => samePath(item.path, selection.path)) : undefined
  const submodule = selection.kind === 'submodule' ? repository.submodules.find((item) => item.path.replace(/\\/g, '/') === selection.path.replace(/\\/g, '/')) : undefined
  const folderSubmodules = selection.kind === 'submodule-folder' ? repository.submodules.filter((item) => item.path.replace(/\\/g, '/').startsWith(`${selection.path.replace(/\\/g, '/')}/`)) : []
  const currentWorktree = worktree ? samePath(worktree.path, activePath ?? repository.path) : false
  // Git refuses to lock or remove the main worktree, so those actions stay disabled for it.
  const primaryWorktree = worktree ? samePath(worktree.path, repository.path) : false
  const currentSubmodule = submodule ? samePath(submoduleAbsolutePath(repository.path, submodule.path), activePath) : false
  const availableSubmodule = submodule && submodule.status !== 'uninitialized' && submodule.status !== 'missing'
  const title = selection.kind === 'worktrees' ? 'Worktrees' : selection.kind === 'worktree' ? (worktree?.path.split(/[\\/]/).pop() || 'Worktree') : selection.kind === 'submodules' ? 'Submodules' : selection.kind === 'submodule-folder' ? selection.path : selection.kind === 'submodule' ? (submodule?.path || 'Submodule') : repository.name
  const description = selection.kind === 'worktrees' ? t('repository.structure.worktreesDescription') : selection.kind === 'submodules' ? t('repository.structure.submodulesDescription') : selection.kind === 'worktree' ? t('repository.structure.worktreeDescription') : selection.kind === 'submodule' ? t('repository.structure.submoduleDescription') : selection.kind === 'submodule-folder' ? t('repository.structure.folderDescription') : t('repository.structure.rootDescription')
  const removeWorktree = async (path: string) => {
    if (await confirm({ title: t('repository.structure.removeWorktreeTitle'), message: t('repository.structure.removeWorktreeMessage', { path }), confirmLabel: t('repository.structure.remove'), variant: 'danger' })) await run('remove', () => removeRepositoryWorktree(repository.path, path), t('repository.structure.worktreeRemoved'))
  }
  const deinitializeSubmodule = async (path: string) => {
    if (await confirm({ title: t('repository.structure.deinitTitle'), message: t('repository.structure.deinitMessage', { path }), confirmLabel: t('repository.structure.deinit'), variant: 'danger' })) await run('deinit', () => deinitializeRepositorySubmodule(repository.path, path), t('repository.structure.deinitDone'))
  }
  // 添加子模块沿用「预览 → 二次确认 → 执行」约定：confirm=false 时后端未改动仓库，
  // 收养已存在目录需要用户显式确认后才带 confirm=true 再调一次。返回 true 让对话框关闭。
  const submitAddSubmodule = async (draft: SubmoduleAddDraft): Promise<boolean> => {
    setAddBusy(true)
    try {
      const call = (confirmFlag: boolean) => addRepositorySubmodule(
        repository.path,
        draft.url,
        draft.path || null,
        draft.name || null,
        draft.branch || null,
        confirmFlag,
      )
      let report = await call(false)
      if (needsSubmoduleConfirmation(report)) {
        if (!await confirm({ title: t('repository.structure.addConfirmTitle'), message: submoduleConfirmationText(report, t), confirmLabel: t('repository.structure.addAnyway'), variant: 'danger' })) return false
        report = await call(true)
      }
      if (report.snapshot) onSnapshot(report.snapshot)
      onNotice(report.summary)
      return report.executed
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setAddBusy(false)
    }
  }

  return <section className="structure-panel workspace-page repository-structure-workspace">
    <div className="workspace-page-heading"><div><span className="eyebrow">{t('repository.tree.title')}</span><h2>{title}</h2><p>{description}</p></div>{selection.kind === 'worktrees' && <Button variant="primary" className="structure-heading-action" onClick={() => setCreateOpen(true)}><Plus size={14}/>{t('repository.worktree.create')}</Button>}</div>

    {selection.kind === 'root' && <div className="structure-detail-grid">
      <article className="structure-detail-card"><span className="structure-icon"><FolderGit2 size={18}/></span><h3>{repository.name}</h3><dl><DetailField label={t('repository.structure.path')}><code>{repository.path}</code></DetailField><DetailField label={t('repository.structure.currentBranch')}><strong>{repository.branch}</strong></DetailField><DetailField label="Worktrees">{repository.worktreeCount}</DetailField><DetailField label="Submodules">{repository.submoduleCount}</DetailField><DetailField label={t('repository.structure.syncStatus')}>{t('repository.structure.aheadBehind', { ahead: repository.ahead ?? 0, behind: repository.behind ?? 0 })}</DetailField></dl></article>
      <article className="structure-summary-card"><h3>{t('repository.structure.summary')}</h3><div><span>{t('repository.structure.worktreeChanges')}</span><strong>{repository.files.length}</strong></div><div><span>{t('repository.structure.lockedWorktrees')}</span><strong>{repository.worktrees.filter((item) => item.locked).length}</strong></div><div><span>{t('repository.structure.brokenSubmodules')}</span><strong>{repository.submodules.filter((item) => item.status !== 'ok').length}</strong></div></article>
    </div>}

    {selection.kind === 'worktrees' && <div className="structure-detail-grid">
      <article className="structure-detail-card"><span className="structure-icon"><GitFork size={18}/></span><h3>Worktrees</h3><dl><DetailField label={t('repository.structure.total')}>{repository.worktrees.length}</DetailField><DetailField label="Detached">{repository.worktrees.filter((item) => !item.branch).length}</DetailField><DetailField label={t('repository.structure.locked')}>{repository.worktrees.filter((item) => item.locked).length}</DetailField><DetailField label={t('repository.structure.prunable')}>{repository.worktrees.filter((item) => item.prunable).length}</DetailField></dl><div className="structure-actions"><Button variant="primary" onClick={() => setCreateOpen(true)}><Plus size={14}/>{t('repository.worktree.create')}</Button><Button variant="secondary" disabled={busy !== null} onClick={() => void run('prune', () => pruneRepositoryWorktrees(repository.path), t('repository.structure.pruneDone'))}><RotateCcw size={14}/>{busy === 'prune' ? t('repository.structure.pruning') : 'Prune'}</Button></div></article>
    </div>}

    {selection.kind === 'worktree' && worktree && <div className="structure-detail-grid"><article className="structure-detail-card"><span className="structure-icon"><GitFork size={18}/></span><h3>{worktree.path.split(/[\\/]/).pop() || worktree.path}</h3><dl><DetailField label={t('repository.structure.directory')}><code>{worktree.path}</code></DetailField><DetailField label={t('repository.structure.branchLabel')}>{worktree.branch ?? 'Detached HEAD'}</DetailField><DetailField label="HEAD"><code>{worktree.head ?? '—'}</code></DetailField><DetailField label={t('repository.structure.statusLabel')}>{currentWorktree ? t('repository.tree.currentWorktree') : worktree.locked ? t('repository.structure.lockedReason', { reason: worktree.locked }) : worktree.prunable ? t('repository.structure.prunableReason', { reason: worktree.prunable }) : primaryWorktree ? t('repository.structure.primaryWorktree') : t('repository.structure.available')}</DetailField></dl><div className="structure-actions"><Button variant="primary" disabled={currentWorktree} onClick={() => onOpenPath(worktree.path, 'worktree')}><FolderGit2 size={14}/>{currentWorktree ? t('repository.tree.currentRepository') : t('repository.details.open')}</Button><Button variant="secondary" disabled={busy !== null || currentWorktree || primaryWorktree} onClick={() => void run('lock', () => setRepositoryWorktreeLock(repository.path, worktree.path, !worktree.locked), worktree.locked ? t('repository.structure.unlocked') : t('repository.structure.lockedDone'))}>{worktree.locked ? <LockOpen size={14}/> : <Lock size={14}/>} {worktree.locked ? t('repository.structure.unlock') : t('repository.structure.lock')}</Button><Button variant="danger" disabled={busy !== null || currentWorktree || primaryWorktree} onClick={() => void removeWorktree(worktree.path)}><Trash2 size={14}/>{t('repository.structure.remove')}</Button></div></article></div>}

    {(selection.kind === 'submodules' || selection.kind === 'submodule-folder') && <div className="structure-detail-grid"><article className="structure-detail-card"><span className="structure-icon"><Box size={18}/></span><h3>{selection.kind === 'submodules' ? 'Submodules' : selection.path}</h3><dl><DetailField label={t('repository.structure.total')}>{selection.kind === 'submodules' ? repository.submodules.length : folderSubmodules.length}</DetailField><DetailField label={t('repository.structure.statusOk')}>{(selection.kind === 'submodules' ? repository.submodules : folderSubmodules).filter((item) => item.status === 'ok').length}</DetailField><DetailField label={t('repository.structure.statusModified')}>{(selection.kind === 'submodules' ? repository.submodules : folderSubmodules).filter((item) => item.status === 'modified').length}</DetailField><DetailField label={t('repository.structure.uninitOrMissing')}>{(selection.kind === 'submodules' ? repository.submodules : folderSubmodules).filter((item) => item.status === 'uninitialized' || item.status === 'missing').length}</DetailField></dl><div className="structure-actions"><Button variant="primary" disabled={busy !== null} onClick={() => void run('update-all', () => updateRepositorySubmodule(repository.path), t('repository.structure.updateAllDone'))}><RefreshCw className={busy === 'update-all' ? 'spin' : ''} size={14}/>{busy === 'update-all' ? t('repository.structure.updating') : t('repository.structure.recursiveUpdate')}</Button><Button variant="secondary" disabled={busy !== null} onClick={() => void run('sync', () => syncRepositorySubmodules(repository.path), t('repository.structure.syncDone'))}><RotateCcw size={14}/>{t('repository.structure.syncUrls')}</Button><Button variant="primary" disabled={busy !== null} onClick={() => setAddOpen(true)}><Plus size={14}/>{t('repository.structure.addSubmodule')}</Button></div></article></div>}

    {selection.kind === 'submodule' && submodule && <div className="structure-detail-grid"><article className="structure-detail-card"><span className="structure-icon"><Box size={18}/></span><h3>{submodule.path}</h3><dl><DetailField label={t('repository.structure.relativePath')}><code>{submodule.path}</code></DetailField><DetailField label={t('repository.structure.absolutePath')}><code>{submoduleAbsolutePath(repository.path, submodule.path)}</code></DetailField><DetailField label={t('repository.structure.recordedCommit')}><code>{submodule.hash}</code></DetailField><DetailField label={t('repository.structure.trackedBranch')}>{submodule.branch ?? t('repository.structure.pinnedCommit')}</DetailField><DetailField label={t('repository.structure.statusLabel')}><strong>{currentSubmodule ? t('repository.tree.currentRepository') : statusLabels(submodule.status)}</strong></DetailField></dl><div className="structure-actions"><Button variant="primary" disabled={!availableSubmodule || currentSubmodule} onClick={() => onOpenPath(submoduleAbsolutePath(repository.path, submodule.path), 'submodule')}><FolderGit2 size={14}/>{currentSubmodule ? '当前仓库' : '打开仓库'}</Button>{(submodule.status === 'uninitialized' || submodule.status === 'missing') && <Button variant="secondary" disabled={busy !== null} onClick={() => void run('init', () => initializeRepositorySubmodule(repository.path, submodule.path), t('repository.structure.initDone'))}><Plus size={14}/>{t('repository.structure.init')}</Button>}<Button variant="secondary" disabled={busy !== null} onClick={() => void run('update', () => updateRepositorySubmodule(repository.path, submodule.path), t('repository.structure.updateDone'))}><RefreshCw className={busy === 'update' ? 'spin' : ''} size={14}/>{t('repository.structure.update')}</Button><Button variant="secondary" disabled={busy !== null} onClick={() => void run('sync', () => syncRepositorySubmodules(repository.path), t('repository.structure.syncDone'))}><RotateCcw size={14}/>{t('repository.structure.syncUrls')}</Button><Button variant="danger" disabled={busy !== null || submodule.status === 'uninitialized'} onClick={() => void deinitializeSubmodule(submodule.path)}><Trash2 size={14}/>{t('repository.structure.deinit')}</Button></div></article><SubmodulePointerDiffPanel repositoryPath={repository.path} submodulePath={submodule.path} onNotice={onNotice}/></div>}

    {((selection.kind === 'worktree' && !worktree) || (selection.kind === 'submodule' && !submodule)) && <div className="workspace-hint"><FolderGit2 size={26}/><strong>{t('repository.structure.staleTitle')}</strong><span>{t('repository.structure.staleHint')}</span></div>}
    {createOpen && (
      <CreateWorktreeDialog
        branches={repository.branches}
        busy={busy === 'create'}
        onClose={() => setCreateOpen(false)}
        onSubmit={async (path, branch, createBranch) => {
          if (await run('create', () => createRepositoryWorktree(repository.path, path, branch, createBranch), t('repository.structure.created', { path }))) setCreateOpen(false)
        }}
      />
    )}
    {addOpen && (
      <SubmoduleAddDialog
        submodules={repository.submodules}
        busy={addBusy}
        onClose={() => setAddOpen(false)}
        onSubmit={submitAddSubmodule}
      />
    )}
    {confirmDialog}
  </section>
}
