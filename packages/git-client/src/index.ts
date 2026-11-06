import type { BisectStatus, BlameLine, CommandLogEntry, ConflictFileContent, FileHistoryEntry, GitUserConfig, MergeQueueSnapshot, RebasePreview, ReflogEntry, RemoteOperationReport, RepositoryBranchTracking, RepositoryCommitStats, RepositoryComparison, RepositoryDiffLine, RepositoryFile, RepositoryRemoteDetail, RepositorySnapshot, RepositorySubmoduleDetail, RepositoryTagDetail, SubmoduleOperationReport, SubmodulePointerDiff } from '@branchline/git-models'

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
    throw new Error('本地仓库操作需要桌面版。请运行 pnpm desktop:dev。')
  }
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke<T>(command, args)
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

export async function loadRepositoryHistory(path: string, commitLimit: number) {
  return invoke<RepositorySnapshot>('load_repository_history', { path, commitLimit })
}

export async function loadRepositoryStateToken(repositoryPath: string) {
  return invoke<string>('load_repository_state_token', { repositoryPath })
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
