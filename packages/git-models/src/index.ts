export type RepositoryCommit = {
  id: string
  fullHash: string
  parent?: string
  parents?: string[]
  lane: number
  color: string
  title: string
  message?: string
  author: string
  email: string
  committer?: string
  committerEmail?: string
  authorTime?: string
  commitTime?: string
  avatar: string
  time: string
  branches?: string[]
  status?: 'ahead' | 'merge' | 'local' | 'stash'
  files: number
  additions: number
  deletions: number
}

export type RepositoryCommitStats = {
  hash: string
  files: number
  additions: number
  deletions: number
}

export type GitUserConfig = {
  userName: string
  userEmail: string
  defaultBranch: string
  autocrlf: 'true' | 'input' | 'false'
  pullStrategy: 'merge' | 'rebase' | 'ff-only'
  commitTemplatePath?: string
  commitTemplateContent?: string
}

export type CommandLogEntry = {
  id: number
  startedAt: number
  durationMs: number
  command: string
  workingDirectory: string
  success: boolean
  exitCode?: number
  stdout: string
  stderr: string
}

export type RepositoryFile = {
  path: string
  type: string
  add: number
  del: number
  staged?: boolean
  unstaged?: boolean
  incoming?: boolean
}

export type RepositoryOperationStep = {
  hash: string
  shortHash: string
  title: string
  author: string
  status: 'applied' | 'current' | 'pending'
}

export type RepositoryOperationState = {
  kind: 'merge' | 'rebase' | 'cherry-pick' | 'conflict'
  label: string
  originalBranch?: string
  onto?: string
  currentStep: number
  totalSteps: number
  currentCommit?: string
  message?: string
  conflicts: string[]
  steps: RepositoryOperationStep[]
}

export type ConflictFileContent = {
  path: string
  base: string | null
  current: string | null
  incoming: string | null
  result: string
  currentLabel: string
  incomingLabel: string
  binary: boolean
  gitlink: boolean
  /**
   * 索引里是否存在"当前侧"的 stage 2 记录（追加字段，不改变上面任何字段的语义）。
   * 二进制与 gitlink 的 current 读不出文本、只能为 null，用 null 判可用性会误杀选侧操作；
   * 后端补上该字段后，前端就能精确区分"该侧不存在（增删改冲突）"。
   */
  currentAvailable?: boolean
  /** 索引里是否存在"对方侧"的 stage 3 记录（追加字段，语义同上）。 */
  incomingAvailable?: boolean
}

export type RebasePreview = {
  branch: string
  onto: string
  ontoShortHash: string
  mergeBase: string
  steps: RepositoryOperationStep[]
}

export type RepositoryDiffLine = {
  old: number | null
  next: number | null
  kind: 'same' | 'add' | 'del'
  code: string
  oldCode?: string | null
  newCode?: string | null
  oldNoNewline?: boolean
  newNoNewline?: boolean
}

export type FileHistoryEntry = {
  hash: string
  shortHash: string
  parents: string[]
  author: string
  email: string
  committer: string
  committerEmail: string
  time: string
  commitTime: string
  title: string
  message: string
}

export type BlameLine = {
  line: number
  originalLine: number
  hash: string
  shortHash: string
  author: string
  email: string
  time: string
  content: string
}

export type RepositoryWorktree = {
  path: string
  branch?: string
  head?: string
  bare: boolean
  locked?: string
  prunable?: string
}

export type RepositorySubmodule = {
  path: string
  hash: string
  status: 'ok' | 'modified' | 'uninitialized' | 'missing' | 'unknown'
  branch?: string
}

export type RepositoryRemote = { name: string; fetchUrls: string[]; pushUrls: string[] }
export type RepositoryDetails = {
  name: string
  path: string
  branch: string
  branches: string[]
  remoteBranches: string[]
  submodules: RepositorySubmodule[]
  remotes: RepositoryRemote[]
}
export type RepositoryReadme = { name: string; content: string; truncated: boolean }

export type RepositoryBranchTracking = {
  upstream?: string
  ahead: number
  behind: number
}

export type RepositorySnapshot = {
  name: string
  path: string
  superprojectPath?: string
  branch: string
  remote?: string
  ahead: number
  behind: number
  worktreeCount: number
  submoduleCount: number
  commits: RepositoryCommit[]
  files: RepositoryFile[]
  worktrees: RepositoryWorktree[]
  submodules: RepositorySubmodule[]
  branches: string[]
  remoteBranches: string[]
  branchTracking: Record<string, RepositoryBranchTracking>
  tags: string[]
  stashes: RepositoryStash[]
  commitTemplate?: RepositoryCommitTemplate
  undoCommitMessage?: string
  operation?: RepositoryOperationState
}

export type RepositoryCommitTemplate = {
  path: string
  content: string
}

export type RepositoryStash = {
  reference: string
  hash: string
  message: string
  author: string
  time: string
}

export type RepositoryComparison = {
  base: string
  target: string
  ahead: number
  behind: number
  files: RepositoryFile[]
}

export type MergeCandidate = {
  branch: string
  ahead: number
  behind: number
  merged: boolean
}

export type MergeQueueSnapshot = {
  currentBranch: string
  conflicts: string[]
  candidates: MergeCandidate[]
}

// ---------------------------------------------------------------------------------------------
// 远程与标签管理（与 apps/desktop/src/models.rs 的 git_remote 结构体一一对应）
// URL 已由 Rust 侧脱敏：内嵌凭据会变成 [redacted]，凭据不会进入前端与日志。
// ---------------------------------------------------------------------------------------------

export type RepositoryRemoteDetail = {
  name: string
  fetchUrls: string[]
  /** 单独配置的 push 地址；为空表示沿用 fetch 地址。 */
  pushUrls: string[]
  fetchRefspecs: string[]
  pushRefspecs: string[]
  headBranch: string | null
  cachedBranchCount: number
  /** 上游指向该远程的本地分支。 */
  trackingBranches: string[]
  credentialsRedacted: boolean
}

export type RepositoryTagDetail = {
  name: string
  kind: 'annotated' | 'lightweight'
  target: string
  /** 注释/签名标签自身的对象哈希；轻量标签为空串。 */
  tagObject: string
  tagger: string
  taggerEmail: string
  date: string
  subject: string
  signed: boolean
  /** 指向的提交是否已被任一本地分支包含。 */
  onBranch: boolean
}

/** 远程 / 分支 / 标签写操作的统一返回；executed=false 表示仓库未被改动，等待二次确认。 */
export type RemoteOperationReport = {
  action: string
  executed: boolean
  requiresConfirmation: boolean
  summary: string
  warnings: string[]
  affected: string[]
  remotes: RepositoryRemoteDetail[]
  tags: RepositoryTagDetail[]
  snapshot?: RepositorySnapshot | null
}

// ---------------------------------------------------------------------------
// W1-5 恢复与问题定位：Reflog / Bisect / Reset 模式
// ---------------------------------------------------------------------------

export type ReflogEntry = {
  selector: string
  datedSelector: string
  entryTime: string
  action: string
  subject: string
  commitHash: string
  shortHash: string
  oldHash: string
  commitTitle: string
  author: string
  commitTime: string
  isHead: boolean
}

export type BisectCommit = {
  hash: string
  shortHash: string
  title: string
  author: string
  commitTime: string
}

export type BisectStep = {
  verdict: string
  hash: string
  shortHash: string
  title: string
  author: string
  commitTime: string
}

export type BisectStatus = {
  active: boolean
  message: string
  originalBranch?: string
  currentCommit?: BisectCommit
  badCommit?: BisectCommit
  goodCommits: BisectCommit[]
  tested: BisectStep[]
  remainingCount: number
  stepsEstimate: number
  done: boolean
  badTerm: string
  goodTerm: string
}

export type RepositoryResetMode = 'soft' | 'mixed' | 'hard'

// ---------------------------------------------------------------------------
// W2-9 历史深度搜索与仓库全文搜索/替换（后端 apps/desktop/src/git_search.rs）
//
// 字段名逐一对齐 Rust 侧的 `#[serde(rename_all = "camelCase")]`。
// 注意：搜索/替换的结果都是**分页且有界**的，`total` 在被上限截断时只表示
// 「已索引的条数」，因此每个页面都带 `truncated` + `notice`，UI 必须显示，不得静默。
// ---------------------------------------------------------------------------

/** 历史搜索的目标域，与 Git 的提交筛选参数一一对应。 */
export type CommitSearchTarget =
  | 'commitMessage'
  | 'commitAuthor'
  | 'commitHash'
  /** `git log -S<text>`：只命中该字符串出现次数真正增减的提交。 */
  | 'diffPickaxe'
  /** `git log -G<regex>`：逐行正则匹配差异内容。 */
  | 'diffRegex'

export type CommitSearchQuery = {
  pattern: string
  target: CommitSearchTarget
  caseSensitive: boolean
  wholeWord: boolean
  /** true 走 Git 扩展正则（-E），false 走固定字符串（-F）。 */
  regex: boolean
  /** 限定分支/范围；为空表示 --all。 */
  revisions: string[]
  paths: string[]
  excludePaths: string[]
  maxCommits?: number | null
  pageSize: number
  offset: number
}

export type CommitSearchItem = {
  hash: string
  shortHash: string
  title: string
  message: string
  author: string
  email: string
  date: string
  refs: string[]
}

export type CommitSearchPage = {
  searchId: string
  target: CommitSearchTarget
  pattern: string
  total: number
  offset: number
  pageSize: number
  hasMore: boolean
  truncated: boolean
  cancelled: boolean
  items: CommitSearchItem[]
  notice?: string | null
}

export type TextSearchQuery = {
  pattern: string
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
  /** 为空表示工作区；否则搜索该 rev 的树。 */
  revision?: string | null
  includes: string[]
  excludePaths: string[]
  contextLines: number
  maxMatches?: number | null
  pageSize: number
  offset: number
}

export type TextSearchMatch = {
  filePath: string
  lineNumber: number
  content: string
  /** 命中位于二进制/非 UTF-8 文件：内容不展示，但记录保留，不能静默丢弃。 */
  binary: boolean
  contextBefore: string[]
  contextAfter: string[]
  revision?: string | null
}

export type TextSearchPage = {
  searchId: string
  pattern: string
  revision?: string | null
  total: number
  matchedFiles: number
  offset: number
  pageSize: number
  hasMore: boolean
  truncated: boolean
  cancelled: boolean
  items: TextSearchMatch[]
  notice?: string | null
}

export type TextReplaceQuery = {
  pattern: string
  replacement: string
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
  includes: string[]
  excludePaths: string[]
  maxFiles?: number | null
}

export type ReplacePreviewFile = {
  filePath: string
  occurrences: number
  sampleLines: number[]
  sizeBytes: number
  /** 非空表示该文件被跳过，不会写盘。 */
  skipped?: string | null
}

export type ReplacePreview = {
  previewId: string
  pattern: string
  replacement: string
  files: ReplacePreviewFile[]
  fileCount: number
  totalOccurrences: number
  skippedFiles: number
  /** 预览范围被上限截断时禁止执行替换（范围不完整时写盘等于误伤）。 */
  truncated: boolean
  requiresConfirmation: boolean
  estimatedBytes: number
  notice?: string | null
}

export type ReplaceReport = {
  replaceId: string
  executed: boolean
  filesChanged: string[]
  occurrences: number
  warnings: string[]
  backupPath?: string | null
  backupAvailable: boolean
  restoredFiles: string[]
  skipped: string[]
  notice?: string | null
}

export type ReplaceBackupSummary = {
  replaceId: string
  createdAtMs: number
  fileCount: number
  occurrences: number
  byteSize: number
  pattern: string
  replacement: string
}

export type RepositoryTextFile = {
  filePath: string
  revision?: string | null
  content: string
  sizeBytes: number
  truncated: boolean
  /** 保存时的乐观并发凭据：不匹配就拒绝覆盖。 */
  checksum: string
  lineCount: number
  binary: boolean
  notice?: string | null
}
