import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { abortRepositoryOperation, applyRepositoryStash, cancelRepositoryHistoryStream, cherryPickRepositoryCommit, continueRepositoryOperation, createRepositoryBranch, createRepositoryStash, createRepositoryTag, deleteBranchPrefix, deleteRepositoryBranch, dropRepositoryStash, isTauriRuntime, loadFileCommitDiff, loadImageFileDiff, loadGitUserConfig, loadRepository, loadRepositoryHistoryNextPage, loadRepositoryCommitFiles, loadRepositoryCommitStats, loadRepositoryFileDiff, loadRepositoryStashFileDiff, loadRepositoryStashFiles, mergeRepositoryReference, openRevisionFileExternally, previewBranchPrefix, pullRepositoryBranch, pushRepository, pushRepositoryWithLease, rebaseRepositoryOnto, resetRepositoryToCommit, revertRepositoryCommit, skipRepositoryOperation, startRepositoryHistoryStream, switchRepositoryBranch, undoLastCommit, type RepositoryCommitStats, type RepositoryFile, type RepositorySnapshot } from './repository'
import { ContextMenu } from './components/ContextMenu'
import { Button } from './components/Button'
import { CompactSelect } from './components/CompactSelect'
import { useConfirmDialog } from './components/ConfirmDialog'
import { useRepositoryWorkspace, type RecentRepository, type RepositoryParent } from './features/repository/useRepositoryWorkspace'
import { ForcePushDialog } from './features/repository/ForcePushDialog'
import { StagingPage } from './features/staging/StagingPage'
import { HistoryDrawer } from './features/history/HistoryDrawer'
import { DiffFileList } from './features/diff/DiffFileList'
import { DiffPanel } from './features/diff/DiffPanel'
import { ComparePanel } from './features/compare/ComparePanel'
import { CreateBranchDialog } from './features/branch/CreateBranchDialog'
import { GitConfigDialog } from './features/settings/GitConfigDialog'
import { CommandLogPanel } from './features/settings/CommandLogPanel'
import { MergeQueuePanel } from './features/merge/MergeQueuePanel'
import { RepositoryStructurePanel, type StructureView } from './features/repository/RepositoryStructurePanel'
import { RemotePanel } from './features/remote/RemotePanel'
import { RepositoryStructureTree } from './features/repository/RepositoryStructureTree'
import { RepositoryManagerPage } from './features/repository/RepositoryManagerPage'
import type { FavoriteRepository } from './features/repository/repositorySwitcher'
import { RepositoryQuickSwitcher } from './features/repository/RepositoryQuickSwitcher'
import { resolveRepositoryStructureSelection, type RepositoryStructureSelection } from './features/repository/repositoryTree'
import { isRepositoryDescendant, sameRepositoryPath } from './features/repository/repositoryPaths'
import { StashPage } from './features/stash/StashPage'
import { RecoveryPage } from './features/recovery/RecoveryPage'
import { CommitTreeBrowser } from './features/tree/CommitTreeBrowser'
import { SearchPage } from './features/search/SearchPage'
import { SequenceEditor } from './features/history-edit/SequenceEditor'
import { LfsPanel } from './features/lfs/LfsPanel'
import { GitflowPanel } from './features/flow/GitflowPanel'
import { CredentialsPanel } from './features/credentials/CredentialsPanel'
import { HostingPanel } from './features/hosting/HostingPanel'
import { TerminalPanel } from './features/terminal/TerminalPanel'
import { PreferencesDialog, type PreferencesPage } from './features/preferences/PreferencesDialog'
import { useI18n } from './i18n'
import { buildMenuLabels, menuActionHandlers, menuRecentIndex } from './menu/menuBridge'
import { useNativeMenu, type NativeMenuState } from './menu/useNativeMenu'
import { setPreference, usePreferences, type ThemePreference } from './preferences'
import { RebaseDialog } from './features/operation/RebaseDialog'
import { CherryPickDialog } from './features/operation/CherryPickDialog'
import { buildCommitGraphLayout, lanePosition, type CommitGraphRow } from './features/graph/commitGraphLayout'
import { captureCommitAnchor, resolveCommitSelection, restoreCommitAnchor, type CommitViewportAnchor } from './features/history/historyRefresh'
import { trackedRemoteReference, visibleCommitReferences, type BranchTrackingMap } from './features/history/historyReferences'
import { matchingCommitIds, nextSearchMatch, retainUnchangedSearchSummary, visibleHistoryCommits, type HistorySearchMode, type HistorySearchSummary } from './features/history/historySearch'
import { createWorkingTreeCommit, resolveWorkingTreeParent, WORKING_TREE_COMMIT_ID } from './features/history/workingTreeCommit'
import { HISTORY_PAGE_SIZE, HISTORY_PREFETCH_ROWS } from './features/history/historyDepth'
import { formatLocalDateTime } from './dateTime'
import { isBooleanRecord, usePersistentState } from './persistentState'
import { DEFAULT_HISTORY_COLUMN_WIDTHS, DEFAULT_HISTORY_VISIBLE_COLUMNS, isHistoryColumnWidths, isHistoryVisibleColumns } from './features/history/historyColumns'
import { committerInitials, committerName, isHistoryCommitVisibleOnSelectedBranches, matchesCommitterFilter, reachableHistoryCommitIds, toggleFilterValue, unloadedHistoryBranches } from './features/history/historyFilters'
import { acquireOperationLock, releaseOperationLock } from './features/operation/operationLock'
import { useReviewThreads } from './features/review/useReviewThreads'
import {
  Archive,
  AlertTriangle,
  ArrowLeft,
  Bell,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleDot,
  Clock3,
  Cloud,
  CloudDownload,
  CloudUpload,
  Code2,
  Command,
  Copy,
  CornerDownLeft,
  Download,
  FileDiff,
  FileText,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitBranchPlus,
  GitCommitHorizontal,
  GitCompareArrows,
  GitFork,
  GitMerge,
  GitPullRequest,
  History,
  KeyRound,
  Languages,
  LayoutGrid,
  List,
  ListFilter,
  ListTodo,
  MoreHorizontal,
  PanelRightOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  RotateCcw,
  Rows3,
  Search,
  FolderTree,
  Settings2,
  SquareTerminal,
  Sun,
  Moon,
  Tag,
  TimerReset,
  TerminalSquare,
  Undo2,
  Trash2,
  Wrench,
  X,
} from 'lucide-react'

type Commit = {
  id: string
  fullHash?: string
  lane: number
  color: string
  title: string
  message?: string
  author: string
  email?: string
  committer?: string
  committerEmail?: string
  authorTime?: string
  commitTime?: string
  avatar: string
  time: string
  branches?: string[]
  status?: 'ahead' | 'merge' | 'local' | 'stash' | 'working'
  parent?: string
  parents?: string[]
  files: number
  additions: number
  deletions: number
}

type WorkspaceView = 'history' | 'changes' | 'stash' | 'recovery' | 'search' | 'tree' | 'compare' | 'merge' | 'operation' | 'remotes' | 'lfs' | 'gitflow' | 'credentials' | 'hosting' | 'terminal' | StructureView
type TimeFilter = 'all' | 'day' | 'week' | 'month'
type SearchNavigationAction = { sequence: number; direction: 1 | -1 }
type SearchSummary = HistorySearchSummary
type HistoryTarget = { path: string; tab: 'history' | 'blame' | 'line'; line?: number; revision?: string }
type ActiveOperation = { key: 'fetch' | 'pull' | 'push' | 'commit' | 'stash' | 'revert' | 'cherry-pick' | 'merge' | 'history'; label: string; detail: string }

// 流式历史只能尾部追加：快照里的前 N 条 + 流会话续取的更早提交，按 fullHash 去重，
// 保持“整列是全量 log 序列的前缀”，提交图谱的跨页 lane 才不会被重排。
function mergeHistoryStreamCommits(base: Commit[], extra: Commit[]) {
  if (!extra.length) return base
  const known = new Set(base.map((commit) => commit.fullHash ?? commit.id))
  return [...base, ...extra.filter((commit) => !known.has(commit.fullHash ?? commit.id))]
}

const nextThemePreference: Record<ThemePreference, ThemePreference> = { light: 'dark', dark: 'system', system: 'light' }

const subscribePrefersDark = (listener: () => void) => {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}
const prefersDarkSnapshot = () => window.matchMedia('(prefers-color-scheme: dark)').matches

const isSidebarWidth = (value: unknown): value is number => typeof value === 'number' && value >= 200 && value <= 360
const isInspectorWidth = (value: unknown): value is number => typeof value === 'number' && value >= 300 && value <= 520
const isDetailsHeight = (value: unknown): value is number => typeof value === 'number' && value >= 230 && value <= 560
const isFileMode = (value: unknown): value is 'list' | 'tree' => value === 'list' || value === 'tree'
const isDetailsTab = (value: unknown): value is 'diff' | 'tree' => value === 'diff' || value === 'tree'
const isSidebarGroups = (value: unknown): value is { stash: boolean; tags: boolean } =>
  typeof value === 'object' && value !== null && 'stash' in value && 'tags' in value &&
  typeof (value as { stash: unknown }).stash === 'boolean' && typeof (value as { tags: unknown }).tags === 'boolean'

const OperationPanel = lazy(async () => ({ default: (await import('./features/operation/OperationPanel')).OperationPanel }))

function AppMark({ className }: { className?: string }) {
  return <img className={className} src="/app-icon.svg" alt="" aria-hidden="true"/>
}

const emptyCommit: Omit<Commit, 'title'> = {
  id: '—', lane: 0, color: '#70d9d2', author: 'Git', avatar: 'GT', time: '—', files: 0, additions: 0, deletions: 0,
}

function formatCommitClipboard(commit: Commit, t: (key: string, params?: Record<string, string | number>) => string) {
  const metadata = [
    t('history.clipboard.hash', { hash: commit.fullHash ?? commit.id }),
    t('history.clipboard.parent', { parents: commit.parents?.join(', ') || commit.parent || '—' }),
    t('history.clipboard.author', { author: `${commit.author}${commit.email ? ` <${commit.email}>` : ''}` }),
    t('history.clipboard.committer', { committer: `${commit.committer ?? commit.author}${commit.committerEmail ? ` <${commit.committerEmail}>` : ''}` }),
    t('history.clipboard.date', { date: formatLocalDateTime(commit.commitTime ?? commit.time) }),
  ].filter(Boolean).join('\n')
  return `${metadata}\n\n${commit.message ?? commit.title}`
}

function commitTimestamp(commit: Commit) {
  const value = commit.commitTime ?? commit.authorTime ?? commit.time
  const parsed = Date.parse(value)
  if (!Number.isNaN(parsed)) return parsed
  const now = new Date()
  if (value === '刚刚') return now.getTime() // i18n-allow 后端相对时间解析
  const minutes = value.match(/(\d+)\s*分钟前/) // i18n-allow 后端相对时间解析
  if (minutes) return now.getTime() - Number(minutes[1]) * 60_000
  const today = value.match(/今天\s*(\d{1,2}):(\d{2})/) // i18n-allow 后端相对时间解析
  if (today) return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(today[1]), Number(today[2])).getTime()
  const yesterday = value.match(/昨天\s*(\d{1,2}):(\d{2})/) // i18n-allow 后端相对时间解析
  if (yesterday) return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, Number(yesterday[1]), Number(yesterday[2])).getTime()
  const monthDay = value.match(/(\d{1,2})月(\d{1,2})日/) // i18n-allow 后端相对时间解析
  if (monthDay) return new Date(now.getFullYear(), Number(monthDay[1]) - 1, Number(monthDay[2])).getTime()
  return null
}

function formatCommitListTime(commit: Commit) {
  const timestamp = commitTimestamp(commit)
  if (timestamp === null) return commit.time
  const value = new Date(timestamp)
  const pad = (part: number) => String(part).padStart(2, '0')
  const date = `${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
  const time = `${pad(value.getHours())}:${pad(value.getMinutes())}`
  return value.getFullYear() === new Date().getFullYear() ? `${date} ${time}` : `${value.getFullYear()}-${date} ${time}`
}

function BranchTree({ branches, remoteBranches = [], branchTracking = {}, worktreeBranches = {}, currentBranch, onCreateBranch, onDeletePrefix, onJumpBranch, onSwitchBranch, onPullBranch, onMergeBranch, onDeleteBranch, onCopyBranch }: { branches: string[]; remoteBranches?: string[]; branchTracking?: Record<string, { upstream?: string; ahead: number; behind: number }>; worktreeBranches?: Record<string, string>; currentBranch?: string; onCreateBranch: (prefix?: string) => void; onDeletePrefix: (prefix: string) => void; onJumpBranch: (branch: string) => void; onSwitchBranch: (branch: string) => void; onPullBranch: (branch: string) => void; onMergeBranch: (branch: string) => void; onDeleteBranch: (branch: string) => void; onCopyBranch: (branch: string) => void }) {
  const { t } = useI18n()
  const [open, setOpen] = usePersistentState('branchline.branchTreeOpen.v1', { local: true, feat: true, fix: true, remote: false }, isBooleanRecord)
  const [contextBranch, setContextBranch] = useState<{ branch: string; x: number; y: number } | null>(null)
  const [contextPrefix, setContextPrefix] = useState<{ prefix: string; x: number; y: number } | null>(null)
  const toggle = (key: string) => setOpen((value) => ({ ...value, [key]: !value[key] }))
  const openContextMenu = (event: React.MouseEvent, branch: string) => {
    event.preventDefault()
    event.stopPropagation()
    setContextPrefix(null)
    setContextBranch({ branch, x: event.clientX, y: event.clientY })
  }
  const openPrefixMenu = (event: React.MouseEvent, prefix: string) => {
    event.preventDefault()
    event.stopPropagation()
    setContextBranch(null)
    setContextPrefix({ prefix, x: event.clientX, y: event.clientY })
  }
  const remoteBranchSet = new Set(remoteBranches)
  const incomingBadge = (branch: string) => {
    const count = branchTracking[branch]?.behind ?? 0
    return count > 0 ? <span className="branch-sync" title={t('repository.branch.unpulledTitle', { branch, count })} aria-label={t('repository.branch.unpulledCount', { count })}>↓{count}</span> : null
  }
  const branchNames = branches.filter((branch) => !remoteBranchSet.has(branch))
  const grouped = branchNames.reduce<Record<string, string[]>>((groups, branch) => {
    const [prefix, ...rest] = branch.split('/')
    const key = rest.length ? prefix : ''
    const value = rest.length ? rest.join('/') : branch
    groups[key] = [...(groups[key] ?? []), value]
    return groups
  }, {})
  const remoteGroups = remoteBranches.reduce<Record<string, string[]>>((groups, branch) => {
    const [remote, ...nameParts] = branch.split('/')
    if (!remote || !nameParts.length) return groups
    groups[remote] = [...(groups[remote] ?? []), nameParts.join('/')]
    return groups
  }, {})
  return <div className="nav-section branch-tree">
    <div className="section-title"><span>{t('repository.branch.title')}</span><button className="section-add" onClick={() => onCreateBranch()} title={t('repository.branch.create')}><Plus size={14}/></button></div>
    <button className="tree-row group" onClick={() => toggle('local')}>{open.local ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}<GitBranch size={14}/><span>{t('repository.branch.local')}</span><span className="count">{branchNames.length}</span></button>
    {open.local && <div className="tree-children">
      {(grouped[''] ?? []).map((branch) => <button className={`tree-row ${branch === currentBranch ? 'active' : ''}`} key={branch} onClick={() => onJumpBranch(branch)} onDoubleClick={() => onSwitchBranch(branch)} onContextMenu={(event) => openContextMenu(event, branch)} title={branch}><span className="tree-spacer"/><CircleDot size={12}/><span>{branch}</span>{worktreeBranches[branch] && <span className="branch-worktree" title={t('repository.branch.worktree', { path: worktreeBranches[branch] })} aria-label={t('repository.branch.worktree', { path: worktreeBranches[branch] })}><GitFork size={12}/></span>}{incomingBadge(branch)}</button>)}
      {Object.entries(grouped).filter(([prefix]) => prefix).map(([prefix, children]) => <div key={prefix}><button className="tree-row group nested" onClick={() => toggle(prefix)} onContextMenu={(event) => openPrefixMenu(event, prefix)} title={t('repository.branch.groupHint')}>{open[prefix] ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}<FolderGit2 size={13}/><span>{prefix}</span><span className="count">{children.length}</span></button>{open[prefix] && <div className="tree-children compact">{children.map((branch) => { const fullBranch = `${prefix}/${branch}`; return <button className={`tree-row ${fullBranch === currentBranch ? 'active' : ''}`} key={fullBranch} onClick={() => onJumpBranch(fullBranch)} onDoubleClick={() => onSwitchBranch(fullBranch)} onContextMenu={(event) => openContextMenu(event, fullBranch)}><span className="tree-spacer"/><GitBranch size={12}/><span>{branch}</span>{worktreeBranches[fullBranch] && <span className="branch-worktree" title={t('repository.branch.worktree', { path: worktreeBranches[fullBranch] })} aria-label={t('repository.branch.worktree', { path: worktreeBranches[fullBranch] })}><GitFork size={12}/></span>}{incomingBadge(fullBranch)}</button> })}</div>}</div>)}
    </div>}
    <button className="tree-row group" onClick={() => toggle('remote')}>{open.remote ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}<CloudDownload size={14}/><span>{t('repository.branch.remote')}</span><span className="count">{remoteBranches.length}</span></button>
    {open.remote && <div className="tree-children remote-tree">{Object.entries(remoteGroups).map(([remote, remoteBranchNames]) => {
      const remoteKey = `remote:${remote}`
      const groupedRemoteBranches = remoteBranchNames.reduce<Record<string, string[]>>((groups, branch) => {
        const [prefix, ...rest] = branch.split('/')
        const key = rest.length ? prefix : ''
        groups[key] = [...(groups[key] ?? []), rest.length ? rest.join('/') : branch]
        return groups
      }, {})
      return <div key={remote}><button className="tree-row group nested remote-root" onClick={() => toggle(remoteKey)}>{open[remoteKey] ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}<CloudDownload size={13}/><span>{remote}</span><span className="count">{remoteBranchNames.length}</span></button>{open[remoteKey] && <div className="tree-children compact remote-children">
        {(groupedRemoteBranches[''] ?? []).map((branch) => { const fullBranch = `${remote}/${branch}`; return <button className="tree-row" key={fullBranch} onClick={() => onJumpBranch(fullBranch)} onDoubleClick={() => onSwitchBranch(fullBranch)} onContextMenu={(event) => openContextMenu(event, fullBranch)} title={fullBranch}><span className="tree-spacer"/><GitBranch size={12}/><span>{branch}</span></button> })}
        {Object.entries(groupedRemoteBranches).filter(([prefix]) => prefix).map(([prefix, children]) => { const prefixKey = `${remoteKey}:${prefix}`; return <div key={prefix}><button className="tree-row group remote-prefix" onClick={() => toggle(prefixKey)}>{open[prefixKey] ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}<FolderGit2 size={12}/><span>{prefix}</span><span className="count">{children.length}</span></button>{open[prefixKey] && <div className="tree-children compact remote-prefix-children">{children.map((branch) => { const fullBranch = `${remote}/${prefix}/${branch}`; return <button className="tree-row" key={fullBranch} onClick={() => onJumpBranch(fullBranch)} onDoubleClick={() => onSwitchBranch(fullBranch)} onContextMenu={(event) => openContextMenu(event, fullBranch)}><span className="tree-spacer"/><GitBranch size={12}/><span>{branch}</span></button> })}</div>}</div> })}
      </div>}</div>
    })}</div>}
    {contextBranch && <ContextMenu x={contextBranch.x} y={contextBranch.y} onClose={() => setContextBranch(null)}>
      <div className="context-menu-title"><GitBranch size={13}/><span>{contextBranch.branch}</span></div>
      <button onClick={() => { onPullBranch(contextBranch.branch); setContextBranch(null) }}><RefreshCw size={14}/><span>{t('repository.branch.pull')}</span></button>
      <button onClick={() => { onMergeBranch(contextBranch.branch); setContextBranch(null) }} disabled={contextBranch.branch === currentBranch}><GitMerge size={14}/><span>{t('repository.branch.mergeInto', { branch: currentBranch ?? t('repository.branch.current') })}</span></button>
      <div className="context-menu-separator"/>
      <button onClick={() => { onCopyBranch(contextBranch.branch); setContextBranch(null) }}><Copy size={14}/><span>{t('repository.branch.copyName')}</span></button>
      <Button variant="danger" onClick={() => { onDeleteBranch(contextBranch.branch); setContextBranch(null) }} disabled={contextBranch.branch === currentBranch}><Trash2 size={14}/><span>{t('repository.branch.delete')}</span></Button>
    </ContextMenu>}
    {contextPrefix && <ContextMenu x={contextPrefix.x} y={contextPrefix.y} onClose={() => setContextPrefix(null)}>
      <div className="context-menu-title"><FolderGit2 size={13}/><span>{t('repository.branch.groupTitle', { prefix: contextPrefix.prefix })}</span></div>
      <button onClick={() => { toggle(contextPrefix.prefix); setContextPrefix(null) }}>{open[contextPrefix.prefix] ? <ChevronRight size={14}/> : <ChevronDown size={14}/>}<span>{open[contextPrefix.prefix] ? t('repository.branch.collapseGroup') : t('repository.branch.expandGroup')}</span></button>
      <button onClick={() => { onCreateBranch(contextPrefix.prefix); setContextPrefix(null) }}><Plus size={14}/><span>{t('repository.branch.createInGroup')}</span></button>
      <button onClick={() => { onCopyBranch(`${contextPrefix.prefix}/`); setContextPrefix(null) }}><Copy size={14}/><span>{t('repository.branch.copyPrefix')}</span></button>
      <div className="context-menu-separator"/>
      <Button variant="danger" onClick={() => { onDeletePrefix(contextPrefix.prefix); setContextPrefix(null) }}><Trash2 size={14}/><span>{t('repository.branch.deleteGroup')}</span></Button>
    </ContextMenu>}
  </div>
}

type SidebarProps = {
  repository: RepositorySnapshot | null
  structureRepository: RepositorySnapshot | null
  parentRepository: RepositoryParent | null
  recentRepositories: RecentRepository[]
  openingRepository: boolean
  favorites: FavoriteRepository[]
  onToggleFavorite: (repository: FavoriteRepository) => void
  onManageRepositories: () => void
  structureSelection: RepositoryStructureSelection
  repositorySwitcherSignal: number
  onOpenRepository: () => void
  onOpenRepositoryPath: (path: string) => void
  onOpenSubmodulePath: (path: string) => void
  onReturnToParentRepository: () => void
  onCreateBranch: (prefix?: string) => void
  onDeleteBranchPrefix: (prefix: string) => void
  onJumpBranch: (branch: string) => void
  onSwitchBranch: (branch: string) => void
  onPullBranch: (branch: string) => void
  onMergeBranch: (branch: string) => void
  onDeleteBranch: (branch: string) => void
  onCopyBranch: (branch: string) => void
  onSelectView: (view: WorkspaceView) => void
  onSelectStructure: (selection: RepositoryStructureSelection) => void
  onOpenGitConfig: () => void
  onOpenCommandLog: () => void
  onOpenUpdates: () => void
  onToggle: () => void
  sidebarGroups: { stash: boolean; tags: boolean }
  onToggleGroup: (key: 'stash' | 'tags') => void
  onSelectStash: (reference: string) => void
}

function Sidebar({ repository, structureRepository, parentRepository, recentRepositories, favorites, onToggleFavorite, onManageRepositories, openingRepository, structureSelection, repositorySwitcherSignal, onOpenRepository, onOpenRepositoryPath, onOpenSubmodulePath, onReturnToParentRepository, onCreateBranch, onDeleteBranchPrefix, onJumpBranch, onSwitchBranch, onPullBranch, onMergeBranch, onDeleteBranch, onCopyBranch, onSelectView, onSelectStructure, onOpenGitConfig, onOpenCommandLog, onOpenUpdates, onToggle, sidebarGroups, onToggleGroup, onSelectStash }: SidebarProps) {
  const { t, language, setLanguage } = useI18n()
  return <aside className="sidebar">
    <div className="sidebar-repository-header">
      <RepositoryQuickSwitcher favorites={favorites} onToggleFavorite={onToggleFavorite} onManageRepositories={onManageRepositories} repository={repository} parentRepository={parentRepository} recentRepositories={recentRepositories} openingRepository={openingRepository} openSignal={repositorySwitcherSignal} onOpenRepository={onOpenRepository} onOpenRepositoryPath={onOpenRepositoryPath} onOpenSubmodulePath={onOpenSubmodulePath} onReturnToParentRepository={onReturnToParentRepository}/>
      <Button variant="icon" className="sidebar-toggle" onClick={onToggle} title={t('common.collapseSidebar')}><PanelLeftClose size={16}/></Button>
    </div>
    <nav>{repository ? <>
      <BranchTree branches={repository.branches} remoteBranches={repository.remoteBranches} branchTracking={repository.branchTracking} worktreeBranches={Object.fromEntries(repository.worktrees.filter((worktree) => worktree.branch && worktree.path.replace(/[\\/]+$/, '').toLocaleLowerCase() !== repository.path.replace(/[\\/]+$/, '').toLocaleLowerCase()).map((worktree) => [worktree.branch as string, worktree.path]))} currentBranch={repository.branch} onCreateBranch={onCreateBranch} onDeletePrefix={onDeleteBranchPrefix} onJumpBranch={onJumpBranch} onSwitchBranch={onSwitchBranch} onPullBranch={onPullBranch} onMergeBranch={onMergeBranch} onDeleteBranch={onDeleteBranch} onCopyBranch={onCopyBranch}/>
      <RepositoryStructureTree repository={structureRepository ?? repository} activePath={repository.path} selection={structureSelection} onSelect={onSelectStructure} onOpenPath={(path, kind) => { if (kind === 'submodule') onOpenSubmodulePath(path); else onOpenRepositoryPath(path) }}/>
      <div className={`nav-group ${sidebarGroups.stash ? 'open' : ''}`}>
        <button className="nav-group-head" aria-expanded={sidebarGroups.stash} onClick={() => onToggleGroup('stash')}><ChevronDown size={12} className="nav-group-chev"/><span>{t('nav.groupStash')}</span><span className="nav-badge muted">{repository.stashes.length}</span></button>
        {sidebarGroups.stash && <div className="nav-group-body">
          {repository.stashes.length === 0 && <div className="nav-group-empty">{t('stash.empty')}</div>}
          {repository.stashes.map((stash) => <button key={stash.reference} className="nav-row nav-row-compact" onClick={() => onSelectStash(stash.reference)} title={`${stash.message} · ${stash.reference} · ${formatLocalDateTime(stash.time)}`}><Archive size={14}/><span>{stash.message}</span></button>)}
        </div>}
      </div>
      <div className={`nav-group ${sidebarGroups.tags ? 'open' : ''}`}>
        <button className="nav-group-head" aria-expanded={sidebarGroups.tags} onClick={() => onToggleGroup('tags')}><ChevronDown size={12} className="nav-group-chev"/><span>{t('nav.groupTags')}</span><span className="nav-badge muted">{repository.tags.length}</span></button>
        {sidebarGroups.tags && <div className="nav-group-body">
          {repository.tags.length === 0 && <div className="nav-group-empty">{t('nav.tagsEmpty')}</div>}
          {repository.tags.map((tag) => <button key={tag} className="nav-row nav-row-compact" onClick={() => onSelectView('tags')} title={tag}><Tag size={14}/><span>{tag}</span></button>)}
        </div>}
      </div>
    </> : <div className="sidebar-empty-state"><FolderOpen size={24}/><strong>{t('sidebar.emptyTitle')}</strong><span>{t('sidebar.emptyHint')}</span><button onClick={onOpenRepository} disabled={openingRepository}>{openingRepository ? t('sidebar.opening') : t('sidebar.open')}</button></div>}</nav>
    <div className="sidebar-footer"><button className="profile" onClick={onOpenGitConfig} title={t('nav.gitConfig')}><AppMark className="app-brand-mark"/><div><strong>Branchline</strong><span>{t('nav.gitConfig')}</span></div><Settings2 size={15}/></button><button className="sidebar-command-log" onClick={onOpenCommandLog} title={t('nav.commandLog')}><TerminalSquare size={14}/><span>{t('nav.commandLog')}</span></button><button className="sidebar-command-log" onClick={onOpenUpdates} title={t('updates.title')}><Download size={14}/><span>{t('nav.updates')}</span></button><button className="sidebar-command-log" onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')} title={t('language.title')}><Languages size={14}/><span>{t('language.switch')}</span></button></div>
  </aside>
}

function GraphLine({ commit, row, laneCount, graphWidth }: { commit: Commit; row: CommitGraphRow; laneCount: number; graphWidth: number }) {
  const { t } = useI18n()
  const x = lanePosition(row.lane, laneCount, graphWidth)
  const isStash = commit.status === 'stash'
  const isWorking = commit.status === 'working'
  const isMerge = !isStash && !isWorking && (row.parentCount > 1 || commit.status === 'merge')
  const title = isWorking ? t('history.graph.working') : isStash ? t('history.graph.stash', { id: commit.id }) : isMerge ? t('history.graph.merge', { id: commit.id, count: row.parentCount }) : row.parentCount === 0 ? t('history.graph.terminal', { id: commit.id }) : t('history.graph.commit', { id: commit.id, lane: row.lane + 1 })
  return <div className="graph-cell" title={title} data-lane={row.lane} data-parent-count={row.parentCount}>
    <svg className="graph-segments" width={graphWidth} height="32" viewBox={`0 0 ${graphWidth} 32`} aria-hidden="true">
      {row.segments.map((segment) => <path key={segment.id} className={`graph-segment ${segment.kind}`} d={segment.path} stroke={segment.color}/>) }
    </svg>
    <span className={`commit-dot ${isMerge ? 'merge' : ''} ${isStash ? 'stash' : ''} ${isWorking ? 'working' : ''} ${row.parentCount === 0 ? 'terminal' : ''}`} style={{ left: x, borderColor: row.color, color: row.color, background: isMerge || isStash || isWorking ? 'transparent' : row.color }}/>
  </div>
}

type ColumnKey = 'branch' | 'graph' | 'time' | 'hash' | 'author'
const COMMIT_ROW_HEIGHT = 32

function commitDay(commit: Commit, formatDate: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => string) {
  const timestamp = commitTimestamp(commit)
  if (timestamp === null) return null
  const date = new Date(timestamp)
  return {
    key: `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`,
    label: formatDate(date, { year: 'numeric', month: 'long', day: 'numeric' }),
  }
}

function CommitList({ commits, selected, onSelect, query, searchMode, searchAction, onSearchSummaryChange, branchFilter, timeFilter, currentBranch, remoteBranches, branchTracking, tags, stashReferences, inspectorCollapsed, onToggleInspector, onMergeCommit, onCherryPickCommit, onResetCommit, onRevertCommit, onRebaseCommit, onTagCommit, onCompareCommit, onCopyCommit, onApplyStash, onPopStash, onDropStash, historyStream, onLoadMoreHistory }: { commits: Commit[]; selected: string; onSelect: (id: string) => void; query: string; searchMode: HistorySearchMode; searchAction: SearchNavigationAction; onSearchSummaryChange: (summary: SearchSummary) => void; branchFilter: string[]; timeFilter: TimeFilter; currentBranch: string; remoteBranches: string[]; branchTracking: BranchTrackingMap; tags: string[]; stashReferences: Record<string, string>; inspectorCollapsed: boolean; onToggleInspector: () => void; onMergeCommit: (commit: Commit) => void; onCherryPickCommit: (commit: Commit) => void; onResetCommit: (commit: Commit) => void; onRevertCommit: (commit: Commit) => void; onRebaseCommit: (commit: Commit) => void; onTagCommit: (commit: Commit) => void; onCompareCommit: (commit: Commit) => void; onCopyCommit: (commit: Commit, mode: 'hash' | 'details') => void; onApplyStash: (reference: string) => void; onPopStash: (reference: string) => void; onDropStash: (reference: string) => void; historyStream?: { hasMore: boolean; loading: boolean }; onLoadMoreHistory?: () => void }) {
  const { t, formatDate } = useI18n()
  const [widths, setWidths] = usePersistentState('branchline.historyColumnWidths.v1', DEFAULT_HISTORY_COLUMN_WIDTHS, isHistoryColumnWidths)
  const [visibleColumns, setVisibleColumns] = usePersistentState('branchline.historyVisibleColumns.v1', DEFAULT_HISTORY_VISIBLE_COLUMNS, isHistoryVisibleColumns)
  const [columnMenuOpen, setColumnMenuOpen] = useState(false)
  const [committerFilter, setCommitterFilter] = useState<string[]>([])
  const [committerMenuOpen, setCommitterMenuOpen] = useState(false)
  const [contextCommit, setContextCommit] = useState<{ commit: Commit; x: number; y: number } | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [listHeight, setListHeight] = useState(600)
  const commitListRef = useRef<HTMLDivElement>(null)
  const columnsHeaderRef = useRef<HTMLDivElement>(null)
  const scrollFrame = useRef<number | null>(null)
  const pendingScrollTop = useRef(0)
  const viewportAnchor = useRef<CommitViewportAnchor | null>(null)
  const handledSearchAction = useRef(0)
  const autoLocatedSearch = useRef('')
  const deferredQuery = useDeferredValue(query)
  const committers = useMemo(() => Array.from(new Set(commits.filter((commit) => commit.status !== 'working').map((commit) => committerName(commit)))), [commits])
  const remoteBranchSet = useMemo(() => new Set(remoteBranches), [remoteBranches])
  const tagSet = useMemo(() => new Set(tags), [tags])
  const mergeBranch = contextCommit?.commit.branches?.find((reference) => remoteBranchSet.has(reference) || remoteBranchSet.has(reference.replace(/^refs\/remotes\//, '')))
  const mergeTargetLabel = mergeBranch ? t('history.mergeBranchLabel', { name: mergeBranch.replace(/^refs\/remotes\//, '') }) : t('history.mergeCommitLabel', { id: contextCommit?.commit.id ?? '' })
  const contextStashReference = contextCommit?.commit.fullHash ? stashReferences[contextCommit.commit.fullHash] : undefined
  const branchCommitIds = useMemo(() => reachableHistoryCommitIds(commits, branchFilter), [branchFilter, commits])
  const baseFiltered = useMemo(() => {
    const timeWindow = timeFilter === 'day' ? 86_400_000 : timeFilter === 'week' ? 7 * 86_400_000 : timeFilter === 'month' ? 30 * 86_400_000 : null
    const threshold = timeWindow ? Date.now() - timeWindow : null
    return commits.filter((commit) => {
      const timestamp = threshold ? commitTimestamp(commit) : null
      const visibleOnBranch = isHistoryCommitVisibleOnSelectedBranches(commit, branchFilter, currentBranch, branchCommitIds)
      return matchesCommitterFilter(commit, committerFilter)
        && visibleOnBranch
        && (!threshold || timestamp === null || timestamp >= threshold)
    })
  }, [branchCommitIds, branchFilter, commits, committerFilter, currentBranch, timeFilter])
  const searchMatches = useMemo(() => matchingCommitIds(baseFiltered, deferredQuery), [baseFiltered, deferredQuery])
  const searchMatchSet = useMemo(() => new Set(searchMatches), [searchMatches])
  const filtered = useMemo(() => visibleHistoryCommits(baseFiltered, deferredQuery, searchMode), [baseFiltered, deferredQuery, searchMode])
  const graphLayout = useMemo(() => buildCommitGraphLayout(filtered, widths.graph), [filtered, widths.graph])
  const virtualRange = useMemo(() => {
    const overscan = 12
    const start = Math.max(0, Math.floor(scrollTop / COMMIT_ROW_HEIGHT) - overscan)
    const end = Math.min(filtered.length, Math.ceil((scrollTop + listHeight) / COMMIT_ROW_HEIGHT) + overscan)
    return { start, end }
  }, [filtered.length, listHeight, scrollTop])
  // 滚动到已加载末尾前预取下一页。只对“全量历史”视图生效：带查询/时间/提交人过滤时
  // 尾部并不代表历史尽头，继续拉取会一边过滤一边无限读完整仓。
  useEffect(() => {
    if (!historyStream?.hasMore || historyStream.loading) return
    if (!filtered.length || query.trim() || timeFilter !== 'all' || committerFilter.length > 0) return
    if (virtualRange.end < filtered.length - HISTORY_PREFETCH_ROWS) return
    onLoadMoreHistory?.()
  }, [committerFilter.length, filtered.length, historyStream?.hasMore, historyStream?.loading, onLoadMoreHistory, query, timeFilter, virtualRange.end])
  const visibleCommits = filtered.slice(virtualRange.start, virtualRange.end)
  const searchMatchIndex = searchMatches.indexOf(selected)
  const searchMatchCount = searchMatches.length
  useEffect(() => {
    const element = commitListRef.current
    if (!element) return
    const updateHeight = () => setListHeight(element.clientHeight)
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => () => { if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current) }, [])
  useEffect(() => {
    onSearchSummaryChange({ current: searchMatchIndex >= 0 ? searchMatchIndex + 1 : 0, total: searchMatchCount })
  }, [onSearchSummaryChange, searchMatchCount, searchMatchIndex])
  useEffect(() => {
    const closeMenus = (event: PointerEvent) => {
      if (!columnsHeaderRef.current?.contains(event.target as Node)) {
        setColumnMenuOpen(false)
        setCommitterMenuOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { setColumnMenuOpen(false); setCommitterMenuOpen(false) } }
    document.addEventListener('pointerdown', closeMenus)
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('pointerdown', closeMenus); document.removeEventListener('keydown', onKeyDown) }
  }, [])
  useEffect(() => {
    const searchKey = `${searchMode}\0${deferredQuery.trim()}`
    if (autoLocatedSearch.current === searchKey) return
    autoLocatedSearch.current = searchKey
    if (!deferredQuery.trim() || !searchMatches.length || searchMatchSet.has(selected)) return
    onSelect(searchMatches[0])
  }, [deferredQuery, onSelect, searchMatches, searchMatchSet, searchMode, selected])
  useEffect(() => {
    if (searchAction.sequence === handledSearchAction.current) return
    handledSearchAction.current = searchAction.sequence
    if (!deferredQuery.trim()) return
    const next = nextSearchMatch(searchMatches, selected, searchAction.direction)
    if (next && next !== selected) onSelect(next)
  }, [deferredQuery, onSelect, searchAction, searchMatches, selected])
  useLayoutEffect(() => {
    const element = commitListRef.current
    if (!element) return
    const nextTop = restoreCommitAnchor(filtered, viewportAnchor.current, COMMIT_ROW_HEIGHT, element.scrollTop)
    if (nextTop !== element.scrollTop) element.scrollTop = nextTop
    const restoredTop = element.scrollTop
    pendingScrollTop.current = restoredTop
    viewportAnchor.current = captureCommitAnchor(filtered, restoredTop, COMMIT_ROW_HEIGHT)
    setScrollTop((current) => current === restoredTop ? current : restoredTop)
  }, [filtered])
  useEffect(() => {
    const index = filtered.findIndex((commit) => commit.id === selected)
    const element = commitListRef.current
    if (index < 0 || !element) return
    const top = index * COMMIT_ROW_HEIGHT
    const bottom = top + COMMIT_ROW_HEIGHT
    if (top < element.scrollTop || bottom > element.scrollTop + element.clientHeight) {
      element.scrollTo({ top: Math.max(0, top - element.clientHeight / 2), behavior: 'smooth' })
    }
  }, [selected])
  const committerColumnVisible = visibleColumns.committer ?? true
  const template = [`${widths.branch}px`, `${widths.graph}px`, 'minmax(180px, 1fr)', visibleColumns.time ? `${widths.time}px` : '', visibleColumns.hash ? `${widths.hash}px` : '', committerColumnVisible ? `${widths.author}px` : ''].filter(Boolean).join(' ')
  const committerFilterButton = <Button variant="icon" active={committerFilter.length > 0} onClick={() => { setCommitterMenuOpen((value) => !value); setColumnMenuOpen(false) }} title={t('history.filter.committer')} aria-label={t('history.filter.committer')}><ListFilter size={14}/></Button>
  const committerFilterMenu = committerMenuOpen && <div className="column-config-menu author-filter-menu"><strong>{t('history.filter.committerMulti')}</strong><button className={committerFilter.length === 0 ? 'active' : ''} onClick={() => setCommitterFilter([])}>{t('history.filter.allCommitters')}</button>{committers.map((committer) => <button className={committerFilter.includes(committer) ? 'active' : ''} key={committer} onClick={() => setCommitterFilter((values) => toggleFilterValue(values, committer))}><Check size={13} className={committerFilter.includes(committer) ? '' : 'filter-check-hidden'}/><span>{committer}</span></button>)}</div>
  const beginResize = (column: ColumnKey, event: React.PointerEvent<HTMLSpanElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = widths[column]
    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX
      const minimum = column === 'graph' ? 120 : column === 'author' ? 128 : column === 'time' ? 88 : column === 'branch' ? 90 : 68
      setWidths((current) => ({ ...current, [column]: Math.max(minimum, startWidth + delta) }))
    }
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  const resizer = (column: ColumnKey) => <span className="column-resizer" role="separator" aria-label={t('history.column.resize')} onPointerDown={(event) => beginResize(column, event)}/>
  const refTag = (reference: string, color: string, references: string[]) => {
    const trackedRemote = trackedRemoteReference(reference, references, remoteBranchSet, branchTracking)
    const kind = reference === 'refs/stash' ? 'stash' : tagSet.has(reference) ? 'tag' : remoteBranchSet.has(reference) ? 'remote' : trackedRemote ? 'tracking' : 'local'
    const RefIcon = kind === 'stash' ? Archive : kind === 'tag' ? Tag : kind === 'remote' ? CloudDownload : GitBranch
    const kindLabel = kind === 'stash' ? t('history.ref.stash') : kind === 'tag' ? t('history.ref.tag') : kind === 'remote' ? t('history.ref.remote') : kind === 'tracking' ? t('history.ref.tracking') : t('history.ref.local')
    const label = kind === 'stash' ? 'Stash' : reference
    const title = trackedRemote ? t('history.ref.sameAsTracking', { kind: kindLabel, reference, tracked: trackedRemote }) : t('history.ref.kindTitle', { kind: kindLabel, reference })
    return <span className={`ref ref-${kind}`} style={{ background: kind === 'stash' ? '#ffd666' : `color-mix(in srgb, ${color} 58%, white)` }} title={title} key={reference}><RefIcon size={11}/>{trackedRemote && <CloudDownload size={11}/>}<span>{label}</span>{reference === currentBranch && <Check className="ref-current" size={11}/>}</span>
  }
  return <div className="commit-table">
    <div ref={columnsHeaderRef} className="commit-columns-header" style={{ gridTemplateColumns: template }}>
      <div className="column-label">{t('history.column.branch')}{resizer('branch')}</div>
      <div className="column-label">{t('history.column.graph')}{resizer('graph')}</div>
      <div className="column-label message-label"><span className="column-title">{t('history.column.message')}</span><div className="column-actions">{committerFilterButton}<Button variant="icon" onClick={() => { setColumnMenuOpen((value) => !value); setCommitterMenuOpen(false) }} title={t('history.column.configure')} aria-label={t('history.column.configure')}><Settings2 size={14}/></Button></div>{columnMenuOpen && <div className="column-config-menu"><strong>{t('history.column.show')}</strong><label><input type="checkbox" checked={visibleColumns.time} onChange={(event) => setVisibleColumns((value) => ({ ...value, time: event.target.checked }))}/>{t('history.column.time')}</label><label><input type="checkbox" checked={visibleColumns.hash} onChange={(event) => setVisibleColumns((value) => ({ ...value, hash: event.target.checked }))}/>Hash</label><label><input type="checkbox" checked={committerColumnVisible} onChange={(event) => setVisibleColumns((value) => ({ ...value, committer: event.target.checked }))}/>{t('history.column.committer')}</label></div>}{committerFilterMenu}</div>
      {visibleColumns.time && <div className="column-label">{t('history.column.time')}{resizer('time')}</div>}
      {visibleColumns.hash && <div className="column-label">Hash{resizer('hash')}</div>}
      {committerColumnVisible && <div className="column-label author-label"><span className="column-title">{t('history.column.committer')}</span>{resizer('author')}</div>}
    </div>
    <div className="commit-list" ref={commitListRef} onScroll={(event) => {
      pendingScrollTop.current = event.currentTarget.scrollTop
      viewportAnchor.current = captureCommitAnchor(filtered, pendingScrollTop.current, COMMIT_ROW_HEIGHT)
      if (scrollFrame.current !== null) return
      scrollFrame.current = requestAnimationFrame(() => {
        scrollFrame.current = null
        setScrollTop(pendingScrollTop.current)
      })
    }}>
    {virtualRange.start > 0 && <div className="commit-list-spacer" style={{ height: virtualRange.start * COMMIT_ROW_HEIGHT }}/>} 
    {visibleCommits.map((commit, localIndex) => {
      const visibleIndex = virtualRange.start + localIndex
      const currentDay = commitDay(commit, formatDate)
      const previousDay = visibleIndex > 0 ? commitDay(filtered[visibleIndex - 1], formatDate) : null
      const timeDivider = visibleIndex > 0 && currentDay && currentDay.key !== previousDay?.key ? currentDay.label : null
      const graphRow = graphLayout.rows[visibleIndex]
      const rowStyle = { gridTemplateColumns: template, '--time-divider-left': `${widths.branch + widths.graph + 8}px` } as React.CSSProperties
      return <button key={commit.id} data-commit-id={commit.id} className={`commit-row ${commit.status === 'working' ? 'working-tree' : ''} ${selected === commit.id ? 'selected' : ''} ${searchMatchSet.has(commit.id) ? 'search-match' : ''} ${selected === commit.id && searchMatchSet.has(commit.id) ? 'search-current' : ''} ${timeDivider ? 'time-break' : ''}`} style={rowStyle} onClick={() => onSelect(commit.id)} onContextMenu={(event) => { event.preventDefault(); if (commit.status === 'working') return; onSelect(commit.id); setContextCommit({ commit, x: event.clientX, y: event.clientY }) }}>
        {timeDivider && <span className="time-divider-label">{timeDivider}</span>}
        <div className="branch-cell">{commit.status === 'working' ? <span className="ref ref-working"><FileDiff size={11}/><span>{t('history.workingTreeLabel')}</span></span> : visibleCommitReferences(commit.branches ?? [], remoteBranchSet, branchTracking).map((branch) => refTag(branch, graphRow.color, commit.branches ?? []))}</div>
        <GraphLine commit={commit} row={graphRow} laneCount={graphLayout.laneCount} graphWidth={widths.graph}/>
        <div className="commit-content message-cell">
          <div className="commit-subject"><span>{commit.title}</span></div>
        </div>
        {visibleColumns.time && <div className="optional-cell time-cell" title={formatLocalDateTime(commit.commitTime ?? commit.authorTime ?? commit.time)}>{formatCommitListTime(commit)}</div>}
        {visibleColumns.hash && <div className="optional-cell hash-cell">{commit.id}</div>}
        {committerColumnVisible && <div className={`author-cell ${committerFilter.includes(committerName(commit)) ? 'filtered-author' : ''}`}><div className="avatar tiny">{committerInitials(committerName(commit))}</div><span>{committerName(commit)}</span></div>}
      </button>
    })}
    {virtualRange.end < filtered.length && <div className="commit-list-spacer" style={{ height: (filtered.length - virtualRange.end) * COMMIT_ROW_HEIGHT }}/>} 
    {historyStream?.loading && <div className="commit-list-footer">{t('history.loadingMore')}</div>}
    {filtered.length === 0 && <div className="empty-search">{commits.length ? <Search size={24}/> : <GitCommitHorizontal size={24}/>}<strong>{commits.length ? t('history.emptyNoMatch') : t('history.emptyTitle')}</strong><span>{commits.length ? t('history.emptyNoMatchHint') : t('history.emptyHint')}</span></div>}
    </div>
    {contextCommit && <ContextMenu x={contextCommit.x} y={contextCommit.y} onClose={() => setContextCommit(null)}>
      {contextCommit.commit.status === 'stash' ? <>
        <div className="context-menu-title"><Archive size={13}/><span>{contextStashReference ?? 'Stash'} · {contextCommit.commit.title}</span></div>
        <button onClick={() => { if (inspectorCollapsed) onToggleInspector(); setContextCommit(null) }}><PanelRightOpen size={14}/><span>{t('history.context.stashView')}</span></button>
        <button disabled={!contextStashReference} onClick={() => { if (contextStashReference) onApplyStash(contextStashReference); setContextCommit(null) }}><Check size={14}/><span>{t('history.context.stashApply')}</span></button>
        <button disabled={!contextStashReference} onClick={() => { if (contextStashReference) onPopStash(contextStashReference); setContextCommit(null) }}><CornerDownLeft size={14}/><span>{t('history.context.stashPop')}</span></button>
        <div className="context-menu-separator"/>
        <Button variant="danger" disabled={!contextStashReference} onClick={() => { if (contextStashReference) onDropStash(contextStashReference); setContextCommit(null) }}><Trash2 size={14}/><span>{t('history.context.stashDrop')}</span></Button>
        <div className="context-menu-separator"/>
        <button onClick={() => { onCopyCommit(contextCommit.commit, 'hash'); setContextCommit(null) }}><Copy size={14}/><span>{t('history.context.stashCopyHash')}</span></button>
        <button onClick={() => { onCopyCommit(contextCommit.commit, 'details'); setContextCommit(null) }}><FileText size={14}/><span>{t('history.context.stashCopyMessage')}</span></button>
      </> : <>
        <div className="context-menu-title"><GitCommitHorizontal size={13}/><span>{contextCommit.commit.id} · {contextCommit.commit.title}</span></div>
        <button onClick={() => { onCompareCommit(contextCommit.commit); setContextCommit(null) }}><GitCompareArrows size={14}/><span>{t('history.context.compare')}</span></button>
        <button onClick={() => { onMergeCommit(contextCommit.commit); setContextCommit(null) }}><GitMerge size={14}/><span>{t('history.context.merge', { target: mergeTargetLabel, branch: currentBranch })}</span></button>
        <button onClick={() => { onCherryPickCommit(contextCommit.commit); setContextCommit(null) }}><GitCommitHorizontal size={14}/><span>{t('history.context.cherryPick')}</span></button>
        <button onClick={() => { onRebaseCommit(contextCommit.commit); setContextCommit(null) }}><GitFork size={14}/><span>{t('history.context.rebase')}</span></button>
        <button onClick={() => { onTagCommit(contextCommit.commit); setContextCommit(null) }}><Tag size={14}/><span>{t('history.context.tag')}</span></button>
        <div className="context-menu-separator"/>
        <button onClick={() => { onRevertCommit(contextCommit.commit); setContextCommit(null) }}><Undo2 size={14}/><span>{t('history.context.revert')}</span></button>
        <div className="context-menu-separator"/>
        <Button variant="danger" onClick={() => { onResetCommit(contextCommit.commit); setContextCommit(null) }}><RotateCcw size={14}/><span>{t('history.context.reset')}</span></Button>
        <div className="context-menu-separator"/>
        <button onClick={() => { onCopyCommit(contextCommit.commit, 'hash'); setContextCommit(null) }}><Copy size={14}/><span>{t('history.context.copyHash')}</span></button>
        <button onClick={() => { onCopyCommit(contextCommit.commit, 'details'); setContextCommit(null) }}><FileText size={14}/><span>{t('history.context.copyMessage')}</span></button>
      </>}
    </ContextMenu>}
  </div>
}

function CommitDetails({ commit, stashReference, onClose }: { commit: Commit; stashReference?: string | null; onClose: () => void }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null)
  const commitTextRef = useRef<HTMLTextAreaElement>(null)
  const isWorkingTree = commit.status === 'working'
  const isStash = commit.status === 'stash'
  const fullHash = isWorkingTree ? t('history.details.workingHash') : commit.fullHash ?? `${commit.id}4b92d7e08f7e16f85b16d0c`
  const parentHash = commit.parents?.length ? commit.parents.join(', ') : commit.parent ? (commit.parent.length > 7 ? commit.parent : `${commit.parent}019be47a1d40d5406a8f61b0`) : '—'
  const email = isWorkingTree ? t('history.details.workingEmail') : commit.email ?? 'zhou@example.com'
  const message = commit.message ?? (isWorkingTree ? t('history.details.workingMessage') : `${commit.title}\n\n${t('history.details.sampleMessage')}`)
  const committer = commit.committer ?? commit.author
  const committerEmail = commit.committerEmail ?? email
  const commitTime = commit.commitTime ?? commit.time
  const commitText = (isWorkingTree ? [
    t('history.details.statusWorking'),
    t('history.details.basedOn', { hash: parentHash }),
    '',
    message,
  ] : isStash ? [
    t('history.details.stashRef', { reference: stashReference ?? '—' }),
    t('history.details.node', { hash: fullHash }),
    t('history.details.basedOn', { hash: parentHash }),
    t('history.details.authorLine', { author: commit.author, email }),
    t('history.details.stashDate', { date: formatLocalDateTime(commitTime) }),
    '',
    message,
  ] : [
    t('history.details.hashLine', { hash: fullHash }),
    t('history.details.parentLine', { parents: parentHash }),
    t('history.details.authorLine', { author: commit.author, email }),
    t('history.details.committerLine', { committer, email: committerEmail }),
    t('history.details.dateLine', { date: formatLocalDateTime(commitTime) }),
    '',
    message,
  ]).join('\n')
  const copy = () => {
    commitTextRef.current?.focus()
    commitTextRef.current?.select()
    document.execCommand('copy')
    navigator.clipboard?.writeText(commitText).catch(() => undefined)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  const copyHash = () => {
    navigator.clipboard?.writeText(fullHash).catch(() => undefined)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  return <section className="commit-details">
    <div className="detail-heading"><div><span className="eyebrow">{isWorkingTree ? t('history.details.working') : isStash ? t('history.details.stash') : t('history.details.commit')}</span><h2>{commit.title}</h2></div><div className="detail-heading-actions">{!isWorkingTree && <Button variant="icon" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMoreMenu({ x: rect.right - 220, y: rect.bottom + 4 }) }} title={t('history.details.more')} aria-label={t('history.details.more')}><MoreHorizontal size={17}/></Button>}<Button variant="icon" onClick={onClose} title={t('history.details.close')} aria-label={t('history.details.close')}><X size={17}/></Button></div></div>
    <div className="identity-row"><div className="avatar large">{commit.avatar}</div><div><strong>{commit.author}</strong><span>{isWorkingTree ? `${email} · ${t('history.details.notCommitted')}` : isStash ? `${stashReference ?? 'Stash'} · ${formatLocalDateTime(commitTime)}` : `${email} · ${formatLocalDateTime(commitTime)}`}</span></div>{!commit.fullHash && !isWorkingTree && <span className="verified"><Check size={11}/> {t('history.details.verified')}</span>}</div>
    <div className="commit-text-panel">
      <div className="commit-text-toolbar"><div><FileText size={14}/><span>{isWorkingTree ? t('history.details.workingInfo') : isStash ? t('history.details.stashInfo') : t('history.details.commitMessage')}</span></div><button className="icon-tool-button" onClick={copy} title={copied ? t('history.details.copied') : t('history.details.copyAll')} aria-label={copied ? t('history.details.copied') : t('history.details.copyAll')}>{copied ? <Check size={14}/> : <Copy size={14}/>}</button></div>
      <textarea ref={commitTextRef} aria-label={t('history.details.commitMessage')} readOnly value={commitText} onFocus={(event) => event.currentTarget.select()}/>
    </div>
    {moreMenu && !isWorkingTree && <ContextMenu x={moreMenu.x} y={moreMenu.y} onClose={() => setMoreMenu(null)}><div className="context-menu-title"><GitCommitHorizontal size={13}/><span>{isStash ? t('history.details.stashActions') : t('history.details.commitActions')}</span></div><button onClick={() => { copyHash(); setMoreMenu(null) }}><Copy size={14}/><span>{t('history.details.copyStashHash')}</span></button><button onClick={() => { copy(); setMoreMenu(null) }}><FileText size={14}/><span>{t('history.details.copyStashMessage')}</span></button></ContextMenu>}
  </section>
}

function ChangedFilesPanel({ files, loading, activeFile, onOpenFile, onOpenHistory }: { files: RepositoryFile[]; loading?: boolean; activeFile: number | null; onOpenFile: (index: number) => void; onOpenHistory: (path: string, tab: HistoryTarget['tab']) => void }) {
  const { t } = useI18n()
  const [fileMode, setFileMode] = usePersistentState('branchline.changedFilesMode.v1', 'list', isFileMode)
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null)
  const [contextFile, setContextFile] = useState<{ file: RepositoryFile; x: number; y: number } | null>(null)
  const [collapsedFolders, setCollapsedFolders] = usePersistentState('branchline.changedFilesCollapsedFolders.v1', {}, isBooleanRecord)
  const fileFolders = useMemo(() => {
    const folders = new Set<string>()
    files.forEach((file) => {
      const segments = file.path.split('/').filter(Boolean).slice(0, -1)
      segments.forEach((_, index) => folders.add(segments.slice(0, index + 1).join('/')))
    })
    return Array.from(folders)
  }, [files])
  return <section className="changed-files-panel">
    <div className="changed-files-heading"><div><FileDiff size={15}/><strong>{t('history.files.title')}</strong><span>{loading ? '…' : files.length}</span></div><div className="changed-files-actions"><div className="segmented compact-segmented icon-segmented"><button className={fileMode === 'tree' ? 'active' : ''} onClick={() => setFileMode('tree')} title={t('history.files.treeView')} aria-label={t('history.files.treeView')}><FolderOpen size={14}/></button><button className={fileMode === 'list' ? 'active' : ''} onClick={() => setFileMode('list')} title={t('history.files.listView')} aria-label={t('history.files.listView')}><List size={14}/></button></div><Button variant="icon" disabled={loading || !files.length} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMoreMenu({ x: rect.right - 220, y: rect.bottom + 4 }) }} title={t('history.files.more')}><MoreHorizontal size={15}/></Button></div></div>
    {loading ? <div className="changed-files-list"><div className="changed-files-empty"><RefreshCw className="spin" size={15}/><span>{t('history.files.loading')}</span></div></div> : !files.length ? <div className="changed-files-list"><div className="changed-files-empty"><FileDiff size={15}/><span>{t('history.files.empty')}</span></div></div> : <DiffFileList files={files} activeFile={activeFile ?? -1} mode={fileMode} onSelectFile={onOpenFile} className="changed-files-list" fileRowHeight={42} folderRowHeight={28} collapsedFolders={collapsedFolders} onCollapsedFoldersChange={setCollapsedFolders} showOpenIndicator onFileContextMenu={(event, file) => { event.preventDefault(); setContextFile({ file, x: event.clientX, y: event.clientY }) }}/>}
    {moreMenu && <ContextMenu x={moreMenu.x} y={moreMenu.y} onClose={() => setMoreMenu(null)}><div className="context-menu-title"><FileDiff size={13}/><span>{t('history.files.actions')}</span></div>{fileMode === 'tree' && <><button onClick={() => { setCollapsedFolders({}); setMoreMenu(null) }}><ChevronDown size={14}/><span>{t('history.files.expandAll')}</span></button><button onClick={() => { setCollapsedFolders(Object.fromEntries(fileFolders.map((folder) => [folder, true]))); setMoreMenu(null) }}><ChevronRight size={14}/><span>{t('history.files.collapseAll')}</span></button><div className="context-menu-separator"/></>}<button onClick={() => { navigator.clipboard?.writeText(files.map((file) => file.path).join('\n')).catch(() => undefined); setMoreMenu(null) }}><Copy size={14}/><span>{t('history.files.copyPaths')}</span></button><button onClick={() => { navigator.clipboard?.writeText(files.map((file) => `${file.type} ${file.path} (+${file.add} -${file.del})`).join('\n')).catch(() => undefined); setMoreMenu(null) }}><FileText size={14}/><span>{t('history.files.copySummary')}</span></button></ContextMenu>}
    {contextFile && <ContextMenu x={contextFile.x} y={contextFile.y} onClose={() => setContextFile(null)}><div className="context-menu-title"><FileText size={13}/><span>{contextFile.file.path}</span></div><button onClick={() => { onOpenHistory(contextFile.file.path, 'history'); setContextFile(null) }}><History size={14}/><span>{t('history.files.fileHistory')}</span></button><button onClick={() => { onOpenHistory(contextFile.file.path, 'blame'); setContextFile(null) }}><Rows3 size={14}/><span>{t('history.files.blame')}</span></button><div className="context-menu-separator"/><button onClick={() => { navigator.clipboard?.writeText(contextFile.file.path).catch(() => undefined); setContextFile(null) }}><Copy size={14}/><span>{t('history.files.copyPath')}</span></button></ContextMenu>}
  </section>
}

function ShortcutOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n()
  if (!open) return null
  const shortcuts = [
    ['⌘ F', t('shortcuts.focusSearch')],
    ['⌘ ⇧ F', t('shortcuts.fetchNow')],
    ['⌘ ↵', t('shortcuts.openStaging')],
    ['T', t('shortcuts.toggleView')],
    ['W', t('shortcuts.toggleWide')],
    ['⌘ + / −', t('shortcuts.fontZoom')],
    ['⌘ 0', t('shortcuts.fontReset')],
    ['⌘ /', t('shortcuts.toggleTheme')],
    ['?', t('shortcuts.showShortcuts')],
  ]
  return <div className="shortcut-backdrop" onClick={onClose}><section className="shortcut-dialog" onClick={(event) => event.stopPropagation()}>
    <div className="drawer-heading"><div><span className="eyebrow">{t('shortcuts.nav')}</span><h2>{t('shortcuts.title')}</h2></div><Button variant="icon" onClick={onClose}><X size={18}/></Button></div>
    <div className="shortcut-list">{shortcuts.map(([key, label]) => <div className="shortcut-row" key={key}><span>{label}</span><kbd>{key}</kbd></div>)}</div>
  </section></div>
}

export default function App() {
  const { t, language, setLanguage, formatDate } = useI18n()
  const preferences = usePreferences()
  const theme = preferences.theme
  const prefersDark = useSyncExternalStore(subscribePrefersDark, prefersDarkSnapshot, prefersDarkSnapshot)
  const resolvedTheme = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme
  const { repository, structureRepository, parentRepository, recentRepositories, favoriteRepositories, registerRepository, toggleFavorite, forgetRepository, openingRepository, fetching, repositoryNotice, pauseRepositoryNotice, resumeRepositoryNotice, setRepositoryNotice, applySnapshot, applyStructureSnapshot, openRepository, openRepositoryPath, openSubmodulePath, returnToParentRepository, fetchNow, autoFetchEnabled, fetchIntervalMinutes, localPollingEnabled, localPollingIntervalSeconds, setAutoFetchEnabled, setFetchIntervalMinutes, setLocalPollingEnabled, setLocalPollingIntervalSeconds, lastFetchAt } = useRepositoryWorkspace()
  const [repositoryManagerOpen, setRepositoryManagerOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistentState('branchline.sidebarCollapsed.v1', false, (value): value is boolean => typeof value === 'boolean')
  const [sidebarWidth, setSidebarWidth] = usePersistentState('branchline.sidebarWidth.v1', 252, isSidebarWidth)
  const [inspectorWidth, setInspectorWidth] = usePersistentState('branchline.inspectorWidth.v1', 360, isInspectorWidth)
  const [detailsHeight, setDetailsHeight] = usePersistentState('branchline.detailsHeight.v1', 330, isDetailsHeight)
  const [panelResizing, setPanelResizing] = useState<'sidebar' | 'inspector' | 'details' | null>(null)
  const [selected, setSelected] = useState('')
  const [undoCommitMessage, setUndoCommitMessage] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [searchMode, setSearchMode] = useState<HistorySearchMode>('locate')
  const [searchAction, setSearchAction] = useState<SearchNavigationAction>({ sequence: 0, direction: 1 })
  const [searchSummary, setSearchSummary] = useState<SearchSummary>({ current: 0, total: 0 })
  const handleSearchSummaryChange = useCallback((next: SearchSummary) => {
    setSearchSummary((current) => retainUnchangedSearchSummary(current, next))
  }, [])
  const [repositorySwitcherSignal, setRepositorySwitcherSignal] = useState(0)
  const [branchFilter, setBranchFilter] = useState<string[]>([])
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all')
  const [filterMenu, setFilterMenu] = useState<{ kind: 'branch' | 'time'; x: number; y: number } | null>(null)
  const [notificationOpen, setNotificationOpen] = useState(false)
  const notificationButtonRef = useRef<HTMLButtonElement>(null)
  const notificationPopoverRef = useRef<HTMLDivElement>(null)
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('history')
  // 方案 B 布局：活动栏承接视图切换后的派生状态——侧栏分组折叠与详情区 tab。
  const [sidebarGroups, setSidebarGroups] = usePersistentState('branchline.sidebarGroups.v1', { stash: true, tags: false }, isSidebarGroups)
  const [detailsTab, setDetailsTab] = usePersistentState('branchline.detailsTab.v1', 'diff', isDetailsTab)
  // 「文件树」tab 被偏好隐藏时，已持久化的选中态回退到差异文件视图。
  const effectiveDetailsTab = preferences.showTreeTab ? detailsTab : 'diff'
  const [toolsMenu, setToolsMenu] = useState<{ x: number; y: number } | null>(null)
  const [structureSelection, setStructureSelection] = useState<RepositoryStructureSelection>({ kind: 'root' })
  const [compareBase, setCompareBase] = useState<string | null>(null)
  const [branchDialog, setBranchDialog] = useState<{ prefix?: string } | null>(null)
  const [rebaseDialog, setRebaseDialog] = useState<{ commit: string; label: string } | null>(null)
  const [cherryPickDialog, setCherryPickDialog] = useState<{ commit: Commit; parents: Array<{ hash: string; title: string; author: string; time: string }> } | null>(null)
  const [gitConfigOpen, setGitConfigOpen] = useState(false)
  const [commandLogOpen, setCommandLogOpen] = useState(false)
  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const [preferencesPage, setPreferencesPage] = useState<PreferencesPage>('general')
  const [forcePushOpen, setForcePushOpen] = useState(false)
  const [historyEditOpen, setHistoryEditOpen] = useState(false)
  const { confirm, confirmDialog } = useConfirmDialog()
  const [wideDiff, setWideDiff] = useState(false)
  const [diffFile, setDiffFile] = useState<number | null>(null)
  const [inspectorCollapsed, setInspectorCollapsed] = usePersistentState('branchline.inspectorCollapsed.v2', true, (value): value is boolean => typeof value === 'boolean')
  const [shortcutOpen, setShortcutOpen] = useState(false)
  const [autoFetchOpen, setAutoFetchOpen] = useState(false)
  const [historyTarget, setHistoryTarget] = useState<HistoryTarget | null>(null)
  const [activeOperation, setActiveOperation] = useState<ActiveOperation | null>(null)
  const mergeOperationLock = useRef(false)
  const [operationPath, setOperationPath] = useState<string | null>(null)
  const [historyConflictPath, setHistoryConflictPath] = useState<string | null>(null)
  const [commitStats, setCommitStats] = useState<Record<string, RepositoryCommitStats>>({})
  const [commitFiles, setCommitFiles] = useState<Record<string, RepositoryFile[]>>({})
  const [historyStreamCommits, setHistoryStreamCommits] = useState<Commit[]>([])
  const [historyStream, setHistoryStream] = useState<{ hasMore: boolean; loading: boolean }>({ hasMore: true, loading: false })
  const [historyPageTick, setHistoryPageTick] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const autoFetchRef = useRef<HTMLDivElement>(null)
  const expandedRepositoryPath = useRef<string | null>(null)
  const structureRepositoryPath = useRef<string | null>(null)
  const previousCommits = useRef<Commit[]>([])
  const historyLoadInProgress = useRef(false)
  const historyStreamSession = useRef<string | null>(null)
  const historyStreamExtras = useRef<Commit[]>([])
  const historyStreamHasMore = useRef(true)
  const historyStreamLoading = useRef(false)
  const historyStreamGeneration = useRef(0)

  useEffect(() => {
    if (!notificationOpen) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (notificationButtonRef.current?.contains(event.target as Node)) return
      if (notificationPopoverRef.current?.contains(event.target as Node)) return
      setNotificationOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [notificationOpen])
  const workingTreeCommit = useMemo(() => repository
    ? createWorkingTreeCommit(repository.files, resolveWorkingTreeParent(repository), repository.operation, t)
    : null, [repository])
  const activeCommits = useMemo<Commit[]>(() => {
    const history = mergeHistoryStreamCommits(repository?.commits ?? [], historyStreamCommits)
    return workingTreeCommit ? [workingTreeCommit, ...history] : history
  }, [repository?.commits, historyStreamCommits, workingTreeCommit])
  const unloadedBranchFilters = useMemo(
    () => unloadedHistoryBranches(activeCommits, branchFilter),
    [activeCommits, branchFilter],
  )
  const repositoryPath = repository?.path
  const loadNextHistoryPage = useCallback(async () => {
    if (!repositoryPath || historyStreamLoading.current || !historyStreamHasMore.current) return null
    historyStreamLoading.current = true
    const generation = historyStreamGeneration.current
    setHistoryStream((current) => ({ ...current, loading: true }))
    try {
      const page = historyStreamSession.current
        ? await loadRepositoryHistoryNextPage(historyStreamSession.current, HISTORY_PAGE_SIZE)
        : await startRepositoryHistoryStream(repositoryPath, HISTORY_PAGE_SIZE)
      if (generation !== historyStreamGeneration.current) {
        void cancelRepositoryHistoryStream(page.sessionId)
        return null
      }
      historyStreamSession.current = page.sessionId
      historyStreamHasMore.current = page.hasMore
      const known = new Set(historyStreamExtras.current.map((commit) => commit.fullHash ?? commit.id))
      const appended = page.commits.filter((commit) => !known.has(commit.fullHash))
      if (appended.length) {
        historyStreamExtras.current = [...historyStreamExtras.current, ...appended]
        setHistoryStreamCommits(historyStreamExtras.current)
      }
      setHistoryStream({ hasMore: page.hasMore, loading: false })
      if (page.truncated && page.notice) setRepositoryNotice(page.notice)
      return page
    } catch (error) {
      setHistoryStream((current) => ({ ...current, loading: false }))
      setRepositoryNotice(error instanceof Error ? error.message : String(error))
      return null
    } finally {
      historyStreamLoading.current = false
      setHistoryPageTick((tick) => tick + 1)
    }
  }, [repositoryPath, setRepositoryNotice])
  // 切仓库或 HEAD 变化（提交/变基/切分支）时旧流的提交不再属于新前缀，必须整段失效。
  useEffect(() => {
    historyStreamGeneration.current += 1
    const session = historyStreamSession.current
    historyStreamSession.current = null
    if (session) void cancelRepositoryHistoryStream(session)
    historyStreamExtras.current = []
    historyStreamHasMore.current = true
    historyStreamLoading.current = false
    setHistoryStreamCommits([])
    setHistoryStream({ hasMore: true, loading: false })
  }, [repositoryPath, repository?.commits[0]?.fullHash])
  useEffect(() => {
    if (!repositoryPath || !unloadedBranchFilters.length || historyLoadInProgress.current || !historyStreamHasMore.current) return
    historyLoadInProgress.current = true
    setActiveOperation({ key: 'history', label: t('repository.history.continuing'), detail: t('repository.history.continuingDetail', { branches: unloadedBranchFilters.join('、') }) })
    void loadNextHistoryPage().finally(() => {
      historyLoadInProgress.current = false
      setActiveOperation((current) => current?.key === 'history' ? null : current)
    })
  }, [historyPageTick, loadNextHistoryPage, repositoryPath, unloadedBranchFilters])
  const currentBranchHead = useMemo(
    () => activeCommits.find((commit) => commit.status !== 'working' && commit.branches?.includes(repository?.branch ?? ''))
      ?? activeCommits.find((commit) => commit.status !== 'working')
      ?? null,
    [activeCommits, repository?.branch],
  )
  const availableBranches = repository?.branches ?? []
  const tagSearchCount = repository?.tags.filter((tag) => !query.trim() || tag.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).length ?? 0
  const stashReferences = useMemo(() => Object.fromEntries((repository?.stashes ?? []).map((stash) => [stash.hash, stash.reference])), [repository?.stashes])
  const selectedCommitBase = activeCommits.find((commit) => commit.id === selected) ?? activeCommits[0] ?? { ...emptyCommit, title: t('history.emptyTitle') }
  const selectedWorkingTree = selectedCommitBase.status === 'working'
  const selectedStatsKey = selectedCommitBase.fullHash ?? selectedCommitBase.id
  const selectedStashReference = selectedCommitBase.status === 'stash'
    ? repository?.stashes.find((stash) => stash.hash === selectedStatsKey)?.reference ?? null
    : null

  // B3 历史区 Diff 的行级审查评论：线程锚定当前提交（工作区锚定 'worktree'）。
  const commitReview = useReviewThreads({ repositoryPath: repository?.path ?? null })
  const reviewAuthorRef = useRef('')
  useEffect(() => {
    let cancelled = false
    loadGitUserConfig()
      .then((config) => { if (!cancelled) reviewAuthorRef.current = config.userName })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [])
  const commitReviewWiring = useMemo(() => ({
    reference: selectedWorkingTree ? 'worktree' : selectedStatsKey,
    threads: commitReview.threads,
    busy: commitReview.status === 'loading',
    error: commitReview.error,
    onCreate: (input: { filePath: string; line: number; endLine?: number; side: 'old' | 'new'; body: string }) =>
      commitReview.actions.addThread({ ...input, author: reviewAuthorRef.current }),
    onReply: (threadId: string, body: string) => commitReview.actions.reply(threadId, body, reviewAuthorRef.current),
    onResolve: (threadId: string, resolved: boolean) => commitReview.actions.setResolved(threadId, resolved),
    onDelete: (threadId: string) => commitReview.actions.remove(threadId),
    onClose: () => undefined,
  }), [commitReview, selectedStatsKey, selectedWorkingTree])
  useEffect(() => {
    if (!structureRepository) {
      structureRepositoryPath.current = null
      setStructureSelection({ kind: 'root' })
      return
    }
    if (structureRepositoryPath.current !== structureRepository.path) {
      structureRepositoryPath.current = structureRepository.path
      setStructureSelection({ kind: 'root' })
      return
    }
    setStructureSelection((current) => resolveRepositoryStructureSelection(structureRepository, current))
  }, [structureRepository])
  const selectedStashFiles = selectedStashReference ? commitFiles[selectedStatsKey] : undefined
  const selectedCommit = selectedStashFiles
    ? { ...selectedCommitBase, files: selectedStashFiles.length, additions: selectedStashFiles.reduce((total, file) => total + file.add, 0), deletions: selectedStashFiles.reduce((total, file) => total + file.del, 0) }
    : !selectedWorkingTree && commitStats[selectedStatsKey]
      ? { ...selectedCommitBase, ...commitStats[selectedStatsKey] }
      : selectedCommitBase
  const selectedCommitFiles = selectedWorkingTree ? repository?.files ?? [] : repository ? (commitFiles[selectedStatsKey] ?? []) : []
  const selectedCommitFilesLoading = !selectedWorkingTree && Boolean(repository) && selectedCommitBase.id !== '—' && !Object.prototype.hasOwnProperty.call(commitFiles, selectedStatsKey)
  useEffect(() => {
    if (!autoFetchOpen) return
    const closeWhenOutside = (event: PointerEvent) => {
      if (!autoFetchRef.current?.contains(event.target as Node)) setAutoFetchOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAutoFetchOpen(false)
    }
    document.addEventListener('pointerdown', closeWhenOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeWhenOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [autoFetchOpen])
  useEffect(() => {
    const path = repository?.path ?? null
    if (path && expandedRepositoryPath.current !== path) {
      setSelected(repository?.commits[0]?.id ?? '')
    } else if (path) {
      setSelected((current) => current === WORKING_TREE_COMMIT_ID && Boolean(repository?.files.length || repository?.operation)
        ? current
        : resolveCommitSelection(previousCommits.current, repository?.commits ?? [], current))
    }
    expandedRepositoryPath.current = path
    previousCommits.current = repository?.commits ?? []
  }, [repository?.commits, repository?.files.length, repository?.path])
  useEffect(() => {
    if (!repository || selectedWorkingTree || selectedStashReference || selectedCommitBase.id === '—' || commitStats[selectedStatsKey]) return
    let cancelled = false
    loadRepositoryCommitStats(repository.path, selectedStatsKey)
      .then((stats) => {
        if (!cancelled) setCommitStats((current) => ({ ...current, [selectedStatsKey]: stats }))
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [commitStats, repository?.path, selectedStashReference, selectedStatsKey, selectedWorkingTree])
  useEffect(() => {
    if (!repository || selectedWorkingTree || selectedCommitBase.id === '—' || Object.prototype.hasOwnProperty.call(commitFiles, selectedStatsKey)) return
    let cancelled = false
    const loadFiles = selectedStashReference
      ? loadRepositoryStashFiles(repository.path, selectedStashReference)
      : loadRepositoryCommitFiles(repository.path, selectedStatsKey)
    loadFiles
      .then((files) => {
        if (!cancelled) setCommitFiles((current) => ({ ...current, [selectedStatsKey]: files }))
      })
      .catch((error) => {
        if (cancelled) return
        setCommitFiles((current) => ({ ...current, [selectedStatsKey]: [] }))
        setRepositoryNotice(error instanceof Error ? error.message : String(error))
      })
    return () => { cancelled = true }
  }, [commitFiles, repository?.path, selectedStashReference, selectedStatsKey, selectedWorkingTree])
  useEffect(() => {
    setDiffFile(null)
    setWideDiff(false)
    setHistoryConflictPath(null)
    setOperationPath(null)
  }, [selectedStatsKey])
  const loadSelectedCommitDiff = useCallback((filePath: string, _index: number | undefined, showWhitespace: boolean) => {
    if (!repository) return Promise.resolve([])
    if (selectedWorkingTree) return loadRepositoryFileDiff(repository.path, filePath, showWhitespace)
    return selectedStashReference
      ? loadRepositoryStashFileDiff(repository.path, selectedStashReference, filePath, showWhitespace)
      : loadFileCommitDiff(repository.path, selectedStatsKey, filePath, showWhitespace)
  }, [repository?.path, selectedStashReference, selectedStatsKey, selectedWorkingTree])
  const handleOpenSnapshot = (snapshot: RepositorySnapshot | null) => {
    if (!snapshot) return
    setRepositoryManagerOpen(false)
    setUndoCommitMessage(snapshot.undoCommitMessage ?? null)
    setCommitStats({})
    setCommitFiles({})
    setSelected(snapshot.files.length ? WORKING_TREE_COMMIT_ID : snapshot.commits[0]?.id ?? '')
    setDiffFile(null)
    setWideDiff(false)
    setQuery('')
    setBranchFilter([])
    setTimeFilter('all')
    setWorkspaceView('history')
  }
  const handleOpenRepository = async () => handleOpenSnapshot(await openRepository())
  const handleOpenRepositoryPath = async (path: string) => {
    // Reopening the repository the sidebar already describes must not reset its structure selection.
    const keepsStructure = sameRepositoryPath(path, structureRepository?.path ?? null)
    const snapshot = await openRepositoryPath(path)
    if (snapshot && !keepsStructure) setStructureSelection({ kind: 'root' })
    handleOpenSnapshot(snapshot)
  }
  const handleOpenSubmodulePath = async (path: string) => {
    if (structureRepository) {
      const root = structureRepository.path.replace(/[\\/]+$/, '')
      const normalizedRoot = root.replace(/\\/g, '/').toLocaleLowerCase()
      const normalizedPath = path.replace(/\\/g, '/').replace(/[\\/]+$/, '')
      if (normalizedPath.toLocaleLowerCase().startsWith(`${normalizedRoot}/`)) {
        setStructureSelection({ kind: 'submodule', path: normalizedPath.slice(root.length + 1) })
      }
    }
    handleOpenSnapshot(await openSubmodulePath(path))
  }
  const handleReturnToParentRepository = async () => {
    const snapshot = await returnToParentRepository()
    if (snapshot) setStructureSelection({ kind: 'root' })
    handleOpenSnapshot(snapshot)
  }
  // The sidebar keeps describing the superproject while a submodule is open, so its root is one
  // click away even from a submodule nested several levels deep.
  const rootRepository = repository && structureRepository
    && !sameRepositoryPath(structureRepository.path, repository.path)
    && !sameRepositoryPath(structureRepository.path, parentRepository?.path)
    && isRepositoryDescendant(repository.path, structureRepository.path)
    ? structureRepository
    : null
  const handleReturnToRootRepository = async () => {
    if (!rootRepository) return
    const snapshot = await openRepositoryPath(rootRepository.path)
    if (snapshot) setStructureSelection({ kind: 'root' })
    handleOpenSnapshot(snapshot)
  }
  const handleSnapshot = (snapshot: RepositorySnapshot) => {
    setUndoCommitMessage(snapshot.undoCommitMessage ?? null)
    applySnapshot(snapshot)
    setSelected((current) => current === WORKING_TREE_COMMIT_ID && (snapshot.files.length || snapshot.operation)
      ? current
      : resolveCommitSelection(activeCommits, snapshot.commits, current))
    if (!snapshot.operation) {
      setHistoryConflictPath(null)
      setOperationPath(null)
      if (workspaceView === 'operation') setWorkspaceView('history')
    }
  }
  const refreshRepositorySnapshot = () => {
    if (!repository) return
    void loadRepository(repository.path).then(handleSnapshot).catch((reason) => setRepositoryNotice(reason instanceof Error ? reason.message : String(reason)))
  }
  const handleDeleteBranchPrefix = async (prefix: string) => {
    if (!repository) return setRepositoryNotice(t('repository.notice.requireRepository'))
    try {
      const branches = await previewBranchPrefix(repository.path, prefix)
      if (!branches.length) return setRepositoryNotice(t('repository.notice.prefixNoBranches', { prefix }))
      // The current branch is checked out somewhere by definition, so it is skipped like any other
      // branch that a worktree holds rather than aborting the whole deletion.
      const checkedOutBranches = new Set(repository.worktrees.flatMap((worktree) => worktree.branch ? [worktree.branch] : []))
      if (repository.branch) checkedOutBranches.add(repository.branch)
      const skippedBranches = branches.filter((branch) => checkedOutBranches.has(branch))
      const deletableBranches = branches.filter((branch) => !checkedOutBranches.has(branch))
      if (!deletableBranches.length) return setRepositoryNotice(t('repository.notice.prefixAllOccupied', { prefix }))
      const skippedMessage = skippedBranches.length
        ? t('repository.confirm.deletePrefixSkipped', { count: skippedBranches.length, branches: skippedBranches.map((branch) => `• ${branch}`).join('\n') })
        : ''
      const confirmed = await confirm({ title: t('repository.confirm.deleteBranchTitle'), message: `${t('repository.confirm.deletePrefixMessage', { count: deletableBranches.length, branches: deletableBranches.join('\n') })}${skippedMessage}${t('repository.confirm.deletePrefixNote')}`, confirmLabel: t('repository.confirm.delete'), variant: 'danger' })
      if (!confirmed) return
      const snapshot = await deleteBranchPrefix(repository.path, prefix, branches)
      applySnapshot(snapshot, skippedBranches.length
        ? t('repository.notice.prefixDeletedSkipped', { count: deletableBranches.length, prefix, skipped: skippedBranches.length })
        : t('repository.notice.prefixDeleted', { count: deletableBranches.length, prefix }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        const snapshot = await loadRepository(repository.path)
        applySnapshot(snapshot)
      } catch {
        // 保留原始 Git 操作错误，仓库可通过下一次刷新重新同步。
      }
      setRepositoryNotice(message)
    }
  }
  const openCreateBranchDialog = (prefix?: string) => {
    if (!repository) return setRepositoryNotice(t('repository.notice.createBranchRequiresRepository'))
    setBranchDialog({ prefix })
  }
  const handleCreateBranch = async (branch: string) => {
    if (!repository) {
      setRepositoryNotice(t('repository.notice.createBranchRequiresRepository'))
      return false
    }
    try {
      const snapshot = await createRepositoryBranch(repository.path, branch)
      applySnapshot(snapshot, t('repository.notice.branchCreated', { branch }))
      return true
    } catch (error) {
      setRepositoryNotice(error instanceof Error ? error.message : String(error))
      return false
    }
  }
  const handleSwitchBranch = async (branch: string) => {
    if (!repository) return setRepositoryNotice(t('repository.notice.switchBranchRequiresRepository'))
    if (branch === repository.branch) return setRepositoryNotice(t('repository.notice.alreadyOnBranch', { branch }))
    try {
      const snapshot = await switchRepositoryBranch(repository.path, branch)
      handleSnapshot(snapshot)
      setRepositoryManagerOpen(false)
      setWorkspaceView('history')
      setRepositoryNotice(t('repository.notice.branchSwitched', { branch: snapshot.branch }))
    } catch (error) {
      setRepositoryNotice(error instanceof Error ? error.message : String(error))
    }
  }
  const executeRepositoryAction = async (action: (repositoryPath: string) => Promise<RepositorySnapshot>, success: string, operation?: ActiveOperation) => {
    if (!repository) {
      setRepositoryNotice(t('repository.notice.actionRequiresRepository'))
      return
    }
    if (operation && activeOperation) {
      setRepositoryNotice(t('repository.notice.operationBusy', { label: activeOperation.label }))
      return
    }
    if (operation) setActiveOperation(operation)
    try {
      const snapshot = await action(repository.path)
      handleSnapshot(snapshot)
      if (snapshot.operation) {
        const conflictPath = snapshot.operation.conflicts[0] ?? null
        setOperationPath(conflictPath)
        setHistoryConflictPath(conflictPath)
        setSelected(WORKING_TREE_COMMIT_ID)
        setInspectorCollapsed(false)
        setWorkspaceView(conflictPath ? 'history' : 'operation')
        setRepositoryNotice(conflictPath
          ? t('repository.notice.conflictPanelOpened', { label: snapshot.operation.label })
          : t('repository.notice.continueInPanel', { label: snapshot.operation.label }))
      } else {
        setRepositoryNotice(success)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        const snapshot = await loadRepository(repository.path)
        applySnapshot(snapshot)
      } catch {
        // 保留原始 Git 操作错误，仓库可通过下一次刷新重新同步。
      }
      setRepositoryNotice(message)
    } finally {
      if (operation) setActiveOperation((current) => current?.key === operation.key ? null : current)
    }
  }
  const handleMergeReference = async (reference: string, label = reference) => {
    if (!repository) return setRepositoryNotice(t('repository.notice.mergeRequiresRepository'))
    if (repository.operation) return setRepositoryNotice(t('repository.notice.finishOperationFirst', { label: repository.operation.label }))
    if (!acquireOperationLock(mergeOperationLock)) return setRepositoryNotice(t('repository.notice.mergeInProgress'))
    try {
      if (!await confirm({ title: t('repository.merge.confirmTitle'), message: t('repository.merge.confirmMessage', { label, branch: repository.branch }), confirmLabel: t('repository.merge.confirm') })) return
      await executeRepositoryAction(
        (path) => mergeRepositoryReference(path, reference),
        t('repository.merge.done', { label, branch: repository.branch }),
        { key: 'merge', label: t('repository.merge.progress'), detail: t('repository.merge.progressDetail', { label, branch: repository.branch }) },
      )
    } finally {
      releaseOperationLock(mergeOperationLock)
    }
  }
  const handleCherryPickCommit = async (commit: Commit) => {
    if (!repository) return setRepositoryNotice(t('repository.notice.cherryPickRequiresRepository'))
    if (repository.operation) return setRepositoryNotice(t('repository.notice.finishOperationFirst', { label: repository.operation.label }))
    const parents = commit.parents ?? (commit.parent ? [commit.parent] : [])
    const parentDetails = parents.map((hash) => {
      const parentCommit = activeCommits.find((candidate) => candidate.fullHash === hash || candidate.id === hash)
      return {
        hash,
        title: parentCommit?.title ?? t('repository.cherryPick.parentUnavailable'),
        author: parentCommit?.author ?? t('repository.cherryPick.unknownAuthor'),
        time: parentCommit ? formatLocalDateTime(parentCommit.commitTime ?? parentCommit.authorTime ?? parentCommit.time) : '—',
      }
    })
    setCherryPickDialog({ commit, parents: parentDetails })
  }
  const confirmCherryPick = async (mainline?: number) => {
    if (!repository || !cherryPickDialog) return
    await executeRepositoryAction(
      (path) => cherryPickRepositoryCommit(path, cherryPickDialog.commit.fullHash ?? cherryPickDialog.commit.id, mainline),
      t('repository.cherryPick.done', { id: cherryPickDialog.commit.id }),
      { key: 'cherry-pick', label: t('repository.cherryPick.progress', { id: cherryPickDialog.commit.id }), detail: t('repository.cherryPick.progressDetail') },
    )
  }
  const handleResetCommit = async (commit: Commit) => {
    if (!repository) return setRepositoryNotice(t('repository.notice.resetRequiresRepository'))
    if (!await confirm({ title: t('repository.reset.confirmTitle'), message: t('repository.reset.confirmMessage', { branch: repository.branch, id: commit.id }), confirmLabel: t('repository.reset.confirm'), variant: 'danger' })) return
    await executeRepositoryAction((path) => resetRepositoryToCommit(path, commit.fullHash ?? commit.id), t('repository.reset.done', { id: commit.id }))
  }
  const handleUndoLastCommit = async (commit: Commit) => {
    if (!repository) return setRepositoryNotice(t('repository.notice.undoRequiresRepository'))
    if (repository.operation) return setRepositoryNotice(t('repository.notice.finishOperationFirst', { label: repository.operation.label }))
    if (!await confirm({ title: t('repository.undo.confirmTitle'), message: t('repository.undo.confirmMessage', { id: commit.id }), confirmLabel: t('repository.undo.confirm'), variant: 'danger' })) return
    await executeRepositoryAction((path) => undoLastCommit(path), t('repository.undo.done', { id: commit.id }))
    setWorkspaceView('changes')
  }
  const handleRevertCommit = async (commit: Commit) => {
    if (!repository) return setRepositoryNotice(t('repository.notice.revertRequiresRepository'))
    if (repository.operation) return setRepositoryNotice(t('repository.notice.finishOperationFirst', { label: repository.operation.label }))
    const parents = commit.parents ?? (commit.parent ? [commit.parent] : [])
    const mainline = parents.length > 1 ? 1 : undefined
    const mergeHint = parents.length > 1 ? t('repository.revert.mergeHint') : ''
    if (!await confirm({ title: t('repository.revert.confirmTitle'), message: t('repository.revert.confirmMessage', { id: commit.id, mergeHint }), confirmLabel: t('repository.revert.confirm') })) return
    await executeRepositoryAction(
      (path) => revertRepositoryCommit(path, commit.fullHash ?? commit.id, mainline),
      t('repository.revert.done', { id: commit.id }),
      { key: 'revert', label: t('repository.revert.progress', { id: commit.id }), detail: t('repository.revert.progressDetail') },
    )
  }
  const handleRebaseCommit = async (commit: Commit) => {
    if (!repository) return setRepositoryNotice(t('repository.notice.rebaseRequiresRepository'))
    if (repository.operation) return setRepositoryNotice(t('repository.notice.finishOperationFirst', { label: repository.operation.label }))
    setRebaseDialog({ commit: commit.fullHash ?? commit.id, label: commit.id })
  }
  const startRebase = async (onto: string) => {
    if (!repository) return
    await executeRepositoryAction((path) => rebaseRepositoryOnto(path, onto), t('repository.rebase.done', { branch: repository.branch, onto: onto.slice(0, 8) }))
    setRebaseDialog(null)
  }
  const handleTagCommit = async (commit: Commit) => {
    if (!repository) return setRepositoryNotice(t('repository.notice.tagRequiresRepository'))
    const tagName = window.prompt(t('repository.tag.prompt', { id: commit.id }))?.trim()
    if (!tagName) return
    await executeRepositoryAction((path) => createRepositoryTag(path, tagName, commit.fullHash ?? commit.id), t('repository.tag.done', { name: tagName }))
  }
  const handleCompareCommit = (commit: Commit) => {
    setCompareBase(commit.fullHash ?? commit.id)
    setWorkspaceView('compare')
  }
  const handleApplyStash = async (reference: string) => {
    await executeRepositoryAction(
      (path) => applyRepositoryStash(path, reference, false),
      t('repository.stash.applyDone', { reference }),
      { key: 'stash', label: t('repository.stash.applyProgress', { reference }), detail: t('repository.stash.applyDetail') },
    )
  }
  const handlePopStash = async (reference: string) => {
    if (!await confirm({ title: t('repository.stash.popConfirmTitle'), message: t('repository.stash.popConfirmMessage', { reference }), confirmLabel: t('repository.stash.pop') })) return
    await executeRepositoryAction(
      (path) => applyRepositoryStash(path, reference, true),
      t('repository.stash.popDone', { reference }),
      { key: 'stash', label: t('repository.stash.popProgress', { reference }), detail: t('repository.stash.popDetail') },
    )
  }
  const handleDropStash = async (reference: string) => {
    if (!await confirm({ title: t('repository.stash.dropConfirmTitle'), message: t('repository.stash.dropConfirmMessage', { reference }), confirmLabel: t('repository.confirm.delete'), variant: 'danger' })) return
    await executeRepositoryAction(
      (path) => dropRepositoryStash(path, reference),
      t('repository.stash.dropDone', { reference }),
      { key: 'stash', label: t('repository.stash.dropProgress', { reference }), detail: t('repository.stash.dropDetail') },
    )
  }
  const handleStashAll = async () => {
    if (!repository) return setRepositoryNotice(t('menu.notice.stashRequiresRepository'))
    await executeRepositoryAction(
      (path) => createRepositoryStash(path, '', false),
      t('menu.notice.stashDone'),
      { key: 'stash', label: t('menu.notice.stashProgress'), detail: t('menu.notice.stashProgressDetail') },
    )
  }
  const handleSelectStash = (reference: string) => {
    const stash = repository?.stashes.find((item) => item.reference === reference)
    const stashCommit = stash ? activeCommits.find((commit) => commit.fullHash === stash.hash) : undefined
    if (!stashCommit) {
      setRepositoryNotice(t('repository.stash.noGraphNode'))
      return
    }
    setQuery('')
    setBranchFilter([])
    setTimeFilter('all')
    setSelected(stashCommit.id)
    setWorkspaceView('history')
  }
  const handlePullBranch = async (branch: string) => {
    const hasLocalChanges = branch === repository?.branch && Boolean(repository?.files.length)
    await executeRepositoryAction(
      (path) => pullRepositoryBranch(path, branch),
      hasLocalChanges ? t('repository.pull.doneKept', { branch }) : t('repository.pull.doneClean', { branch }),
      { key: 'pull', label: hasLocalChanges ? t('repository.pull.progressCheck') : t('repository.pull.progress', { branch }), detail: hasLocalChanges ? t('repository.pull.progressDetailCheck') : t('repository.pull.progressDetail') },
    )
  }
  const handlePush = async () => {
    await executeRepositoryAction((path) => pushRepository(path), t('repository.push.done', { branch: repository?.branch ?? '' }), { key: 'push', label: t('repository.push.progress', { branch: repository?.branch ?? '' }), detail: t('repository.push.progressDetail') })
  }
  const handleForcePush = async () => {
    setForcePushOpen(false)
    await executeRepositoryAction((path) => pushRepositoryWithLease(path), t('repository.push.forceDone', { branch: repository?.branch ?? '' }), { key: 'push', label: t('repository.push.forceProgress', { branch: repository?.branch ?? '' }), detail: t('repository.push.forceDetail') })
  }
  const handleFetch = useCallback(async () => {
    if (!repository || fetching || activeOperation) return
    setActiveOperation({ key: 'fetch', label: t('repository.fetch.progress'), detail: t('repository.fetch.progressDetail') })
    try {
      await fetchNow()
    } finally {
      setActiveOperation((current) => current?.key === 'fetch' ? null : current)
    }
  }, [activeOperation, fetchNow, fetching, repository, t])
  const handleDeleteBranch = async (branch: string) => {
    if (!repository) return setRepositoryNotice(t('repository.notice.deleteBranchRequiresRepository'))
    const remote = branch.includes('/') && branch.startsWith('origin/')
    if (!await confirm({ title: t('repository.branch.deleteConfirmTitle'), message: t(remote ? 'repository.branch.deleteConfirmRemote' : 'repository.branch.deleteConfirmLocal', { branch }), confirmLabel: t('repository.confirm.delete'), variant: 'danger' })) return
    await executeRepositoryAction((path) => deleteRepositoryBranch(path, branch), t('repository.branch.deleteDone', { branch }))
  }
  const copyText = async (value: string, success: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setRepositoryNotice(success)
    } catch {
      setRepositoryNotice(t('repository.notice.copyFailed'))
    }
  }
  const handleJumpBranch = async (branch: string) => {
    let commit = activeCommits.find((item) => item.branches?.includes(branch))
    if (!commit && repository && !historyLoadInProgress.current) {
      historyLoadInProgress.current = true
      setActiveOperation({ key: 'history', label: t('repository.jump.locatingBranch'), detail: t('repository.jump.locatingDetail', { name: branch }) })
      try {
        let guard = 0
        while (!commit && historyStreamHasMore.current && guard < 400) {
          guard += 1
          const page = await loadNextHistoryPage()
          if (!page) break
          commit = mergeHistoryStreamCommits(repository.commits, historyStreamExtras.current)
            .find((item) => item.branches?.includes(branch))
        }
      } finally {
        historyLoadInProgress.current = false
        setActiveOperation((current) => current?.key === 'history' ? null : current)
      }
    }
    if (!commit) {
      setRepositoryNotice(t('repository.jump.branchNotFound', { name: branch }))
      return
    }
    setRepositoryManagerOpen(false)
    setWorkspaceView('history')
    setQuery('')
    setBranchFilter([])
    setTimeFilter('all')
    setSelected(commit.id)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-commit-id="${commit.id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      })
    })
  }

  const handleJumpTag = (tag: string) => {
    const commit = activeCommits.find((item) => item.branches?.includes(tag))
    if (!commit) {
      setRepositoryNotice(t('repository.jump.tagNotFound', { name: tag }))
      return
    }
    setWorkspaceView('history')
    setQuery('')
    setBranchFilter([])
    setTimeFilter('all')
    setSelected(commit.id)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-commit-id="${commit.id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      })
    })
  }
  const openPreferences = (page: PreferencesPage) => {
    setPreferencesPage(page)
    setPreferencesOpen(true)
  }

  const runMenuAction = (id: string) => {
    const recentIndex = menuRecentIndex(id)
    if (recentIndex !== null) {
      const recent = recentRepositories[recentIndex]
      if (recent) void handleOpenRepositoryPath(recent.path)
      return
    }
    const handler = menuActionHandlers[id as keyof typeof menuActionHandlers]
    if (!handler) return
    const selectedReference = selectedCommitBase.fullHash ?? selectedCommitBase.id
    const canOperateOnSelection = !selectedWorkingTree && !selectedStashReference && selectedCommitBase.id !== '—'
    const selectView = (view: WorkspaceView) => {
      setRepositoryManagerOpen(false)
      setWorkspaceView(view)
    }
    const actions: Record<string, (() => void) | undefined> = {
      'new-repository': () => setRepositoryManagerOpen(true),
      'open-repository': () => void handleOpenRepository(),
      'clone-repository': () => setRepositoryManagerOpen(true),
      'close-repository': () => setRepositoryManagerOpen(true),
      'check-updates': () => openPreferences('updates'),
      'preferences': () => openPreferences('general'),
      'find': () => {
        if (repositoryManagerOpen || !repository) {
          document.querySelector<HTMLInputElement>('.repository-catalog-search input')?.focus()
          return
        }
        setWorkspaceView('history')
        window.setTimeout(() => searchRef.current?.focus(), 0)
      },
      'find-next': () => setSearchAction((current) => ({ sequence: current.sequence + 1, direction: 1 })),
      'find-previous': () => setSearchAction((current) => ({ sequence: current.sequence + 1, direction: -1 })),
      'search-repository': () => setWorkspaceView('search'),
      'toggle-word-wrap': () => setPreference('wordWrap', !preferences.wordWrap),
      'diff-unified': () => setPreference('diffLayout', 'unified'),
      'diff-split': () => setPreference('diffLayout', 'split'),
      'toggle-show-whitespace': () => setPreference('showWhitespace', !preferences.showWhitespace),
      'font-increase': () => setPreference('diffFontSize', preferences.diffFontSize + 1),
      'font-decrease': () => setPreference('diffFontSize', preferences.diffFontSize - 1),
      'font-reset': () => setPreference('diffFontSize', 12),
      'view-history': () => selectView('history'),
      'view-changes': () => selectView('changes'),
      'view-stash': () => selectView('stash'),
      'view-recovery': () => selectView('recovery'),
      'view-search': () => selectView('search'),
      'view-tree': () => selectView('tree'),
      'view-compare': () => { setCompareBase(null); selectView('compare') },
      'view-merge': () => selectView('merge'),
      'view-terminal': () => selectView('terminal'),
      'toggle-sidebar': () => setSidebarCollapsed((value) => !value),
      'toggle-inspector': () => setInspectorCollapsed((value) => !value),
      'theme-light': () => setPreference('theme', 'light'),
      'theme-dark': () => setPreference('theme', 'dark'),
      'language-zh': () => setLanguage('zh'),
      'language-en': () => setLanguage('en'),
      'reload': () => window.location.reload(),
      'fetch': () => void handleFetch(),
      'pull': () => { if (repository) void handlePullBranch(repository.branch) },
      'push': () => void handlePush(),
      'commit': () => selectView('changes'),
      'undo-last-commit': () => { if (currentBranchHead) void handleUndoLastCommit(currentBranchHead) },
      'create-branch': () => openCreateBranchDialog(),
      'stash-all': () => void handleStashAll(),
      'show-remotes': () => selectView('remotes'),
      'show-tags': () => selectView('tags'),
      'show-worktrees': () => { setStructureSelection({ kind: 'worktrees' }); selectView('structure') },
      'show-submodules': () => { setStructureSelection({ kind: 'submodules' }); selectView('structure') },
      'show-lfs': () => selectView('lfs'),
      'show-gitflow': () => selectView('gitflow'),
      'merge': () => { if (canOperateOnSelection) void handleMergeReference(selectedReference, t('menu.notice.mergeCommit', { id: selectedCommitBase.id })) },
      'rebase': () => { if (canOperateOnSelection) void handleRebaseCommit(selectedCommitBase) },
      'cherry-pick': () => { if (canOperateOnSelection) void handleCherryPickCommit(selectedCommitBase) },
      'revert': () => { if (canOperateOnSelection) void handleRevertCommit(selectedCommitBase) },
      'reset': () => { if (canOperateOnSelection) void handleResetCommit(selectedCommitBase) },
      'continue-operation': () => {
        if (!repository?.operation) return
        void executeRepositoryAction((path) => continueRepositoryOperation(path), t('menu.notice.continueDone'))
      },
      'skip-operation': () => {
        if (!repository?.operation) return
        void executeRepositoryAction((path) => skipRepositoryOperation(path), t('menu.notice.skipDone'))
      },
      'abort-operation': () => {
        if (!repository?.operation) return
        void (async () => {
          if (!await confirm({ title: t('menu.notice.abortTitle'), message: t('menu.notice.abortMessage'), confirmLabel: t('menu.notice.abortConfirm'), variant: 'danger' })) return
          await executeRepositoryAction((path) => abortRepositoryOperation(path), t('menu.notice.abortDone'))
        })()
      },
      'show-shortcuts': () => setShortcutOpen(true),
      'open-docs': () => { window.open('https://github.com/ViewWay/mySmartGit', '_blank', 'noopener') },
      'report-issue': () => { window.open('https://github.com/ViewWay/mySmartGit/issues/new', '_blank', 'noopener') },
    }
    actions[handler]?.()
  }

  const menuLabels = useMemo(() => buildMenuLabels(language), [language])
  const menuState = useMemo<NativeMenuState>(() => ({
    language,
    hasRepository: Boolean(repository),
    busy: Boolean(activeOperation) || fetching || openingRepository,
    operation: Boolean(repository?.operation),
    hasSelection: Boolean(selected) && !selectedWorkingTree && !selectedStashReference && selectedCommitBase.id !== '—',
    sidebarVisible: !sidebarCollapsed,
    inspectorVisible: !inspectorCollapsed,
    diffLayout: preferences.diffLayout,
    wordWrap: preferences.wordWrap,
    showWhitespace: preferences.showWhitespace,
    diffFontSize: preferences.diffFontSize,
    theme,
    recent: recentRepositories.map((entry) => ({ path: entry.path, name: entry.name })),
  }), [activeOperation, fetching, inspectorCollapsed, language, openingRepository, preferences, recentRepositories, repository, selected, selectedCommitBase.id, selectedStashReference, selectedWorkingTree, sidebarCollapsed, theme])
  useNativeMenu(runMenuAction, menuLabels, menuState)

  const beginPanelResize = (panel: 'sidebar' | 'inspector', event: React.PointerEvent<HTMLSpanElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = panel === 'sidebar' ? sidebarWidth : inspectorWidth
    setPanelResizing(panel)
    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX
      if (panel === 'sidebar') setSidebarWidth(Math.min(360, Math.max(200, startWidth + delta)))
      else setInspectorWidth(Math.min(520, Math.max(300, startWidth - delta)))
    }
    const onUp = () => {
      setPanelResizing(null)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  const beginDetailsResize = (event: React.PointerEvent<HTMLSpanElement>) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = detailsHeight
    setPanelResizing('details')
    const onMove = (moveEvent: PointerEvent) => setDetailsHeight(Math.min(560, Math.max(230, startHeight + moveEvent.clientY - startY)))
    const onUp = () => {
      setPanelResizing(null)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('.repository-add-dialog')) return
      const modifier = event.metaKey || event.ctrlKey
      if (modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        if (repositoryManagerOpen || !repository) {
          document.querySelector<HTMLInputElement>('.repository-catalog-search input')?.focus()
        } else {
          setSidebarCollapsed(false)
          setRepositorySwitcherSignal((current) => current + 1)
        }
      }
      if (modifier && event.key === '/') { event.preventDefault(); setPreference('theme', nextThemePreference[preferences.theme]) }
      if (isTauriRuntime()) {
        const key = event.key.toLowerCase()
        const nativeMenuShortcut = (modifier && !event.altKey && !event.shiftKey && ['n', 'o', 'f', 'b', 'g', 'r', ',', '=', '-', '0'].includes(key))
          || (modifier && event.shiftKey && !event.altKey && ['o', 'w', 'f', 'g', 'p'].includes(key))
          || (modifier && event.altKey && !event.shiftKey && key === 'p')
          || (modifier && event.key === 'Enter')
        // The native menu owns these accelerators; letting them run here would fire twice.
        if (nativeMenuShortcut) return
      }
      if (repositoryManagerOpen || !repository) {
        if (modifier && !event.shiftKey && event.key.toLowerCase() === 'f') { event.preventDefault(); document.querySelector<HTMLInputElement>('.repository-catalog-search input')?.focus() }
        return
      }
      if (modifier && event.key.toLowerCase() === 'f') { event.preventDefault(); searchRef.current?.focus() }
      if (modifier && event.shiftKey && event.key.toLowerCase() === 'f') { event.preventDefault(); void handleFetch() }
      if (modifier && event.key === 'Enter') { event.preventDefault(); setWorkspaceView('changes') }
      if (event.key.toLowerCase() === 'w' && !modifier && document.activeElement?.tagName !== 'INPUT') { setWideDiff((value) => !value) }
      if (event.key.toLowerCase() === 't' && !modifier && document.activeElement?.tagName !== 'INPUT') {
        const activeView = document.querySelector<HTMLButtonElement>('.view-switch button.active')
        const nextView = activeView?.nextElementSibling ?? activeView?.parentElement?.querySelector('button')
        ;(nextView as HTMLButtonElement | null)?.click()
      }
      if (event.key === '?' && !modifier) { setShortcutOpen((value) => !value) }
      if (event.key === 'Escape') { setShortcutOpen(false); setHistoryTarget(null); setHistoryConflictPath(null); setDiffFile(null); setWideDiff(false); setFilterMenu(null); setNotificationOpen(false) }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleFetch, preferences.theme, repositoryManagerOpen, repository])
  const inspectorVisible = workspaceView === 'history' && !inspectorCollapsed && !(wideDiff && diffFile !== null)
  const timeFilterLabels: Record<TimeFilter, string> = { all: t('history.filter.time.all'), day: t('history.filter.time.day'), week: t('history.filter.time.week'), month: t('history.filter.time.month') }
  const branchFilterLabel = branchFilter.length === 0 ? t('history.filter.branchAll') : branchFilter.length === 1 ? branchFilter[0] : t('history.filter.branchSelected', { count: branchFilter.length })
  return <main className={`app-shell ${resolvedTheme === 'light' ? 'theme-light' : ''} ${panelResizing === 'details' ? 'panel-resizing-vertical' : panelResizing ? 'panel-resizing' : ''}`}>
    {repository && !repositoryManagerOpen && <>
      <div className={`sidebar-shell ${sidebarCollapsed ? 'collapsed' : ''}`} style={{ width: sidebarCollapsed ? 0 : sidebarWidth, flexBasis: sidebarCollapsed ? 0 : sidebarWidth }}>
        <Sidebar repository={repository} structureRepository={structureRepository} parentRepository={parentRepository} recentRepositories={recentRepositories} favorites={favoriteRepositories} onToggleFavorite={toggleFavorite} onManageRepositories={() => setRepositoryManagerOpen(true)} openingRepository={openingRepository} structureSelection={structureSelection} repositorySwitcherSignal={repositorySwitcherSignal} onOpenRepository={handleOpenRepository} onOpenRepositoryPath={handleOpenRepositoryPath} onOpenSubmodulePath={handleOpenSubmodulePath} onReturnToParentRepository={handleReturnToParentRepository} onCreateBranch={openCreateBranchDialog} onDeleteBranchPrefix={(prefix) => void handleDeleteBranchPrefix(prefix)} onJumpBranch={handleJumpBranch} onSwitchBranch={(branch) => void handleSwitchBranch(branch)} onPullBranch={(branch) => void handlePullBranch(branch)} onMergeBranch={(branch) => void handleMergeReference(branch)} onDeleteBranch={(branch) => void handleDeleteBranch(branch)} onCopyBranch={(branch) => void copyText(branch, t('shell.copiedBranch', { branch }))} onSelectView={(view) => { setRepositoryManagerOpen(false); setWorkspaceView(view) }} onSelectStructure={(selection) => { setRepositoryManagerOpen(false); setStructureSelection(selection); setWorkspaceView('structure') }} onOpenGitConfig={() => setGitConfigOpen(true)} onOpenCommandLog={() => setCommandLogOpen(true)} onOpenUpdates={() => openPreferences('updates')} onToggle={() => setSidebarCollapsed(!sidebarCollapsed)} sidebarGroups={sidebarGroups} onToggleGroup={(key) => setSidebarGroups((value) => ({ ...value, [key]: !value[key] }))} onSelectStash={handleSelectStash}/>
      </div>
      <span className={`panel-resizer sidebar-resizer ${sidebarCollapsed ? 'hidden' : ''} ${panelResizing === 'sidebar' ? 'active' : ''}`} role="separator" aria-label={t('shell.sidebarResizer')} onPointerDown={(event) => beginPanelResize('sidebar', event)}/>
    </>}
    {repository && !repositoryManagerOpen && <nav className="activity-rail" aria-label={t('nav.railLabel')}>
      <button className={`rail-btn ${workspaceView === 'history' ? 'active' : ''}`} onClick={() => { setRepositoryManagerOpen(false); setWorkspaceView('history') }} title={t('tab.historyTitle')} aria-label={t('tab.history')}><GitCommitHorizontal size={18}/></button>
      <button className={`rail-btn ${workspaceView === 'changes' ? 'active' : ''}`} onClick={() => { setRepositoryManagerOpen(false); setWorkspaceView('changes') }} title={t('tab.changesTitle')} aria-label={t('tab.changes')}><FileDiff size={18}/>{Boolean(repository.files.length) && <small className="rail-badge">{repository.files.length}</small>}</button>
      <button className={`rail-btn ${workspaceView === 'tree' ? 'active' : ''}`} onClick={() => { setRepositoryManagerOpen(false); setWorkspaceView('tree') }} title={t('tab.treeTitle')} aria-label={t('tab.tree')}><FolderTree size={18}/></button>
      <button className={`rail-btn ${workspaceView === 'search' ? 'active' : ''}`} onClick={() => { setRepositoryManagerOpen(false); setWorkspaceView('search') }} title={t('tab.searchTitle')} aria-label={t('tab.search')}><Search size={18}/></button>
      <button className={`rail-btn ${workspaceView === 'recovery' ? 'active' : ''}`} onClick={() => { setRepositoryManagerOpen(false); setWorkspaceView('recovery') }} title={t('tab.recoveryTitle')} aria-label={t('tab.recovery')}><History size={18}/></button>
      <button className={`rail-btn ${workspaceView === 'compare' ? 'active' : ''}`} onClick={() => { setRepositoryManagerOpen(false); setCompareBase(null); setWorkspaceView('compare') }} title={t('tab.compareTitle')} aria-label={t('tab.compare')}><GitCompareArrows size={18}/></button>
      <button className={`rail-btn ${workspaceView === 'merge' ? 'active' : ''}`} onClick={() => { setRepositoryManagerOpen(false); setWorkspaceView('merge') }} title={t('tab.mergeTitle')} aria-label={t('tab.merge')}><GitMerge size={18}/></button>
      {repository.operation && <button className={`rail-btn ${workspaceView === 'operation' ? 'active' : ''}`} onClick={() => setWorkspaceView('operation')} title={t('tab.operationTitle')} aria-label={t('tab.operationTitle')}><CircleDot size={18}/><small className="rail-badge">{repository.operation.conflicts.length || repository.operation.currentStep || '!'}</small></button>}
      <span className="rail-spacer" aria-hidden="true"/>
      <button className={`rail-btn ${['remotes', 'lfs', 'gitflow', 'credentials', 'hosting', 'terminal'].includes(workspaceView) ? 'active' : ''}`} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setToolsMenu({ x: rect.right + 6, y: rect.top }) }} title={t('nav.toolsRail')} aria-label={t('nav.toolsRail')} aria-haspopup="menu" aria-expanded={Boolean(toolsMenu)}><Wrench size={18}/></button>
      <button className={`rail-btn ${repositoryManagerOpen ? 'active' : ''}`} onClick={() => setRepositoryManagerOpen(true)} title={t('nav.repositories')} aria-label={t('nav.repositories')}><FolderGit2 size={18}/></button>
    </nav>}
    <div className={`workspace ${repository && !repositoryManagerOpen ? '' : 'empty-repository'}`}>
      {repository && !repositoryManagerOpen && <header className="topbar">
        <div className="toolbar-actions">
          <button className="toolbar-act" onClick={() => void handleFetch()} disabled={!repository || fetching || Boolean(activeOperation)} title={t('shell.fetchTitle')}><RefreshCw size={16} className={fetching ? 'spin' : ''}/><span>{fetching ? t('shell.fetching') : t('shell.fetch')}</span></button>
          <button className="toolbar-act" onClick={() => repository && void handlePullBranch(repository.branch)} disabled={!repository || Boolean(activeOperation) || Boolean(repository.operation)} title={repository?.operation ? t('shell.finishOperationFirstTitle') : repository?.behind ? t('shell.pullTitleBehind', { count: repository.behind }) : t('shell.pullTitle')}>{activeOperation?.key === 'pull' ? <RefreshCw className="spin" size={16}/> : <CloudDownload size={16}/>}<span>{activeOperation?.key === 'pull' ? t('shell.pulling') : t('shell.pull')}</span>{Boolean(repository?.behind) && <small className="sync-count pull-count">{repository!.behind}</small>}</button>
          <button className="toolbar-act" onClick={() => void handlePush()} disabled={!repository || Boolean(activeOperation) || Boolean(repository.operation)} title={repository?.operation ? t('shell.finishOperationFirstTitle') : repository?.ahead ? t('shell.pushTitleAhead', { count: repository.ahead }) : t('shell.pushTitle')}>{activeOperation?.key === 'push' ? <RefreshCw className="spin" size={16}/> : <CloudUpload size={16}/>}<span>{activeOperation?.key === 'push' ? t('shell.pushing') : t('shell.push')}</span>{Boolean(repository?.ahead) && <small className="sync-count push-count">{repository!.ahead}</small>}</button>
          <button className="toolbar-act" onClick={() => void handleStashAll()} disabled={!repository || Boolean(activeOperation) || Boolean(repository.operation)} title={t('shell.toolbarStashTitle')}><Archive size={16}/><span>{t('shell.toolbarStash')}</span></button>
          <span className="toolbar-sep" aria-hidden="true"/>
          <button className="toolbar-act" onClick={() => openCreateBranchDialog()} disabled={!repository || Boolean(activeOperation) || Boolean(repository.operation)} title={t('shell.newBranchTitle')}><GitBranchPlus size={16}/><span>{t('shell.newBranch')}</span></button>
        </div>
        {(parentRepository || rootRepository) && <div className="branch-context branch-context-chips">{parentRepository && <button className="parent-repository-chip" onClick={() => void handleReturnToParentRepository()} title={t('shell.parentRepoTitle', { path: parentRepository.path })}><ArrowLeft size={13}/><Box size={13}/><span>{parentRepository.name}</span></button>}{rootRepository && <button className="parent-repository-chip root-repository-chip" onClick={() => void handleReturnToRootRepository()} title={t('shell.rootRepoTitle', { path: rootRepository.path })}><FolderGit2 size={13}/><span>{t('shell.rootRepoLabel', { name: rootRepository.name })}</span></button>}</div>}
          <div className={`global-search ${query ? 'has-query' : ''}`}><Search size={16}/><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && workspaceView === 'history') { event.preventDefault(); setSearchAction((current) => ({ sequence: current.sequence + 1, direction: event.shiftKey ? -1 : 1 })) } }} placeholder={workspaceView === 'tags' ? t('shell.searchPlaceholderTags') : repository ? t('shell.searchPlaceholderCommits') : t('shell.searchPlaceholderNoRepository')} disabled={!repository}/>{query ? <><span className="search-result-count">{workspaceView === 'tags' ? t('shell.tagCount', { count: tagSearchCount }) : searchSummary.total ? `${searchSummary.current || 1}/${searchSummary.total}` : '0/0'}</span>{workspaceView === 'history' && <><button type="button" onClick={() => setSearchAction((current) => ({ sequence: current.sequence + 1, direction: -1 }))} disabled={!searchSummary.total} title={t('shell.searchPrevious')}><ChevronUp size={13}/></button><button type="button" onClick={() => setSearchAction((current) => ({ sequence: current.sequence + 1, direction: 1 }))} disabled={!searchSummary.total} title={t('shell.searchNext')}><ChevronDown size={13}/></button><button type="button" className={searchMode === 'filter' ? 'active' : ''} onClick={() => setSearchMode((current) => current === 'locate' ? 'filter' : 'locate')} title={searchMode === 'locate' ? t('shell.searchFilterOn') : t('shell.searchFilterOff')}><ListFilter size={13}/></button></>}<button type="button" onClick={() => setQuery('')} title={t('shell.searchClear')}><X size={13}/></button></> : <kbd>⌘ F</kbd>}</div>
          <div className="top-actions">
            {sidebarCollapsed && <Button variant="icon" className="panel-toggle" onClick={() => setSidebarCollapsed(false)} title={t('common.expandSidebar')}><PanelLeftOpen size={17}/></Button>}
            <Button variant="icon" onClick={() => setShortcutOpen(true)} title={t('shell.shortcuts')}><Command size={17}/></Button>
            <Button variant="icon" className="force-push-trigger" onClick={() => setForcePushOpen(true)} disabled={!repository || Boolean(activeOperation) || Boolean(repository.operation)} title={repository?.operation ? t('shell.finishOperationFirstTitle') : t('shell.forcePushTitle')}><AlertTriangle size={16}/></Button>
            <Button variant="icon" onClick={() => setPreference('theme', nextThemePreference[theme])} title={t('shell.themeToggleTitle', { current: t(`preferences.theme.${theme}`), resolved: t(`preferences.theme.${resolvedTheme}`), next: t(`preferences.theme.${nextThemePreference[theme]}`) })}>{resolvedTheme === 'dark' ? <Sun size={17}/> : <Moon size={17}/>}</Button>
            <Button ref={notificationButtonRef} variant="icon" className="notification" active={notificationOpen} onClick={() => setNotificationOpen((value) => !value)} title={t('shell.notifications')}><Bell size={17}/><span/></Button>
            {notificationOpen && <div ref={notificationPopoverRef} className="notification-popover">
              <div className="popover-heading"><strong>{t('shell.notifications')}</strong><button onClick={() => setNotificationOpen(false)} title={t('shell.closeNotifications')}><X size={13}/></button></div>
              <div className="notification-item unread"><span/><div><strong>{repository ? t('shell.repoHealthy') : t('shell.noRepository')}</strong><small>{repository ? t('shell.repoAheadBehind', { branch: repository.branch, ahead: repository.ahead ?? 0, behind: repository.behind ?? 0 }) : t('shell.startHint')}</small></div></div>
              <div className="notification-item"><span/><div><strong>{repository ? (autoFetchEnabled ? t('shell.autoFetchOn') : t('shell.autoFetchOff')) : t('shell.autoFetchWaiting')}</strong><small>{repository ? (autoFetchEnabled ? t('shell.autoFetchIntervalHint', { count: fetchIntervalMinutes }) : t('shell.autoFetchDisabledHint')) : t('shell.autoFetchPendingHint')}</small></div></div>
              <div className="notification-item"><span/><div><strong>{t('shell.submodules')}</strong><small>{repository ? t('shell.submodulesSynced', { count: repository.submoduleCount }) : t('shell.noRepoData')}</small></div></div>
            </div>}
          </div>
        </header>
      }
      {repository && !repositoryManagerOpen ? <>
      {toolsMenu && <ContextMenu x={toolsMenu.x} y={toolsMenu.y} onClose={() => setToolsMenu(null)}>
        <div className="context-menu-title"><Wrench size={13}/><span>{t('shell.toolsMenuTitle')}</span></div>
        <button onClick={() => { setToolsMenu(null); setRepositoryManagerOpen(false); setWorkspaceView('remotes') }}><Cloud size={14}/><span>{t('nav.remotes')}</span></button>
        <button onClick={() => { setToolsMenu(null); setRepositoryManagerOpen(false); setWorkspaceView('lfs') }}><Box size={14}/><span>{t('nav.lfs')}</span></button>
        <button onClick={() => { setToolsMenu(null); setRepositoryManagerOpen(false); setWorkspaceView('gitflow') }}><GitMerge size={14}/><span>{t('nav.gitflow')}</span></button>
        <button onClick={() => { setToolsMenu(null); setRepositoryManagerOpen(false); setWorkspaceView('credentials') }}><KeyRound size={14}/><span>{t('nav.credentials')}</span></button>
        <button onClick={() => { setToolsMenu(null); setRepositoryManagerOpen(false); setWorkspaceView('hosting') }}><GitPullRequest size={14}/><span>{t('nav.hosting')}</span></button>
        <button onClick={() => { setToolsMenu(null); setRepositoryManagerOpen(false); setWorkspaceView('terminal') }}><SquareTerminal size={14}/><span>{t('nav.terminal')}</span></button>
      </ContextMenu>}
      {filterMenu && <ContextMenu x={filterMenu.x} y={filterMenu.y} onClose={() => setFilterMenu(null)}>
        {filterMenu.kind === 'branch' ? <><div className="context-menu-title"><ListFilter size={13}/><span>{t('history.filter.byBranch')}</span></div><div className="context-menu-options"><button className={branchFilter.length === 0 ? 'selected-option' : ''} onClick={() => { setBranchFilter([]); setFilterMenu(null) }}><Check size={14}/><span>{t('history.filter.branchAll')}</span></button>{availableBranches.map((branch) => <label className="history-filter-option" key={branch}><input type="checkbox" checked={branchFilter.includes(branch)} onChange={() => setBranchFilter((values) => toggleFilterValue(values, branch))}/><GitBranch size={14}/><span>{branch}</span></label>)}</div></> : <><div className="context-menu-title"><Clock3 size={13}/><span>{t('history.filter.byTime')}</span></div>{(['all', 'day', 'week', 'month'] as TimeFilter[]).map((value) => <button className={timeFilter === value ? 'selected-option' : ''} key={value} onClick={() => { setTimeFilter(value); setFilterMenu(null) }}><Clock3 size={14}/><span>{timeFilterLabels[value]}</span></button>)}</>}
      </ContextMenu>}
      <div className={`workspace-grid ${wideDiff && diffFile !== null ? 'diff-wide' : ''} ${inspectorCollapsed ? 'inspector-collapsed' : ''}`} style={{ gridTemplateColumns: `minmax(0, 1fr) ${inspectorVisible ? 1 : 0}px ${inspectorVisible ? inspectorWidth : 0}px` }}>
        {workspaceView === 'history' && <section className="history-pane">
          <div className="history-actionbar">
            <Button variant="secondary" className="filter-button" active={branchFilter.length > 0} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setFilterMenu({ kind: 'branch', x: rect.right - 220, y: rect.bottom + 4 }) }} title={t('history.filter.branchTitle', { label: branchFilterLabel })}><ListFilter size={14}/><span>{branchFilterLabel}</span><ChevronDown size={12}/></Button>
            <Button variant="secondary" className="filter-button" active={timeFilter !== 'all'} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setFilterMenu({ kind: 'time', x: rect.right - 220, y: rect.bottom + 4 }) }} title={t('history.filter.timeTitle', { label: timeFilterLabels[timeFilter] })}><Clock3 size={14}/><span>{timeFilterLabels[timeFilter]}</span><ChevronDown size={12}/></Button>
            <span className="history-actionbar-spacer" aria-hidden="true"/>
            <Button variant="secondary" className="history-edit-button" onClick={() => setHistoryEditOpen(true)} disabled={Boolean(repository.operation) || Boolean(activeOperation)} title={repository.operation ? t('shell.finishOperationFirstTitle') : t('tab.historyEditTitle')}><ListTodo size={14}/><span>{t('tab.historyEdit')}</span></Button>
            <Button variant="danger" className="history-undo-button" disabled={!currentBranchHead || Boolean(repository.operation) || Boolean(activeOperation)} onClick={() => currentBranchHead && void handleUndoLastCommit(currentBranchHead)} title={t('shell.undoLastCommitTitle')}><Undo2 size={14}/><span>{t('shell.undoLastCommit')}</span></Button>
          </div>
          <CommitList key={repository.path} commits={activeCommits} selected={selected} onSelect={(id) => { setSelected(id); setInspectorCollapsed(false) }} query={query} searchMode={searchMode} searchAction={searchAction} onSearchSummaryChange={handleSearchSummaryChange} branchFilter={branchFilter} timeFilter={timeFilter} currentBranch={repository.branch} remoteBranches={repository.remoteBranches} branchTracking={repository.branchTracking} tags={repository.tags} stashReferences={stashReferences} inspectorCollapsed={inspectorCollapsed} onToggleInspector={() => setInspectorCollapsed((value) => !value)} onMergeCommit={(commit) => { const remote = commit.branches?.find((reference) => repository.remoteBranches.includes(reference) || repository.remoteBranches.includes(reference.replace(/^refs\/remotes\//, ''))); const normalized = remote?.replace(/^refs\/remotes\//, ''); void handleMergeReference(remote ?? commit.fullHash ?? commit.id, remote ? t('history.mergeBranchLabel', { name: normalized ?? '' }) : t('history.mergeCommitLabel', { id: commit.id })) }} onCherryPickCommit={(commit) => void handleCherryPickCommit(commit)} onResetCommit={(commit) => void handleResetCommit(commit)} onRevertCommit={(commit) => void handleRevertCommit(commit)} onRebaseCommit={(commit) => void handleRebaseCommit(commit)} onTagCommit={(commit) => void handleTagCommit(commit)} onCompareCommit={handleCompareCommit} onCopyCommit={(commit, mode) => void copyText(mode === 'hash' ? commit.fullHash ?? commit.id : formatCommitClipboard(commit, t), mode === 'hash' ? (commit.status === 'stash' ? t('history.copiedStashHash', { id: commit.id }) : t('history.copiedCommitHash', { id: commit.id })) : (commit.status === 'stash' ? t('history.copiedStashMessage') : t('history.copiedCommitMessage', { id: commit.id })))} onApplyStash={(reference) => void handleApplyStash(reference)} onPopStash={(reference) => void handlePopStash(reference)} onDropStash={(reference) => void handleDropStash(reference)} historyStream={historyStream} onLoadMoreHistory={() => { void loadNextHistoryPage() }}/>
          {diffFile !== null && <div className="history-diff-overlay"><DiffPanel files={selectedCommitFiles} repositoryPath={repository.path} wide={wideDiff} onWideChange={setWideDiff} initialFile={diffFile} onActiveFileChange={setDiffFile} hideFileList loadRows={loadSelectedCommitDiff} loadImageDiff={selectedWorkingTree ? undefined : (filePath) => loadImageFileDiff(repository.path, selectedCommit.parents?.[0] ?? selectedCommit.parent ?? selectedStatsKey, selectedCommitBase.id, filePath)} onOpenFileExternally={(filePath) => { void openRevisionFileExternally(repository.path, selectedCommitBase.id, filePath).then(() => setRepositoryNotice(t('shell.exportedCopy', { path: filePath }))).catch((reason) => setRepositoryNotice(String(reason))) }} onOpenLineHistory={(path, line, side) => setHistoryTarget({ path, line, tab: 'line', revision: selectedWorkingTree ? (side === 'old' ? selectedCommit.parent : undefined) : side === 'old' ? (selectedCommit.parents?.[0] ?? selectedCommit.parent ?? selectedStatsKey) : selectedStatsKey })} review={commitReviewWiring} onClose={() => { setDiffFile(null); setWideDiff(false) }}/></div>}
          {historyConflictPath && repository.operation && <div className="history-diff-overlay history-operation-overlay"><Suspense fallback={<section className="workspace-empty"><RefreshCw className="spin" size={28}/><strong>{t('shell.loadingConflictEditor')}</strong></section>}><OperationPanel repository={repository} onSnapshot={handleSnapshot} onNotice={setRepositoryNotice} initialPath={historyConflictPath} onReturnToChanges={() => { setHistoryConflictPath(null); setOperationPath(null) }} onClose={() => { setHistoryConflictPath(null); setOperationPath(null) }}/></Suspense></div>}
        </section>}
        {workspaceView === 'compare' && <ComparePanel repository={repository} initialBase={compareBase ?? undefined} initialTarget={compareBase ? repository?.branch : undefined} onNotice={setRepositoryNotice}/>} 
        {workspaceView === 'merge' && <MergeQueuePanel repository={repository} onNotice={setRepositoryNotice} onSwitchBranch={handleSwitchBranch}/>} 
        {workspaceView === 'lfs' && <LfsPanel repositoryPath={repository.path} confirm={confirm} onNotice={setRepositoryNotice} onChanged={refreshRepositorySnapshot}/>}
        {workspaceView === 'gitflow' && <GitflowPanel repositoryPath={repository.path} confirm={confirm} onNotice={setRepositoryNotice} onChanged={refreshRepositorySnapshot}/>}
        {workspaceView === 'credentials' && <CredentialsPanel repositoryPath={repository.path} confirm={confirm} onNotice={setRepositoryNotice}/>}
        {workspaceView === 'hosting' && <HostingPanel repositoryPath={repository.path} confirm={confirm} onNotice={setRepositoryNotice}/>}
        {workspaceView === 'terminal' && <TerminalPanel repositoryPath={repository.path} onNotice={setRepositoryNotice}/>}
         {workspaceView === 'operation' && <Suspense fallback={<section className="workspace-empty"><RefreshCw className="spin" size={28}/><strong>{t('shell.loadingConflictEditor')}</strong><span>{t('shell.loadingConflictEditorHint')}</span></section>}><OperationPanel repository={repository} onSnapshot={handleSnapshot} onNotice={setRepositoryNotice} initialPath={operationPath} onReturnToChanges={() => setWorkspaceView('changes')} onClose={() => setWorkspaceView('history')}/></Suspense>}
        {workspaceView === 'changes' && (
          <StagingPage
            repository={repository}
            undoCommitMessage={undoCommitMessage}
            onSnapshot={handleSnapshot}
            onNotice={setRepositoryNotice}
            onOperationChange={(label) => setActiveOperation(label ? { key: 'commit', label, detail: t('shell.commitOperationDetail') } : null)}
             onOpenHistory={(path, tab) => setHistoryTarget({ path, tab })}
             onOpenLineHistory={(path, line) => setHistoryTarget({ path, line, tab: 'line', revision: 'HEAD' })}
             onOpenConflict={(path) => { setOperationPath(path); setHistoryConflictPath(path); setSelected(WORKING_TREE_COMMIT_ID); setWorkspaceView('history') }}
           />
        )}
        {workspaceView === 'stash' && <StashPage repository={repository} onSelectStash={handleSelectStash} onSnapshot={(snapshot) => {
          handleSnapshot(snapshot)
          if (snapshot.operation) {
            setOperationPath(snapshot.operation.conflicts[0] ?? null)
            setSelected(WORKING_TREE_COMMIT_ID)
            setInspectorCollapsed(false)
            setWorkspaceView('history')
          }
        }} onNotice={setRepositoryNotice}/>}
        {workspaceView === 'remotes' && (
          <RemotePanel repository={repository} onSnapshot={handleSnapshot} onNotice={setRepositoryNotice}/>
        )}
        {workspaceView === 'recovery' && <RecoveryPage repository={repository} onSnapshot={(snapshot) => { handleSnapshot(snapshot) }} onNotice={setRepositoryNotice}/>}
        {workspaceView === 'search' && <SearchPage repository={repository} onSnapshot={handleSnapshot} onNotice={setRepositoryNotice} onSelectCommit={(hash) => { setSelected(hash); setWorkspaceView('history') }}/>}
        {workspaceView === 'tree' && repository && <CommitTreeBrowser repositoryPath={repository.path} reference={selectedCommitBase.id} onOpenExternally={(filePath) => { void openRevisionFileExternally(repository.path, selectedCommitBase.id, filePath).then(() => setRepositoryNotice(t('shell.exportedCopy', { path: filePath }))).catch((reason) => setRepositoryNotice(String(reason))) }} onOpenHistory={(filePath) => setHistoryTarget({ path: filePath, tab: 'history' })} onCopyPath={(path) => void copyText(path, t('repository.tree.copiedPath', { path }))} onCopyName={(name) => void copyText(name, t('repository.tree.copiedName', { name }))}/>}
        {(workspaceView === 'structure' || workspaceView === 'tags') && (
          <RepositoryStructurePanel
            repository={structureRepository ?? repository}
            activePath={repository.path}
            view={workspaceView}
            selection={structureSelection}
            onOpenPath={(path, kind) => void (kind === 'submodule' ? handleOpenSubmodulePath(path) : handleOpenRepositoryPath(path))}
            onOpenTag={handleJumpTag}
            query={query}
            onSnapshot={applyStructureSnapshot}
            onNotice={setRepositoryNotice}
          />
        )}
        <span className={`panel-resizer inspector-resizer ${inspectorVisible ? '' : 'hidden'} ${panelResizing === 'inspector' ? 'active' : ''}`} role="separator" aria-label={t('shell.inspectorResizer')} onPointerDown={(event) => beginPanelResize('inspector', event)}/>
        {workspaceView === 'history' && !inspectorCollapsed && <section className="inspector-pane" style={{ gridTemplateRows: `${detailsHeight}px 1px minmax(0, 1fr)` }}>
          <CommitDetails commit={selectedCommit} stashReference={selectedStashReference} onClose={() => setInspectorCollapsed(true)}/>
          <span className={`panel-resizer inspector-vertical-resizer ${panelResizing === 'details' ? 'active' : ''}`} role="separator" aria-label={t('shell.detailsResizer')} onPointerDown={beginDetailsResize}/>
          <section className="details-body">
            <div className="details-tabs" role="tablist" aria-label={t('shell.detailsTabsLabel')}>
              <button role="tab" aria-selected={effectiveDetailsTab === 'diff'} className={effectiveDetailsTab === 'diff' ? 'active' : ''} onClick={() => setDetailsTab('diff')}>{t('shell.detailsTabDiff')}</button>
              {preferences.showTreeTab && <button role="tab" aria-selected={detailsTab === 'tree'} className={detailsTab === 'tree' ? 'active' : ''} disabled={selectedWorkingTree || !selectedCommitBase.id} title={selectedWorkingTree ? t('shell.detailsTabTreeDisabled') : undefined} onClick={() => setDetailsTab('tree')}>{t('shell.detailsTabTree')}</button>}
            </div>
            {effectiveDetailsTab === 'diff' || selectedWorkingTree || !selectedCommitBase.id ? <ChangedFilesPanel files={selectedCommitFiles} loading={selectedCommitFilesLoading} activeFile={diffFile} onOpenFile={(index) => {
            const file = selectedCommitFiles[index]
            const isConflict = selectedWorkingTree && Boolean(file) && (file.type.toUpperCase() === 'U' || repository.operation?.conflicts.includes(file.path))
            if (isConflict) {
              setOperationPath(file.path)
              setHistoryConflictPath(file.path)
              setDiffFile(null)
              return
            }
            setDiffFile(index)
            setWideDiff(false)
          }} onOpenHistory={(path, tab) => setHistoryTarget({ path, tab })}/>
            : <CommitTreeBrowser layout="docked" repositoryPath={repository.path} reference={selectedCommitBase.id} onOpenExternally={(filePath) => { void openRevisionFileExternally(repository.path, selectedCommitBase.id, filePath).then(() => setRepositoryNotice(t('shell.exportedCopy', { path: filePath }))).catch((reason) => setRepositoryNotice(String(reason))) }} onOpenHistory={(filePath) => setHistoryTarget({ path: filePath, tab: 'history' })} onCopyPath={(path) => void copyText(path, t('repository.tree.copiedPath', { path }))} onCopyName={(name) => void copyText(name, t('repository.tree.copiedName', { name }))}/>}
          </section>
        </section>}
      </div>
      <footer className="statusbar">
        <div><span className={repository.operation ? 'status-warning' : 'status-ok'}>{repository.operation ? <AlertTriangle size={11}/> : <Check size={11}/>}</span><span>{repository.operation?.label ?? t('shell.repoHealthy')}</span><span className="status-separator"/><GitBranch size={12}/><span>{repository.operation?.originalBranch ?? repository.branch}</span><span>↑{repository.ahead}</span><span>↓{repository.behind}</span></div>
        <div ref={autoFetchRef} className="statusbar-secondary"><button className="status-command-log" onClick={() => setCommandLogOpen(true)} title={t('shell.commandLogTitle')}><TerminalSquare size={12}/><span>{t('shell.commandLog')}</span></button><span className="status-separator"/><button className={`status-fetch-control ${autoFetchOpen ? 'active' : ''}`} onClick={() => setAutoFetchOpen((value) => !value)} aria-expanded={autoFetchOpen} aria-haspopup="dialog" title={t('shell.autoFetchConfig')}><TimerReset size={12}/><span>{autoFetchEnabled ? t('shell.autoFetchStatusOn', { count: fetchIntervalMinutes }) : t('shell.autoFetchStatusOff')}</span></button><span className="status-separator"/><Box size={12}/><span>{t('shell.submodulesSynced', { count: repository.submoduleCount })}</span><span className="status-separator"/><Code2 size={12}/><span>UTF-8</span>{autoFetchOpen && <div className="auto-fetch-popover" role="dialog" aria-label={t('shell.ariaAutoFetchDialog')}><div className="auto-fetch-heading"><div><strong>{t('shell.autoFetchTitle')}</strong><small>{t('shell.autoFetchHint')}</small></div><Button variant="icon" onClick={() => setAutoFetchOpen(false)} title={t('common.close')}><X size={14}/></Button></div><label className="auto-fetch-toggle"><span><strong>{t('shell.autoFetchEnable')}</strong><small>{t('shell.autoFetchEnableHint')}</small></span><input type="checkbox" checked={autoFetchEnabled} onChange={(event) => setAutoFetchEnabled(event.target.checked)}/><span className="toggle-track" aria-hidden="true"><span/></span></label><div className="auto-fetch-field"><span>{t('shell.fetchInterval')}</span><CompactSelect className="auto-fetch-interval-select" value={fetchIntervalMinutes} options={[1, 5, 10, 15, 30].map((minutes) => ({ value: minutes, label: t('shell.fetchIntervalEvery', { count: minutes }) }))} onChange={setFetchIntervalMinutes} ariaLabel={t('shell.ariaFetchInterval')} disabled={!autoFetchEnabled}/></div><div className="local-polling-settings"><label className="auto-fetch-toggle"><span><strong>{t('shell.localPolling')}</strong><small>{t('shell.localPollingHint')}</small></span><input type="checkbox" checked={localPollingEnabled} onChange={(event) => setLocalPollingEnabled(event.target.checked)}/><span className="toggle-track" aria-hidden="true"><span/></span></label><div className="auto-fetch-field"><span>{t('shell.pollingInterval')}</span><CompactSelect className="auto-fetch-interval-select" value={localPollingIntervalSeconds} options={[2, 5, 10, 30].map((seconds) => ({ value: seconds, label: t('shell.pollingEvery', { count: seconds }) }))} onChange={setLocalPollingIntervalSeconds} ariaLabel={t('shell.ariaPollingInterval')} disabled={!localPollingEnabled}/></div></div><div className="auto-fetch-meta"><span>{t('shell.lastFetch')}</span><strong>{lastFetchAt ? formatDate(lastFetchAt, { hour: '2-digit', minute: '2-digit' }) : t('shell.lastFetchNever')}</strong></div><Button variant="secondary" className="auto-fetch-now" onClick={() => void handleFetch()} disabled={fetching || Boolean(activeOperation)}><RefreshCw size={13} className={fetching ? 'spin' : ''}/>{fetching ? t('shell.fetching') : t('shell.fetchNow')}</Button></div>}</div>
      </footer></> : <RepositoryManagerPage recent={recentRepositories} favorites={favoriteRepositories} current={repository} opening={openingRepository} theme={resolvedTheme} onToggleTheme={() => setPreference('theme', nextThemePreference[theme])} onBack={() => setRepositoryManagerOpen(false)} onOpen={(path) => void handleOpenRepositoryPath(path)} onRegister={registerRepository} onToggleFavorite={toggleFavorite} onForget={forgetRepository} onNotice={setRepositoryNotice}/>}
    </div>
    {openingRepository && <div className="repository-loading" role="status" aria-live="polite"><div><RefreshCw className="spin" size={22}/><strong>{t('shell.loadingRepository')}</strong><span>{t('shell.loadingRepositoryHint')}</span></div></div>}
    <div className={`operation-indicator ${activeOperation ? 'visible' : ''} ${activeOperation?.key === 'cherry-pick' ? 'cherry-pick' : ''}`} role="status" aria-live="polite" aria-hidden={!activeOperation}>{activeOperation && <><RefreshCw className="spin" size={17}/><div><strong>{activeOperation.label}</strong><span>{activeOperation.detail}</span></div></>}</div>
    <HistoryDrawer repositoryPath={repository?.path} filePath={historyTarget?.path ?? null} initialTab={historyTarget?.tab ?? 'history'} lineNumber={historyTarget?.line} revision={historyTarget?.revision} onClose={() => setHistoryTarget(null)}/>
    <CreateBranchDialog open={Boolean(branchDialog)} prefix={branchDialog?.prefix} currentBranch={repository?.branch ?? ''} onClose={() => setBranchDialog(null)} onCreate={handleCreateBranch}/>
    <RebaseDialog open={Boolean(rebaseDialog)} repository={repository} onto={rebaseDialog?.commit ?? null} targetLabel={rebaseDialog?.label ?? ''} onClose={() => setRebaseDialog(null)} onStart={startRebase}/>
    {cherryPickDialog && <CherryPickDialog
      open
      commit={{ id: cherryPickDialog.commit.id, title: cherryPickDialog.commit.title, parents: cherryPickDialog.parents }}
      currentBranch={repository?.branch ?? ''}
      onClose={() => setCherryPickDialog(null)}
      onConfirm={confirmCherryPick}
    />}
    <GitConfigDialog open={gitConfigOpen} onClose={() => setGitConfigOpen(false)} onNotice={setRepositoryNotice}/>
    <CommandLogPanel open={commandLogOpen} onClose={() => setCommandLogOpen(false)}/>
    <PreferencesDialog open={preferencesOpen} page={preferencesPage} onClose={() => setPreferencesOpen(false)} onPageChange={setPreferencesPage}/>
    <ShortcutOverlay open={shortcutOpen} onClose={() => setShortcutOpen(false)}/>
    <ForcePushDialog open={forcePushOpen} branch={repository?.branch ?? ''} busy={activeOperation?.key === 'push'} onCancel={() => setForcePushOpen(false)} onConfirm={() => void handleForcePush()}/>
    {repository && <SequenceEditor open={historyEditOpen} repositoryPath={repository.path} baseRef={selectedCommitBase.parent ?? 'HEAD~10'} onClose={() => setHistoryEditOpen(false)} onChanged={() => { void loadRepository(repository.path).then(handleSnapshot).catch((reason) => setRepositoryNotice(String(reason))) }}/>}
    {confirmDialog}
    {repositoryNotice && <button className="app-notice" onMouseEnter={pauseRepositoryNotice} onMouseLeave={resumeRepositoryNotice} onFocus={pauseRepositoryNotice} onBlur={resumeRepositoryNotice} onClick={() => setRepositoryNotice(null)}>{repositoryNotice}<X size={14}/></button>}
  </main>
}
