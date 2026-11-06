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
  kind: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'conflict'
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
// W2-8 图片/SVG 差异预览 与 提交文件树浏览（后端 git_media.rs / git_tree.rs）
// ---------------------------------------------------------------------------

/** 与 Rust `MediaBlob` 对齐；字节载荷只在不超阈值时存在。 */
export type MediaBlob = {
  path: string
  reference: string
  oid: string
  mime: string
  extension: string
  previewKind: 'image' | 'svg' | 'other'
  sizeBytes: number
  width: number | null
  height: number | null
  previewable: boolean
  tooLarge: boolean
  dataBase64: string | null
  cached: boolean
}

export type ImageFileDiff = {
  path: string
  fromReference: string
  toReference: string
  before: MediaBlob | null
  after: MediaBlob | null
  identical: boolean
  error: string | null
}

/** 嵌套树节点（小仓库一次成树）。 */
export type CommitTreeNode = {
  name: string
  path: string
  kind: 'tree' | 'blob' | 'commit' | 'symlink' | string
  mode: string
  oid: string
  sizeBytes: number | null
  children: CommitTreeNode[]
}

/** 单层目录的直接子项（大目录懒加载）。 */
export type CommitTreeEntry = {
  name: string
  path: string
  kind: 'tree' | 'blob' | 'commit' | 'symlink' | string
  mode: string
  oid: string
  sizeBytes: number | null
  hasChildren: boolean
}

export type CommitTree = {
  reference: string
  oid: string
  /** 非 partial 时是条目总数；partial 时只是后端有界扫描读到的下界（一定 > maxEntries）。 */
  nodeCount: number
  // true 表示条目过多，只带了「精确的根层单层列表」，前端必须走懒加载。
  partial: boolean
  maxEntries: number
  roots: CommitTreeNode[]
}

export type RevisionFilePreview = {
  path: string
  reference: string
  oid: string
  sizeBytes: number
  kind: 'text' | 'image' | 'binary' | 'too_large' | string
  text: string | null
  truncated: boolean
  media: MediaBlob | null
  error: string | null
}

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

// ---------------------------------------------------------------------------
// W2-10 子模块接入：添加 Submodule / 递归克隆 / 指针差异
// 对应 apps/desktop/src/git_submodule.rs 与 models.rs 的同名结构体。
// 地址一律由 Rust 侧脱敏：内嵌凭据替换为 [redacted]，凭据不进前端也不进命令日志。
// ---------------------------------------------------------------------------

/** `.gitmodules` 与 `submodule status --recursive` 合并出的子模块明细。 */
export type RepositorySubmoduleDetail = {
  /** 相对父仓库的路径，始终用 `/` 分隔。 */
  path: string
  /** `.gitmodules` 里的段名；未配置时退化为路径。 */
  name: string
  /** 已脱敏的子模块地址。 */
  url: string
  /** `.gitmodules` 配置的跟踪分支；为空表示跟随父仓库记录的提交。 */
  configuredBranch?: string
  status: RepositorySubmodule['status']
  initialized: boolean
  /** 父仓库 HEAD 记录的 gitlink 提交；未提交时为空串。 */
  headCommit: string
  /** 父仓库索引记录的 gitlink 提交。 */
  stagedCommit: string
  /** 子模块工作区 HEAD；未初始化时为空串。 */
  checkedOutCommit: string
  /** 子模块工作区的未提交改动文件数；超大仓库未探测时为 null。 */
  dirtyFiles: number | null
  /** 该路径下的嵌套子模块数量。 */
  nestedCount: number
  credentialsRedacted: boolean
  /** 磁盘上的绝对路径，供「下钻打开子模块仓库」复用。 */
  absolutePath: string
}

/** 子模块指针差异里列出的单条提交（子模块仓库内部的新增提交）。 */
export type SubmoduleCommitEntry = {
  hash: string
  shortHash: string
  title: string
  author: string
  email: string
  commitTime: string
}

/** 子模块差异语义：指针从哪个提交移到哪个提交，以及子模块内部为此新增了什么。 */
export type SubmodulePointerDiff = {
  path: string
  name: string
  /** 已脱敏的子模块地址。 */
  url: string
  absolutePath: string
  headCommit: string
  stagedCommit: string
  currentCommit: string
  /** 实际用于比较的旧提交（优先父仓库 HEAD 记录）。 */
  previousCommit: string
  /** 实际用于比较的新提交；未初始化时为空串。 */
  targetCommit: string
  changed: boolean
  /** 指针变化只落在索引里（已暂存未提交）。 */
  pointerStaged: boolean
  /** 子模块工作区 HEAD 与索引记录不一致（未暂存的指针移动）。 */
  pointerUnstaged: boolean
  uninitialized: boolean
  detached: boolean
  addedCommits: SubmoduleCommitEntry[]
  addedCount: number
  /** 指针后移丢掉的提交数（非快进 / 回退）。 */
  removedCount: number
  fastForward: boolean
  filesChanged: number
  additions: number
  deletions: number
  dirtyFiles: number
  summary: string
  warnings: string[]
}

/** 添加子模块的统一返回；executed=false 表示仓库未被改动，等待二次确认。 */
export type SubmoduleOperationReport = {
  action: string
  executed: boolean
  requiresConfirmation: boolean
  summary: string
  warnings: string[]
  affected: string[]
  submodules: RepositorySubmoduleDetail[]
  snapshot?: RepositorySnapshot | null
}

// ---------------------------------------------------------------------------
// W3-1 交互式历史编辑（git_history_edit.rs 的 TS 镜像，仅追加）
// ---------------------------------------------------------------------------

/** 交互式序列编辑的动作取值域；与后端 ALL_ACTIONS 常量一一对应。 */
export type HistoryEditActionKind = 'pick' | 'reword' | 'drop' | 'fixup' | 'squash' | 'edit'

/** 单条序列动作输入：一条对应 `基点..HEAD` 内的一个提交，数组顺序即新历史顺序。 */
export type HistoryEditActionInput = {
  /** 提交完整哈希（40 位十六进制），集合内必须恰好出现一次。 */
  hash: string
  action: HistoryEditActionKind
  /** reword 必填；squash 可选（缺省自动生成合并消息）；其余动作忽略。 */
  message?: string | null
}

/** 序列编辑器单行的提交元数据。 */
export type HistoryEditEntry = {
  hash: string
  shortHash: string
  title: string
  /** 完整提交信息，供 reword 预填。 */
  message: string
  author: string
  email: string
  commitTime: string
  parents: string[]
  isMerge: boolean
  /** 提交树对象，reword 前后必须一致。 */
  tree: string
}

/** `load_history_edit_sequence` 的结果：可编辑提交序列（先旧后新）。 */
export type HistoryEditSequence = {
  repositoryPath: string
  branch: string
  baseRef: string
  baseHash: string
  head: string
  entries: HistoryEditEntry[]
  warnings: string[]
}

/** 应用前影响预览：重写规模、掉队分支/标签、强推风险。 */
export type HistoryEditImpact = {
  branch: string
  baseHash: string
  headBefore: string
  total: number
  dropped: number
  folded: number
  reworded: number
  rewrittenUpper: number
  expectedResultCount: number
  branchesLeftBehind: string[]
  tagsOnRewritten: string[]
  upstream?: string | null
  published: boolean
  dangerous: boolean
  warnings: string[]
}

/** 序列应用报告；status 机器枚举。 */
export type HistoryEditReport = {
  status: 'completed' | 'stopped'
  branch: string
  baseHash: string
  headBefore: string
  headAfter: string
  resultCount: number
  recovery?: string | null
  notice?: string | null
}

/** 批量 cherry-pick 单条结果；status 机器枚举（空提交为结构化跳过）。 */
export type CherryPickOutcome = {
  hash: string
  shortHash: string
  title: string
  status: 'applied' | 'skippedEmpty' | 'conflict' | 'failed'
  detail?: string | null
}

/** 批量 cherry-pick 报告：先旧后新应用，冲突即停并给出恢复指引。 */
export type CherryPickBatchReport = {
  requested: number
  applied: number
  skippedEmpty: number
  outcomes: CherryPickOutcome[]
  stoppedAt?: string | null
  recovery?: string | null
  headBefore: string
  headAfter: string
}

// ---------------------------------------------------------------------------
// W3-3 流式提交历史（游标分页 / 有界 / 可取消）——与 models.rs 同名结构对齐
// ---------------------------------------------------------------------------

/** 历史流类型：graph=提交图谱；file=文件历史（--follow）；line=行历史（-L）。 */
export type HistoryStreamKind = 'graph' | 'file' | 'line'

/**
 * 流式历史一页：`sessionId` 指向后端持续读取中的 `git log` 子进程会话。
 * 翻页从同一进程快照续读：已发行条目不受期间新提交影响（游标稳定、不重不漏）。
 * `truncated=true` 表示本页有超出字符预算的标题/正文被显式截断（见 notice）；
 * 字节预算只会推迟记录到下一页，绝不静默丢数据（靠 `hasMore` 续取）。
 */
export type RepositoryHistoryPage = {
  sessionId: string
  kind: HistoryStreamKind
  /** 仅 graph 流非空；lane 携带跨页一致的轨道状态。 */
  commits: RepositoryCommit[]
  /** 仅 file/line 流非空。 */
  entries: FileHistoryEntry[]
  /** 会话累计已发出条数（含本页）。 */
  emitted: number
  hasMore: boolean
  truncated: boolean
  notice?: string | null
  pageBytes: number
}

// ---------------------------------------------------------------------------
// W3-4 Git LFS 管理（apps/desktop/src/git_lfs.rs）——与 Rust 结构逐字段对齐
// ---------------------------------------------------------------------------

/**
 * 仓库级 LFS 状态。`available` 表示本机能否执行 `git lfs version`；
 * `installedLocally` 表示当前仓库是否写过 filter.lfs.*（install --local）。
 * 未安装 git-lfs 不是错误：available=false + notice 给出安装指引。
 */
export type LfsStatus = {
  available: boolean
  version?: string | null
  installedLocally: boolean
  /** `.gitattributes` 中 filter=lfs 的模式（后端已去重）。 */
  patterns: string[]
  trackedFileCount: number
  notice?: string | null
}

export type LfsFile = {
  /** 完整 64 字符 OID。 */
  oid: string
  /** 字节数；git-lfs 未给出大小时为 0。 */
  size: number
  path: string
  /** true 表示工作区已下载完整对象；false 表示仍是 LFS 指针。 */
  downloaded: boolean
}

/** `truncated=true` 表示超过请求上限（默认 500、硬上限 2000），绝不静默截断。 */
export type LfsFilesPage = {
  files: LfsFile[]
  truncated: boolean
}

/** fetch / pull / prune 的成功回执；失败走 invoke 的 reject。 */
export type LfsOperationReport = {
  action: 'fetch' | 'pull' | 'prune' | string
  summary: string
  output: string
}

// ---------------------------------------------------------------------------
// W3-4 Gitflow 工作流（apps/desktop/src/git_flow.rs）——与 Rust 结构逐字段对齐
// ---------------------------------------------------------------------------

export type GitflowKind = 'feature' | 'release' | 'hotfix' | 'support'

/** 本地 git config 的 gitflow.* 键；main 缺省时 main 优先、其次 master。 */
export type GitflowConfig = {
  mainBranch: string
  developBranch: string
  featurePrefix: string
  releasePrefix: string
  hotfixPrefix: string
  supportPrefix: string
  /** 发布标签前缀，默认空。 */
  tagPrefix: string
}

/** 分组只含去掉前缀后的短名，start / finish 直接接收短名。 */
export type GitflowBranches = {
  mainBranch: string
  developBranch: string
  feature: string[]
  release: string[]
  hotfix: string[]
  support: string[]
}

export type GitflowStartReport = {
  kind: GitflowKind
  branch: string
  base: string
  head: string
}

export type GitflowFinishOptions = {
  tag: boolean
  tagMessage?: string | null
}

export type GitflowStepStatus = 'completed' | 'skipped' | 'failed' | 'conflict'

export type GitflowStepReport = {
  action: string
  status: GitflowStepStatus
  detail?: string | null
}

/**
 * 完成报告。`conflicts=true` 时 Git 的 MERGE_HEAD 仍保留（后端不自动 abort），
 * 用户可到现有「操作」页继续或中止；`guidance` 给出可操作说明。
 */
export type GitflowFinishReport = {
  kind: GitflowKind
  branch: string
  completed: boolean
  conflicts: boolean
  steps: GitflowStepReport[]
  guidance?: string | null
  headBefore: string
  headAfter: string
}

// ---------------------------------------------------------------------------
// W3-5 AI 提交消息生成（apps/desktop/src/git_ai.rs）——与 Rust 同名结构对齐
//
// API Key 只存后端配置文件；AiSettings 仅用 `apiKeyConfigured` 标记是否已配置，
// 前端永远拿不到明文。save 时 apiKey 传 null 表示保留原 key，空字符串表示清除。
// ---------------------------------------------------------------------------

export type AiLanguage = 'zh' | 'en'

export type AiMessageStyle = 'conventional' | 'plain'

/** 暴露给前端的 AI 设置；apiKeyConfigured 只表示后端是否已保存 key。 */
export type AiSettings = {
  baseUrl: string
  model: string
  language: AiLanguage
  style: AiMessageStyle
  includeBody: boolean
  /** subject 字符上限（后端会钳制到 16–200）。 */
  maxSubjectChars: number
  apiKeyConfigured: boolean
}

/** 保存设置时的输入（不含 apiKeyConfigured）。 */
export type AiSettingsInput = Omit<AiSettings, 'apiKeyConfigured'>

/** 单次生成的可选覆盖项；缺省时沿用已保存设置。 */
export type AiGenerateOptions = {
  language?: AiLanguage | null
  style?: AiMessageStyle | null
  includeBody?: boolean | null
  maxSubjectChars?: number | null
}

/**
 * 生成结果。note 标明降级来源（暂存区为空时回退工作区）与截断信息；
 * truncated 为机器可判定的「diff 或 subject 被截断」标记。
 */
export type AiCommitMessage = {
  subject: string
  body?: string | null
  model: string
  note?: string | null
  truncated: boolean
}

// ---------------------------------------------------------------------------
// W3-6 SSH 密钥、凭据助手与 Git 运行时 —— 与 git_credentials.rs 同名结构对齐
// ---------------------------------------------------------------------------

/**
 * Git / SSH / LFS 运行时探测结果。
 * 所有版本与路径都可能为 null（未安装 / 探测失败）；本应用不附带 Git 二进制，
 * `bundledGitPresent` 只表示安装包目录里是否恰好存在内置 git。
 */
export type GitRuntimeInfo = {
  gitVersion?: string | null
  gitPath?: string | null
  sshVersion?: string | null
  gitLfsVersion?: string | null
  credentialHelpers: string[]
  sshAgentRunning: boolean
  sshAgentKeys: string[]
  customGitDir?: string | null
  bundledGitPresent: boolean
}

/** 单个 SSH 密钥对；`fileName` 为 base 名（不含 .pub），`.pub` 由 hasPublic 表示。 */
export type SshKeyInfo = {
  fileName: string
  keyType: string
  bits?: number | null
  fingerprint?: string | null
  comment: string
  hasPrivate: boolean
  hasPublic: boolean
  path: string
}

/** 设置 credential.helper 后的回报；notice 承载明文存储等风险提示。 */
export type CredentialHelperReport = {
  configuredHelpers: string[]
  notice?: string | null
}
