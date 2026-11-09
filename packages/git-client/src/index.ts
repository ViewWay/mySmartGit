import type { BisectStatus, BlameLine, CommandLogEntry, ConflictFileContent, FileHistoryEntry, GitUserConfig, MergeQueueSnapshot, RebasePreview, ReflogEntry, RemoteOperationReport, RepositoryBranchTracking, RepositoryCommitStats, RepositoryComparison, RepositoryDiffLine, RepositoryFile, RepositoryRemoteDetail, RepositorySnapshot, RepositorySubmoduleDetail, RepositoryTagDetail, SubmoduleOperationReport, SubmodulePointerDiff } from '@branchline/git-models'
import { BranchlineCommandError } from './errors'

export { BranchlineCommandError } from './errors'

export type {
  RepositoryDetails,
  RepositoryReadme,
  RepositoryRemote,
  BlameLine,
  CommandLogEntry,
  ConflictFileContent,
  FileHistoryEntry,
  GitUserConfig,
  MergeCandidate,
  MergeQueueSnapshot,
  RemoteOperationReport,
  RepositoryCommit,
  RepositoryBranchTracking,
  RepositoryCommitStats,
  RepositoryCommitTemplate,
  RepositoryDiffLine,
  RepositoryFile,
  RepositoryComparison,
  RepositoryRemoteDetail,
  RepositorySnapshot,
  RepositoryOperationState,
  RepositoryOperationStep,
  RepositoryStash,
  RepositorySubmodule,
  RepositoryTagDetail,
  RepositoryWorktree,
  RebasePreview,
  ReflogEntry,
  BisectCommit,
  BisectStep,
  BisectStatus,
  RepositoryResetMode,
  RepositorySubmoduleDetail,
  SubmoduleCommitEntry,
  SubmodulePointerDiff,
  SubmoduleOperationReport,
} from '@branchline/git-models'

export async function loadGitUserConfig() {
  return invoke<GitUserConfig>('load_git_user_config', {})
}

export async function updateGitUserConfig(config: GitUserConfig) {
  return invoke<GitUserConfig>('update_git_user_config', config)
}

export async function updateRepositoryCommitTemplate(repositoryPath: string, content: string) {
  return invoke<RepositorySnapshot>('update_repository_commit_template', { repositoryPath, content })
}

export async function clearRepositoryCommitTemplate(repositoryPath: string) {
  return invoke<RepositorySnapshot>('clear_repository_commit_template', { repositoryPath })
}

export async function loadCommandLogs() {
  return invoke<CommandLogEntry[]>('load_command_logs', {})
}

export async function clearCommandLogs() {
  return invoke('clear_command_logs', {})
}

export function isTauriRuntime() {
  return '__TAURI_INTERNALS__' in window
}

async function invoke<T>(command: string, args: Record<string, unknown>) {
  if (!isTauriRuntime()) {
    throw new BranchlineCommandError('errors.desktopOnly')
  }
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  try {
    return await tauriInvoke<T>(command, args)
  } catch (error) {
    throw BranchlineCommandError.from(error)
  }
}

export async function loadRepository(path: string) {
  return invoke<RepositorySnapshot>('load_repository', { path })
}

export async function pickRepositoryDirectory(title = '选择仓库目录'): Promise<string | null> {
  if (!isTauriRuntime()) throw new Error('选择本地目录需要桌面版')
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({ directory: true, multiple: false, title })
  return (Array.isArray(selected) ? selected[0] : selected) ?? null
}

export async function loadRepositoryDetails(repositoryPath: string) {
  return invoke<import('@branchline/git-models').RepositoryDetails>('load_repository_details', { repositoryPath })
}

export async function loadRepositoryReadme(repositoryPath: string) {
  return invoke<import('@branchline/git-models').RepositoryReadme | null>('load_repository_readme', { repositoryPath })
}

export async function createRepository(destination: string, source: string | null = null) {
  return invoke<import('@branchline/git-models').RepositoryDetails>('create_repository', { destination, source })
}

export async function openRepositoryInVscode(repositoryPath: string) {
  return invoke<void>('open_repository_in_vscode', { repositoryPath })
}

/** 扫描文件夹里的本地 Git 仓库；缺省深度由后端定（3 层），超上限由后端报错。 */
export type ScannedRepository = { name: string; path: string }

export async function scanGitRepositories(root: string, maxDepth?: number) {
  return invoke<ScannedRepository[]>('scan_git_repositories', { root, maxDepth: maxDepth ?? null })
}

export async function loadRepositoryHistory(path: string, commitLimit: number) {
  return invoke<RepositorySnapshot>('load_repository_history', { path, commitLimit })
}

export async function loadRepositoryStateToken(repositoryPath: string) {
  return invoke<string>('load_repository_state_token', { repositoryPath })
}

/** 订阅后端文件监听推送的仓库变更事件（repository_service）；返回取消订阅函数。 */
export async function onRepositoryChanged(
  handler: (event: { repositoryPath: string; generation: number }) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen<{ repository_path: string; generation: number }>('repository-changed', (event) => {
    handler({
      repositoryPath: event.payload.repository_path,
      generation: event.payload.generation,
    })
  })
}

// 定时 Fetch 已移到 Rust service（覆盖全部已开仓库、单飞、失败退避）；前端设置
// 面板只负责下发开关与间隔，快照刷新仍走 repository-changed 推送。
export async function setRepositoryAutoFetchConfig(
  enabled: boolean,
  intervalMinutes: number,
  notifyFailedText?: string,
  notifyRecoveredText?: string,
) {
  return invoke<void>('set_repository_auto_fetch_config', {
    enabled,
    intervalMinutes,
    notifyFailedText,
    notifyRecoveredText,
  })
}

/** 请求系统通知权限（macOS 需授权，Windows/Linux 默认放行）；返回授权结果。 */
export async function requestNotificationPermission(): Promise<string> {
  if (!isTauriRuntime()) return 'granted'
  const { requestPermission } = await import('@tauri-apps/plugin-notification')
  return requestPermission()
}

/** 订阅后台定时 Fetch 完成事件；返回取消订阅函数。reason 仅失败时有值（"auth"/"timeout"/"other"）。 */
export async function onRepositoryAutoFetched(
  handler: (event: { repositoryPath: string; ok: boolean; reason?: string | null }) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen<{ repository_path: string; ok: boolean; reason?: string | null }>(
    'repository-auto-fetched',
    (event) => {
      handler({
        repositoryPath: event.payload.repository_path,
        ok: event.payload.ok,
        reason: event.payload.reason,
      })
    },
  )
}

export async function pickAndLoadRepository(): Promise<RepositorySnapshot | null> {
  if (!isTauriRuntime()) {
    throw new Error('打开本地仓库需要桌面版。请运行 pnpm desktop:dev。')
  }
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({ directory: true, multiple: false, title: '打开 Git 仓库' })
  const path = Array.isArray(selected) ? selected[0] : selected
  return path ? loadRepository(path) : null
}

export async function loadRepositoryFileDiff(repositoryPath: string, filePath: string, showWhitespace = true) {
  return invoke<RepositoryDiffLine[]>('load_file_diff', { repositoryPath, filePath, showWhitespace })
}

export async function loadRepositoryUnstagedFileDiff(repositoryPath: string, filePath: string, showWhitespace = true) {
  return invoke<RepositoryDiffLine[]>('load_unstaged_file_diff', { repositoryPath, filePath, showWhitespace })
}

export async function loadRepositoryStagedFileDiff(repositoryPath: string, filePath: string, showWhitespace = true) {
  return invoke<RepositoryDiffLine[]>('load_staged_file_diff', { repositoryPath, filePath, showWhitespace })
}

export async function fetchRepository(repositoryPath: string) {
  return invoke<RepositorySnapshot>('fetch_repository', { repositoryPath })
}

export async function stageRepositoryFiles(repositoryPath: string, filePaths: string[], force = false) {
  return invoke<RepositoryFile[]>('stage_files', { repositoryPath, filePaths, force })
}

export async function stageRepositoryPatch(repositoryPath: string, patch: string) {
  return invoke<RepositoryFile[]>('stage_patch', { repositoryPath, patch })
}

export async function restoreRepositoryPatch(repositoryPath: string, patch: string) {
  return invoke<RepositoryFile[]>('restore_patch', { repositoryPath, patch })
}

export async function unstageRepositoryPatch(repositoryPath: string, patch: string) {
  return invoke<RepositoryFile[]>('unstage_patch', { repositoryPath, patch })
}

export async function unstageRepositoryFiles(repositoryPath: string, filePaths: string[]) {
  return invoke<RepositoryFile[]>('unstage_files', { repositoryPath, filePaths })
}

export async function discardRepositoryFiles(repositoryPath: string, filePaths: string[]) {
  return invoke<RepositoryFile[]>('discard_worktree_files', { repositoryPath, filePaths })
}

export async function loadRepositoryCommitStats(repositoryPath: string, commit: string) {
  return invoke<RepositoryCommitStats>('load_commit_stats', { repositoryPath, commit })
}

export async function loadRepositoryCommitFiles(repositoryPath: string, commit: string) {
  return invoke<RepositoryFile[]>('load_commit_files', { repositoryPath, commit })
}

export async function commitRepository(repositoryPath: string, message: string, amend = false, sign = false) {
  return invoke<RepositorySnapshot>('commit_repository', { repositoryPath, message, amend, sign })
}

export async function resolveGitlinkConflictsLocal(repositoryPath: string) {
  return invoke<number>('resolve_gitlink_conflicts_local', { repositoryPath })
}

export async function loadConflictFile(repositoryPath: string, filePath: string) {
  return invoke<ConflictFileContent>('load_conflict_file', { repositoryPath, filePath })
}

export async function resolveConflictFile(repositoryPath: string, filePath: string, strategy: 'current' | 'incoming' | 'both' | 'delete' | 'result', content?: string) {
  return invoke<RepositorySnapshot>('resolve_conflict_file', { repositoryPath, filePath, strategy, content })
}

export async function resolveConflictBlock(repositoryPath: string, filePath: string, blockIndex: number, strategy: 'current' | 'incoming' | 'both') {
  return invoke<string>('resolve_conflict_block', { repositoryPath, filePath, blockIndex, strategy })
}

export async function launchConflictMergetool(repositoryPath: string, filePath: string) {
  return invoke<RepositorySnapshot>('launch_conflict_mergetool', { repositoryPath, filePath })
}

export async function continueRepositoryOperation(repositoryPath: string) {
  return invoke<RepositorySnapshot>('continue_repository_operation', { repositoryPath })
}

export async function skipRepositoryOperation(repositoryPath: string) {
  return invoke<RepositorySnapshot>('skip_repository_operation', { repositoryPath })
}

export async function abortRepositoryOperation(repositoryPath: string) {
  return invoke<RepositorySnapshot>('abort_repository_operation', { repositoryPath })
}

export async function previewRepositoryRebase(repositoryPath: string, onto: string) {
  return invoke<RebasePreview>('preview_repository_rebase', { repositoryPath, onto })
}

export async function loadFileHistory(repositoryPath: string, filePath: string) {
  return invoke<FileHistoryEntry[]>('load_file_history', { repositoryPath, filePath })
}

export async function loadFileCommitDiff(repositoryPath: string, commit: string, filePath: string, showWhitespace = true) {
  return invoke<RepositoryDiffLine[]>('load_file_commit_diff', { repositoryPath, commit, filePath, showWhitespace })
}

export async function loadFileBlame(repositoryPath: string, filePath: string, revision?: string) {
  return invoke<BlameLine[]>('load_file_blame', { repositoryPath, filePath, revision })
}

export async function loadLineHistory(repositoryPath: string, filePath: string, line: number, revision?: string) {
  return invoke<FileHistoryEntry[]>('load_line_history', { repositoryPath, filePath, line, revision })
}

export async function previewBranchPrefix(repositoryPath: string, prefix: string) {
  return invoke<string[]>('preview_branch_prefix', { repositoryPath, prefix })
}

export async function deleteBranchPrefix(repositoryPath: string, prefix: string, branches: string[]) {
  return invoke<RepositorySnapshot>('delete_branch_prefix', { repositoryPath, prefix, branches })
}

export async function switchRepositoryBranch(repositoryPath: string, branch: string) {
  return invoke<RepositorySnapshot>('switch_repository_branch', { repositoryPath, branch })
}

export async function createRepositoryBranch(repositoryPath: string, branch: string) {
  return invoke<RepositorySnapshot>('create_repository_branch', { repositoryPath, branch })
}

export async function mergeRepositoryReference(repositoryPath: string, reference: string) {
  return invoke<RepositorySnapshot>('merge_repository_reference', { repositoryPath, reference })
}

export async function cherryPickRepositoryCommit(repositoryPath: string, commit: string, mainline?: number) {
  return invoke<RepositorySnapshot>('cherry_pick_repository_commit', { repositoryPath, commit, mainline: mainline ?? null })
}

export async function pullRepositoryBranch(repositoryPath: string, branch: string) {
  return invoke<RepositorySnapshot>('pull_repository_branch', { repositoryPath, branch })
}

export async function pushRepository(repositoryPath: string) {
  return invoke<RepositorySnapshot>('push_repository', { repositoryPath })
}

export async function pushRepositoryWithLease(repositoryPath: string) {
  return invoke<RepositorySnapshot>('push_repository_with_lease', { repositoryPath })
}

export async function resetRepositoryToCommit(repositoryPath: string, commit: string) {
  return invoke<RepositorySnapshot>('reset_repository_to_commit', { repositoryPath, commit })
}

export async function undoLastCommit(repositoryPath: string) {
  return invoke<RepositorySnapshot>('undo_last_commit', { repositoryPath })
}

export async function revertRepositoryCommit(repositoryPath: string, commit: string, mainline?: number) {
  return invoke<RepositorySnapshot>('revert_repository_commit', { repositoryPath, commit, mainline: mainline ?? null })
}

export async function rebaseRepositoryOnto(repositoryPath: string, commit: string) {
  return invoke<RepositorySnapshot>('rebase_repository_onto', { repositoryPath, commit })
}

export async function createRepositoryTag(repositoryPath: string, tag: string, commit: string) {
  return invoke<RepositorySnapshot>('create_repository_tag', { repositoryPath, tag, commit })
}

export async function deleteRepositoryBranch(repositoryPath: string, branch: string) {
  return invoke<RepositorySnapshot>('delete_repository_branch', { repositoryPath, branch })
}

export async function compareRepositoryRefs(repositoryPath: string, base: string, target: string) {
  return invoke<RepositoryComparison>('compare_repository_refs', { repositoryPath, base, target })
}

export async function loadRepositoryCompareFileDiff(repositoryPath: string, base: string, target: string, filePath: string, showWhitespace = true) {
  return invoke<RepositoryDiffLine[]>('load_compare_file_diff', { repositoryPath, base, target, filePath, showWhitespace })
}

export async function loadMergeQueue(repositoryPath: string) {
  return invoke<MergeQueueSnapshot>('load_merge_queue', { repositoryPath })
}

export async function createRepositoryWorktree(repositoryPath: string, worktreePath: string, branch: string, createBranch: boolean) {
  return invoke<RepositorySnapshot>('create_repository_worktree', { repositoryPath, worktreePath, branch, createBranch })
}

export async function removeRepositoryWorktree(repositoryPath: string, worktreePath: string) {
  return invoke<RepositorySnapshot>('remove_repository_worktree', { repositoryPath, worktreePath })
}

export async function setRepositoryWorktreeLock(repositoryPath: string, worktreePath: string, locked: boolean) {
  return invoke<RepositorySnapshot>('set_repository_worktree_lock', { repositoryPath, worktreePath, locked })
}

export async function pruneRepositoryWorktrees(repositoryPath: string) {
  return invoke<RepositorySnapshot>('prune_repository_worktrees', { repositoryPath })
}

export async function initializeRepositorySubmodule(repositoryPath: string, submodulePath: string) {
  return invoke<RepositorySnapshot>('initialize_repository_submodule', { repositoryPath, submodulePath })
}

export async function updateRepositorySubmodule(repositoryPath: string, submodulePath?: string) {
  return invoke<RepositorySnapshot>('update_repository_submodule', { repositoryPath, submodulePath })
}

export async function syncRepositorySubmodules(repositoryPath: string) {
  return invoke<RepositorySnapshot>('sync_repository_submodules', { repositoryPath })
}

export async function deinitializeRepositorySubmodule(repositoryPath: string, submodulePath: string) {
  return invoke<RepositorySnapshot>('deinitialize_repository_submodule', { repositoryPath, submodulePath })
}

export async function createRepositoryStash(repositoryPath: string, message: string, includeUntracked: boolean) {
  return invoke<RepositorySnapshot>('create_repository_stash', { repositoryPath, message, includeUntracked })
}

export async function createScopedRepositoryStash(repositoryPath: string, scope: 'staged' | 'unstaged', message: string) {
  return invoke<RepositorySnapshot>('create_scoped_repository_stash', { repositoryPath, scope, message })
}

export async function applyRepositoryStash(repositoryPath: string, reference: string, pop: boolean) {
  return invoke<RepositorySnapshot>('apply_repository_stash', { repositoryPath, reference, pop })
}

export async function dropRepositoryStash(repositoryPath: string, reference: string) {
  return invoke<RepositorySnapshot>('drop_repository_stash', { repositoryPath, reference })
}

export async function loadRepositoryStashFiles(repositoryPath: string, reference: string) {
  return invoke<import('@branchline/git-models').RepositoryFile[]>('load_stash_files', { repositoryPath, reference })
}

export async function loadRepositoryStashFileDiff(repositoryPath: string, reference: string, filePath: string, showWhitespace = true) {
  return invoke<RepositoryDiffLine[]>('load_stash_file_diff', { repositoryPath, reference, filePath, showWhitespace })
}

// ---------------------------------------------------------------------------------------------
// 远程仓库 / 分支上游 / 标签管理。
// 破坏性动作的调用约定：先以 confirm=false 取回预览（report.executed=false），
// 用 report.summary + report.warnings 让用户二次确认后，再以 confirm=true 重新调用。
// ---------------------------------------------------------------------------------------------

export async function loadRepositoryRemotes(repositoryPath: string) {
  return invoke<RepositoryRemoteDetail[]>('load_repository_remotes', { repositoryPath })
}

export async function loadRepositoryTagDetails(repositoryPath: string) {
  return invoke<RepositoryTagDetail[]>('load_repository_tag_details', { repositoryPath })
}

export async function addRepositoryRemote(repositoryPath: string, name: string, url: string, fetch: boolean) {
  return invoke<RemoteOperationReport>('add_repository_remote', { repositoryPath, name, url, fetch })
}

export async function removeRepositoryRemote(repositoryPath: string, name: string, confirm: boolean) {
  return invoke<RemoteOperationReport>('remove_repository_remote', { repositoryPath, name, confirm })
}

export async function renameRepositoryRemote(repositoryPath: string, oldName: string, newName: string, confirm: boolean) {
  return invoke<RemoteOperationReport>('rename_repository_remote', { repositoryPath, oldName, newName, confirm })
}

export async function setRepositoryRemoteUrl(repositoryPath: string, name: string, url: string, push: boolean, confirm: boolean) {
  return invoke<RemoteOperationReport>('set_repository_remote_url', { repositoryPath, name, url, push, confirm })
}

export async function renameRepositoryBranch(repositoryPath: string, oldName: string, newName: string, confirm: boolean) {
  return invoke<RemoteOperationReport>('rename_repository_branch', { repositoryPath, oldName, newName, confirm })
}

export async function setRepositoryBranchUpstream(repositoryPath: string, branch: string, upstream: string | null) {
  return invoke<RemoteOperationReport>('set_repository_branch_upstream', { repositoryPath, branch, upstream })
}

export async function createRepositoryAnnotatedTag(repositoryPath: string, tag: string, commit: string, message: string, force = false, confirm = false) {
  return invoke<RemoteOperationReport>('create_repository_annotated_tag', { repositoryPath, tag, commit, message, force, confirm })
}

export async function createRepositorySignedTag(repositoryPath: string, tag: string, commit: string, message: string, signingKey?: string | null, force = false, confirm = false) {
  return invoke<RemoteOperationReport>('create_repository_signed_tag', { repositoryPath, tag, commit, message, signingKey: signingKey ?? null, force, confirm })
}

export async function deleteRepositoryTag(repositoryPath: string, tag: string, confirm: boolean) {
  return invoke<RemoteOperationReport>('delete_repository_tag', { repositoryPath, tag, confirm })
}

export async function deleteRepositoryRemoteTag(repositoryPath: string, remote: string, tag: string, confirm: boolean) {
  return invoke<RemoteOperationReport>('delete_repository_remote_tag', { repositoryPath, remote, tag, confirm })
}

export async function pushRepositoryTags(repositoryPath: string, remote: string, tags: string[], force = false, confirm = false) {
  return invoke<RemoteOperationReport>('push_repository_tags', { repositoryPath, remote, tags, force, confirm })
}

// ---------------------------------------------------------------------------
// W1-5 恢复与问题定位（Reflog / Bisect / Reset 模式）
// ---------------------------------------------------------------------------

export async function loadReflogEntries(repositoryPath: string, branch?: string, limit?: number) {
  return invoke<ReflogEntry[]>('load_reflog_entries', { repositoryPath, branch: branch ?? null, limit: limit ?? null })
}

export async function loadRevisionFiles(repositoryPath: string, reference: string) {
  return invoke<RepositoryFile[]>('load_revision_files', { repositoryPath, reference })
}

export async function loadRevisionFileDiff(repositoryPath: string, reference: string, filePath: string, showWhitespace = true) {
  return invoke<RepositoryDiffLine[]>('load_revision_file_diff', { repositoryPath, reference, filePath, showWhitespace })
}

export async function checkoutReflogEntry(repositoryPath: string, reference: string) {
  return invoke<RepositorySnapshot>('checkout_reflog_entry', { repositoryPath, reference })
}

export async function createBranchFromReflogEntry(repositoryPath: string, reference: string, branch: string) {
  return invoke<RepositorySnapshot>('create_branch_from_reflog_entry', { repositoryPath, reference, branch })
}

export async function resetRepositoryWithMode(repositoryPath: string, commit: string, mode: 'soft' | 'mixed' | 'hard', confirmHard: boolean) {
  return invoke<RepositorySnapshot>('reset_repository_with_mode', { repositoryPath, commit, mode, confirmHard })
}

export async function startRepositoryBisect(repositoryPath: string, bad: string, good: string, newTerm?: string, oldTerm?: string) {
  return invoke<BisectStatus>('start_repository_bisect', { repositoryPath, bad, good, newTerm: newTerm ?? null, oldTerm: oldTerm ?? null })
}

export async function loadRepositoryBisectStatus(repositoryPath: string) {
  return invoke<BisectStatus>('load_repository_bisect_status', { repositoryPath })
}

export async function markRepositoryBisect(repositoryPath: string, verdict: 'bad' | 'good' | 'skip') {
  return invoke<BisectStatus>('mark_repository_bisect', { repositoryPath, verdict })
}

export async function advanceRepositoryBisect(repositoryPath: string) {
  return invoke<BisectStatus>('advance_repository_bisect', { repositoryPath })
}

export async function resetRepositoryBisect(repositoryPath: string) {
  return invoke<RepositorySnapshot>('reset_repository_bisect', { repositoryPath })
}

// ---------------------------------------------------------------------------
// W2-8 图片/SVG 差异预览 与 提交文件树浏览（后端 git_media.rs / git_tree.rs）
// 类型走 inline import()，与既有写法一致，避免改动文件头部的聚合 import。
// ---------------------------------------------------------------------------

export type {
  CommitTree,
  CommitTreeEntry,
  CommitTreeNode,
  ImageFileDiff,
  MediaBlob,
  RevisionFilePreview,
} from '@branchline/git-models'

/** 与后端 git_media.rs 的预览阈值保持一致（4 MiB）。 */
export const MEDIA_PREVIEW_MAX_BYTES = 4 * 1024 * 1024

/**
 * 读取某个 ref 下一个媒体 blob（图片/SVG）。
 * `requestId` 用于协作式取消：切换文件/关闭窗口时调用 cancelMediaPreview 传同一个 id。
 */
export async function loadMediaBlob(repositoryPath: string, reference: string, filePath: string, requestId?: string) {
  return invoke<import('@branchline/git-models').MediaBlob>('load_media_blob', {
    repositoryPath,
    reference,
    filePath,
    requestId: requestId ?? null,
  })
}

/** 差异配对：变更前 / 变更后两张图；新增侧或删除侧可能为 null。 */
export async function loadImageFileDiff(
  repositoryPath: string,
  fromReference: string,
  toReference: string,
  filePath: string,
  requestId?: string,
) {
  return invoke<import('@branchline/git-models').ImageFileDiff>('load_image_file_diff', {
    repositoryPath,
    fromReference,
    toReference,
    filePath,
    requestId: requestId ?? null,
  })
}

/** 取消进行中的媒体读取（按 requestId）。 */
export async function cancelMediaPreview(requestId: string) {
  return invoke<void>('cancel_media_preview', { requestId })
}

/** 按 ref 组出该版本的完整文件树；`partial` 为 true 时须改用懒加载。 */
export async function loadCommitTree(repositoryPath: string, reference: string, maxEntries?: number) {
  return invoke<import('@branchline/git-models').CommitTree>('load_commit_tree', {
    repositoryPath,
    reference,
    maxEntries: maxEntries ?? null,
  })
}

/** 懒加载某个目录的直接子项；directoryPath 传空串表示仓库根。 */
export async function loadCommitTreeChildren(repositoryPath: string, reference: string, directoryPath: string) {
  return invoke<import('@branchline/git-models').CommitTreeEntry[]>('load_commit_tree_children', {
    repositoryPath,
    reference,
    directoryPath,
  })
}

/** 按 ref 预览某个文件：文本截断返回，图片交给 media 字段。 */
export async function loadRevisionFilePreview(
  repositoryPath: string,
  reference: string,
  filePath: string,
  maxTextBytes?: number,
  requestId?: string,
) {
  return invoke<import('@branchline/git-models').RevisionFilePreview>('load_revision_file_preview', {
    repositoryPath,
    reference,
    filePath,
    maxTextBytes: maxTextBytes ?? null,
    requestId: requestId ?? null,
  })
}

/** 无法预览时，导出到临时目录并用系统默认程序打开。 */
export async function openRevisionFileExternally(repositoryPath: string, reference: string, filePath: string) {
  return invoke<string>('open_revision_file_externally', { repositoryPath, reference, filePath })
}

// ---------------------------------------------------------------------------
// W2-9 历史深度搜索与仓库全文搜索/替换
//
// import 放在追加区块内而不是改头部那行，是为了让本轨道的 diff 只落在文件末尾：
// 并行轨道都在动这个文件，改同一条 import 行必然产生冲突。ESM 的 import 声明
// 允许出现在模块顶层的任意位置并被提升，行为与写在文件头完全一致。
import type {
  CommitSearchPage,
  CommitSearchQuery,
  ReplaceBackupSummary,
  ReplacePreview,
  ReplaceReport,
  RepositoryTextFile,
  TextReplaceQuery,
  TextSearchPage,
  TextSearchQuery,
} from '@branchline/git-models'

export type {
  CommitSearchItem,
  CommitSearchPage,
  CommitSearchQuery,
  CommitSearchTarget,
  ReplaceBackupSummary,
  ReplacePreview,
  ReplacePreviewFile,
  ReplaceReport,
  RepositoryTextFile,
  TextReplaceQuery,
  TextSearchMatch,
  TextSearchPage,
  TextSearchQuery,
} from '@branchline/git-models'

/**
 * 历史深度搜索。命令参数是 `(repositoryPath, query)` 两个具名实参：
 * `query` 整体交给 Rust 侧的 `CommitSearchQuery`（`#[serde(default)]`，可省略字段）。
 */
export async function searchCommits(repositoryPath: string, query: CommitSearchQuery) {
  return invoke<CommitSearchPage>('search_commits', { repositoryPath, query })
}

/** 翻页：复用后端已建好的提交索引，不重跑重查询。 */
export async function loadCommitSearchPage(repositoryPath: string, searchId: string, offset: number, pageSize: number) {
  return invoke<CommitSearchPage>('load_commit_search_page', { repositoryPath, searchId, offset, pageSize })
}

export async function searchRepositoryText(repositoryPath: string, query: TextSearchQuery) {
  return invoke<TextSearchPage>('search_repository_text', { repositoryPath, query })
}

export async function loadRepositoryTextPage(
  repositoryPath: string,
  searchId: string,
  offset: number,
  pageSize: number,
  contextLines: number,
) {
  return invoke<TextSearchPage>('load_repository_text_page', { repositoryPath, searchId, offset, pageSize, contextLines })
}

/** dry-run 预览：仓库不会被改动，返回受影响文件与处数。 */
export async function previewTextReplace(repositoryPath: string, query: TextReplaceQuery) {
  return invoke<ReplacePreview>('preview_text_replace', { repositoryPath, query })
}

/** 写盘执行：必须携带预览标识且 confirm=true，否则后端直接拒绝。 */
export async function applyTextReplace(repositoryPath: string, previewId: string, confirm: boolean) {
  return invoke<ReplaceReport>('apply_text_replace', { repositoryPath, previewId, confirm })
}

export async function undoTextReplace(repositoryPath: string, replaceId: string) {
  return invoke<ReplaceReport>('undo_text_replace', { repositoryPath, replaceId })
}

export async function listTextReplaceBackups(repositoryPath: string) {
  return invoke<ReplaceBackupSummary[]>('list_text_replace_backups', { repositoryPath })
}

export async function loadRepositoryTextFile(
  repositoryPath: string,
  filePath: string,
  maxBytes?: number | null,
  revision?: string | null,
) {
  return invoke<RepositoryTextFile>('load_repository_text_file', {
    repositoryPath,
    filePath,
    maxBytes: maxBytes ?? null,
    revision: revision ?? null,
  })
}

export async function saveRepositoryTextFile(
  repositoryPath: string,
  filePath: string,
  content: string,
  baseChecksum: string,
) {
  return invoke<RepositoryTextFile>('save_repository_text_file', { repositoryPath, filePath, content, baseChecksum })
}

/** 中止该仓库所有在跑的搜索/预览任务并清空其分页索引（切仓库、关窗口、发新搜索时调用）。 */
export async function cancelRepositorySearch(repositoryPath: string) {
  return invoke<number>('cancel_repository_search', { repositoryPath })
}

// ---------------------------------------------------------------------------
// W2-10 子模块接入：添加 Submodule / 递归克隆 / 指针差异。
//
// 约定与远程管理一致：写操作第一次调用只做「预览」—— report.executed=false
// 且 requiresConfirmation=true 时 Rust 层没动仓库，前端确认后带 confirm=true 再调一次。
// 所有 Submodule 地址都由 Rust 侧脱敏后返回，凭据不进前端、不进命令日志。
// ---------------------------------------------------------------------------

export async function addRepositorySubmodule(
  repositoryPath: string,
  url: string,
  submodulePath?: string | null,
  name?: string | null,
  branch?: string | null,
  confirm = false,
) {
  return invoke<SubmoduleOperationReport>('add_repository_submodule', {
    repositoryPath,
    url,
    submodulePath: submodulePath || null,
    name: name || null,
    branch: branch || null,
    confirm,
  })
}

export async function listRepositorySubmoduleDetails(repositoryPath: string) {
  return invoke<RepositorySubmoduleDetail[]>('list_repository_submodule_details', { repositoryPath })
}

export async function loadSubmodulePointerDiff(repositoryPath: string, submodulePath: string) {
  return invoke<SubmodulePointerDiff>('load_submodule_pointer_diff', { repositoryPath, submodulePath })
}

export async function cloneRepositoryWithSubmodules(
  destination: string,
  source: string,
  recurseSubmodules = false,
  depth: number | null = null,
  branch: string | null = null,
  singleBranch = false,
) {
  return invoke<import('@branchline/git-models').RepositoryDetails>('clone_repository_with_options', {
    destination,
    source,
    recurseSubmodules,
    depth,
    branch,
    singleBranch,
  })
}

// ---------------------------------------------------------------------------
// W3-1 交互式历史编辑（仅追加；类型块独立以免改动既有 export 列表）
// ---------------------------------------------------------------------------

export type {
  HistoryEditActionKind,
  HistoryEditActionInput,
  HistoryEditEntry,
  HistoryEditSequence,
  HistoryEditImpact,
  HistoryEditReport,
  CherryPickOutcome,
  CherryPickBatchReport,
} from '@branchline/git-models'

import type {
  CherryPickBatchReport,
  HistoryEditActionInput,
  HistoryEditImpact,
  HistoryEditReport,
  HistoryEditSequence,
} from '@branchline/git-models'

/** 读取 `基点..HEAD` 的可编辑提交序列（先旧后新）。 */
export async function loadHistoryEditSequence(repositoryPath: string, baseRef: string) {
  return invoke<HistoryEditSequence>('load_history_edit_sequence', { repositoryPath, baseRef })
}

/** 应用前的影响预览：会重写多少提交、哪些 ref 掉队、是否需要强推。 */
export async function previewHistoryEditImpact(repositoryPath: string, baseRef: string, actions: HistoryEditActionInput[]) {
  return invoke<HistoryEditImpact>('preview_history_edit_impact', { repositoryPath, baseRef, actions })
}

/** 应用序列编辑（脚本化 GIT_SEQUENCE_EDITOR 注入，绝不依赖交互式终端）。 */
export async function applyHistoryEditSequence(repositoryPath: string, baseRef: string, actions: HistoryEditActionInput[]) {
  return invoke<HistoryEditReport>('apply_history_edit_sequence', { repositoryPath, baseRef, actions })
}

/** 改写任意历史提交的消息（后代提交一并重写，树保持不变）。 */
export async function rewordHistoryCommit(repositoryPath: string, commit: string, message: string) {
  return invoke<HistoryEditReport>('reword_history_commit', { repositoryPath, commit, message })
}

/** 删除（drop）单个非合并提交。 */
export async function dropHistoryCommit(repositoryPath: string, commit: string) {
  return invoke<HistoryEditReport>('drop_history_commit', { repositoryPath, commit })
}

/** 批量 cherry-pick：按「先旧后新」应用，空提交结构化跳过，冲突即停。 */
export async function cherryPickHistoryCommits(repositoryPath: string, commits: string[], mainline?: number | null) {
  return invoke<CherryPickBatchReport>('cherry_pick_history_commits', { repositoryPath, commits, mainline: mainline ?? null })
}

// ---------------------------------------------------------------------------
// W3-3 流式提交历史：游标分页 / 有界 / 可取消（apps/desktop/src/git.rs）
//
// 一次「开始」= 后端一个持续读取中的 `git log` 子进程会话；翻页从同一流快照
// 续读，已发行条目不受期间新提交影响。切仓库 / 换分支 / 重开抽屉前必须先
// cancelRepositoryHistoryStream（或仓库级 cancelRepositoryHistory），否则旧
// 任务会被下一次 start 自动替换（同仓库同类型只保留最新一条流）。
// ---------------------------------------------------------------------------

export type { HistoryStreamKind, RepositoryHistoryPage } from '@branchline/git-models'

/** 提交图谱流：从 `git log --all --date-order` 快照流式取第一页（无总上限）。 */
export async function startRepositoryHistoryStream(repositoryPath: string, pageSize?: number | null) {
  return invoke<import('@branchline/git-models').RepositoryHistoryPage>('start_repository_history_stream', {
    repositoryPath,
    pageSize: pageSize ?? null,
  })
}

/** 图谱续页：滚动到底部时调用；hasMore=false 即历史读完。 */
export async function loadRepositoryHistoryNextPage(sessionId: string, pageSize?: number | null) {
  return invoke<import('@branchline/git-models').RepositoryHistoryPage>('load_repository_history_next_page', {
    sessionId,
    pageSize: pageSize ?? null,
  })
}

/** 文件历史流：保留 --follow，重命名跨页可继续追踪（替代旧 200 条硬上限）。 */
export async function startRepositoryFileHistoryStream(repositoryPath: string, filePath: string, pageSize?: number | null) {
  return invoke<import('@branchline/git-models').RepositoryHistoryPage>('start_repository_file_history_stream', {
    repositoryPath,
    filePath,
    pageSize: pageSize ?? null,
  })
}

export async function loadRepositoryFileHistoryNextPage(sessionId: string, pageSize?: number | null) {
  return invoke<import('@branchline/git-models').RepositoryHistoryPage>('load_repository_file_history_next_page', {
    sessionId,
    pageSize: pageSize ?? null,
  })
}

/** 行历史流（-L）：替代旧 200 条硬上限，可分页续取。 */
export async function startRepositoryLineHistoryStream(
  repositoryPath: string,
  filePath: string,
  line: number,
  revision?: string | null,
  pageSize?: number | null,
) {
  return invoke<import('@branchline/git-models').RepositoryHistoryPage>('start_repository_line_history_stream', {
    repositoryPath,
    filePath,
    line,
    revision: revision ?? null,
    pageSize: pageSize ?? null,
  })
}

export async function loadRepositoryLineHistoryNextPage(sessionId: string, pageSize?: number | null) {
  return invoke<import('@branchline/git-models').RepositoryHistoryPage>('load_repository_line_history_next_page', {
    sessionId,
    pageSize: pageSize ?? null,
  })
}

/** 取消单个流会话（kill+wait，不留僵尸）；返回是否确实存在过该会话。 */
export async function cancelRepositoryHistoryStream(sessionId: string) {
  return invoke<boolean>('cancel_repository_history_stream', { sessionId })
}

/** 仓库级取消：切仓库/换分支时中止该仓库全部在跑的历史流，返回被取消的会话数。 */
export async function cancelRepositoryHistory(repositoryPath: string) {
  return invoke<number>('cancel_repository_history', { repositoryPath })
}

// ---------------------------------------------------------------------------
// W3-4 Git LFS 与 Gitflow（apps/desktop/src/git_lfs.rs / git_flow.rs）
// 命令名与 Rust #[tauri::command] 一一对应；错误统一走 reject。
// ---------------------------------------------------------------------------

export type {
  GitflowBranches,
  GitflowConfig,
  GitflowFinishOptions,
  GitflowFinishReport,
  GitflowKind,
  GitflowStartReport,
  GitflowStepReport,
  GitflowStepStatus,
  LfsFile,
  LfsFilesPage,
  LfsOperationReport,
  LfsStatus,
} from '@branchline/git-models'

/** 仓库级 LFS 状态：可用性 / 版本 / 本地安装 / 跟踪模式 / 已跟踪文件数。 */
export async function loadLfsStatus(repositoryPath: string) {
  return invoke<import('@branchline/git-models').LfsStatus>('lfs_status', { repositoryPath })
}

/** 执行 `git lfs install --local` 并返回最新状态。 */
export async function installLfs(repositoryPath: string) {
  return invoke<import('@branchline/git-models').LfsStatus>('lfs_install', { repositoryPath })
}

/** 添加跟踪模式；后端校验 - 开头 / 换行 / NUL 后写回 .gitattributes。 */
export async function trackLfsPattern(repositoryPath: string, pattern: string) {
  return invoke<import('@branchline/git-models').LfsStatus>('lfs_track_pattern', { repositoryPath, pattern })
}

/** 移除跟踪模式；模式不存在时后端返回 git-lfs 的可操作错误。 */
export async function untrackLfsPattern(repositoryPath: string, pattern: string) {
  return invoke<import('@branchline/git-models').LfsStatus>('lfs_untrack_pattern', { repositoryPath, pattern })
}

/** 列出 LFS 文件；limit 缺省 500、硬上限 2000，超出显式 truncated。 */
export async function listLfsFiles(repositoryPath: string, limit?: number | null) {
  return invoke<import('@branchline/git-models').LfsFilesPage>('lfs_list_files', {
    repositoryPath,
    limit: limit ?? null,
  })
}

/** 只填充本地 LFS 缓存，不修改工作区。 */
export async function fetchLfsObjects(repositoryPath: string) {
  return invoke<import('@branchline/git-models').LfsOperationReport>('lfs_fetch', { repositoryPath })
}

/** 抓取并检出当前引用的 LFS 对象；会改动工作区，前端应先确认。 */
export async function pullLfsObjects(repositoryPath: string) {
  return invoke<import('@branchline/git-models').LfsOperationReport>('lfs_pull', { repositoryPath })
}

/** 删除本地不再引用的 LFS 缓存对象；破坏性操作，前端必须先确认。 */
export async function pruneLfsObjects(repositoryPath: string) {
  return invoke<import('@branchline/git-models').LfsOperationReport>('lfs_prune', { repositoryPath })
}

/** 读取本地 gitflow.* 配置（main 缺省时 main 优先、其次 master）。 */
export async function loadGitflowConfig(repositoryPath: string) {
  return invoke<import('@branchline/git-models').GitflowConfig>('load_gitflow_config', { repositoryPath })
}

/** 校验并写入 gitflow.* 本地配置，返回规范化后的值。 */
export async function saveGitflowConfig(repositoryPath: string, config: import('@branchline/git-models').GitflowConfig) {
  return invoke<import('@branchline/git-models').GitflowConfig>('save_gitflow_config', { repositoryPath, config })
}

/** 按 feature/release/hotfix/support 前缀分组的本地分支（短名）。 */
export async function listGitflowBranches(repositoryPath: string) {
  return invoke<import('@branchline/git-models').GitflowBranches>('list_gitflow_branches', { repositoryPath })
}

/** 创建并切换 Gitflow 分支；base 为空时按类型使用 develop / main。 */
export async function startGitflowBranch(repositoryPath: string, kind: import('@branchline/git-models').GitflowKind, name: string, base?: string | null) {
  return invoke<import('@branchline/git-models').GitflowStartReport>('start_gitflow_branch', {
    repositoryPath,
    kind,
    name,
    base: base ?? null,
  })
}

/** 完成分支：本地 --no-ff 合并、可选打标签、删分支；冲突时保留合并状态，绝不 push。 */
export async function finishGitflowBranch(
  repositoryPath: string,
  kind: import('@branchline/git-models').GitflowKind,
  name: string,
  options: import('@branchline/git-models').GitflowFinishOptions,
) {
  return invoke<import('@branchline/git-models').GitflowFinishReport>('finish_gitflow_branch', {
    repositoryPath,
    kind,
    name,
    options,
  })
}

// ---------------------------------------------------------------------------
// W3-5 AI 提交消息生成（apps/desktop/src/git_ai.rs）
//
// API Key 只在后端设置文件中保存；saveAiSettings 的 apiKey 传 null 保留原值，
// 传空字符串清除。返回的 AiSettings 永不包含明文 key。
// ---------------------------------------------------------------------------

export type { AiSettings, AiSettingsInput, AiGenerateOptions, AiCommitMessage, AiLanguage, AiMessageStyle } from '@branchline/git-models'

/** 读取 AI 设置（只回传 apiKeyConfigured 标记，不含明文 key）。 */
export async function loadAiSettings() {
  return invoke<import('@branchline/git-models').AiSettings>('load_ai_settings', {})
}

/** 保存 AI 设置；apiKey 为 null/undefined 时保留后端原 key，空字符串清除。 */
export async function saveAiSettings(
  settings: import('@branchline/git-models').AiSettingsInput,
  apiKey?: string | null,
) {
  return invoke<import('@branchline/git-models').AiSettings>('save_ai_settings', {
    settings,
    apiKey: apiKey ?? null,
  })
}

/** 清除已保存的 API Key，其余设置保持不变。 */
export async function clearAiApiKey() {
  return invoke<import('@branchline/git-models').AiSettings>('clear_ai_api_key', {})
}

/** 基于暂存区 diff（为空回退工作区）生成提交消息；错误文本已由后端脱敏。 */
export async function generateCommitMessage(
  repositoryPath: string,
  options: import('@branchline/git-models').AiGenerateOptions,
) {
  return invoke<import('@branchline/git-models').AiCommitMessage>('generate_commit_message', {
    repositoryPath,
    options,
  })
}

// ---------------------------------------------------------------------------
// W3-6 SSH 密钥、凭据助手与 Git 运行时（apps/desktop/src/git_credentials.rs）
//
// 所有调用都只传结构化参数；后端对文件名、密钥类型、位数与凭据助手做白名单校验。
// 生成密钥仅支持空口令：口令保护需要在终端执行 `ssh-keygen -p -f <私钥>`。
// ---------------------------------------------------------------------------

export type { GitRuntimeInfo, SshKeyInfo, CredentialHelperReport } from '@branchline/git-models'

/** 只读探测 Git / SSH / LFS 版本、凭据助手与 ssh-agent 状态。 */
export async function loadGitRuntimeInfo() {
  return invoke<import('@branchline/git-models').GitRuntimeInfo>('load_git_runtime_info', {})
}

/** 设置（或传 null 清除）自定义 Git 目录；后端会校验目录内含可执行 git。 */
export async function setCustomGitDirectory(path: string | null) {
  return invoke<string | null>('set_custom_git_directory', { path })
}

/** 列出 ~/.ssh 下的密钥对（跳过符号链接与目录）。 */
export async function loadSshKeys() {
  return invoke<import('@branchline/git-models').SshKeyInfo[]>('load_ssh_keys', {})
}

/** 生成 ed25519 / rsa 密钥对（空口令）；同名文件需要 overwrite=true。 */
export async function generateSshKey(
  fileName: string,
  keyType: 'ed25519' | 'rsa',
  bits?: number | null,
  comment?: string | null,
  overwrite = false,
) {
  return invoke<import('@branchline/git-models').SshKeyInfo>('generate_ssh_key', {
    fileName,
    keyType,
    bits: bits ?? null,
    comment: comment ?? null,
    overwrite,
  })
}

/** 读取公钥文本（优先 .pub，只有私钥时由 ssh-keygen 推导；上限 16KB）。 */
export async function readSshPublicKey(fileName: string) {
  return invoke<string>('read_ssh_public_key', { fileName })
}

/** 删除密钥（可选连同 .pub）；后端拒绝目录、符号链接与路径逃逸。 */
export async function deleteSshKey(fileName: string, alsoPublic = false) {
  return invoke<string[]>('delete_ssh_key', { fileName, alsoPublic })
}

/** 设置 global / local 作用域的 credential.helper；空串表示清除。 */
export async function setCredentialHelper(
  scope: 'global' | 'local',
  repositoryPath: string | null,
  helper: string,
) {
  return invoke<import('@branchline/git-models').CredentialHelperReport>('set_credential_helper', {
    scope,
    repositoryPath,
    helper,
  })
}

/** 读取 global（或指定仓库的 local）凭据助手列表。 */
export async function getCredentialHelpers(repositoryPath?: string | null) {
  return invoke<string[]>('get_credential_helpers', { repositoryPath: repositoryPath ?? null })
}

// ---------------------------------------------------------------------------
// W4-1 GitHub / GitLab 托管（apps/desktop/src/git_hosting.rs）
//
// 令牌只在保存设置时提交一次，写入后端 0600 配置文件；随后的列表 / 详情 /
// 创建请求都由后端读取令牌，不再从前端传入。
// ---------------------------------------------------------------------------

export type {
  HostingProvider,
  HostingCiStatus,
  HostingSettings,
  HostingRepository,
  HostingPullRequest,
  HostingCheck,
  HostingPullRequestDetail,
  HostingReviewComment,
  ReviewPublishResult,
  CreatePullRequestInput,
} from '@branchline/git-models'

/** 读取托管设置与「是否已配置令牌」标记（永不返回令牌）。 */
export async function loadHostingSettings() {
  return invoke<import('@branchline/git-models').HostingSettings>('load_hosting_settings', {})
}

/** 保存设置；token 传 null 或空字符串表示保留已保存的令牌。 */
export async function saveHostingSettings(
  provider: 'github' | 'gitlab',
  host: string | null,
  token: string | null,
) {
  return invoke<import('@branchline/git-models').HostingSettings>('save_hosting_settings', {
    provider,
    host,
    token,
  })
}

/** 清除已保存令牌，保留 provider / host。 */
export async function clearHostingToken() {
  return invoke<import('@branchline/git-models').HostingSettings>('clear_hosting_token', {})
}

/** 读取 origin 远端并识别托管平台、项目路径与网页地址。 */
export async function detectHostingRepository(repositoryPath: string) {
  return invoke<import('@branchline/git-models').HostingRepository>('detect_hosting_repository', {
    repositoryPath,
  })
}

/** 列出开放 PR/MR；列表中 ciStatus 固定为 unknown，避免 N+1 请求。 */
export async function listHostingPullRequests(repositoryPath: string) {
  return invoke<import('@branchline/git-models').HostingPullRequest[]>('list_hosting_pull_requests', {
    repositoryPath,
  })
}

/** 创建 PR/MR；GitLab 的 Draft 前缀由后端按 draft 生成。 */
export async function createHostingPullRequest(
  repositoryPath: string,
  input: import('@branchline/git-models').CreatePullRequestInput,
) {
  return invoke<import('@branchline/git-models').HostingPullRequest>('create_hosting_pull_request', {
    repositoryPath,
    input,
  })
}

/** 读取 PR/MR 详情，包括正文、检查列表与可合并状态。 */
export async function loadHostingPullRequest(repositoryPath: string, number: number) {
  return invoke<import('@branchline/git-models').HostingPullRequestDetail>(
    'load_hosting_pull_request',
    { repositoryPath, number },
  )
}

/** B4 拉取远端 PR/MR 的 diff 行评论（GitHub review comments / GitLab discussions）。 */
export async function fetchHostingReviewComments(repositoryPath: string, number: number) {
  return invoke<import('@branchline/git-models').HostingReviewComment[]>(
    'fetch_hosting_review_comments',
    { repositoryPath, number },
  )
}

/**
 * B5 逐条发布本地草稿线程到 PR/MR。成功者回填本地 remote；失败不中断其余线程，
 * 逐条结果由返回值给出。只发布锚定在当前 PR 源分支 head 上的线程。
 */
export async function publishHostingReview(repositoryPath: string, number: number, threadIds: string[]) {
  return invoke<import('@branchline/git-models').ReviewPublishResult[]>('publish_hosting_review', {
    repositoryPath,
    number,
    threadIds,
  })
}

// ---------------------------------------------------------------------------
// 子项目 B1 本地行级审查评论（apps/desktop/src/git_review.rs）
//
// 纯本地存储（<配置目录>/reviews/<仓库键>.json），离线可用；
// 发布 / 拉取远端评论的同步命令在 B4/B5 加入。
// ---------------------------------------------------------------------------

export type {
  ReviewThreadSide,
  ReviewComment,
  ReviewThreadRemote,
  ReviewThread,
} from '@branchline/git-models'

/** 列出当前仓库的全部评论线程；仓库无存储文件时返回空数组。 */
export async function listReviewThreads(repositoryPath: string) {
  return invoke<import('@branchline/git-models').ReviewThread[]>('list_review_threads', {
    repositoryPath,
  })
}

/** 新建或按 id 覆盖保存线程；返回后端规整后的最终形态（含补齐的时间戳）。 */
export async function upsertReviewThread(
  repositoryPath: string,
  thread: import('@branchline/git-models').ReviewThread,
) {
  return invoke<import('@branchline/git-models').ReviewThread>('upsert_review_thread', {
    repositoryPath,
    thread,
  })
}

/** 删除线程（幂等：目标不存在也返回成功）。带 remote 的线程只删本地记录。 */
export async function deleteReviewThread(repositoryPath: string, threadId: string) {
  return invoke<void>('delete_review_thread', { repositoryPath, threadId })
}

/** 翻转线程的已解决标记；返回更新后的线程。 */
export async function setReviewThreadResolved(
  repositoryPath: string,
  threadId: string,
  resolved: boolean,
) {
  return invoke<import('@branchline/git-models').ReviewThread>('set_review_thread_resolved', {
    repositoryPath,
    threadId,
    resolved,
  })
}

// ---------------------------------------------------------------------------
// W4-2 内置终端与自定义命令流水线
// ---------------------------------------------------------------------------

/** 在仓库根目录启动真实 PTY 会话；默认 shell 由后端按平台选择。 */
export async function startTerminalSession(
  repositoryPath: string,
  shell: string | null = null,
  cols = 80,
  rows = 24,
) {
  return invoke<import('@branchline/git-models').TerminalSessionInfo>(
    'start_terminal_session',
    { repositoryPath, shell, cols, rows },
  )
}

/** 读取 fromOffset 之后的增量输出；缓冲区截断时返回保留的尾部。 */
export async function readTerminalOutput(sessionId: string, fromOffset: number) {
  return invoke<import('@branchline/git-models').TerminalOutput>('read_terminal_output', {
    sessionId,
    fromOffset,
  })
}

/** 写入终端输入（单次上限 64 KiB）；数据按原样发送，不经 shell。 */
export async function writeTerminal(sessionId: string, data: string) {
  return invoke<void>('write_terminal', { sessionId, data })
}

/** 把 PTY 窗口调整为 cols x rows（两者都必须 >= 1）。 */
export async function resizeTerminal(sessionId: string, cols: number, rows: number) {
  return invoke<void>('resize_terminal', { sessionId, cols, rows })
}

/** 关闭会话并终止子进程；返回会话是否仍然存在。 */
export async function closeTerminalSession(sessionId: string) {
  return invoke<boolean>('close_terminal_session', { sessionId })
}

/** 列出当前进程内所有终端会话。 */
export async function listTerminalSessions() {
  return invoke<import('@branchline/git-models').TerminalSessionInfo[]>(
    'list_terminal_sessions',
    {},
  )
}

/** 读取 <branchline home>/commands.json；文件不存在时返回空列表。 */
export async function loadPipelineCommands() {
  return invoke<import('@branchline/git-models').PipelineCommands>(
    'load_pipeline_commands',
    {},
  )
}

/** 校验并保存命令列表（0600 JSON），返回后端归一化后的结果。 */
export async function savePipelineCommands(
  commands: import('@branchline/git-models').PipelineCommands,
) {
  return invoke<import('@branchline/git-models').PipelineCommands>(
    'save_pipeline_commands',
    { commands },
  )
}

/**
 * 执行指定命令。timeoutSeconds 会被钳制到 1..600（默认 120）；
 * runId 可选，前端预生成后可调用 cancelPipelineCommand 取消进行中的运行。
 */
export async function runPipelineCommand(
  repositoryPath: string,
  commandId: string,
  timeoutSeconds: number | null = null,
  runId: string | null = null,
) {
  return invoke<import('@branchline/git-models').CommandRunReport>('run_pipeline_command', {
    repositoryPath,
    commandId,
    timeoutSeconds,
    runId,
  })
}

/** 请求取消进行中的运行；runId 已结束或不存在时返回 false。 */
export async function cancelPipelineCommand(runId: string) {
  return invoke<boolean>('cancel_pipeline_command', { runId })
}

export type {
  CommandRunReport,
  PipelineCommand,
  PipelineCommands,
  TerminalOutput,
  TerminalSessionInfo,
} from '@branchline/git-models'
