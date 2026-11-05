//! 恢复与问题定位能力：Reflog 浏览/恢复、Bisect 引导式排查、Reset 多模式。
//!
//! 该模块独立于 git.rs 的提交流程，仅通过 `crate::git` 的公开接口调用 Git；
//! 所有引用/分支都经过 `check-ref-format` 或 `rev-parse --verify` 校验，
//! Git 一律以参数数组方式启动，绝不拼接 shell 命令。

use crate::git;
use crate::models::{BisectCommit, BisectStatus, BisectStep, DiffLine, ReflogEntry, RepositoryFile};
use std::path::{Path, PathBuf};

const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const ZERO_HASH: &str = "0000000000000000000000000000000000000000";
const DEFAULT_REFLOG_LIMIT: usize = 300;
const MAX_REFLOG_LIMIT: usize = 20000;

/// 与 git.rs 内部 resolve_commit 相同的校验路径：rev-parse --verify + ^{commit}。
/// 板级契约保持一致：非法引用一律拒绝，绝不把原始字符串交给 shell。
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

/// 校验“历史对象引用”：完整/短 Hash、`HEAD@{n}`、`<branch>@{n}`、`stash@{n}`。
/// 这类引用无法用 rev-parse --verify 单独约束语义，因此先做字符白名单，
/// 再解析为提交对象，避免选项注入（如以 '-' 开头的字符串）。
fn validated_revision_reference(reference: &str) -> Result<String, String> {
    let trimmed = reference.trim();
    if trimmed.is_empty() || trimmed.len() > 256 || trimmed.starts_with('-') {
        return Err("无效的引用".to_string());
    }
    if !trimmed
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'@' | b'{' | b'}' | b'/' | b'-' | b'_' | b'.' | b':'))
    {
        return Err("引用包含不支持的字符".to_string());
    }
    Ok(trimmed.to_string())
}

fn commit_subject(root: &Path, hash: &str) -> (String, String, String, String) {
    let output = git::git_output_owned(
        root,
        &[
            "show".into(),
            "-s".into(),
            "--format=%h%x1f%s%x1f%an%x1f%cI".into(),
            hash.into(),
        ],
    )
    .unwrap_or_default();
    let fields: Vec<&str> = output.trim().split('\x1f').collect();
    if fields.len() == 4 {
        (fields[0].to_string(), fields[1].to_string(), fields[2].to_string(), fields[3].to_string())
    } else {
        (hash[..hash.len().min(8)].to_string(), String::new(), String::new(), String::new())
    }
}

fn bisect_commit(root: &Path, hash: &str) -> BisectCommit {
    let (short_hash, title, author, commit_time) = commit_subject(root, hash);
    BisectCommit {
        hash: hash.to_string(),
        short_hash,
        title,
        author,
        commit_time,
    }
}

// ---------------------------------------------------------------------------
// 进行中操作与 Bisect 状态检测
// ---------------------------------------------------------------------------

fn git_dir(root: &Path) -> PathBuf {
    let output = git::git_output(root, &["rev-parse", "--absolute-git-dir"])
        .unwrap_or_default();
    let value = output.trim();
    if value.is_empty() {
        root.join(".git")
    } else {
        PathBuf::from(value)
    }
}

/// 与 git.rs 的 repository_operation 等价的只读检测（rebase / merge / cherry-pick / 冲突）。
/// 不修改 stash 语义，也不依赖 git.rs 的私有实现，供 Bisect/恢复动作互斥使用。
fn has_conflicting_operation(root: &Path) -> Option<&'static str> {
    let dir = git_dir(root);
    if dir.join("rebase-merge").is_dir() || dir.join("rebase-apply").is_dir() {
        return Some("变基");
    }
    if dir.join("MERGE_HEAD").is_file() {
        return Some("合并");
    }
    if dir.join("CHERRY_PICK_HEAD").is_file() {
        return Some("Cherry-pick");
    }
    let conflicts = git::git_output_owned(
        root,
        &["diff".into(), "--name-only".into(), "--diff-filter=U".into()],
    )
    .unwrap_or_default();
    if !conflicts.trim().is_empty() {
        return Some("冲突处理");
    }
    None
}

fn bisect_in_progress(root: &Path) -> bool {
    let dir = git_dir(root);
    if dir.join("BISECT_START").is_file() {
        return true;
    }
    git::git_output_owned(root, &["rev-parse".into(), "--verify".into(), "refs/bisect/bad".into()])
        .map(|value| value.trim().len() == 40)
        .unwrap_or(false)
}

fn ensure_no_conflicting_operation(root: &Path, action: &str) -> Result<(), String> {
    if let Some(kind) = has_conflicting_operation(root) {
        return Err(format!("当前存在未完成的 Git 操作（{kind}），请先完成或中止后再{action}"));
    }
    if bisect_in_progress(root) {
        return Err(format!("Bisect 排查正在进行，请先退出 Bisect 再{action}"));
    }
    Ok(())
}

fn worktree_is_clean(root: &Path) -> bool {
    git::git_output_owned(
        root,
        &["status".into(), "--porcelain".into(), "--ignore-submodules=dirty".into()],
    )
    .map(|value| value.trim().is_empty())
    .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Reflog
// ---------------------------------------------------------------------------

pub fn load_reflog_entries(
    repository_path: &str,
    branch: Option<&str>,
    limit: Option<usize>,
) -> Result<Vec<ReflogEntry>, String> {
    let root = git::repository_root(repository_path)?;
    let selector_ref: String = match branch {
        None => "HEAD".into(),
        Some(name) => {
            git::git_output(
                &root,
                &["check-ref-format", "--branch", name.trim()],
            )?;
            name.trim().to_string()
        }
    };
    let limit = limit.unwrap_or(DEFAULT_REFLOG_LIMIT).clamp(1, MAX_REFLOG_LIMIT);
    // %gd 选择器（带时间）、%gs 动作说明、%H/%h 新值、%s 提交标题、%an 作者、%cI 时间，
    // 记录间以 %x1e 定界。注意：git reflog 的 pretty 扩展不支持 %gS，动作类别由说明推导。
    let format = "%gd%x1f%gs%x1f%H%x1f%h%x1f%s%x1f%an%x1f%cI%x1e";
    let args = vec![
        "reflog".into(),
        "show".into(),
        "--date=iso-strict".into(),
        format!("--format={format}"),
        "-n".into(),
        limit.to_string(),
        "--end-of-options".into(),
        selector_ref.clone(),
    ];
    let output = git::git_output_owned(&root, &args)?;
    let head_hash = resolve_commit(&root, "HEAD").unwrap_or_default();
    let records: Vec<Vec<String>> = output
        .split('\x1e')
        .map(|record| record.trim())
        .filter(|record| !record.is_empty())
        .map(|record| record.split('\x1f').map(str::to_string).collect())
        .filter(|fields: &Vec<String>| fields.len() >= 7 && !fields[2].is_empty())
        .collect();
    let mut entries = Vec::with_capacity(records.len());
    for (index, fields) in records.iter().enumerate() {
        let new_hash = fields[2].clone();
        // Reflog 是追加链：第 k 条的旧值等于第 k+1 条的新值；最早一条的旧值不可知。
        let old_hash = records
            .get(index + 1)
            .map(|next| next[2].clone())
            .unwrap_or_else(|| ZERO_HASH.to_string());
        let dated_selector = fields[0].clone();
        let entry_time = dated_selector
            .split_once('@')
            .and_then(|(_, rest)| rest.strip_prefix('{'))
            .and_then(|value| value.strip_suffix('}'))
            .unwrap_or("")
            .to_string();
        let ref_prefix = selector_ref.split_once('@').map_or_else(
            || selector_ref.clone(),
            |(prefix, _)| prefix.to_string(),
        );
        entries.push(ReflogEntry {
            selector: format!("{ref_prefix}@{{{index}}}"),
            dated_selector,
            entry_time,
            action: derive_reflog_action(&fields[1]),
            subject: fields[1].clone(),
            commit_hash: new_hash.clone(),
            short_hash: fields[3].clone(),
            old_hash,
            commit_title: fields[4].clone(),
            author: fields[5].clone(),
            commit_time: fields[6].clone(),
            is_head: index == 0 && new_hash == head_hash,
        });
    }
    Ok(entries)
}

/// 从 %gs 说明推导动作类别（"commit (amend): xxx" -> "commit"，"reset: moving to" -> "reset"）。
fn derive_reflog_action(subject: &str) -> String {
    let head = subject.split(':').next().unwrap_or("").trim();
    match head.split_whitespace().next() {
        Some(word) if !word.is_empty() => word.to_lowercase(),
        _ => "other".to_string(),
    }
}

/// 直接按引用（提交号 / reflog / stash 索引）列出该对象相对首个父提交的变更文件，
/// 不经过提交图谱，因此不受图谱读取上限影响，历史对象始终可查。
pub fn load_revision_files(repository_path: &str, reference: &str) -> Result<Vec<RepositoryFile>, String> {
    let root = git::repository_root(repository_path)?;
    let reference = validated_revision_reference(reference)?;
    let hash = resolve_commit(&root, &reference)?;
    let parent = git::git_output_owned(&root, &["rev-parse".into(), format!("{hash}^")])
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| value.len() == 40);
    let range_args: Vec<String> = match &parent {
        Some(parent) => vec![
            "-c".into(),
            "core.quotepath=false".into(),
            "diff".into(),
            "--name-status".into(),
            "-M".into(),
            "--root".into(),
            parent.clone(),
            hash.clone(),
        ],
        None => vec![
            "-c".into(),
            "core.quotepath=false".into(),
            "diff".into(),
            "--name-status".into(),
            EMPTY_TREE.into(),
            hash.clone(),
        ],
    };
    let status_output = git::git_output_owned(&root, &range_args)?;
    let numstat_args: Vec<String> = match &parent {
        Some(parent) => vec![
            "diff".into(),
            "--numstat".into(),
            parent.clone(),
            hash.clone(),
        ],
        None => vec!["diff".into(), "--numstat".into(), EMPTY_TREE.into(), hash.clone()],
    };
    let numstat_output = git::git_output_owned(&root, &numstat_args)?;
    Ok(build_file_list(&numstat_output, &status_output))
}

fn build_file_list(numstat: &str, status: &str) -> Vec<RepositoryFile> {
    let mut stats: Vec<(usize, usize)> = Vec::new();
    for line in numstat.lines() {
        let columns: Vec<&str> = line.splitn(3, '\t').collect();
        if columns.len() == 3 {
            stats.push((
                columns[0].parse::<usize>().unwrap_or(0),
                columns[1].parse::<usize>().unwrap_or(0),
            ));
        }
    }
    let mut files = Vec::new();
    let mut stat_index = 0usize;
    for line in status.lines() {
        let columns: Vec<&str> = line.split('\t').collect();
        if columns.len() < 2 {
            continue;
        }
        let code = columns[0].trim();
        let path = if columns.len() >= 3 {
            // rename/copy：以新路径为准
            columns[columns.len() - 1].to_string()
        } else {
            columns[1].to_string()
        };
        let (add, del) = stats.get(stat_index).copied().unwrap_or((0, 0));
        stat_index += 1;
        files.push(RepositoryFile {
            path,
            r#type: if code.starts_with('R') {
                "rename".into()
            } else if code.starts_with('A') {
                "add".into()
            } else if code.starts_with('D') {
                "delete".into()
            } else {
                "modify".into()
            },
            add,
            del,
            staged: false,
            unstaged: false,
            incoming: false,
        });
    }
    files
}

/// 按引用直接加载某文件的 diff（父提交 -> 该提交），不依赖图谱。
pub fn load_revision_file_diff(
    repository_path: &str,
    reference: &str,
    file_path: &str,
    show_whitespace: bool,
) -> Result<Vec<DiffLine>, String> {
    let root = git::repository_root(repository_path)?;
    let reference = validated_revision_reference(reference)?;
    let hash = resolve_commit(&root, &reference)?;
    if file_path.trim().is_empty() || file_path.contains("..") {
        return Err("无效的文件路径".to_string());
    }
    let base = git::git_output_owned(&root, &["rev-parse".into(), format!("{hash}^")])
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| value.len() == 40);
    if let Some(base) = base {
        // 复用公开的图谱无关对比接口（两个提交都可通过 rev-parse 校验）。
        return git::parse_compare_diff(repository_path, &base, &hash, file_path, show_whitespace);
    }
    // 根提交：与空树比较。空树对象不是提交，无法走 resolve_commit，
    // 这里读取文件内容并按“全部新增”构造行，保证旧 stash/根提交仍可查看。
    let text = git::git_output_owned(
        &root,
        &["show".into(), format!("{hash}:{file_path}")],
    )?;
    if text.contains('\u{0}') {
        return Err("该文件是二进制文件，无法显示文本差异".to_string());
    }
    Ok(text
        .lines()
        .enumerate()
        .map(|(index, line)| DiffLine {
            old: None,
            next: Some(index + 1),
            kind: "add".into(),
            code: line.to_string(),
            old_code: None,
            new_code: Some(line.to_string()),
            old_no_newline: false,
            new_no_newline: false,
        })
        .collect())
}

/// 从 Reflog 条目检出该提交（进入 detached HEAD），工作区必须干净。
pub fn checkout_reflog_entry(repository_path: &str, reference: &str) -> Result<(), String> {
    let root = git::repository_root(repository_path)?;
    let reference = validated_revision_reference(reference)?;
    let hash = resolve_commit(&root, &reference)?;
    ensure_no_conflicting_operation(&root, "按 Reflog 恢复")?;
    if !worktree_is_clean(&root) {
        return Err("工作区存在未提交修改，为避免覆盖请先 Stash 或提交后再恢复".into());
    }
    git::git_output_owned(&root, &["checkout".into(), "--detach".into(), hash]).map(|_| ())
}

/// 从 Reflog 条目创建新分支（不动当前分支）。
pub fn create_branch_from_reflog_entry(repository_path: &str, reference: &str, branch: &str) -> Result<(), String> {
    let root = git::repository_root(repository_path)?;
    let reference = validated_revision_reference(reference)?;
    let hash = resolve_commit(&root, &reference)?;
    let branch = branch.trim();
    if branch.is_empty() || branch.starts_with('-') {
        return Err("分支名称不能为空".into());
    }
    git::git_output(&root, &["check-ref-format", "--branch", branch])
        .map_err(|_| format!("无效的分支名称：{branch}"))?;
    git::git_output_owned(&root, &["branch".into(), branch.into(), hash]).map(|_| ())
}

// ---------------------------------------------------------------------------
// Reset 模式（soft / mixed / hard）
// ---------------------------------------------------------------------------

pub fn reset_repository_with_mode(
    repository_path: &str,
    commit: &str,
    mode: &str,
    confirm_hard: bool,
) -> Result<(), String> {
    let root = git::repository_root(repository_path)?;
    let commit = resolve_commit(&root, commit.trim())?;
    let flag = match mode.trim() {
        "soft" => "--soft",
        "mixed" => "--mixed",
        "hard" => "--hard",
        other => return Err(format!("不支持的 Reset 模式：{other}")),
    };
    ensure_no_conflicting_operation(&root, "回退（Reset）")?;
    if flag == "--hard" {
        if !confirm_hard {
            return Err("hard Reset 需要显式危险确认".into());
        }
        // 硬回退前记录当前 HEAD，错误信息里给出 reflog 找回提示。
        let previous = resolve_commit(&root, "HEAD").unwrap_or_default();
        let result = git::git_output_owned(&root, &["reset".into(), flag.into(), commit.clone()]);
        if let Err(error) = result {
            return Err(format!(
                "{error}\n当前分支未变化；如需找回历史提交，可在恢复面板按 Reflog 定位（如 {previous}）。"
            ));
        }
        return Ok(());
    }
    git::git_output_owned(&root, &["reset".into(), flag.into(), commit]).map(|_| ())
}

// ---------------------------------------------------------------------------
// Bisect
// ---------------------------------------------------------------------------

fn validated_bisect_term(term: &str) -> Result<String, String> {
    let term = term.trim();
    if term.is_empty()
        || term.len() > 32
        || !term.bytes().all(|byte| byte.is_ascii_alphanumeric())
        || term.starts_with('-')
    {
        return Err(format!("无效的 Bisect 术语：{term}"));
    }
    Ok(term.to_string())
}

fn read_bisect_terms(root: &Path) -> (String, String) {
    // 实测 .git/BISECT_TERMS 第一行为“新术语”（bad 侧），第二行为“旧术语”（good 侧）。
    // 返回顺序统一为 (bad_term, good_term)。
    let content = std::fs::read_to_string(git_dir(root).join("BISECT_TERMS")).unwrap_or_default();
    let mut lines = content.lines().map(str::trim);
    let bad = lines.next().filter(|value| !value.is_empty()).unwrap_or("bad");
    let good = lines.next().filter(|value| !value.is_empty()).unwrap_or("good");
    (bad.to_string(), good.to_string())
}

pub fn start_repository_bisect(
    repository_path: &str,
    bad: &str,
    good: &str,
    new_term: Option<&str>,
    old_term: Option<&str>,
) -> Result<BisectStatus, String> {
    let root = git::repository_root(repository_path)?;
    ensure_no_conflicting_operation(&root, "开始 Bisect")?;
    if bisect_in_progress(&root) {
        return Err("Bisect 已在进行中，请先退出当前 Bisect".into());
    }
    if !worktree_is_clean(&root) {
        return Err("工作区存在未提交修改，Bisect 需要检出历史提交，请先 Stash 或提交".into());
    }
    let bad_hash = resolve_commit(&root, bad.trim())?;
    let good_hash = resolve_commit(&root, good.trim())?;
    if git::git_output_owned(
        &root,
        &["merge-base".into(), "--is-ancestor".into(), good_hash.clone(), bad_hash.clone()],
    )
    .is_err()
    {
        return Err("好提交必须包含在坏提交的历史中（good 是 bad 的祖先）".into());
    }
    let mut args: Vec<String> = vec!["bisect".into(), "start".into()];
    if let Some(term) = new_term {
        args.push(format!("--term-new={}", validated_bisect_term(term)?));
    }
    if let Some(term) = old_term {
        args.push(format!("--term-old={}", validated_bisect_term(term)?));
    }
    args.extend([bad_hash.clone(), good_hash.clone()]);
    if git::git_output_owned(&root, &args).is_err() {
        // 任何异常都不得把仓库留在半完成状态：兜底清理后重试一次 reset。
        if bisect_in_progress(&root) {
            let _ = git::git_output_owned(&root, &["bisect".into(), "reset".into()]);
        }
        return Err("启动 Bisect 失败，已自动回滚状态，请检查提交范围后重试".into());
    }
    load_bisect_status(repository_path)
}

pub fn mark_repository_bisect(repository_path: &str, verdict: &str) -> Result<BisectStatus, String> {
    let root = git::repository_root(repository_path)?;
    if !bisect_in_progress(&root) {
        return Err("当前没有进行中的 Bisect".into());
    }
    let (bad_term, good_term) = read_bisect_terms(&root);
    let verdict = verdict.trim().to_lowercase();
    let mut args: Vec<String> = vec!["bisect".into()];
    match verdict.as_str() {
        "good" | "old" | "pass" | "work" => args.push(good_term.clone()),
        "bad" | "new" | "fail" | "broken" => args.push(bad_term.clone()),
        "skip" => args.push("skip".into()),
        other => return Err(format!("无法识别的 Bisect 结论：{other}")),
    }
    if git::git_output_owned(&root, &args).is_err() {
        // 标记失败通常源于工作区冲突；保留 Bisect 状态，但绝不留下脏改动。
        return Err("记录 Bisect 结论失败，仓库仍处于 Bisect 中，可退出后重试".into());
    }
    load_bisect_status(repository_path)
}

pub fn advance_repository_bisect(repository_path: &str) -> Result<BisectStatus, String> {
    let root = git::repository_root(repository_path)?;
    if !bisect_in_progress(&root) {
        return Err("当前没有进行中的 Bisect".into());
    }
    git::git_output_owned(&root, &["bisect".into(), "next".into()])?;
    load_bisect_status(repository_path)
}

/// 退出 Bisect。优先走 `bisect reset`；若因残留状态文件失败，
/// 手动回到起始分支并移除 refs/bisect/*，保证不会留在半完成状态。
pub fn reset_repository_bisect(repository_path: &str) -> Result<(), String> {
    let root = git::repository_root(repository_path)?;
    if !bisect_in_progress(&root) {
        return Ok(());
    }
    let original = std::fs::read_to_string(git_dir(&root).join("BISECT_START"))
        .unwrap_or_default()
        .trim()
        .to_string();
    if git::git_output_owned(&root, &["bisect".into(), "reset".into()]).is_ok() {
        return Ok(());
    }
    // 兜底：回到 Bisect 起始 ref，再清理 bisect 引用与状态文件。
    let target = if original.is_empty() || original == "HEAD" || original.starts_with('-') {
        "HEAD".to_string()
    } else {
        original.clone()
    };
    if let Err(error) = git::git_output_owned(&root, &["checkout".into(), "--force".into(), target.clone()]) {
        return Err(format!("退出 Bisect 失败且无法回到 {target}：{error}"));
    }
    let _ = git::git_output_owned(&root, &["update-ref".into(), "-d".into(), "refs/bisect/bad".into()]);
    let good_refs = git::git_output_owned(
        &root,
        &["for-each-ref".into(), "--format=%(refname)".into(), "refs/bisect".into()],
    )
    .unwrap_or_default();
    for line in good_refs.lines() {
        let name = line.trim();
        if name.starts_with("refs/bisect/good-") {
            let _ = git::git_output_owned(&root, &["update-ref".into(), "-d".into(), name.into()]);
        }
    }
    // 手动清理残留状态文件，否则检测逻辑会误判 Bisect 仍在进行。
    if let Ok(read_dir) = std::fs::read_dir(git_dir(&root)) {
        for entry in read_dir.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("BISECT_") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

pub fn load_bisect_status(repository_path: &str) -> Result<BisectStatus, String> {
    let root = git::repository_root(repository_path)?;
    let active = bisect_in_progress(&root);
    let (bad_term, good_term) = read_bisect_terms(&root);
    if !active {
        return Ok(BisectStatus {
            active: false,
            message: "当前没有进行中的 Bisect".into(),
            original_branch: None,
            current_commit: None,
            bad_commit: None,
            good_commits: Vec::new(),
            tested: Vec::new(),
            remaining_count: 0,
            steps_estimate: 0,
            done: false,
            bad_term: bad_term.clone(),
            good_term: good_term.clone(),
        });
    }
    let original_branch = std::fs::read_to_string(git_dir(&root).join("BISECT_START"))
        .unwrap_or_default()
        .trim()
        .strip_prefix("refs/heads/")
        .map(str::to_string);
    let bad_hash = git::git_output_owned(
        &root,
        &["rev-parse".into(), "--verify".into(), "refs/bisect/bad".into()],
    )
    .ok()
    .map(|value| value.trim().to_string())
    .filter(|value| value.len() == 40);
    // 注意：refs/bisect/good 是 refs/bisect/good-<sha> 的前缀而非目录，
    // for-each-ref 只匹配完整路径段，因此取 refs/bisect 全量再按名字过滤。
    let good_hashes: Vec<String> = git::git_output_owned(
        &root,
        &[
            "for-each-ref".into(),
            "--format=%(refname)%09%(objectname)".into(),
            "refs/bisect".into(),
        ],
    )
    .unwrap_or_default()
    .lines()
    .filter_map(|line| {
        let (name, hash) = line.split_once('\t')?;
        name.starts_with("refs/bisect/good-")
            .then(|| hash.trim().to_string())
            .filter(|hash| hash.len() == 40)
    })
    .collect();
    let current_hash = resolve_commit(&root, "HEAD").ok();
    let mut exclude_args: Vec<String> = good_hashes.iter().map(|hash| format!("^{hash}")).collect();
    exclude_args.sort();
    exclude_args.dedup();
    let (remaining_count, steps_estimate) = match &bad_hash {
        Some(bad) => {
            let mut args: Vec<String> = vec!["rev-list".into(), "--count".into(), bad.clone()];
            args.append(&mut exclude_args.clone());
            let count = git::git_output_owned(&root, &args)
                .unwrap_or_default()
                .trim()
                .parse::<usize>()
                .unwrap_or(0);
            let steps = if count <= 1 { 0 } else { (count as f64).log2().ceil() as usize };
            (count, steps)
        }
        None => (0, 0),
    };
    let tested = parse_bisect_log(&root);
    Ok(BisectStatus {
        active: true,
        message: match &bad_hash {
            Some(bad) if remaining_count <= 1 => format!("已定位首个{bad_term}提交：{bad}"),
            Some(bad) => {
                let next = next_candidate(&root);
                match next {
                    Some(hash) if hash != *bad => format!("还剩 {remaining_count} 个提交待排查，下一步检查 {hash}"),
                    _ => format!("还剩 {remaining_count} 个提交待排查"),
                }
            }
            None => "Bisect 已开始，等待标记好/坏边界".into(),
        },
        original_branch,
        current_commit: current_hash.as_deref().map(|hash| bisect_commit(&root, hash)),
        bad_commit: bad_hash.as_deref().map(|hash| bisect_commit(&root, hash)),
        good_commits: good_hashes.iter().map(|hash| bisect_commit(&root, hash)).collect(),
        tested,
        remaining_count,
        steps_estimate,
        done: bad_hash.is_some() && remaining_count <= 1,
        bad_term,
        good_term,
    })
}

fn next_candidate(root: &Path) -> Option<String> {
    git::git_output_owned(root, &["rev-list".into(), "--bisect".into()])
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| value.len() == 40)
}

fn parse_bisect_log(root: &Path) -> Vec<BisectStep> {
    let output = git::git_output_owned(root, &["bisect".into(), "log".into()]).unwrap_or_default();
    let mut steps = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        if !line.starts_with("git bisect ") {
            continue;
        }
        let mut parts = line.split_whitespace();
        parts.next();
        parts.next(); // "bisect"
        let Some(verb) = parts.next() else { continue };
        let hash = parts.next().filter(|value| value.len() == 40);
        if hash.is_none() && verb != "start" {
            // 自定义术语行形如 "git bisect term <t> <hash>"
            if verb == "term" {
                let _term = parts.next();
            }
        }
        if let Some(hash) = hash {
            let (short_hash, title, author, commit_time) = commit_subject(root, hash);
            steps.push(BisectStep {
                verdict: verb.to_string(),
                hash: hash.to_string(),
                short_hash,
                title,
                author,
                commit_time,
            });
        }
    }
    steps
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static UNIQUE_SEQ: AtomicU64 = AtomicU64::new(0);

    struct TestRepository(PathBuf);

    impl Drop for TestRepository {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn test_repository() -> TestRepository {
        // 并行运行时临时目录可能撞名：叠加进程号 + 纳秒 + 进程内序号。
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let seq = UNIQUE_SEQ.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "branchline-recovery-test-{}-{unique}-{seq}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create recovery test repository");
        git::git_output(&path, &["init", "--initial-branch=main"]).expect("git init");
        git::git_output(&path, &["config", "user.name", "Branchline Recovery"]).expect("user name");
        git::git_output(&path, &["config", "user.email", "recovery@example.com"]).expect("user email");
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
        git::git_output(root, &["rev-parse", "HEAD"])
            .expect("head hash")
            .trim()
            .to_string()
    }

    fn head_hash(root: &Path) -> String {
        git::git_output(root, &["rev-parse", "HEAD"])
            .expect("head")
            .trim()
            .to_string()
    }

    #[test]
    fn reflog_lists_entries_after_rewrites_and_restores_old_commit() {
        let repository = test_repository();
        let root = repository.0.as_path();
        let path = root.to_string_lossy().to_string();
        let first = head_hash(root);
        // 制造 rewrite 历史：提交 -> amend -> reset --hard 回退
        let original = commit_file(root, "extra.txt", "extra\n", "补充功能");
        fs::write(root.join("extra.txt"), "extra amended\n").expect("rewrite");
        git::git_output(root, &["add", "-A"]).expect("add");
        git::git_output(root, &["commit", "--amend", "-m", "补充功能（修订）"]).expect("amend");
        let amended = head_hash(root);
        git::git_output(root, &["reset", "--hard", &first]).expect("reset back");

        let entries = load_reflog_entries(&path, None, None).expect("reflog");
        assert!(!entries.is_empty());
        assert_eq!(entries[0].selector, "HEAD@{0}");
        assert_eq!(entries[0].action, "reset");
        assert!(entries[0].is_head);
        // 旧值链：第 k 条的旧值等于第 k+1 条的新值
        assert_eq!(entries[0].old_hash, entries[1].commit_hash);
        assert_eq!(entries[0].commit_hash, first);
        assert_eq!(entries[1].commit_hash, amended);
        assert_eq!(entries[1].old_hash, original, "amend 条目的旧值应是被重写的原提交");
        assert!(entries[1].subject.contains("修订"));
        // 被 rewrite 掉的提交仍能在 reflog 中找到
        let located = entries
            .iter()
            .find(|entry| entry.commit_hash == original)
            .expect("原提交应出现在 reflog");
        assert_eq!(located.action, "commit");

        // 恢复动作 1：从条目创建分支（不影响当前分支）
        create_branch_from_reflog_entry(&path, "HEAD@{2}", "recovery/from-reflog").expect("create branch");
        assert_eq!(
            git::git_output(root, &["rev-parse", "recovery/from-reflog"])
                .expect("branch hash")
                .trim(),
            original,
        );

        // 恢复动作 2：按条目 reset 当前分支（hard 需确认）
        assert!(reset_repository_with_mode(&path, "HEAD@{2}", "hard", false).is_err());
        reset_repository_with_mode(&path, "HEAD@{2}", "hard", true).expect("reset via reflog selector");
        assert_eq!(head_hash(root), original);

        // 恢复动作 3：checkout 到 amend 后的提交（detached），工作区干净才允许
        git::git_output(root, &["checkout", "--detach", &first]).expect("detach first");
        checkout_reflog_entry(&path, &amended).expect("checkout entry");
        assert_eq!(head_hash(root), amended);
        let current_branch = git::git_output(root, &["branch", "--show-current"])
            .unwrap_or_default();
        assert!(current_branch.trim().is_empty(), "detached 状态不应停在分支上");
    }

    #[test]
    fn reflog_supports_branch_scoped_entries_without_touching_stash_semantics() {
        let repository = test_repository();
        let root = repository.0.as_path();
        let path = root.to_string_lossy().to_string();
        git::git_output(root, &["branch", "feature"]).expect("branch");
        commit_file(root, "main-only.txt", "x\n", "仅主线");
        git::git_output(root, &["checkout", "feature"]).expect("checkout feature");
        commit_file(root, "feature.txt", "y\n", "特性提交");
        git::git_output(root, &["checkout", "main"]).expect("checkout main");

        let feature_entries = load_reflog_entries(&path, Some("feature"), None).expect("branch reflog");
        assert!(feature_entries.iter().any(|entry| entry.commit_title == "特性提交"));
        assert!(feature_entries.iter().all(|entry| entry.selector.starts_with("feature@{")));

        // stash reflog 语义不变：refs/stash 不在 HEAD reflog 里混入
        commit_file(root, "tracked.txt", "clean\n", "基线文件");
        fs::write(root.join("tracked.txt"), "dirty\n").expect("write tracked change");
        git::git_output(root, &["add", "tracked.txt"]).expect("stage");
        git::git_output(root, &["stash", "push", "-m", "临时保存"]).expect("stash push");
        let head_entries = load_reflog_entries(&path, None, None).expect("head reflog");
        assert!(head_entries.iter().all(|entry| !entry.selector.contains("stash")));
        let stash_rows = git::git_output(root, &["reflog", "show", "--format=%H", "refs/stash"])
            .expect("stash reflog count keeps working");
        assert_eq!(stash_rows.lines().count(), 1);
        git::git_output(root, &["stash", "pop", "--quiet"]).expect("restore clean");
    }

    #[test]
    fn revision_files_and_diff_do_not_depend_on_commit_graph_limit() {
        let repository = test_repository();
        let root = repository.0.as_path();
        let path = root.to_string_lossy().to_string();
        let first = head_hash(root);
        let second = commit_file(root, "notes.md", "hello\nworld\n", "记录笔记");

        // 直接按提交号取内容：无图谱参与
        let files = load_revision_files(&path, &second).expect("files");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "notes.md");
        assert_eq!(files[0].add, 2);

        let diff = load_revision_file_diff(&path, &second, "notes.md", true).expect("diff");
        assert!(diff.iter().any(|line| line.kind == "add" && line.code == "hello"));

        // 初始（根）提交：父不存在，按“全部新增”呈现
        let root_files = load_revision_files(&path, &first).expect("root files");
        assert_eq!(root_files.len(), 1);
        let root_diff = load_revision_file_diff(&path, &first, "README.md", true).expect("root diff");
        assert!(root_diff.iter().all(|line| line.kind == "add"));

        // stash 索引同样可直接取内容（不要求图谱里有该节点）
        fs::write(root.join("README.md"), "base modified\n").expect("modify tracked");
        fs::write(root.join("wip.txt"), "wip\n").expect("write wip");
        git::git_output(root, &["stash", "push", "-u", "-m", "未完成"]).expect("stash");
        let stash_files = load_revision_files(&path, "stash@{0}").expect("stash files");
        assert!(stash_files.iter().any(|file| file.path == "README.md"));

        // 非法引用必须被拒绝（注入面为零）
        assert!(load_revision_files(&path, "--format=%H;rm").is_err());
        assert!(load_revision_files(&path, "no-such-ref").is_err());
    }

    #[test]
    fn reset_supports_soft_mixed_hard_with_danger_confirmation() {
        let repository = test_repository();
        let root = repository.0.as_path();
        let path = root.to_string_lossy().to_string();
        let first = head_hash(root);
        commit_file(root, "a.txt", "1\n", "提交 a");
        fs::write(root.join("a.txt"), "2\n").expect("write");
        git::git_output(root, &["add", "-A"]).expect("stage");
        commit_file(root, "b.txt", "b\n", "提交 b");
        let staged_before = git::git_output(root, &["diff", "--cached", "--name-only"])
            .expect("staged");
        assert!(staged_before.trim().is_empty());

        // hard 未确认必须拒绝
        assert!(reset_repository_with_mode(&path, &first, "hard", false).is_err());
        // 非法模式拒绝
        assert!(reset_repository_with_mode(&path, &first, "keep", true).is_err());

        // soft：HEAD 回退，索引与工作区保留已暂存内容
        fs::write(root.join("c.txt"), "c\n").expect("write c");
        git::git_output(root, &["add", "-A"]).expect("stage c");
        git::git_output(root, &["commit", "-m", "提交 c"]).expect("commit c");
        reset_repository_with_mode(&path, &first, "soft", false).expect("soft reset");
        assert_eq!(head_hash(root), first);
        let staged = git::git_output(root, &["diff", "--cached", "--name-only"]).expect("staged");
        assert!(staged.contains("c.txt"), "soft 后 c.txt 应仍处于暂存区");
        assert!(root.join("c.txt").exists());

        // mixed：索引被重置，工作区文件仍在
        fs::write(root.join("d.txt"), "d\n").expect("write d");
        git::git_output(root, &["add", "-A"]).expect("stage d");
        git::git_output(root, &["commit", "-m", "提交 d"]).expect("commit d");
        reset_repository_with_mode(&path, &first, "mixed", false).expect("mixed reset");
        assert_eq!(head_hash(root), first);
        let staged = git::git_output(root, &["diff", "--cached", "--name-only"]).expect("staged");
        assert!(!staged.contains("d.txt"), "mixed 后索引不应保留 d.txt");
        assert!(root.join("d.txt").exists());

        // hard（带确认）：HEAD、索引与工作区已跟踪内容全部回退；
        // 注意 reset --hard 不会删除因回退而变成未跟踪的文件，这是 Git 语义。
        reset_repository_with_mode(&path, &first, "hard", true).expect("hard reset");
        assert_eq!(head_hash(root), first);
        let tracked = git::git_output(root, &["ls-files"]).expect("index");
        assert!(!tracked.contains("d.txt"));
        assert!(!tracked.contains("c.txt"));
        let status = git::git_output(root, &["status", "--porcelain", "--untracked-files=no"])
            .expect("status");
        assert!(status.trim().is_empty(), "hard 后已跟踪内容必须干净");
    }

    #[test]
    fn bisect_converges_to_first_bad_commit_with_deterministic_predicate() {
        let repository = test_repository();
        let root = repository.0.as_path();
        let path = root.to_string_lossy().to_string();
        // 线性历史 C1..C6，首个坏提交是 C4（C4 起 state.txt 带 bug 标记，内容逐次变化）
        let mut hashes = vec![head_hash(root)];
        for index in 2..=6 {
            let content = if index >= 4 {
                format!("buggy-{index}\n")
            } else {
                format!("ok-{index}\n")
            };
            hashes.push(commit_file(root, "state.txt", &content, &format!("提交 {index}")));
        }
        let bad_set: std::collections::HashSet<String> = hashes[3..].iter().cloned().collect();

        start_repository_bisect(&path, &hashes[5], &hashes[0], None, None).expect("bisect start");
        let mut guard = 0usize;
        loop {
            guard += 1;
            assert!(guard < 12, "bisect 必须收敛");
            let status = load_bisect_status(&path).expect("bisect status");
            assert!(status.active);
            if status.remaining_count <= 1 {
                break;
            }
            // 标记当前检出候选后，Git 会自动检出下一个候选，无需额外 bisect next。
            let current = status.current_commit.expect("current commit");
            let verdict = if bad_set.contains(&current.hash) { "bad" } else { "good" };
            mark_repository_bisect(&path, verdict).expect("mark");
        }
        let final_status = load_bisect_status(&path).expect("final status");
        assert!(final_status.done);
        assert!(!final_status.tested.is_empty(), "已测试步骤应可在状态中回放");
        assert_eq!(
            final_status.bad_commit.expect("bad ref").hash,
            hashes[3],
            "应收敛到首个坏提交 C4"
        );

        // 退出后必须回到起始分支且不留半完成状态
        reset_repository_bisect(&path).expect("bisect exit");
        assert!(!bisect_in_progress(root));
        assert_eq!(
            git::git_output(root, &["branch", "--show-current"])
                .expect("branch")
                .trim(),
            "main"
        );
        assert_eq!(head_hash(root), hashes[5]);
    }

    #[test]
    fn bisect_start_maps_custom_terms_and_rejects_bad_ranges() {
        let repository = test_repository();
        let root = repository.0.as_path();
        let path = root.to_string_lossy().to_string();
        let first = head_hash(root);
        let mut last = first.clone();
        for index in 2..=6 {
            last = commit_file(root, "s.txt", &format!("v{index}\n"), &format!("提交 {index}"));
        }
        // 顺序颠倒：good 必须是 bad 的祖先
        assert!(start_repository_bisect(&path, &first, &last, None, None).is_err());
        // 非法术语被拒绝
        assert!(start_repository_bisect(&path, &last, &first, Some("--help"), None).is_err());
        // 自定义 --term-* 映射可用，状态回显术语
        let status = start_repository_bisect(&path, &last, &first, Some("broken"), Some("work"))
            .expect("custom term start");
        assert!(status.active);
        assert_eq!(status.bad_term, "broken");
        assert_eq!(status.good_term, "work");
        // bisect next 在未标记时保持候选不变
        let advanced = advance_repository_bisect(&path).expect("advance keeps candidate");
        assert_eq!(
            advanced.current_commit.expect("advanced current").hash,
            status.current_commit.expect("initial current").hash,
        );
        // 用同义词映射到自定义 good 术语
        let marked = mark_repository_bisect(&path, "pass").expect("mark with synonym");
        assert!(marked.active);
        assert!(!marked.tested.is_empty(), "bisect log 应记录已测试步骤");
        reset_repository_bisect(&path).expect("exit");
        assert!(!bisect_in_progress(root));
    }

    #[test]
    fn bisect_and_recovery_actions_respect_in_progress_operations() {
        let repository = test_repository();
        let root = repository.0.as_path();
        let path = root.to_string_lossy().to_string();
        let first = head_hash(root);
        // 制造合并冲突（进行中的操作）
        git::git_output(root, &["branch", "side"]).expect("branch side");
        commit_file(root, "conflict.txt", "main\n", "主线改动");
        git::git_output(root, &["checkout", "side"]).expect("checkout side");
        fs::write(root.join("conflict.txt"), "side\n").expect("write side");
        git::git_output(root, &["add", "-A"]).expect("add");
        git::git_output(root, &["commit", "-m", "分支改动"]).expect("commit");
        let merge_result = git::git_output_owned(
            root,
            &["merge".into(), "--no-edit".into(), "main".into()],
        );
        assert!(merge_result.is_err(), "预期合并冲突");

        // Bisect 启动必须被进行中的合并挡住
        assert!(start_repository_bisect(&path, "HEAD", &first, None, None).is_err());
        // 恢复类 Reset 同样被挡住
        assert!(reset_repository_with_mode(&path, &first, "hard", true).is_err());
        // checkout 恢复也被挡住
        assert!(checkout_reflog_entry(&path, &first).is_err());

        // 中止合并后一切恢复可用
        git::git_output(root, &["merge", "--abort"]).expect("abort merge");
        reset_repository_with_mode(&path, &first, "mixed", false).expect("reset now works");
    }
}
