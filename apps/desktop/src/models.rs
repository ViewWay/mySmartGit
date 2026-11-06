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
// 子模块接入（W2-10）：添加子模块 / 递归克隆 / 指针差异
// 全部由 src/git_submodule.rs 与 src/repository_management.rs 生产。
// 红线：所有 URL 一律先脱敏再序列化，凭据不进入返回值；
//       Git 在 stderr 里回显的地址同样过 redact_error_text 后才返回前端。
// ---------------------------------------------------------------------------

/// `.gitmodules` + `submodule status --recursive` 合并出的子模块明细。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySubmoduleDetail {
    /// 相对父仓库的路径（始终是 `/` 分隔，便于前端比对）。
    pub path: String,
    /// `.gitmodules` 里的段名；未配置时退化为路径。
    pub name: String,
    /// 已脱敏的子模块地址（userinfo 与查询串替换为 `[redacted]`）。
    pub url: String,
    /// `.gitmodules` 配置的跟踪分支；为空表示「跟随父仓库记录的提交」。
    pub configured_branch: Option<String>,
    pub status: String,
    /// `submodule.<name>.url` 是否已进入本地 `.git/config`（即是否已 init）。
    pub initialized: bool,
    /// 父仓库 HEAD 记录的 gitlink 提交；未提交时为空。
    pub head_commit: String,
    /// 父仓库索引记录的 gitlink 提交。
    pub staged_commit: String,
    /// 子模块工作区当前 HEAD；未初始化时为空。
    pub checked_out_commit: String,
    /// 子模块工作区的未提交改动文件数；过深仓库可能为 None（未探测）。
    pub dirty_files: Option<usize>,
    /// 该路径下的嵌套子模块数量。
    pub nested_count: usize,
    /// 原始 URL 是否内嵌凭据；为真时上面的 url 已脱敏。
    pub credentials_redacted: bool,
    /// 子模块在磁盘上的绝对路径，供前端「下钻打开仓库」复用。
    pub absolute_path: String,
}

/// 子模块指针差异里列出的单条提交（子模块仓库内部的新增提交）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleCommitEntry {
    pub hash: String,
    pub short_hash: String,
    pub title: String,
    pub author: String,
    pub email: String,
    pub commit_time: String,
}

/// 子模块差异语义：指针从哪个提交移到哪个提交，以及子模块内部为此新增了什么。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmodulePointerDiff {
    pub path: String,
    pub name: String,
    /// 已脱敏的子模块地址。
    pub url: String,
    pub absolute_path: String,
    /// 父仓库 HEAD 记录的提交（「旧」侧优先取它）。
    pub head_commit: String,
    /// 父仓库索引记录的提交。
    pub staged_commit: String,
    /// 子模块工作区 HEAD（「新」侧）。
    pub current_commit: String,
    /// 实际用于比较的旧提交。
    pub previous_commit: String,
    /// 实际用于比较的新提交；未初始化时为空。
    pub target_commit: String,
    /// 相对 HEAD 记录，指针是否发生变化（暂存或工作区任一不同）。
    pub changed: bool,
    /// 指针变化是否只停留在索引（已暂存未提交）。
    pub pointer_staged: bool,
    /// 子模块工作区 HEAD 与索引记录不一致（未暂存的指针移动）。
    pub pointer_unstaged: bool,
    pub uninitialized: bool,
    pub detached: bool,
    /// `previous..target`：子模块内为此新增的提交列表（限量并给出截断提示）。
    pub added_commits: Vec<SubmoduleCommitEntry>,
    pub added_count: usize,
    /// `target..previous`：指针后移丢掉的提交数（非快进 / 回退）。
    pub removed_count: usize,
    /// 旧提交是否是新增提交的祖先；false 表示指针被回退或分叉。
    pub fast_forward: bool,
    pub files_changed: usize,
    pub additions: usize,
    pub deletions: usize,
    /// 子模块自身工作区的未提交改动文件数。
    pub dirty_files: usize,
    pub summary: String,
    pub warnings: Vec<String>,
}

/// 添加子模块的统一返回：既能表达「已执行」，也能表达「等待二次确认」。
/// executed=false 时 Rust 层没有对仓库做任何改动。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleOperationReport {
    /// 稳定的动作标识，前端据此选择确认文案。
    pub action: String,
    pub executed: bool,
    /// 为真表示这是一次预览，需要用户确认后携带 confirm=true 再调用一次。
    pub requires_confirmation: bool,
    pub summary: String,
    pub warnings: Vec<String>,
    pub affected: Vec<String>,
    /// 执行后的子模块明细（URL 已脱敏）。
    pub submodules: Vec<RepositorySubmoduleDetail>,
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
