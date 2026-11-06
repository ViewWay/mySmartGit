use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryCommit {
    pub id: String,
    pub full_hash: String,
    pub parent: Option<String>,
    pub parents: Vec<String>,
    pub lane: usize,
    pub color: String,
    pub title: String,
    pub message: String,
    pub author: String,
    pub email: String,
    pub committer: String,
    pub committer_email: String,
    pub avatar: String,
    pub time: String,
    pub author_time: String,
    pub commit_time: String,
    pub branches: Vec<String>,
    pub status: Option<String>,
    pub files: usize,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryCommitStats {
    pub hash: String,
    pub files: usize,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryFile {
    pub path: String,
    pub r#type: String,
    pub add: usize,
    pub del: usize,
    pub staged: bool,
    pub unstaged: bool,
    pub incoming: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryOperationStep {
    pub hash: String,
    pub short_hash: String,
    pub title: String,
    pub author: String,
    pub status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryOperationState {
    pub kind: String,
    pub label: String,
    pub original_branch: Option<String>,
    pub onto: Option<String>,
    pub current_step: usize,
    pub total_steps: usize,
    pub current_commit: Option<String>,
    pub message: Option<String>,
    pub conflicts: Vec<String>,
    pub steps: Vec<RepositoryOperationStep>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFileContent {
    pub path: String,
    pub base: Option<String>,
    pub current: Option<String>,
    pub incoming: Option<String>,
    pub result: String,
    pub current_label: String,
    pub incoming_label: String,
    pub binary: bool,
    pub gitlink: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebasePreview {
    pub branch: String,
    pub onto: String,
    pub onto_short_hash: String,
    pub merge_base: String,
    pub steps: Vec<RepositoryOperationStep>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitUserConfig {
    pub user_name: String,
    pub user_email: String,
    pub default_branch: String,
    pub autocrlf: String,
    pub pull_strategy: String,
    pub commit_template_path: Option<String>,
    pub commit_template_content: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommandLogEntry {
    pub id: u64,
    pub started_at: u128,
    pub duration_ms: u128,
    pub command: String,
    pub working_directory: String,
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub old: Option<usize>,
    pub next: Option<usize>,
    pub kind: String,
    pub code: String,
    pub old_code: Option<String>,
    pub new_code: Option<String>,
    pub old_no_newline: bool,
    pub new_no_newline: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryEntry {
    pub hash: String,
    pub short_hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub committer: String,
    pub committer_email: String,
    pub time: String,
    pub commit_time: String,
    pub title: String,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub line: usize,
    pub original_line: usize,
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub email: String,
    pub time: String,
    pub content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryWorktree {
    pub path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub bare: bool,
    pub locked: Option<String>,
    pub prunable: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySubmodule {
    pub path: String,
    pub hash: String,
    pub status: String,
    pub branch: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryBranchTracking {
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryStash {
    pub reference: String,
    pub hash: String,
    pub message: String,
    pub author: String,
    pub time: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryCommitTemplate {
    pub path: String,
    pub content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryComparison {
    pub base: String,
    pub target: String,
    pub ahead: usize,
    pub behind: usize,
    pub files: Vec<RepositoryFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeCandidate {
    pub branch: String,
    pub ahead: usize,
    pub behind: usize,
    pub merged: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeQueueSnapshot {
    pub current_branch: String,
    pub conflicts: Vec<String>,
    pub candidates: Vec<MergeCandidate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySnapshot {
    pub name: String,
    pub path: String,
    pub superproject_path: Option<String>,
    pub branch: String,
    pub remote: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub worktree_count: usize,
    pub submodule_count: usize,
    pub commits: Vec<RepositoryCommit>,
    pub files: Vec<RepositoryFile>,
    pub worktrees: Vec<RepositoryWorktree>,
    pub submodules: Vec<RepositorySubmodule>,
    pub branches: Vec<String>,
    pub remote_branches: Vec<String>,
    pub branch_tracking: std::collections::HashMap<String, RepositoryBranchTracking>,
    pub tags: Vec<String>,
    pub stashes: Vec<RepositoryStash>,
    pub commit_template: Option<RepositoryCommitTemplate>,
    pub undo_commit_message: Option<String>,
    pub operation: Option<RepositoryOperationState>,
}

// ---------------------------------------------------------------------------------------------
// 远程与标签管理（git_remote.rs）
// 以下结构体只由 src/git_remote.rs 生产；URL 一律脱敏后再序列化，凭据不进入返回值。
// ---------------------------------------------------------------------------------------------

/// 单个远程仓库的完整视图：fetch/push 地址、引用规格、HEAD 与本地跟踪关系。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryRemoteDetail {
    pub name: String,
    /// 已脱敏（userinfo 与查询串替换为 [redacted]）的 fetch 地址，可能有多条。
    pub fetch_urls: Vec<String>,
    /// 已脱敏的 push 地址；为空表示沿用 fetch 地址。
    pub push_urls: Vec<String>,
    pub fetch_refspecs: Vec<String>,
    pub push_refspecs: Vec<String>,
    /// refs/remotes/<name>/HEAD 指向的远端分支（简称）。
    pub head_branch: Option<String>,
    /// 本地已缓存的该远程分支数量。
    pub cached_branch_count: usize,
    /// 上游指向该远程的本地分支。
    pub tracking_branches: Vec<String>,
    /// 原始配置里是否内嵌了凭据；为真时上面的 URL 已被脱敏。
    pub credentials_redacted: bool,
}

/// 标签明细：区分轻量标签、注释标签与签名标签。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryTagDetail {
    pub name: String,
    /// "annotated" | "lightweight"
    pub kind: String,
    /// 标签对象指向的提交（短哈希）。轻量标签即标签自身指向的提交。
    pub target: String,
    /// 标签对象短哈希；轻量标签为空。
    pub tag_object: String,
    /// 注释标签的打标签人；轻量标签为空。
    pub tagger: String,
    pub tagger_email: String,
    /// 注释标签为打标签时间，轻量标签为提交时间（ISO8601）。
    pub date: String,
    /// 注释标签的标签说明首行；轻量标签为提交标题。
    pub subject: String,
    /// 标签对象内是否含 PGP/x509 签名块。
    pub signed: bool,
    /// 指向的提交是否已被任一本地分支包含；false 时删除可能使对象孤立。
    pub on_branch: bool,
}

/// 远程/分支/标签写操作的统一返回：既能表达「已执行」，也能表达「等待二次确认」。
/// executed=false 时 Rust 层没有对仓库做任何改动。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteOperationReport {
    /// 稳定的动作标识，前端据此选择确认文案。
    pub action: String,
    pub executed: bool,
    /// 为真表示这是一次预览，需要用户确认后携带 confirm=true 再调用一次。
    pub requires_confirmation: bool,
    pub summary: String,
    /// 破坏性影响说明（会丢什么、会改什么配置）。
    pub warnings: Vec<String>,
    /// 受影响的具体对象（分支名、标签名、引用名）。
    pub affected: Vec<String>,
    pub remotes: Vec<RepositoryRemoteDetail>,
    pub tags: Vec<RepositoryTagDetail>,
    /// 仅在 executed=true 时回填，供前端直接刷新主界面；读取失败不影响操作本身。
    pub snapshot: Option<RepositorySnapshot>,
}

// ---------------------------------------------------------------------------
// 恢复与问题定位（W1-5）：Reflog / Bisect / Reset 模式
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflogEntry {
    /// HEAD@{3} 形式的选择器
    pub selector: String,
    /// 带时间的原始选择器（git reflog --date=iso-strict 输出）
    pub dated_selector: String,
    /// 选择器花括号内的记录时间
    pub entry_time: String,
    /// 动作类别：commit / checkout / reset / merge / rebase ...
    pub action: String,
    /// 完整动作说明（%gs），如 "reset: moving to HEAD~1"
    pub subject: String,
    /// 该条目的新值（完整 Hash）
    pub commit_hash: String,
    pub short_hash: String,
    /// 旧值：由 reflog 链推导（最早条目为全 0）
    pub old_hash: String,
    /// 新值指向提交的标题；指向非提交对象时为空
    pub commit_title: String,
    pub author: String,
    pub commit_time: String,
    pub is_head: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BisectCommit {
    pub hash: String,
    pub short_hash: String,
    pub title: String,
    pub author: String,
    pub commit_time: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BisectStep {
    /// 结论动词：good / bad / skip / start（自定义术语时为其映射）
    pub verdict: String,
    pub hash: String,
    pub short_hash: String,
    pub title: String,
    pub author: String,
    pub commit_time: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BisectStatus {
    pub active: bool,
    pub message: String,
    pub original_branch: Option<String>,
    pub current_commit: Option<BisectCommit>,
    pub bad_commit: Option<BisectCommit>,
    pub good_commits: Vec<BisectCommit>,
    pub tested: Vec<BisectStep>,
    pub remaining_count: usize,
    pub steps_estimate: usize,
    pub done: bool,
    pub bad_term: String,
    pub good_term: String,
}

// ---------------------------------------------------------------------------
// W2-9 深度搜索与仓库全文替换（apps/desktop/src/git_search.rs）
//
// 这一批结构体只服务于搜索/替换轨道：输入结构需要反序列化，因此这里显式写全路径
// `serde::Deserialize`，不修改文件顶部的 `use` 行，避免与其他并行轨道产生合并冲突。
// 所有输出结构都带 `truncated`/`notice`：超限必须是显式提示，绝不静默丢弃结果。
// ---------------------------------------------------------------------------

/// 历史深度搜索的目标域；与 Git 的提交筛选参数一一对应，互斥选择。
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommitSearchTarget {
    /// `git log --grep=<值>`：提交信息（含正文）。
    CommitMessage,
    /// `git log --author=<值>`：作者名与邮箱。
    CommitAuthor,
    /// 按提交 Hash 精确定位（4-40 位十六进制），走 rev-parse 校验路径。
    CommitHash,
    /// `git log -S<值>`：pickaxe 语义，只命中该字符串出现次数发生增减的提交。
    DiffPickaxe,
    /// `git log -G<值>`：逐行正则语义，命中差异文本中出现过该模式的提交。
    DiffRegex,
}

/// 全量历史搜索输入：不受提交图谱 2000 条上限约束，由后端流式扫描。
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CommitSearchQuery {
    /// 搜索文本；regex=true 时交给 Git 自身的正则引擎（BRE/ERE），不进 shell。
    pub pattern: String,
    pub target: CommitSearchTarget,
    /// true 为区分大小写（Git 默认语义）；false 时追加 `-i`。
    pub case_sensitive: bool,
    /// 追加 `--word-regexp`，整词匹配。
    pub whole_word: bool,
    /// true 追加 `-E`（扩展正则）；false 追加 `-F`（固定字符串）。
    pub regex: bool,
    /// 限定分支/范围（如 `main`、`main..feature`）；为空表示 `--all`。
    pub revisions: Vec<String>,
    /// pathspec 白名单（限定搜索的文件范围）。
    pub paths: Vec<String>,
    /// pathspec 排除（转成 `:(exclude)…` 交给 Git）。
    pub exclude_paths: Vec<String>,
    /// 单次扫描的提交上限（防御性截断）；为空使用默认上限。
    pub max_commits: Option<usize>,
    pub page_size: usize,
    pub offset: usize,
}

impl Default for CommitSearchQuery {
    fn default() -> Self {
        Self {
            pattern: String::new(),
            target: CommitSearchTarget::CommitMessage,
            case_sensitive: true,
            whole_word: false,
            regex: false,
            revisions: Vec::new(),
            paths: Vec::new(),
            exclude_paths: Vec::new(),
            max_commits: None,
            page_size: 100,
            offset: 0,
        }
    }
}

/// 历史搜索命中提交的最小展示单元（只带元数据，不带文件内容）。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSearchItem {
    pub hash: String,
    pub short_hash: String,
    pub title: String,
    /// 完整提交信息，按字节预算截断。
    pub message: String,
    pub author: String,
    pub email: String,
    /// 作者时间（ISO8601）。
    pub date: String,
    /// 引用装饰（分支/标签），由 `%D` 解析，可能为空。
    pub refs: Vec<String>,
}

/// 分页结果：`search_id` 指向后端的一次扫描索引，翻页不再重跑重查询。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSearchPage {
    pub search_id: String,
    pub target: CommitSearchTarget,
    pub pattern: String,
    /// 命中总数（截断时为已索引条数）。
    pub total: usize,
    pub offset: usize,
    pub page_size: usize,
    pub has_more: bool,
    /// 扫描被上限截断：必须向用户显示「结果被截断」。
    pub truncated: bool,
    /// 被新任务/切换仓库取消：前端据此丢弃过期结果。
    pub cancelled: bool,
    pub items: Vec<CommitSearchItem>,
    pub notice: Option<String>,
}

/// 仓库全文搜索输入（工作区或指定 rev）。
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TextSearchQuery {
    pub pattern: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    /// true 追加 `-E`；false 追加 `-F`（固定字符串）。
    pub regex: bool,
    /// 为空表示工作区（已跟踪、受 .gitignore 约束）；否则搜索该 rev 的树。
    pub revision: Option<String>,
    pub includes: Vec<String>,
    pub exclude_paths: Vec<String>,
    /// 每条命中的上下文行数（0 表示不读取上下文）。
    pub context_lines: usize,
    /// 命中行数上限（防御性截断）；为空使用默认上限。
    pub max_matches: Option<usize>,
    pub page_size: usize,
    pub offset: usize,
}

impl Default for TextSearchQuery {
    fn default() -> Self {
        Self {
            pattern: String::new(),
            case_sensitive: true,
            whole_word: false,
            regex: false,
            revision: None,
            includes: Vec::new(),
            exclude_paths: Vec::new(),
            context_lines: 2,
            max_matches: None,
            page_size: 200,
            offset: 0,
        }
    }
}

/// 「文件:行:内容」命中项，带上下文片段，可直接定位到行。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSearchMatch {
    pub file_path: String,
    pub line_number: usize,
    /// 命中行内容（按字节预算截断）。
    pub content: String,
    /// 命中位于二进制/非 UTF-8 文件：内容不展示，但**必须出现在结果里**，不能静默丢弃。
    pub binary: bool,
    pub context_before: Vec<String>,
    pub context_after: Vec<String>,
    pub revision: Option<String>,
}

/// 全文搜索分页结果。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSearchPage {
    pub search_id: String,
    pub pattern: String,
    pub revision: Option<String>,
    pub total: usize,
    pub matched_files: usize,
    pub offset: usize,
    pub page_size: usize,
    pub has_more: bool,
    pub truncated: bool,
    pub cancelled: bool,
    pub items: Vec<TextSearchMatch>,
    pub notice: Option<String>,
}

/// 批量替换输入：替换只作用于工作区，绝不写入某个 rev。
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TextReplaceQuery {
    pub pattern: String,
    pub replacement: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regex: bool,
    pub includes: Vec<String>,
    pub exclude_paths: Vec<String>,
    /// 文件数上限（防御性截断）；为空使用默认上限。
    pub max_files: Option<usize>,
}

impl Default for TextReplaceQuery {
    fn default() -> Self {
        Self {
            pattern: String::new(),
            replacement: String::new(),
            case_sensitive: true,
            whole_word: false,
            regex: false,
            includes: Vec::new(),
            exclude_paths: Vec::new(),
            max_files: None,
        }
    }
}

/// 预览中的单个受影响文件。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacePreviewFile {
    pub file_path: String,
    pub occurrences: usize,
    /// 前若干个命中行号，供 UI 抽样展示。
    pub sample_lines: Vec<usize>,
    pub size_bytes: usize,
    /// 非空表示该文件被跳过（超限/二进制/位置校验失败），不会写盘。
    pub skipped: Option<String>,
}

/// dry-run 预览结果：`requires_confirmation` 恒为 true，未确认时仓库未被改动。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacePreview {
    pub preview_id: String,
    pub pattern: String,
    pub replacement: String,
    pub files: Vec<ReplacePreviewFile>,
    pub file_count: usize,
    pub total_occurrences: usize,
    pub skipped_files: usize,
    /// 预览范围是否被条数/字节上限截断（截断时禁止 apply，需缩小范围）。
    pub truncated: bool,
    pub requires_confirmation: bool,
    pub estimated_bytes: usize,
    pub notice: Option<String>,
}

/// 替换/撤销的执行结果。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceReport {
    pub replace_id: String,
    pub executed: bool,
    pub files_changed: Vec<String>,
    pub occurrences: usize,
    pub warnings: Vec<String>,
    /// 备份位置（相对 git 目录），用于用户自行核对。
    pub backup_path: Option<String>,
    pub backup_available: bool,
    /// 撤销路径：已恢复的文件。
    pub restored_files: Vec<String>,
    /// 撤销时因外部修改而拒绝恢复的文件。
    pub skipped: Vec<String>,
    pub notice: Option<String>,
}

/// 一次可撤销的替换备份摘要。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceBackupSummary {
    pub replace_id: String,
    pub created_at_ms: u128,
    pub file_count: usize,
    pub occurrences: usize,
    pub byte_size: usize,
    pub pattern: String,
    pub replacement: String,
}

/// 内置编辑器的文件内容载体；`checksum` 是保存时的乐观并发凭据。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryTextFile {
    pub file_path: String,
    pub revision: Option<String>,
    pub content: String,
    pub size_bytes: usize,
    pub truncated: bool,
    pub checksum: String,
    pub line_count: usize,
    pub binary: bool,
    pub notice: Option<String>,
}
