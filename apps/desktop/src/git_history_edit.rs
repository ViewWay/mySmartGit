//! 交互式历史编辑（W3-1）：脚本化 rebase todo 序列 / 影响预览 / 批量 cherry-pick /
//! 任意历史提交改写消息与删除。
//!
//! 该模块独立于 git.rs 的提交流程，仅通过 `crate::git` 的公开接口读写仓库，
//! 不修改 git.rs 的任何函数（continue/skip/abort 一族由主线维护，本模块只依赖其
//! 结构化状态目录检测的同等手段自行判定）。
//!
//! ## 设计要点
//! 1. **脚本化 todo 注入**：程序生成完整的 git-rebase-todo 文件写入临时目录，
//!    用 `GIT_SEQUENCE_EDITOR` 指向一个「把我们的文件复制过去」的脚本完成注入；
//!    `GIT_EDITOR` 指向一个退出不改文件的脚本，确保任何步骤都不依赖交互式终端。
//! 2. **消息不走编辑器**：reword/squash 不用 git 原生关键字，而是
//!    `pick + exec git commit --amend --no-verify -F <消息文件>`——消息来源是
//!    程序写入的文件，多条目、不同消息天然互不串扰；fixup 用
//!    `pick + exec git reset --soft HEAD~1 + exec git commit --amend --no-verify -C HEAD`，
//!    保留目标消息且同样零编辑器。`-C HEAD` 让 fixup 在目标刚被 edit/reword 改过
//!    消息时也能取到**当下**的目标消息，而不是编排时的旧值。
//! 3. **前置校验**（干净工作区 / 无进行中操作 / 非 detached / base 可解析且为祖先 /
//!    范围内无合并提交）全部通过才允许起跑；起跑失败仓库必然停在
//!    「可被现有 继续/跳过/中止 面板处理」的变基中状态，返回值里给出恢复指引。
//! 4. **安全红线**：Git 一律以参数数组启动（绝不 sh -c、绝不拼接命令行字符串）；
//!    唯一进入 shell 的是 todo 里的 `exec` 行，其参数只有固定字面量与本模块生成的
//!    临时文件路径；临时根目录经过字符白名单校验（拒绝引号/反引号/$/百分号等），
//!    用户提供的任何文本（提交消息、哈希）都不进 exec 行、不进脚本体。
//! 5. **已知限制**：不支持含合并提交的范围（`git rebase -i` 会展平合并，显式拒绝）；
//!    exec 路径跳过 hooks（--no-verify），保证批量重写不被个人 hooks 卡住；
//!    与主线一致：不接入 git.rs 的命令日志（record_command 为私有），集成时可评估。

use crate::git;
use crate::models::{
    CherryPickBatchReport, CherryPickOutcome, HistoryEditActionInput, HistoryEditEntry,
    HistoryEditImpact, HistoryEditReport, HistoryEditSequence,
};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// 序列动作取值域（对外契约，与 packages/git-models 的 HistoryEditActionKind 对齐）。
const ACTION_PICK: &str = "pick";
const ACTION_REWORD: &str = "reword";
const ACTION_DROP: &str = "drop";
const ACTION_FIXUP: &str = "fixup";
const ACTION_SQUASH: &str = "squash";
const ACTION_EDIT: &str = "edit";
const ALL_ACTIONS: [&str; 6] =
    [ACTION_PICK, ACTION_REWORD, ACTION_DROP, ACTION_FIXUP, ACTION_SQUASH, ACTION_EDIT];

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

fn resolve_commit(root: &Path, reference: &str) -> Result<String, String> {
    let object = git::git_output_owned(
        root,
        &[
            "rev-parse".into(),
            "--verify".into(),
            "--end-of-options".into(),
            reference.into(),
        ],
    )?
    .trim()
    .to_string();
    if object.len() != 40 || !object.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("无效的提交或分支：{reference}"));
    }
    let commit = git::git_output_owned(
        root,
        &["rev-parse".into(), "--verify".into(), format!("{object}^{{commit}}")],
    )?
    .trim()
    .to_string();
    if commit.len() != 40 || !commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("无效的提交或分支：{reference}"));
    }
    Ok(commit)
}

fn head_hash(root: &Path) -> Result<String, String> {
    Ok(git::git_output(root, &["rev-parse", "HEAD"])?.trim().to_string())
}

fn git_dir(root: &Path) -> PathBuf {
    let output = git::git_output(root, &["rev-parse", "--absolute-git-dir"]).unwrap_or_default();
    let value = output.trim();
    if value.is_empty() {
        root.join(".git")
    } else {
        PathBuf::from(value)
    }
}

/// 进行中操作的结构化检测（状态目录/状态文件，不解析任何文案）。
/// 刻意不依赖 git.rs 的 `repository_operation`（该族函数正由另一轨道修改）。
fn in_progress_operation(root: &Path) -> Option<&'static str> {
    let dir = git_dir(root);
    if dir.join("rebase-merge").is_dir() || dir.join("rebase-apply").is_dir() {
        return Some("变基");
    }
    if dir.join("MERGE_HEAD").is_file() {
        return Some("合并");
    }
    if dir.join("CHERRY_PICK_HEAD").is_file() {
        return Some("拣选");
    }
    if dir.join("REVERT_HEAD").is_file() {
        return Some("回滚");
    }
    if dir.join("BISECT_LOG").is_file() {
        return Some("二分定位");
    }
    None
}

fn is_ancestor(root: &Path, ancestor: &str, descendant: &str) -> bool {
    git::git_output(root, &["merge-base", "--is-ancestor", ancestor, descendant]).is_ok()
}

/// 路径字符白名单：只允许字母数字与 `._/:+-,@空格`。
/// 该路径会出现在 POSIX 脚本（单引号内）、Windows .cmd（双引号内）与 todo 的
/// exec 行（单引号内）三种上下文里，取三者安全字符的交集：
/// 拒绝 `' " $ \` \ % ; & | < > ( ) { } [ ] * ? ! # ~ ^ 换行/回车/制表符与控制字符、非 ASCII。
fn script_safe_path(path: &Path) -> Result<String, String> {
    let raw = path.to_string_lossy().to_string();
    let safe = !raw.is_empty()
        && raw.len() <= 4096
        && raw.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, '.' | '_' | '/' | '+' | '-' | ':' | ',' | '@' | ' ')
        });
    if safe {
        Ok(raw)
    } else {
        Err(format!(
            "临时目录路径包含不安全字符，无法安全注入序列编辑器：{raw}\n\
             提示：请调整 TMPDIR/TMP 环境变量后重试（避免引号、$、% 等 shell 特殊字符）。"
        ))
    }
}

fn is_full_hash(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) && value == value.to_ascii_lowercase()
}

/// 带环境变量注入的 Git 启动器：参数数组，绝不进 shell。
fn run_git_with_env(
    root: &Path,
    envs: &[(&str, &Path)],
    args: &[&str],
) -> Result<std::process::Output, String> {
    #[cfg(test)]
    git::isolate_test_git_environment();
    let mut command = Command::new("git");
    command.arg("-C").arg(root);
    for (key, value) in envs {
        command.env(key, value);
    }
    command.args(args);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000_0000);
    }
    command.output().map_err(|error| format!("无法启动 Git：{error}"))
}

// ---------------------------------------------------------------------------
// 临时工作区（todo 文件 + 消息文件 + 编辑器脚本）
// ---------------------------------------------------------------------------

struct TempWorkspace {
    dir: PathBuf,
    dir_string: String,
}

impl TempWorkspace {
    fn new() -> Result<Self, String> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("系统时钟异常：{error}"))?
            .as_nanos();
        let seq = TEMP_SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "branchline-history-edit-{}-{nanos}-{seq}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).map_err(|error| format!("创建临时编辑目录失败：{error}"))?;
        let dir_string = script_safe_path(&dir)?;
        Ok(Self { dir, dir_string })
    }

    fn write_file(&self, name: &str, content: &str) -> Result<PathBuf, String> {
        let path = self.dir.join(name);
        fs::write(&path, content).map_err(|error| format!("写入 {name} 失败：{error}"))?;
        // 目录根已校验过字符白名单，子文件名为固定字面量，路径整体必然安全。
        script_safe_path(&path)?;
        Ok(path)
    }

    /// 写入可执行脚本（POSIX 直接 chmod；Windows 用 .cmd 后缀）。
    fn write_script(&self, base_name: &str, body: &str) -> Result<PathBuf, String> {
        #[cfg(windows)]
        let file_name = format!("{base_name}.cmd");
        #[cfg(not(windows))]
        let file_name = base_name.to_string();
        let path = self.write_file(&file_name, body)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
                .map_err(|error| format!("脚本不可执行：{error}"))?;
        }
        Ok(path)
    }

    fn cleanup(&self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// 保留（不随本次调用清理）的临时目录，仅在变基停在半程时返回。
fn abandoned_temp(temp: &TempWorkspace) -> String {
    temp.dir_string.clone()
}

fn sequence_editor_script(todo: &str) -> String {
    #[cfg(windows)]
    {
        format!("@echo off\r\ncopy /y \"{todo}\" \"%~1\" >nul\r\nif errorlevel 1 exit /b 1\r\n")
    }
    #[cfg(not(windows))]
    {
        format!("#!/bin/sh\nset -eu\ncp -- '{todo}' \"$1\"\n")
    }
}

fn noop_editor_script() -> String {
    #[cfg(windows)]
    {
        "@echo off\r\nexit /b 0\r\n".to_string()
    }
    #[cfg(not(windows))]
    {
        "#!/bin/sh\nexit 0\n".to_string()
    }
}

// ---------------------------------------------------------------------------
// 提交序列读取
// ---------------------------------------------------------------------------

fn range_spec(base: Option<&str>, head: &str) -> String {
    match base {
        Some(b) => format!("{b}..{head}"),
        None => head.to_string(),
    }
}

/// 读取 `base..head`（或 --root 语义下 head 的全部历史）的提交条目，先旧后新。
fn range_entries(
    root: &Path,
    base: Option<&str>,
    head: &str,
) -> Result<Vec<HistoryEditEntry>, String> {
    let spec = range_spec(base, head);
    let format = "%H\x1f%h\x1f%an\x1f%ae\x1f%cI\x1f%T\x1f%P\x1f%B\x1e";
    let output = git::git_output(
        root,
        &["log", "--reverse", &format!("--format={format}"), &spec],
    )?;
    let mut entries = Vec::new();
    for record in output.split('\x1e') {
        if record.trim().is_empty() {
            continue;
        }
        let fields: Vec<&str> = record.split('\x1f').collect();
        if fields.len() != 8 {
            return Err("解析提交序列失败：字段数不符".to_string());
        }
        // 首条记录前可能有换行（git log 每条记录以 \n 收尾），只清理首尾边界。
        let hash = fields[0].trim().to_string();
        if !is_full_hash(&hash) {
            return Err(format!("解析提交序列失败：{hash} 不是完整哈希"));
        }
        let parents = fields[6]
            .split_whitespace()
            .map(|value| value.to_string())
            .collect::<Vec<_>>();
        let message = fields[7].trim_matches(|c| c == '\n' || c == '\r').to_string();
        entries.push(HistoryEditEntry {
            hash,
            short_hash: fields[1].trim().to_string(),
            title: message.lines().next().unwrap_or_default().to_string(),
            message,
            author: fields[2].to_string(),
            email: fields[3].to_string(),
            commit_time: fields[4].trim().to_string(),
            is_merge: parents.len() > 1,
            parents,
            tree: fields[5].trim().to_string(),
        });
    }
    Ok(entries)
}

/// 范围内是否含合并提交（含则拒绝序列编辑，防止 rebase -i 静默展平历史）。
fn range_has_merge(root: &Path, base: Option<&str>, head: &str) -> Result<bool, String> {
    let spec = range_spec(base, head);
    let count = git::git_output(root, &["rev-list", "--merges", "--count", &spec])?;
    Ok(count.trim() != "0")
}

// ---------------------------------------------------------------------------
// 前置校验
// ---------------------------------------------------------------------------

struct Ready {
    branch: String,
    head: String,
    path_string: String,
}

/// 统一的起跑前置校验：无进行中操作 → 非 detached → 工作区（跟踪文件）干净。
/// 顺序刻意先查进行中状态：中途状态下 status 输出本身含冲突行，两条报错都要给得到。
fn preflight(root: &Path) -> Result<Ready, String> {
    if let Some(kind) = in_progress_operation(root) {
        return Err(format!(
            "仓库正处于{kind}进行中状态，不能开始新的历史编辑。请先在操作面板「继续 / 跳过 / 中止」处理完该操作（中止会回到操作前的位置）。"
        ));
    }
    let branch = git::git_output(root, &["symbolic-ref", "--short", "-q", "HEAD"])
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    if branch.is_empty() {
        return Err(
            "当前处于分离 HEAD（未检出分支）。交互式历史编辑需要一个可重写的分支，\
             请先 git switch <branch> 回到分支再操作。"
                .to_string(),
        );
    }
    let dirty = git::git_output(root, &["status", "--porcelain", "--untracked-files=no"])?;
    if !dirty.trim().is_empty() {
        return Err(
            "工作区存在未提交的改动（含已暂存）。历史编辑要求干净工作区：\
             请先提交或暂存（stash）这些改动，再重试。"
                .to_string(),
        );
    }
    let head = head_hash(root)?;
    Ok(Ready { branch, head, path_string: root.to_string_lossy().to_string() })
}

/// 校验 base 引用：可解析为提交、且是 HEAD 的祖先、且不等于 HEAD。
fn validated_base(root: &Path, base_ref: &str, head: &str) -> Result<String, String> {
    let trimmed = base_ref.trim();
    if trimmed.is_empty() {
        return Err("基点不能为空：需要一个可解析的分支/标签/提交引用".to_string());
    }
    let base_hash = resolve_commit(root, trimmed)
        .map_err(|error| format!("基点引用无法解析：{error}"))?;
    if base_hash == head {
        return Err("基点与 HEAD 相同，范围内没有可编辑的提交".to_string());
    }
    if !is_ancestor(root, &base_hash, head) {
        return Err(format!(
            "基点 {} 不是 HEAD 的祖先，交互式历史编辑只能重写「基点..HEAD」这条单线历史",
            &base_hash[..8.min(base_hash.len())]
        ));
    }
    Ok(base_hash)
}

// ---------------------------------------------------------------------------
// 序列计划：校验 + 生成 todo
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
enum Step {
    Pick { hash: String },
    Edit { hash: String },
    Fixup { hash: String },
    Reword { hash: String, message: String },
    Squash { hash: String, message: String },
}

#[derive(Clone, Debug)]
struct PlanData {
    steps: Vec<Step>,
    dropped: usize,
    /// fixup + squash 折叠掉的条数（结果并入前一条）。
    folded: usize,
    reworded: usize,
    edited: usize,
    /// 预期结果历史相对 base 的提交数。
    result_count: usize,
}

/// 把用户动作序列（顺序即新历史顺序）校验并编译为步骤列表。
/// 纯函数：不触盘、不起 Git 子进程，供 apply 与 impact 预览共用同一套规则。
fn validate_plan(
    entries: &[HistoryEditEntry],
    actions: &[HistoryEditActionInput],
) -> Result<PlanData, String> {
    if entries.is_empty() {
        return Err("范围内没有可编辑的提交".to_string());
    }
    if actions.len() != entries.len() {
        return Err(format!(
            "动作数量与提交数量不一致：序列含 {} 个提交，收到 {} 条动作。每条动作必须对应序列内的提交。",
            entries.len(),
            actions.len()
        ));
    }
    let known: HashMap<&str, &HistoryEditEntry> =
        entries.iter().map(|entry| (entry.hash.as_str(), entry)).collect();
    let mut used: HashSet<String> = HashSet::new();
    let mut steps: Vec<Step> = Vec::new();
    let mut dropped = 0usize;
    let mut folded = 0usize;
    let mut reworded = 0usize;
    let mut edited = 0usize;
    // squash 默认合并消息需要知道前一条的「当前消息」：pick/edit 用原消息，
    // reword/squash 用新消息，fixup 不改消息，drop 不改变前一条。
    let mut prev_message: Option<String> = None;
    let mut has_prev_kept = false;

    for action in actions {
        let hash = action.hash.trim().to_ascii_lowercase();
        if !is_full_hash(&hash) {
            return Err(format!("动作引用了非完整哈希：{}", action.hash));
        }
        let entry = known.get(hash.as_str()).ok_or_else(|| {
            format!("动作引用的提交 {} 不在当前序列（基点..HEAD）内，或不属于同一集合", hash)
        })?;
        if !used.insert(hash.clone()) {
            return Err(format!("提交 {} 出现多条动作：每个提交必须且只能标记一次", entry.short_hash));
        }
        let kind = action.action.trim().to_ascii_lowercase();
        if !ALL_ACTIONS.contains(&kind.as_str()) {
            return Err(format!(
                "未知动作 {kind}：允许值为 pick / reword / drop / fixup / squash / edit"
            ));
        }
        match kind.as_str() {
            ACTION_DROP => {
                dropped += 1;
            }
            ACTION_PICK => {
                has_prev_kept = true;
                prev_message = Some(entry.message.clone());
                steps.push(Step::Pick { hash: hash.clone() });
            }
            ACTION_EDIT => {
                has_prev_kept = true;
                edited += 1;
                prev_message = Some(entry.message.clone());
                steps.push(Step::Edit { hash: hash.clone() });
            }
            ACTION_REWORD => {
                let message = action
                    .message
                    .as_deref()
                    .map(|value| value.trim_end_matches(|c| c == '\n' || c == '\r').to_string())
                    .unwrap_or_default();
                if message.trim().is_empty() {
                    return Err(format!("reword 需要新消息：提交 {} 的消息不能为空", entry.short_hash));
                }
                has_prev_kept = true;
                reworded += 1;
                prev_message = Some(message.clone());
                steps.push(Step::Reword { hash: hash.clone(), message });
            }
            ACTION_FIXUP => {
                if !has_prev_kept {
                    return Err(format!(
                        "提交 {} 标记了 fixup，但其之前没有可折叠的目标提交（第一条有效提交不能 fixup，前一条被 drop 也不行）",
                        entry.short_hash
                    ));
                }
                folded += 1;
                steps.push(Step::Fixup { hash: hash.clone() });
            }
            ACTION_SQUASH => {
                if !has_prev_kept {
                    return Err(format!(
                        "提交 {} 标记了 squash，但其之前没有可折叠的目标提交（第一条有效提交不能 squash，前一条被 drop 也不行）",
                        entry.short_hash
                    ));
                }
                folded += 1;
                let custom = action
                    .message
                    .as_deref()
                    .map(|value| value.trim_end_matches(|c| c == '\n' || c == '\r').to_string())
                    .filter(|value| !value.trim().is_empty());
                let message = custom.unwrap_or_else(|| match &prev_message {
                    Some(previous) => {
                        format!("{}\n\n{}", previous.trim_end(), entry.message.trim())
                    }
                    None => entry.message.clone(),
                });
                prev_message = Some(message.clone());
                steps.push(Step::Squash { hash: hash.clone(), message });
            }
            _ => unreachable!("kind 已通过取值校验"),
        }
    }
    let result_count = steps.len() - folded;
    Ok(PlanData { steps, dropped, folded, reworded, edited, result_count })
}

/// 把计划编译为 git-rebase-todo 文本；消息写入临时文件，exec 行只引用固定字面量
/// 与已校验路径。todo 为空（全部 drop）时输出仅含换行——git 视为「重置到基点」。
fn materialize_todo(plan: &PlanData, temp: &TempWorkspace) -> Result<String, String> {
    let mut lines: Vec<String> = Vec::new();
    let mut index = 0usize;
    for step in &plan.steps {
        match step {
            Step::Pick { hash } => lines.push(format!("pick {hash}")),
            Step::Edit { hash } => lines.push(format!("edit {hash}")),
            Step::Fixup { hash } => {
                // 折叠必须整体在单条 exec 内完成：sequencer 在每条 todo 行之间
                // 要求索引相对 HEAD 干净，reset --soft 与 amend 拆成两行会被拒绝。
                lines.push(format!("pick {hash}"));
                lines.push("exec git reset --soft HEAD~1 && git commit --amend --no-verify -C HEAD".to_string());
            }
            Step::Reword { hash, message } => {
                index += 1;
                let path = temp.write_file(&format!("message-{index}.txt"), message)?;
                let display = script_safe_path(&path)?;
                lines.push(format!("pick {hash}"));
                lines.push(format!("exec git commit --amend --no-verify -F '{display}'"));
            }
            Step::Squash { hash, message } => {
                index += 1;
                let path = temp.write_file(&format!("message-{index}.txt"), message)?;
                let display = script_safe_path(&path)?;
                lines.push(format!("pick {hash}"));
                lines.push(format!("exec git reset --soft HEAD~1 && git commit --amend --no-verify -F '{display}'"));
            }
        }
    }
    let mut todo = lines.join("\n");
    if !todo.is_empty() {
        todo.push('\n');
    }
    Ok(todo)
}

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/// 读取可编辑的提交序列（先旧后新）。只要求：无进行中操作、非 detached、干净工作区、
/// base 可解析且为 HEAD 祖先。范围内含合并提交时不报错但给出 warning（apply 会拒绝）。
pub fn load_history_edit_sequence(
    repository_path: &str,
    base_ref: &str,
) -> Result<HistoryEditSequence, String> {
    let root = git::repository_root(repository_path)?;
    let ready = preflight(&root)?;
    let base_hash = validated_base(&root, base_ref, &ready.head)?;
    let entries = range_entries(&root, Some(&base_hash), &ready.head)?;
    let mut warnings = Vec::new();
    if range_has_merge(&root, Some(&base_hash), &ready.head)? {
        warnings.push(
            "范围内包含合并提交：交互式序列编辑会拒绝应用（rebase -i 会展平合并结构），请改用普通变基或逐个改写".to_string(),
        );
    }
    Ok(HistoryEditSequence {
        repository_path: ready.path_string,
        branch: ready.branch,
        base_ref: base_ref.trim().to_string(),
        base_hash,
        head: ready.head,
        entries,
        warnings,
    })
}

/// 应用前的影响预览：统计重写/丢弃/折叠规模，并列出会被掉队的分支/标签与强推风险。
/// 与 apply 共用 validate_plan，保证「预览所见 = 应用所得」。
pub fn preview_history_edit_impact(
    repository_path: &str,
    base_ref: &str,
    actions: Vec<HistoryEditActionInput>,
) -> Result<HistoryEditImpact, String> {
    let root = git::repository_root(repository_path)?;
    let ready = preflight(&root)?;
    let base_hash = validated_base(&root, base_ref, &ready.head)?;
    let entries = range_entries(&root, Some(&base_hash), &ready.head)?;
    if range_has_merge(&root, Some(&base_hash), &ready.head)? {
        return Err("范围内包含合并提交，交互式序列编辑会拒绝应用；预览同步拒绝".to_string());
    }
    let plan = validate_plan(&entries, &actions)?;

    // 范围内提交集合（不含 base 自身——指向 base 的 ref 不受影响）。
    let in_range: HashSet<&str> = entries.iter().map(|entry| entry.hash.as_str()).collect();
    let mut branches_left_behind = Vec::new();
    let mut tags_on_rewritten = Vec::new();
    let refs_listing = git::git_output(
        &root,
        &["for-each-ref", "--format=%(objectname) %(refname:short)", "refs/heads", "refs/tags"],
    )?;
    for line in refs_listing.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some((object, name)) = line.split_once(' ') else { continue };
        if !in_range.contains(object) {
            continue;
        }
        // 当前分支指向 HEAD，会被 rebase 正常移动，不属于「掉队」。
        if name == ready.branch {
            continue;
        }
        let is_branch = git::git_output(&root, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{name}")]).is_ok();
        if is_branch {
            branches_left_behind.push(name.to_string());
        } else {
            tags_on_rewritten.push(name.to_string());
        }
    }

    let upstream = git::git_output(
        &root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", &format!("{}@{{upstream}}", ready.branch)],
    )
    .map(|value| value.trim().to_string())
    .ok()
    .filter(|value| !value.is_empty() && value != "HEAD");
    let published = upstream
        .as_ref()
        .map(|target| is_ancestor(&root, &entries[0].hash, target))
        .unwrap_or(false);

    let mut warnings = Vec::new();
    if !branches_left_behind.is_empty() {
        warnings.push(format!(
            "分支 {} 指向范围内将被重写的提交：变基只移动当前分支，它们会停在旧历史（掉队）",
            branches_left_behind.join("、")
        ));
    }
    if !tags_on_rewritten.is_empty() {
        warnings.push(format!(
            "标签 {} 钉在旧提交上：重写后需要人工重新打标签",
            tags_on_rewritten.join("、")
        ));
    }
    if published {
        warnings.push(
            "范围内提交已推送到上游分支：这次重写属于公共历史改写，完成后必须强制推送（--force-with-lease），协作者需要重置本地分支"
                .to_string(),
        );
    }
    if plan.dropped > 0 {
        warnings.push(format!("将丢弃 {} 个提交的变更内容，此操作改写历史、不可轻易撤销", plan.dropped));
    }

    let dangerous = plan.dropped > 0 || plan.folded > 0 || published;
    Ok(HistoryEditImpact {
        branch: ready.branch,
        base_hash,
        head_before: ready.head,
        total: entries.len(),
        dropped: plan.dropped,
        folded: plan.folded,
        reworded: plan.reworded,
        rewritten_upper: plan.result_count,
        expected_result_count: plan.result_count,
        branches_left_behind,
        tags_on_rewritten,
        upstream,
        published,
        dangerous,
        warnings,
    })
}

/// 应用序列编辑：生成 todo → 注入 GIT_SEQUENCE_EDITOR → git rebase -i。
/// 返回 status=completed（重写完成）或 status=stopped（冲突/edit 停点，仓库处于
/// 变基中，可被现有 继续/跳过/中止 面板处理，恢复指引见 recovery）。
pub fn apply_history_edit_sequence(
    repository_path: &str,
    base_ref: &str,
    actions: Vec<HistoryEditActionInput>,
) -> Result<HistoryEditReport, String> {
    let root = git::repository_root(repository_path)?;
    let ready = preflight(&root)?;
    let base_hash = validated_base(&root, base_ref, &ready.head)?;
    run_sequence(&root, ready, Some(base_hash), actions, "交互式历史编辑")
}

/// 核心执行：base=None 表示 `rebase -i --root`（改写根提交时没有父基点）。
fn run_sequence(
    root: &Path,
    ready: Ready,
    base: Option<String>,
    actions: Vec<HistoryEditActionInput>,
    action_label: &str,
) -> Result<HistoryEditReport, String> {
    let head_before = ready.head.clone();
    if range_has_merge(root, base.as_deref(), &ready.head)? {
        return Err(
            "范围内包含合并提交：交互式序列编辑会将其静默展平，已拒绝执行。\
             请改用普通变基/合并流程，或把基点选在合并提交之后。"
                .to_string(),
        );
    }
    let entries = range_entries(root, base.as_deref(), &ready.head)?;
    if entries.is_empty() {
        return Err("范围内没有可编辑的提交".to_string());
    }
    let plan = validate_plan(&entries, &actions)?;
    let temp = TempWorkspace::new()?;
    let outcome = (|| -> Result<HistoryEditReport, String> {
        let todo = materialize_todo(&plan, &temp)?;
        let todo_path = temp.write_file("git-rebase-todo", &todo)?;
        let todo_display = script_safe_path(&todo_path)?;
        let editor_script = temp.write_script("sequence-editor", &sequence_editor_script(&todo_display))?;
        let noop_script = temp.write_script("message-editor", &noop_editor_script())?;
        let mut args: Vec<&str> = vec!["rebase", "-i"];
        match base.as_deref() {
            Some(value) => args.push(value),
            None => args.push("--root"),
        }
        let output = run_git_with_env(
            root,
            &[
                ("GIT_SEQUENCE_EDITOR", editor_script.as_path()),
                ("GIT_EDITOR", noop_script.as_path()),
            ],
            &args,
        )?;
        // 判定一律走结构化状态目录，绝不匹配 Git 的本地化文案。
        if in_progress_operation(root).is_some() {
            let head_now = head_hash(root).unwrap_or_default();
            return Ok(HistoryEditReport {
                status: "stopped".to_string(),
                branch: ready.branch.clone(),
                base_hash: base.clone().unwrap_or_default(),
                head_before: head_before.clone(),
                head_after: head_now,
                result_count: 0,
                recovery: Some(format!(
                    "变基已暂停（冲突或 edit 停点）。请在操作面板用「继续 / 跳过 / 中止」处理：\
                     中止（abort）会把分支恢复到 {head_before}；\
                     注意 exec 步骤引用的临时消息文件保留在 {temp_dir}，处理完结前请勿手动清理。",
                    temp_dir = abandoned_temp(&temp)
                )),
                notice: if output.status.success() {
                    None
                } else {
                    Some(String::from_utf8_lossy(&output.stderr).trim().to_string())
                },
            });
        }
        // 未在进行中：要么完成，要么启动即失败（仓库未被改写）。
        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let error = if error.is_empty() { "Git 命令执行失败".to_string() } else { error };
            let head_now = head_hash(root).unwrap_or_default();
            return Err(if head_now == head_before {
                format!("{action_label}启动失败，仓库未被改写：{error}")
            } else {
                format!(
                    "{action_label}失败且 HEAD 已移动（当前 {head_now}，原 {head_before}）。\
                     可用 git reset --hard {head_before} 或 reflog 恢复。{error}"
                )
            });
        }
        temp.cleanup();
        let head_after = head_hash(root)?;
        let spec = range_spec(base.as_deref(), "HEAD");
        let result_count: usize = git::git_output(root, &["rev-list", "--count", &spec])?
            .trim()
            .parse()
            .map_err(|_| "统计结果历史失败".to_string())?;
        Ok(HistoryEditReport {
            status: "completed".to_string(),
            branch: ready.branch.clone(),
            base_hash: base.unwrap_or_default(),
            head_before,
            head_after,
            result_count,
            recovery: None,
            notice: Some(format!(
                "分支 {} 已重写：{} 条保留、{} 条折叠、{} 条丢弃、{} 条改写消息、{} 处停点编辑",
                ready.branch,
                plan.steps.len() - plan.folded,
                plan.folded,
                plan.dropped,
                plan.reworded,
                plan.edited
            )),
        })
    })();
    // 仅在确定未停在中途时清理；stopped 路径保留消息文件供 continue 重跑 exec。
    if outcome.as_ref().map(|report| report.status == "completed").unwrap_or(true) {
        temp.cleanup();
    }
    outcome
}

/// 改写任意历史提交的消息（EnjoyGit 右键「编辑提交说明」语义）。
/// 目标到 HEAD 之间的所有提交都会被重写（哈希变化），tree 逐一保持不变。
pub fn reword_history_commit(
    repository_path: &str,
    commit: &str,
    message: &str,
) -> Result<HistoryEditReport, String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("新的提交消息不能为空".to_string());
    }
    let root = git::repository_root(repository_path)?;
    let ready = preflight(&root)?;
    let target = resolve_commit(&root, commit.trim())?;
    if target != ready.head && !is_ancestor(&root, &target, &ready.head) {
        return Err("目标提交不在当前分支的历史中，无法改写".to_string());
    }
    let parents = commit_parents(&root, &target)?;
    if parents.len() > 1 {
        return Err("暂不支持改写合并提交的消息（序列编辑会展平其结构）。".to_string());
    }
    let base = parents.first().cloned();
    let entries = range_entries(&root, base.as_deref(), &ready.head)?;
    let actions = entries
        .iter()
        .map(|entry| HistoryEditActionInput {
            hash: entry.hash.clone(),
            action: if entry.hash == target { ACTION_REWORD.to_string() } else { ACTION_PICK.to_string() },
            message: if entry.hash == target { Some(trimmed.to_string()) } else { None },
        })
        .collect();
    run_sequence(&root, ready, base, actions, "改写提交消息")
}

/// 删除（drop）任意单个非合并提交（EnjoyGit 右键「删除提交」语义）。
pub fn drop_history_commit(repository_path: &str, commit: &str) -> Result<HistoryEditReport, String> {
    let root = git::repository_root(repository_path)?;
    let ready = preflight(&root)?;
    let target = resolve_commit(&root, commit.trim())?;
    if target != ready.head && !is_ancestor(&root, &target, &ready.head) {
        return Err("目标提交不在当前分支的历史中，无法删除".to_string());
    }
    let parents = commit_parents(&root, &target)?;
    if parents.len() > 1 {
        return Err("不能删除合并提交：它会连带破坏两条父链，请改用逐个回滚（revert）".to_string());
    }
    let base = parents.first().cloned();
    let entries = range_entries(&root, base.as_deref(), &ready.head)?;
    if base.is_none() && entries.len() == 1 {
        return Err("拒绝删除仓库唯一的根提交：分支将没有任何历史（请先 revert 或改用其他基点）".to_string());
    }
    let actions = entries
        .iter()
        .map(|entry| HistoryEditActionInput {
            hash: entry.hash.clone(),
            action: if entry.hash == target { ACTION_DROP.to_string() } else { ACTION_PICK.to_string() },
            message: None,
        })
        .collect();
    run_sequence(&root, ready, base, actions, "删除提交")
}

/// 提交父列表：`rev-list --parents -n 1 <hash>` 首 token 为自身，其余为父。
fn commit_parents(root: &Path, hash: &str) -> Result<Vec<String>, String> {
    let output = git::git_output(root, &["rev-list", "--parents", "-n", "1", hash])?;
    let parents = output
        .split_whitespace()
        .skip(1)
        .filter(|value| is_full_hash(value))
        .map(|value| value.to_string())
        .collect();
    Ok(parents)
}

/// 批量 cherry-pick：一次挑选多个提交，按「先旧后新」（作者时间，其次输入序）应用。
///
/// 空提交（内容已存在于目标历史）用结构化判定跳过：复用主线
/// `cherry_pick_repository_commit_with_mainline` 的「CHERRY_PICK_HEAD + 无未合并
/// 路径 + diff --cached」语义，本函数以「调用后 HEAD 是否移动」分类 applied /
/// skippedEmpty，绝不匹配 Git 的本地化错误文案。
/// 任一提交因冲突失败即停：仓库停在该提交的拣选中途，恢复路径为现有
/// 继续/跳过/中止 面板，recovery 字段给出指引。
pub fn cherry_pick_history_commits(
    repository_path: &str,
    commits: Vec<String>,
    mainline: Option<usize>,
) -> Result<CherryPickBatchReport, String> {
    let root = git::repository_root(repository_path)?;
    let ready = preflight(&root)?;
    let head_before = ready.head.clone();
    if commits.is_empty() {
        return Err("没有挑选任何提交".to_string());
    }
    // 解析 + 去重（保留首次出现的输入序，作为同时间提交的决定性次序）。
    let mut ordered: Vec<(usize, String)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (index, reference) in commits.iter().enumerate() {
        let hash = resolve_commit(&root, reference.trim())
            .map_err(|error| format!("第 {} 个提交的引用无效：{error}", index + 1))?;
        if seen.insert(hash.clone()) {
            ordered.push((index, hash));
        }
    }
    // 先旧后新：作者时间升序，其次提交时间，再次用户点选顺序——确定性排序。
    let mut keyed: Vec<(i64, i64, usize, String)> = Vec::new();
    for (index, hash) in &ordered {
        let line = git::git_output(
            &root,
            &["show", "-s", "--format=%at %ct", hash],
        )
        .map_err(|error| format!("读取提交 {hash} 时间失败：{error}"))?;
        let mut fields = line.trim().split_whitespace();
        let author_time: i64 = fields.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        let commit_time: i64 = fields.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        keyed.push((author_time, commit_time, *index, hash.clone()));
    }
    keyed.sort();

    let mut outcomes: Vec<CherryPickOutcome> = Vec::new();
    let mut applied = 0usize;
    let mut skipped_empty = 0usize;
    let mut stopped_at: Option<String> = None;
    let mut recovery: Option<String> = None;

    for (_, _, _, hash) in &keyed {
        let title = git::git_output(&root, &["show", "-s", "--format=%s", hash])
            .unwrap_or_default()
            .trim()
            .to_string();
        let short = git::git_output(&root, &["rev-parse", "--short", hash])
            .unwrap_or_else(|_| hash[..8].to_string())
            .trim()
            .to_string();
        let before = head_hash(&root)?;
        let result = git::cherry_pick_repository_commit_with_mainline(&ready.path_string, hash, mainline);
        match result {
            Ok(()) => {
                let after = head_hash(&root)?;
                if after == *before {
                    // 主线逻辑已把「内容已存在的空拣选」skip 掉：HEAD 不动即证据。
                    skipped_empty += 1;
                    outcomes.push(CherryPickOutcome {
                        hash: hash.clone(),
                        short_hash: short,
                        title,
                        status: "skippedEmpty".to_string(),
                        detail: Some("该提交的变更已存在于当前历史，作为空提交自动跳过".to_string()),
                    });
                } else {
                    applied += 1;
                    outcomes.push(CherryPickOutcome {
                        hash: hash.clone(),
                        short_hash: short,
                        title,
                        status: "applied".to_string(),
                        detail: None,
                    });
                }
            }
            Err(error) => {
                // 结构化分类：未合并路径 → 真冲突停点；否则视为启动/校验失败。
                let unmerged = git::git_output(&root, &["ls-files", "--unmerged"])
                    .map(|value| !value.trim().is_empty())
                    .unwrap_or(false);
                let in_pick = git_dir(&root).join("CHERRY_PICK_HEAD").is_file();
                let status = if unmerged || in_pick { "conflict" } else { "failed" };
                if status == "conflict" {
                    stopped_at = Some(hash.clone());
                    recovery = Some(format!(
                        "批量拣选停在 {short}：仓库处于拣选中途（cherry-pick in progress）。\
                         可在操作面板「继续（解决冲突后）/ 跳过该提交 / 中止整批」处理；\
                         中止只回退这最后一个提交，之前已应用的提交保留。"
                    ));
                } else {
                    stopped_at = Some(hash.clone());
                    recovery = Some(format!(
                        "批量拣选在 {short} 前中止：{error}\n之前的提交已按序应用；仓库应无残留状态，请核实后重试剩余提交。"
                    ));
                }
                outcomes.push(CherryPickOutcome {
                    hash: hash.clone(),
                    short_hash: short,
                    title,
                    status: status.to_string(),
                    detail: Some(error),
                });
                break;
            }
        }
    }
    Ok(CherryPickBatchReport {
        requested: keyed.len(),
        applied,
        skipped_empty,
        outcomes,
        stopped_at,
        recovery,
        head_before,
        head_after: head_hash(&root)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64 as StdAtomicU64;

    static UNIQUE_SEQ: StdAtomicU64 = StdAtomicU64::new(0);

    struct TestRepository(PathBuf);

    impl Drop for TestRepository {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    impl TestRepository {
        fn path(&self) -> &Path {
            &self.0
        }
        fn path_string(&self) -> String {
            self.0.to_string_lossy().to_string()
        }
    }

    fn test_repository() -> TestRepository {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let seq = UNIQUE_SEQ.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "branchline-history-edit-test-{}-{unique}-{seq}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create history-edit test repository");
        git::git_output(&path, &["init", "--initial-branch=main"]).expect("git init");
        git::git_output(&path, &["config", "user.name", "Branchline HistoryEdit"]).expect("user name");
        git::git_output(&path, &["config", "user.email", "history-edit@example.com"]).expect("user email");
        git::git_output(&path, &["config", "commit.gpgsign", "false"]).expect("disable gpg");
        fs::write(path.join("README.md"), "base\n").expect("write file");
        git::git_output(&path, &["add", "-A"]).expect("add");
        git::git_output(&path, &["commit", "-m", "初始提交"]).expect("commit");
        TestRepository(path)
    }

    fn commit_file(root: &Path, name: &str, content: &str, message: &str) -> String {
        fs::write(root.join(name), content).expect("write file");
        git::git_output(root, &["add", "-A"]).expect("add");
        git::git_output(root, &["commit", "-m", message]).expect("commit");
        git::git_output(root, &["rev-parse", "HEAD"]).expect("head hash").trim().to_string()
    }

    /// 带固定作者/提交者时间的提交：批量拣选的「先旧后新」排序必须可测。
    fn commit_file_at(root: &Path, name: &str, content: &str, message: &str, epoch: u64) -> String {
        fs::write(root.join(name), content).expect("write file");
        git::git_output(root, &["add", "-A"]).expect("add");
        let stamp = format!("@{epoch} +0000");
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .env("GIT_AUTHOR_DATE", &stamp)
            .env("GIT_COMMITTER_DATE", &stamp)
            .args(["commit", "-m", message])
            .output()
            .expect("commit with date");
        assert!(output.status.success(), "带时间提交失败：{}", String::from_utf8_lossy(&output.stderr));
        git::git_output(root, &["rev-parse", "HEAD"]).expect("head hash").trim().to_string()
    }

    fn head(root: &Path) -> String {
        git::git_output(root, &["rev-parse", "HEAD"]).expect("head").trim().to_string()
    }

    fn tree_of(root: &Path, rev: &str) -> String {
        git::git_output(root, &["rev-parse", &format!("{rev}^{{tree}}")])
            .expect("tree")
            .trim()
            .to_string()
    }

    /// 从 HEAD 向下的 subject 列表（最新在前）。
    fn subjects(root: &Path, count: usize) -> Vec<String> {
        git::git_output(
            root,
            &["log", &format!("-{count}"), "--format=%s", "HEAD"],
        )
        .expect("log")
        .lines()
        .map(|line| line.to_string())
        .collect()
    }

    fn base_of(root: &Path) -> String {
        // 初始提交：根提交，恒为 HEAD 历史的底。
        git::git_output(root, &["rev-list", "--max-parents=0", "HEAD"])
            .expect("root commit")
            .trim()
            .to_string()
    }

    fn entries_of(repository: &TestRepository, base_ref: &str) -> Vec<HistoryEditEntry> {
        let sequence = load_history_edit_sequence(&repository.path_string(), base_ref)
            .expect("load sequence");
        sequence.entries
    }

    fn plan(entries: &[HistoryEditEntry]) -> Vec<HistoryEditActionInput> {
        entries
            .iter()
            .map(|entry| HistoryEditActionInput {
                hash: entry.hash.clone(),
                action: ACTION_PICK.to_string(),
                message: None,
            })
            .collect()
    }

    fn apply(repository: &TestRepository, base_ref: &str, actions: Vec<HistoryEditActionInput>) -> Result<HistoryEditReport, String> {
        apply_history_edit_sequence(&repository.path_string(), base_ref, actions)
    }

    // -----------------------------------------------------------------------
    // 序列编辑核心
    // -----------------------------------------------------------------------

    #[test]
    fn apply_reorders_commits_and_keeps_final_tree_for_disjoint_changes() {
        let repository = test_repository();
        let root = repository.path();
        // 三个互不相交文件的提交：c1, c2, c3；重排为 c2, c3, c1。
        commit_file(root, "a.txt", "a\n", "改动 A");
        commit_file(root, "b.txt", "b\n", "改动 B");
        commit_file(root, "c.txt", "c\n", "改动 C");
        let original_tree = tree_of(root, "HEAD");
        let entries = entries_of(&repository, &base_of(root));
        assert_eq!(entries.len(), 3);
        let mut actions = plan(&entries);
        let first = actions.remove(0);
        actions.push(first);
        let report = apply(&repository, &base_of(root), actions).expect("apply reorder");
        assert_eq!(report.status, "completed");
        assert_eq!(report.result_count, 3);
        // 应用顺序为 todo 顺序（B, C, A）：log 最新在前 → [改动 A, 改动 C, 改动 B]。
        assert_eq!(subjects(root, 3), vec!["改动 A", "改动 C", "改动 B"]);
        assert_eq!(tree_of(root, "HEAD"), original_tree, "不相交改动重排不应改变最终树");
        assert_ne!(report.head_before, report.head_after);
    }

    #[test]
    fn apply_drop_removes_commit_and_others_keep_order() {
        let repository = test_repository();
        let root = repository.path();
        commit_file(root, "a.txt", "a\n", "改动 A");
        let doomed = commit_file(root, "doomed.txt", "drop me\n", "要丢弃的提交");
        commit_file(root, "c.txt", "c\n", "改动 C");
        let base = base_of(root);
        let mut actions = plan(&entries_of(&repository, &base));
        for action in actions.iter_mut() {
            if action.hash == doomed {
                action.action = ACTION_DROP.to_string();
            }
        }
        let report = apply(&repository, &base, actions).expect("apply drop");
        assert_eq!(report.status, "completed");
        assert_eq!(report.result_count, 2);
        assert_eq!(subjects(root, 2), vec!["改动 C", "改动 A"]);
        assert!(!root.join("doomed.txt").exists(), "被丢弃提交的变更不应出现在结果树");
    }

    #[test]
    fn apply_fixup_folds_changes_and_keeps_target_message() {
        let repository = test_repository();
        let root = repository.path();
        commit_file(root, "a.txt", "a\n", "改动 A");
        commit_file(root, "b.txt", "fixup content\n", "补丁 B");
        let base = base_of(root);
        let mut actions = plan(&entries_of(&repository, &base));
        actions[1].action = ACTION_FIXUP.to_string();
        let report = apply(&repository, &base, actions).expect("apply fixup");
        assert_eq!(report.status, "completed");
        assert_eq!(report.result_count, 1);
        assert_eq!(subjects(root, 2), vec!["改动 A", "初始提交"], "fixup 必须保留目标提交的消息");
        assert_eq!(fs::read_to_string(root.join("b.txt")).expect("read"), "fixup content\n");
    }

    #[test]
    fn apply_squash_combines_messages_by_default_and_uses_custom_message() {
        let repository = test_repository();
        let root = repository.path();
        commit_file(root, "a.txt", "a\n", "改动 A");
        commit_file(root, "b.txt", "b\n", "改动 B");
        let base = base_of(root);
        let mut actions = plan(&entries_of(&repository, &base));
        actions[1].action = ACTION_SQUASH.to_string();
        let report = apply(&repository, &base, actions).expect("apply squash default");
        assert_eq!(report.result_count, 1);
        let message = git::git_output(root, &["log", "-1", "--format=%B", "HEAD"]).expect("message");
        assert_eq!(message.trim(), "改动 A\n\n改动 B", "缺省合并消息 = 前一条 + 本条");
        assert_eq!(fs::read_to_string(root.join("a.txt")).expect("a"), "a\n");
        assert_eq!(fs::read_to_string(root.join("b.txt")).expect("b"), "b\n");

        // 自定义消息分支：再来一次 squash，message 显式提供。
        let repository2 = test_repository();
        let root2 = repository2.path();
        commit_file(root2, "a.txt", "a\n", "改动 A");
        commit_file(root2, "b.txt", "b\n", "改动 B");
        let base2 = base_of(root2);
        let mut actions2 = plan(&entries_of(&repository2, &base2));
        actions2[1].action = ACTION_SQUASH.to_string();
        actions2[1].message = Some("打包发布".to_string());
        apply(&repository2, &base2, actions2).expect("apply squash custom");
        assert_eq!(
            git::git_output(root2, &["log", "-1", "--format=%s", "HEAD"]).expect("subject").trim(),
            "打包发布"
        );
    }

    #[test]
    fn apply_reword_changes_message_but_keeps_every_tree() {
        let repository = test_repository();
        let root = repository.path();
        commit_file(root, "a.txt", "a\n", "改动 A");
        let target = commit_file(root, "b.txt", "b\n", "改动 B");
        let base = base_of(root);
        let trees_before: Vec<String> = git::git_output(root, &["rev-list", &format!("{base}..HEAD"), "--reverse"])
            .expect("revlist")
            .lines()
            .map(|line| tree_of(root, line.trim()))
            .collect();
        let mut actions = plan(&entries_of(&repository, &base));
        assert!(actions.iter().any(|action| action.hash == target));
        actions[1].action = ACTION_REWORD.to_string();
        actions[1].message = Some("改动 B（重写）".to_string());
        let report = apply(&repository, &base, actions).expect("apply reword");
        assert_eq!(report.status, "completed");
        assert_eq!(subjects(root, 2), vec!["改动 B（重写）", "改动 A"]);
        let trees_after: Vec<String> = git::git_output(root, &["rev-list", &format!("{}..HEAD", report.base_hash), "--reverse"])
            .expect("revlist")
            .lines()
            .map(|line| tree_of(root, line.trim()))
            .collect();
        assert_eq!(trees_before, trees_after, "reword 不应改变任何一棵树");
    }

    #[test]
    fn apply_edit_stops_rebase_and_abort_restores_head() {
        let repository = test_repository();
        let root = repository.path();
        commit_file(root, "a.txt", "a\n", "改动 A");
        commit_file(root, "b.txt", "b\n", "改动 B");
        let base = base_of(root);
        let before = head(root);
        let mut actions = plan(&entries_of(&repository, &base));
        actions[0].action = ACTION_EDIT.to_string();
        let report = apply(&repository, &base, actions).expect("apply edit stop");
        assert_eq!(report.status, "stopped");
        assert!(in_progress_operation(root) == Some("变基"), "edit 停点后仓库应处于变基中");
        let recovery = report.recovery.expect("stopped 必须带恢复指引");
        assert!(recovery.contains("中止"), "恢复指引需说明 abort 路径");
        // 用主线可用的 abort 语义恢复：直接跑 git rebase --abort（等价于面板的「中止」）。
        git::git_output(root, &["rebase", "--abort"]).expect("abort restores");
        assert_eq!(head(root), before, "中止后 HEAD 必须回到编辑前");
        assert_eq!(in_progress_operation(root), None);
    }

    #[test]
    fn apply_conflict_stops_in_rebase_with_recovery_and_abort_restores() {
        let repository = test_repository();
        let root = repository.path();
        // 同一行内容冲突的两个提交：互换顺序必然冲突。
        fs::write(root.join("shared.txt"), "base\nline1\n").expect("write");
        git::git_output(root, &["add", "-A"]).expect("add");
        git::git_output(root, &["commit", "-m", "基线共享"]).expect("commit");
        let base = head(root);
        commit_file(root, "shared.txt", "base\nline1\n改为 X\n", "改为 X");
        commit_file(root, "shared.txt", "base\nline1\n改为 Y\n", "改为 Y");
        let original_head = head(root);
        let mut actions = plan(&entries_of(&repository, &base));
        actions.swap(0, 1);
        let report = apply(&repository, &base, actions).expect("conflict stops");
        assert_eq!(report.status, "stopped");
        assert_eq!(in_progress_operation(root), Some("变基"));
        assert!(report.recovery.expect("recovery").contains("继续 / 跳过 / 中止"));
        // 冲突标记结构可被检测到（未合并路径），证明停在可处置状态。
        let unmerged = git::git_output(root, &["ls-files", "--unmerged"]).expect("unmerged");
        assert!(unmerged.contains("shared.txt"));
        git::git_output(root, &["rebase", "--abort"]).expect("abort");
        assert_eq!(head(root), original_head, "失败路径必须可被 abort 完整恢复");
    }

    // -----------------------------------------------------------------------
    // 前置校验
    // -----------------------------------------------------------------------

    #[test]
    fn preflight_rejects_dirty_worktree_and_detached_head() {
        let repository = test_repository();
        let root = repository.path();
        commit_file(root, "a.txt", "a\n", "改动 A");
        let base = base_of(root);
        let actions = plan(&entries_of(&repository, &base));

        // 脏工作区（未提交的跟踪文件改动）。
        fs::write(root.join("a.txt"), "dirty\n").expect("dirty write");
        let error = apply(&repository, &base, actions.clone()).expect_err("dirty must fail");
        assert!(error.contains("工作区"), "报错需说明工作区不干净：{error}");
        git::git_output(root, &["checkout", "--", "a.txt"]).expect("clean up");

        // 分离 HEAD。
        git::git_output(root, &["checkout", "--detach", "HEAD"]).expect("detach");
        let error = load_history_edit_sequence(&repository.path_string(), &base)
            .expect_err("detached must fail");
        assert!(error.contains("分离"), "报错需说明 detached：{error}");
        let error = apply(&repository, &base, actions).expect_err("detached apply must fail");
        assert!(error.contains("分离"));
        git::git_output(root, &["checkout", "main"]).expect("re-attach");
    }

    #[test]
    fn preflight_rejects_operation_in_progress() {
        let repository = test_repository();
        let root = repository.path();
        // 在 side 分支做一个与 main 冲突的提交，发起 cherry-pick 制造「拣选中途」。
        let c1 = commit_file(root, "a.txt", "a\n", "改动 A");
        commit_file(root, "b.txt", "b\n", "改动 B");
        let base = base_of(root);
        let actions = plan(&entries_of(&repository, &base));
        git::git_output(root, &["checkout", "-b", "side", &c1]).expect("branch side");
        commit_file(root, "b.txt", "conflicting\n", "side 改动 B");
        let side_commit = head(root);
        git::git_output(root, &["checkout", "main"]).expect("back to main");
        let pick = run_git_with_env(root, &[], &["cherry-pick", &side_commit]).expect("spawn");
        assert!(!pick.status.success(), "预期冲突");
        assert_eq!(in_progress_operation(root), Some("拣选"));

        let error = apply(&repository, &base, actions).unwrap_err();
        assert!(error.contains("进行中"), "应拒绝于进行中状态：{error}");
        let error = cherry_pick_history_commits(&repository.path_string(), vec!["HEAD".to_string()], None).unwrap_err();
        assert!(error.contains("进行中"));
        git::git_output(root, &["cherry-pick", "--abort"]).expect("cleanup");
    }

    #[test]
    fn preflight_rejects_unresolvable_or_non_ancestor_base() {
        let repository = test_repository();
        let root = repository.path();
        commit_file(root, "a.txt", "a\n", "改动 A");
        let error = load_history_edit_sequence(&repository.path_string(), "no/such-ref").unwrap_err();
        assert!(error.contains("基点"), "报错需面向基点引用：{error}");

        // 制造与 HEAD 无祖先关系的另一条根。
        git::git_output(root, &["checkout", "--orphan", "orphan"]).expect("orphan");
        let other = commit_file(root, "orphan.txt", "x\n", "孤立提交");
        git::git_output(root, &["checkout", "main"]).expect("back");
        let error = validated_base(root, &other, &head(root)).expect_err("non-ancestor must fail");
        assert!(error.contains("祖先"), "报错需说明祖先关系：{error}");
    }

    #[test]
    fn apply_rejects_mismatched_action_set_without_touching_repository() {
        let repository = test_repository();
        let root = repository.path();
        commit_file(root, "a.txt", "a\n", "改动 A");
        commit_file(root, "b.txt", "b\n", "改动 B");
        let base = base_of(root);
        let before = head(root);
        let entries = entries_of(&repository, &base);

        // 数量不符。
        let too_few = plan(&entries[..1].to_vec());
        assert!(apply(&repository, &base, too_few).is_err());
        assert_eq!(head(root), before);

        // 重复哈希。
        let mut duplicated = plan(&entries);
        duplicated[1].hash = duplicated[0].hash.clone();
        assert!(apply(&repository, &base, duplicated).is_err());

        // 集合外的哈希。
        let mut foreign = plan(&entries);
        foreign[0].hash = "f".repeat(40);
        assert!(apply(&repository, &base, foreign).is_err());
        assert_eq!(head(root), before);
        assert!(in_progress_operation(root).is_none(), "校验失败不得留下任何进行中状态");
    }

    #[test]
    fn apply_rejects_squash_or_fixup_without_target() {
        let repository = test_repository();
        let root = repository.path();
        commit_file(root, "a.txt", "a\n", "改动 A");
        commit_file(root, "b.txt", "b\n", "改动 B");
        let base = base_of(root);
        // 首条 squash：无折叠目标。
        let mut actions = plan(&entries_of(&repository, &base));
        actions[0].action = ACTION_SQUASH.to_string();
        let error = apply(&repository, &base, actions.clone()).expect_err("first squash must fail");
        assert!(error.contains("squash"));
        // 前一条 drop 后 squash：同样无目标。
        let mut actions = plan(&entries_of(&repository, &base));
        actions[0].action = ACTION_DROP.to_string();
        actions[1].action = ACTION_SQUASH.to_string();
        assert!(apply(&repository, &base, actions).is_err());
        // reword 空消息：拒绝。
        let mut actions = plan(&entries_of(&repository, &base));
        actions[0].action = ACTION_REWORD.to_string();
        actions[0].message = Some("   ".to_string());
        assert!(apply(&repository, &base, actions).is_err());
    }

    #[test]
    fn apply_rejects_ranges_containing_merge_commits() {
        let repository = test_repository();
        let root = repository.path();
        let c1 = commit_file(root, "a.txt", "a\n", "改动 A");
        commit_file(root, "b.txt", "b\n", "改动 B");
        git::git_output(root, &["checkout", "-b", "side", &c1]).expect("branch");
        commit_file(root, "s.txt", "s\n", "side 改动");
        git::git_output(root, &["checkout", "main"]).expect("back");
        git::git_output(root, &["merge", "--no-edit", "side"]).expect("merge");
        let base = base_of(root);
        let sequence = load_history_edit_sequence(&repository.path_string(), &base).expect("load with warning");
        assert!(!sequence.warnings.is_empty(), "load 应给出合并提交警告");
        assert!(sequence.entries.iter().any(|entry| entry.is_merge));
        let actions = plan(&sequence.entries);
        let error = apply(&repository, &base, actions).expect_err("merge range must be rejected");
        assert!(error.contains("合并提交"));
        assert_eq!(in_progress_operation(root), None, "拒绝必须在起跑之前");
    }

    // -----------------------------------------------------------------------
    // 影响预览
    // -----------------------------------------------------------------------

    #[test]
    fn impact_reports_left_behind_branches_tags_and_publish_state() {
        let repository = test_repository();
        let root = repository.path();
        commit_file(root, "a.txt", "a\n", "改动 A");
        let pinned = commit_file(root, "b.txt", "b\n", "改动 B");
        commit_file(root, "c.txt", "c\n", "改动 C");
        // 分支停在范围内提交；标签钉在范围内提交。
        git::git_output(root, &["branch", "side", &pinned]).expect("side branch");
        git::git_output(root, &["tag", "v1", &pinned]).expect("tag v1");
        // 伪造已推送状态：upstream 指向包含范围内提交的远端跟踪分支
        // （需要 remote.origin.fetch 配置，否则 Git 不承认其为远程跟踪分支）。
        git::git_output(root, &["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]).expect("cfg0");
        git::git_output(root, &["update-ref", "refs/remotes/origin/main", &head(root)]).expect("remote ref");
        git::git_output(root, &["config", "branch.main.remote", "origin"]).expect("cfg1");
        git::git_output(root, &["config", "branch.main.merge", "refs/heads/main"]).expect("cfg2");

        let base = base_of(root);
        let entries = entries_of(&repository, &base);
        let mut actions = plan(&entries);
        actions[2].action = ACTION_DROP.to_string();
        let impact = preview_history_edit_impact(&repository.path_string(), &base, actions).expect("impact");
        assert_eq!(impact.total, 3);
        assert_eq!(impact.dropped, 1);
        assert_eq!(impact.expected_result_count, 2);
        assert!(impact.branches_left_behind.contains(&"side".to_string()));
        assert!(impact.tags_on_rewritten.contains(&"v1".to_string()));
        assert_eq!(impact.upstream.as_deref(), Some("origin/main"));
        assert!(impact.published, "上游已含范围内提交必须标记为公共历史改写");
        assert!(impact.dangerous);
        assert!(!impact.warnings.is_empty());

        // 纯 pick 重排的预览路径：不丢弃内容 → dangerous 仍可能因 published 为 true；
        // 去掉伪造的 upstream 后应为 false。
        git::git_output(root, &["update-ref", "-d", "refs/remotes/origin/main"]).expect("drop remote ref");
        git::git_output(root, &["config", "--unset", "branch.main.remote"]).expect("unset1");
        git::git_output(root, &["config", "--unset", "branch.main.merge"]).expect("unset2");
        let impact = preview_history_edit_impact(&repository.path_string(), &base, plan(&entries)).expect("impact2");
        assert!(!impact.dangerous, "无丢弃、无折叠、未发布时不应为危险");
        // 预览不落任何改动。
        assert_eq!(impact.head_before, head(root));
    }

    // -----------------------------------------------------------------------
    // 任意提交改写 / 删除
    // -----------------------------------------------------------------------

    #[test]
    fn reword_history_commit_changes_message_only_and_rewrites_descendants() {
        let repository = test_repository();
        let root = repository.path();
        commit_file(root, "a.txt", "a\n", "改动 A");
        let target = commit_file(root, "b.txt", "b\n", "改动 B");
        commit_file(root, "c.txt", "c\n", "改动 C");
        let trees_before: Vec<String> = git::git_output(root, &["rev-list", "HEAD", "--reverse"])
            .expect("revlist")
            .lines()
            .map(|line| tree_of(root, line.trim()))
            .collect();
        let report = reword_history_commit(&repository.path_string(), &target, "改动 B（已改写）").expect("reword");
        assert_eq!(report.status, "completed");
        assert_eq!(subjects(root, 3), vec!["改动 C", "改动 B（已改写）", "改动 A"]);
        let trees_after: Vec<String> = git::git_output(root, &["rev-list", "HEAD", "--reverse"])
            .expect("revlist")
            .lines()
            .map(|line| tree_of(root, line.trim()))
            .collect();
        assert_eq!(trees_before, trees_after, "改写消息不得改变任何树（含后代的相对差异）");
        // 后代提交哈希必须已变（历史被重写）。
        assert_ne!(report.head_before, report.head_after);
    }

    #[test]
    fn drop_history_commit_removes_target_and_keeps_relative_order() {
        let repository = test_repository();
        let root = repository.path();
        commit_file(root, "a.txt", "a\n", "改动 A");
        let doomed = commit_file(root, "b.txt", "b\n", "改动 B");
        commit_file(root, "c.txt", "c\n", "改动 C");
        let report = drop_history_commit(&repository.path_string(), &doomed).expect("drop");
        assert_eq!(report.status, "completed");
        assert_eq!(subjects(root, 2), vec!["改动 C", "改动 A"]);
        assert!(!root.join("b.txt").exists());
        // 删除不在历史中的提交：拒绝。
        let repository2 = test_repository();
        commit_file(repository2.path(), "x.txt", "x\n", "另一条线");
        assert!(drop_history_commit(&repository.path_string(), &head(repository2.path())).is_err());
    }

    #[test]
    fn reword_history_commit_supports_root_commit_via_rebase_root() {
        let repository = test_repository();
        let root = repository.path();
        commit_file(root, "a.txt", "a\n", "改动 A");
        let base_commit = base_of(root);
        let report = reword_history_commit(&repository.path_string(), &base_commit, "初始提交（改写）").expect("reword root");
        assert_eq!(report.status, "completed");
        assert_eq!(subjects(root, 2), vec!["改动 A", "初始提交（改写）"]);
        // drop 根提交且删空历史：拒绝。
        let repository2 = test_repository();
        let only_root = base_of(repository2.path());
        let error = drop_history_commit(&repository2.path_string(), &only_root).expect_err("must refuse wiping repo");
        assert!(error.contains("根提交"), "报错需明确说明拒绝原因：{error}");
    }

    // -----------------------------------------------------------------------
    // 批量 cherry-pick
    // -----------------------------------------------------------------------

    #[test]
    fn batch_cherry_pick_applies_oldest_first_regardless_of_selection_order() {
        let repository = test_repository();
        let root = repository.path();
        let fork = head(root);
        // feature 分支：按时间 f1(更早) → f2。故意乱序挑选。
        git::git_output(root, &["checkout", "-b", "feature"]).expect("feature");
        commit_file_at(root, "f1.txt", "one\n", "功能一", 1_700_000_100);
        commit_file_at(root, "f2.txt", "two\n", "功能二", 1_700_000_200);
        let f2 = head(root);
        let f1 = git::git_output(root, &["rev-parse", "HEAD~1"]).expect("f1").trim().to_string();
        git::git_output(root, &["checkout", "-b", "target", &fork]).expect("target from fork");

        let report = cherry_pick_history_commits(&repository.path_string(), vec![f2.clone(), f1.clone()], None).expect("batch");
        assert_eq!(report.applied, 2);
        assert_eq!(report.skipped_empty, 0);
        assert!(report.stopped_at.is_none());
        // 结果顺序：先旧后新 → f1' 在前（log 最新在前：功能二在上）。
        assert_eq!(subjects(root, 2), vec!["功能二", "功能一"]);
        assert!(root.join("f1.txt").exists() && root.join("f2.txt").exists());
        assert_eq!(report.outcomes[0].status, "applied");
        assert_eq!(report.outcomes[0].hash, f1, "先应用的必须是更早的提交");
        assert_eq!(report.head_after, head(root));
    }

    #[test]
    fn batch_cherry_pick_skips_already_applied_commit_structurally() {
        let repository = test_repository();
        let root = repository.path();
        git::git_output(root, &["checkout", "-b", "feature"]).expect("feature");
        commit_file_at(root, "f1.txt", "one\n", "功能一", 1_700_000_100);
        let dup = commit_file_at(root, "f2.txt", "two\n", "功能二", 1_700_000_200);
        git::git_output(root, &["checkout", "-b", "target", "main"]).expect("target");
        // 先手工拣选 dup，再批量 [f1, dup]：dup 必须以 skippedEmpty 结构化跳过。
        git::cherry_pick_repository_commit_with_mainline(&repository.path_string(), &dup, None).expect("pre-pick");
        let f1 = git::git_output(root, &["rev-parse", "feature~1"]).expect("f1").trim().to_string();
        let report = cherry_pick_history_commits(&repository.path_string(), vec![dup.clone(), f1.clone()], None).expect("batch with duplicate");
        assert_eq!(report.applied, 1);
        assert_eq!(report.skipped_empty, 1);
        assert!(report.stopped_at.is_none(), "空提交跳过不能算中断");
        assert_eq!(subjects(root, 3).first().map(String::as_str), Some("功能一"));
        let statuses: Vec<(&str, &str)> = report
            .outcomes
            .iter()
            .map(|outcome| (outcome.hash.as_str(), outcome.status.as_str()))
            .collect();
        assert!(statuses.contains(&(dup.as_str(), "skippedEmpty")));
        assert!(statuses.contains(&(f1.as_str(), "applied")));
        // 跳过必须留下干净状态（无 CHERRY_PICK_HEAD 残留）。
        assert_eq!(in_progress_operation(root), None);
    }

    #[test]
    fn batch_cherry_pick_stops_on_conflict_and_reports_recovery_paths() {
        let repository = test_repository();
        let root = repository.path();
        git::git_output(root, &["checkout", "-b", "feature"]).expect("feature");
        commit_file_at(root, "shared.txt", "base\nfeature 版本\n", "功能一", 1_700_000_100);
        let conflict_commit = commit_file_at(root, "other.txt", "o\n", "功能二", 1_700_000_200);
        let f1 = git::git_output(root, &["rev-parse", "HEAD~1"]).expect("f1").trim().to_string();
        git::git_output(root, &["checkout", "-b", "target", "main"]).expect("target");
        // 让功能一在 target 上必然冲突：target 先把 shared.txt 改成不同内容。
        commit_file(root, "shared.txt", "base\ntarget 版本\n", "target 抢先");
        let report = cherry_pick_history_commits(&repository.path_string(), vec![f1.clone(), conflict_commit.clone()], None).expect("batch stops");
        assert_eq!(report.applied, 0);
        assert_eq!(report.stopped_at.as_deref(), Some(f1.as_str()));
        assert_eq!(report.outcomes.last().expect("outcome").status, "conflict");
        assert!(report.recovery.expect("recovery hint").contains("中止"));
        assert_eq!(in_progress_operation(root), Some("拣选"), "失败必须停在可被面板处置的明确状态");
        git::git_output(root, &["cherry-pick", "--abort"]).expect("abort restores");
        assert_eq!(in_progress_operation(root), None);
    }

    #[test]
    fn batch_cherry_pick_rejects_empty_selection_and_dirty_worktree() {
        let repository = test_repository();
        let root = repository.path();
        commit_file(root, "a.txt", "a\n", "改动 A");
        assert!(cherry_pick_history_commits(&repository.path_string(), vec![], None).is_err());
        fs::write(root.join("a.txt"), "dirty\n").expect("dirty");
        let error = cherry_pick_history_commits(&repository.path_string(), vec![head(root)], None).expect_err("dirty must fail");
        assert!(error.contains("工作区"));
    }

    // -----------------------------------------------------------------------
    // 加载与纯函数
    // -----------------------------------------------------------------------

    #[test]
    fn load_sequence_lists_oldest_first_with_metadata() {
        let repository = test_repository();
        let root = repository.path();
        commit_file(root, "a.txt", "a\n", "改动 A\n\n正文一");
        let last = commit_file(root, "b.txt", "b\n", "改动 B");
        let base = base_of(root);
        let sequence = load_history_edit_sequence(&repository.path_string(), &base).expect("load");
        assert_eq!(sequence.branch, "main");
        assert_eq!(sequence.entries.len(), 2);
        assert_eq!(sequence.entries[0].title, "改动 A", "先旧后新");
        assert_eq!(sequence.entries[0].message, "改动 A\n\n正文一");
        assert_eq!(sequence.entries[1].hash, last);
        assert!(!sequence.entries[0].is_merge);
        assert!(sequence.warnings.is_empty());
        assert_eq!(sequence.head, head(root));
    }

    #[test]
    fn validate_plan_is_pure_and_script_path_guard_rejects_unsafe_dirs() {
        let repository = test_repository();
        let root = repository.path();
        commit_file(root, "a.txt", "a\n", "改动 A");
        let base = base_of(root);
        let entries = entries_of(&repository, &base);
        // 纯校验不产生任何仓库状态变化、不起子进程。
        let validated = validate_plan(&entries, &plan(&entries)).expect("pure validate");
        assert_eq!(validated.steps.len(), 1);
        assert_eq!(validated.result_count, 1);
        // 非法动作值拒绝（不起进程即失败）。
        let mut bad = plan(&entries);
        bad[0].action = "reset".to_string();
        assert!(validate_plan(&entries, &bad).is_err());
        // 路径守卫：含 shell 特殊字符的目录必须被拒绝。
        assert!(script_safe_path(Path::new("/tmp/ok-dir_1.2")).is_ok());
        assert!(script_safe_path(Path::new("/tmp/bad'quote")).is_err());
        assert!(script_safe_path(Path::new("/tmp/bad$dollar")).is_err());
        assert!(script_safe_path(Path::new("/tmp/中文")).is_err());
        // todo 文本：全 drop 时为空串（git 语义 = 重置到基点）。
        let temp = TempWorkspace::new().expect("temp workspace");
        let mut all_drop = plan(&entries);
        all_drop[0].action = ACTION_DROP.to_string();
        let dropped_plan = validate_plan(&entries, &all_drop).expect("all drop validates");
        assert_eq!(dropped_plan.result_count, 0);
        assert_eq!(materialize_todo(&dropped_plan, &temp).expect("empty todo"), "");
        let todo = materialize_todo(&validated, &temp).expect("todo");
        assert_eq!(todo, format!("pick {}\n", entries[0].hash));
        temp.cleanup();
    }
}
