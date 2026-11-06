//! Git LFS 仓库级管理（W3-4）：可用性探测、本地安装、跟踪模式与文件列表。
//!
//! 本模块刻意与 git.rs 分离：git.rs 体积已大，且并行轨道正在改动其 commit /
//! checkout / merge 区域。这里只复用 `crate::git` 暴露的公共入口
//! （`repository_root` / `git_output` / `git_output_owned`），Git 进程调用与命令
//! 日志仍走同一套基础设施。
//!
//! 安全约束（红线）：
//! - 所有 Git 调用都以参数数组发起，绝不拼接 shell 字符串，绝不使用 `sh -c`；
//! - 跟踪模式先过本地规则：拒绝以 `-` 开头的输入（选项注入）、拒绝换行 / NUL /
//!   其他控制字符（`.gitattributes` 换行注入），再交给 `git lfs track/untrack`
//!   作为独立参数处理；
//! - `git lfs fetch/pull/prune` 不做任何网络测试：测试只覆盖失败路径与参数形状，
//!   网络相关失败原样转成可操作错误返回；
//! - 机器上没有 git-lfs 时，除状态探测外的所有入口都返回同一条明确错误，
//!   避免把「未安装」误报成「仓库没有 LFS 文件」；
//! - `git lfs prune` 会删除本地缓存对象，前端必须先二次确认；Rust 层不额外落
//!   任何文件改动，只执行显式命令。

// 命令包装由 commands.rs 注册、lib.rs 挂载，那两处由主仓串行合并；
// 注册落地前这些入口在 crate 内没有调用点，故在此放行 dead_code。
#![allow(dead_code)]

use crate::git;
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;

/// 无 git-lfs 时的统一错误文案：前端可据此给出安装指引。
pub const LFS_MISSING_MESSAGE: &str =
    "未安装 git-lfs：请先安装 git-lfs 并确认 `git lfs version` 可用后重试";

/// 文件列表默认返回条数。
const DEFAULT_FILE_LIMIT: usize = 500;
/// 文件列表硬上限：无论前端传多大都不越过，避免返回体失控。
const MAX_FILE_LIMIT: usize = 2_000;
/// 跟踪模式最大长度。
const MAX_PATTERN_LEN: usize = 500;
/// 操作输出回传前端时的字符上限。
const OUTPUT_LIMIT: usize = 4_000;

// =============================================================================================
// 数据契约（与 packages/git-models 尾部同名类型对齐）
// =============================================================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsStatus {
    /// `git lfs version` 是否可用。
    pub available: bool,
    /// 解析出的版本号（如 3.8.1）；不可用时为 None。
    pub version: Option<String>,
    /// 当前仓库是否执行过 `git lfs install --local`。
    pub installed_locally: bool,
    /// `.gitattributes` 中 `filter=lfs` 行的模式（去重、保持出现顺序）。
    pub patterns: Vec<String>,
    /// `git lfs ls-files` 当前列出的文件数。
    pub tracked_file_count: usize,
    /// 面向用户的状态说明：未安装 / 未本地启用 / 尚无跟踪模式。
    pub notice: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsFile {
    /// 完整 OID（64 字符）。
    pub oid: String,
    /// 对象字节数；解析失败时为 0。
    pub size: u64,
    pub path: String,
    /// `*` 表示工作区已下载完整对象，`-` 表示仍是 LFS 指针。
    pub downloaded: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsFilesPage {
    pub files: Vec<LfsFile>,
    /// 条目超过生效上限时为 true；绝不静默截断。
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsOperationReport {
    /// fetch / pull / prune。
    pub action: String,
    pub summary: String,
    /// 命令 stdout（已限长）；stderr 走错误通道。
    pub output: String,
}

// =============================================================================================
// 调用 helper
// =============================================================================================

fn optional(root: &Path, args: &[&str]) -> String {
    git::git_output(root, args).unwrap_or_default()
}

fn succeeds(root: &Path, args: &[&str]) -> bool {
    git::git_output(root, args).is_ok()
}

/// 仅保留前 `limit` 个字符，避免把整段 prune 日志塞回前端。
fn limit_text(value: &str, limit: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= limit {
        return trimmed.to_string();
    }
    let mut limited: String = trimmed.chars().take(limit).collect();
    limited.push('…');
    limited
}

/// 把 `git lfs version` 的第一行解析成版本号。
fn parse_lfs_version(output: &str) -> String {
    let first = output.lines().next().unwrap_or_default().trim();
    first
        .split_whitespace()
        .next()
        .and_then(|token| token.strip_prefix("git-lfs/"))
        .filter(|version| !version.is_empty())
        .unwrap_or(first)
        .to_string()
}

/// 当前进程能否找到 git-lfs；返回解析出的版本。
fn installed_lfs_version(root: &Path) -> Option<String> {
    git::git_output(root, &["lfs", "version"])
        .ok()
        .map(|output| parse_lfs_version(&output))
        .filter(|version| !version.is_empty())
}

/// 除状态探测外的入口统一前置检查：没有 git-lfs 就给出明确错误。
fn require_lfs(root: &Path) -> Result<(), String> {
    installed_lfs_version(root)
        .map(|_| ())
        .ok_or_else(|| LFS_MISSING_MESSAGE.to_string())
}

/// 本地是否启用 LFS：`git lfs install --local` 会写入 filter.lfs.*。
fn installed_locally(root: &Path) -> bool {
    !optional(root, &["config", "--local", "--get", "filter.lfs.clean"])
        .trim()
        .is_empty()
}

// =============================================================================================
// `.gitattributes` 解析
// =============================================================================================

/// 取一行属性的模式字段。支持双引号包住含空格模式与反斜杠转义；
/// 注释行、空行、没有 `filter=lfs` 的行直接跳过。
fn attributes_pattern(line: &str) -> Option<String> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    if !line.split_whitespace().any(|field| field == "filter=lfs") {
        return None;
    }
    let mut pattern = String::new();
    let mut quoted = false;
    let mut escaped = false;
    for character in line.chars() {
        if escaped {
            pattern.push(character);
            escaped = false;
            continue;
        }
        match character {
            '\\' => escaped = true,
            '"' => quoted = !quoted,
            value if value.is_whitespace() && !quoted => break,
            value => pattern.push(value),
        }
    }
    if pattern.is_empty() {
        None
    } else {
        Some(pattern)
    }
}

fn parse_patterns(content: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut patterns = Vec::new();
    for pattern in content.lines().filter_map(attributes_pattern) {
        if seen.insert(pattern.clone()) {
            patterns.push(pattern);
        }
    }
    patterns
}

fn read_patterns(root: &Path) -> Vec<String> {
    std::fs::read_to_string(root.join(".gitattributes"))
        .map(|content| parse_patterns(&content))
        .unwrap_or_default()
}

// =============================================================================================
// `git lfs ls-files --long --size` 解析
// =============================================================================================

/// `(5 B)` / `(1.2 MB)` 这类人类可读大小转字节；无法识别返回 None。
fn parse_size_text(value: &str) -> Option<u64> {
    let value = value
        .trim()
        .trim_matches(|character| character == '(' || character == ')')
        .trim();
    let mut parts = value.split_whitespace();
    let number = parts.next()?.parse::<f64>().ok()?;
    let unit = parts.next().unwrap_or("B").to_ascii_uppercase();
    let factor = match unit.as_str() {
        "B" => 1_f64,
        "KB" | "KIB" => 1024_f64,
        "MB" | "MIB" => 1024_f64 * 1024_f64,
        "GB" | "GIB" => 1024_f64 * 1024_f64 * 1024_f64,
        "TB" | "TIB" => 1024_f64 * 1024_f64 * 1024_f64 * 1024_f64,
        _ => return None,
    };
    if !number.is_finite() || number < 0_f64 {
        return None;
    }
    Some((number * factor).round() as u64)
}

/// 拆掉行尾 ` (size)`，返回（剩余正文, 字节数）。
fn split_size_suffix(line: &str) -> (&str, u64) {
    if line.ends_with(')') {
        if let Some(index) = line.rfind(" (") {
            let inner = &line[index + 2..line.len() - 1];
            if let Some(size) = parse_size_text(inner) {
                return (&line[..index], size);
            }
        }
    }
    (line, 0)
}

fn parse_ls_files(output: &str) -> Vec<LfsFile> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim_end();
            if line.trim().is_empty() {
                return None;
            }
            let (body, size) = split_size_suffix(line);
            let mut fields = body.splitn(3, ' ');
            let oid = fields.next()?.trim();
            let marker = fields.next()?.trim();
            let path = fields.next()?.trim_start();
            if oid.is_empty() || path.is_empty() {
                return None;
            }
            Some(LfsFile {
                oid: oid.to_string(),
                size,
                path: path.to_string(),
                downloaded: marker == "*",
            })
        })
        .collect()
}

// =============================================================================================
// 模式校验
// =============================================================================================

fn validate_pattern(raw: &str) -> Result<String, String> {
    let pattern = raw.trim();
    if pattern.is_empty() {
        return Err("跟踪模式不能为空".to_string());
    }
    if pattern.chars().count() > MAX_PATTERN_LEN {
        return Err(format!("跟踪模式过长（上限 {MAX_PATTERN_LEN} 字符）"));
    }
    if pattern.starts_with('-') {
        return Err("跟踪模式不能以 - 开头，否则会被 git-lfs 当成命令选项".to_string());
    }
    if pattern.starts_with('#') {
        return Err("跟踪模式不能以 # 开头（会被 .gitattributes 当成注释）".to_string());
    }
    if pattern.chars().any(|character| {
        character == '\n' || character == '\r' || character == '\0' || character.is_control()
    }) {
        return Err("跟踪模式不能包含换行、NUL 或其他控制字符".to_string());
    }
    Ok(pattern.to_string())
}

// =============================================================================================
// 公共入口
// =============================================================================================

/// 读取 LFS 状态。未安装 git-lfs 不是错误，而是 `available=false` + notice。
pub fn read_lfs_status(repository_path: &str) -> Result<LfsStatus, String> {
    let root = git::repository_root(repository_path)?;
    let version = installed_lfs_version(&root);
    let available = version.is_some();
    let local = installed_locally(&root);
    let patterns = read_patterns(&root);
    let tracked_file_count = if available {
        optional(&root, &["lfs", "ls-files", "--long"])
            .lines()
            .filter(|line| !line.trim().is_empty())
            .count()
    } else {
        0
    };
    let notice = if !available {
        Some(LFS_MISSING_MESSAGE.to_string())
    } else if !local {
        Some("git-lfs 已安装，但当前仓库尚未启用：执行「安装到本仓库」写入 filter.lfs 配置并安装钩子".to_string())
    } else if patterns.is_empty() {
        Some(
            "当前仓库还没有 LFS 跟踪模式；添加 *.psd 等模式并提交 .gitattributes 后才会接管大文件"
                .to_string(),
        )
    } else {
        None
    };
    Ok(LfsStatus {
        available,
        version,
        installed_locally: local,
        patterns,
        tracked_file_count,
        notice,
    })
}

/// `git lfs install --local`，返回安装后的状态。
pub fn install_lfs(repository_path: &str) -> Result<LfsStatus, String> {
    let root = git::repository_root(repository_path)?;
    require_lfs(&root)?;
    git::git_output(&root, &["lfs", "install", "--local"])
        .map_err(|error| format!("安装 Git LFS 到当前仓库失败：{error}"))?;
    read_lfs_status(repository_path)
}

/// 添加跟踪模式并写回 `.gitattributes`，返回最新状态。
pub fn track_lfs_pattern(repository_path: &str, pattern: &str) -> Result<LfsStatus, String> {
    let root = git::repository_root(repository_path)?;
    let pattern = validate_pattern(pattern)?;
    require_lfs(&root)?;
    git::git_output(&root, &["lfs", "track", &pattern])
        .map_err(|error| format!("添加 LFS 跟踪模式 {pattern} 失败：{error}"))?;
    read_lfs_status(repository_path)
}

/// 移除跟踪模式，返回最新状态；模式本来不存在时把 git-lfs 的错误原样返回。
pub fn untrack_lfs_pattern(repository_path: &str, pattern: &str) -> Result<LfsStatus, String> {
    let root = git::repository_root(repository_path)?;
    let pattern = validate_pattern(pattern)?;
    require_lfs(&root)?;
    git::git_output(&root, &["lfs", "untrack", &pattern])
        .map_err(|error| format!("移除 LFS 跟踪模式 {pattern} 失败：{error}"))?;
    read_lfs_status(repository_path)
}

/// 列出当前引用的 LFS 文件。默认 500 条，硬上限 2000 条；超出显式 truncated。
pub fn list_lfs_files(repository_path: &str, limit: Option<usize>) -> Result<LfsFilesPage, String> {
    let root = git::repository_root(repository_path)?;
    require_lfs(&root)?;
    let requested = limit.unwrap_or(DEFAULT_FILE_LIMIT);
    let effective = requested.min(MAX_FILE_LIMIT);
    // `--long` 给出完整 OID，`--size` 补上字节数；两个都是稳定输出字段。
    let output = git::git_output(&root, &["lfs", "ls-files", "--long", "--size"])
        .map_err(|error| format!("读取 LFS 文件列表失败：{error}"))?;
    let all = parse_ls_files(&output);
    let truncated = all.len() > effective;
    let files = all.into_iter().take(effective).collect();
    Ok(LfsFilesPage { files, truncated })
}

fn run_lfs_operation(
    root: &Path,
    action: &str,
    args: &[&str],
) -> Result<LfsOperationReport, String> {
    require_lfs(root)?;
    let output = git::git_output(root, args)
        .map_err(|error| format!("执行 git lfs {action} 失败：{error}"))?;
    let summary = match action {
        "fetch" => "已抓取 LFS 对象到本地缓存（未修改工作区）",
        "pull" => "已拉取并检出 LFS 对象",
        "prune" => "已清理本地不再引用的 LFS 缓存对象",
        _ => "LFS 操作完成",
    };
    Ok(LfsOperationReport {
        action: action.to_string(),
        summary: summary.to_string(),
        output: limit_text(&output, OUTPUT_LIMIT),
    })
}

/// `git lfs fetch`：只填充本地缓存，不动工作区。
pub fn fetch_lfs_objects(repository_path: &str) -> Result<LfsOperationReport, String> {
    let root = git::repository_root(repository_path)?;
    run_lfs_operation(&root, "fetch", &["lfs", "fetch"])
}

/// `git lfs pull`：抓取并检出当前引用的 LFS 对象。
pub fn pull_lfs_objects(repository_path: &str) -> Result<LfsOperationReport, String> {
    let root = git::repository_root(repository_path)?;
    run_lfs_operation(&root, "pull", &["lfs", "pull"])
}

/// `git lfs prune`：删除本地不再引用的缓存对象（前端必须先二次确认）。
pub fn prune_lfs_objects(repository_path: &str) -> Result<LfsOperationReport, String> {
    let root = git::repository_root(repository_path)?;
    run_lfs_operation(&root, "prune", &["lfs", "prune"])
}

// =============================================================================================
// Tauri 命令包装（主代理在 commands.rs / lib.rs 注册时可直接引用本模块函数）
// =============================================================================================

#[tauri::command]
pub async fn lfs_status(repository_path: String) -> Result<LfsStatus, String> {
    tauri::async_runtime::spawn_blocking(move || read_lfs_status(&repository_path))
        .await
        .map_err(|error| format!("读取 LFS 状态失败：{error}"))?
}

#[tauri::command]
pub async fn lfs_install(repository_path: String) -> Result<LfsStatus, String> {
    tauri::async_runtime::spawn_blocking(move || install_lfs(&repository_path))
        .await
        .map_err(|error| format!("安装 Git LFS 失败：{error}"))?
}

#[tauri::command]
pub async fn lfs_track_pattern(
    repository_path: String,
    pattern: String,
) -> Result<LfsStatus, String> {
    tauri::async_runtime::spawn_blocking(move || track_lfs_pattern(&repository_path, &pattern))
        .await
        .map_err(|error| format!("添加 LFS 跟踪模式失败：{error}"))?
}

#[tauri::command]
pub async fn lfs_untrack_pattern(
    repository_path: String,
    pattern: String,
) -> Result<LfsStatus, String> {
    tauri::async_runtime::spawn_blocking(move || untrack_lfs_pattern(&repository_path, &pattern))
        .await
        .map_err(|error| format!("移除 LFS 跟踪模式失败：{error}"))?
}

#[tauri::command]
pub async fn lfs_list_files(
    repository_path: String,
    limit: Option<usize>,
) -> Result<LfsFilesPage, String> {
    tauri::async_runtime::spawn_blocking(move || list_lfs_files(&repository_path, limit))
        .await
        .map_err(|error| format!("读取 LFS 文件列表失败：{error}"))?
}

#[tauri::command]
pub async fn lfs_fetch(repository_path: String) -> Result<LfsOperationReport, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_lfs_objects(&repository_path))
        .await
        .map_err(|error| format!("抓取 LFS 对象失败：{error}"))?
}

#[tauri::command]
pub async fn lfs_pull(repository_path: String) -> Result<LfsOperationReport, String> {
    tauri::async_runtime::spawn_blocking(move || pull_lfs_objects(&repository_path))
        .await
        .map_err(|error| format!("拉取 LFS 对象失败：{error}"))?
}

#[tauri::command]
pub async fn lfs_prune(repository_path: String) -> Result<LfsOperationReport, String> {
    tauri::async_runtime::spawn_blocking(move || prune_lfs_objects(&repository_path))
        .await
        .map_err(|error| format!("清理 LFS 缓存失败：{error}"))?
}

// =============================================================================================
// 测试
// =============================================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static SCRATCH_SEQ: AtomicUsize = AtomicUsize::new(0);

    struct Sandbox {
        root: PathBuf,
        repo: PathBuf,
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn sandbox(label: &str) -> Sandbox {
        git::isolate_test_git_environment();
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let seq = SCRATCH_SEQ.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "branchline-lfs-test-{label}-{}-{unique}-{seq}",
            std::process::id()
        ));
        let repo = root.join("work");
        std::fs::create_dir_all(&repo).expect("create sandbox repository");
        git_at(&repo, &["init", "--quiet"]);
        git_at(&repo, &["config", "user.name", "Branchline Test"]);
        git_at(&repo, &["config", "user.email", "branchline@example.com"]);
        git_at(&repo, &["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.join("README.md"), "first\n").expect("write readme");
        git_at(&repo, &["add", "README.md"]);
        git_at(&repo, &["commit", "--quiet", "-m", "初始提交"]);
        Sandbox { root, repo }
    }

    fn git_at(dir: &Path, args: &[&str]) -> String {
        git::git_output(dir, args).expect("fixture git command")
    }

    fn path_of(dir: &Path) -> String {
        dir.to_string_lossy().to_string()
    }

    fn stage_lfs_file(env: &Sandbox, name: &str, content: &[u8]) {
        std::fs::write(env.repo.join(name), content).expect("write lfs file");
        git_at(&env.repo, &["add", ".gitattributes", name]);
        git_at(
            &env.repo,
            &["commit", "--quiet", "-m", &format!("添加 {name}")],
        );
    }

    // ---------------------------------------------------------------- 纯解析

    #[test]
    fn parses_patterns_from_gitattributes_without_duplicates() {
        let content = "\
# 注释行不参与
*.psd filter=lfs diff=lfs merge=lfs -text
*.zip filter=lfs diff=lfs merge=lfs -text
assets/** filter=lfs diff=lfs merge=lfs -text
*.psd filter=lfs diff=lfs merge=lfs -text
\"my file.bin\" filter=lfs diff=lfs merge=lfs -text
*.txt text
";
        assert_eq!(
            parse_patterns(content),
            vec![
                "*.psd".to_string(),
                "*.zip".to_string(),
                "assets/**".to_string(),
                "my file.bin".to_string(),
            ]
        );
    }

    #[test]
    fn parses_ls_files_long_output_with_size_and_download_state() {
        let output = "\
2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824 * a.bin (5 B)
42a19f77459c45b0218f7d21a485a8a41e3bcb4e80e6e570033c49e2fb16446a - dir/b b.psd (1.5 MB)
";
        let files = parse_ls_files(output);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "a.bin");
        assert_eq!(files[0].size, 5);
        assert!(files[0].downloaded);
        assert_eq!(files[1].path, "dir/b b.psd");
        assert_eq!(files[1].size, (1.5_f64 * 1024.0 * 1024.0) as u64);
        assert!(!files[1].downloaded);
    }

    #[test]
    fn parses_lfs_version_line() {
        assert_eq!(
            parse_lfs_version("git-lfs/3.8.1 (GitHub; darwin arm64; go 1.27.3)\n"),
            "3.8.1"
        );
        assert_eq!(parse_lfs_version("git-lfs/3.7.0"), "3.7.0");
    }

    #[test]
    fn rejects_option_like_and_multiline_patterns() {
        for pattern in [
            "-x",
            "--force",
            "*.bin\nfilter=lfs",
            "a\0b",
            "  ",
            "#comment",
        ] {
            assert!(
                validate_pattern(pattern).is_err(),
                "模式 {pattern:?} 应被拒绝"
            );
        }
        assert_eq!(validate_pattern("  *.psd  ").expect("trimmed"), "*.psd");
        assert_eq!(
            validate_pattern("my file.bin").expect("spaces allowed"),
            "my file.bin"
        );
    }

    // ---------------------------------------------------------------- 仓库级流程

    #[test]
    fn reports_availability_installation_and_patterns() {
        let env = sandbox("status");
        let path = path_of(&env.repo);
        let status = read_lfs_status(&path).expect("lfs status");
        assert!(status.available, "本机应已安装 git-lfs：{status:?}");
        assert!(status
            .version
            .as_deref()
            .is_some_and(|version| !version.is_empty()));
        assert!(!status.installed_locally);
        assert!(status.patterns.is_empty());
        assert_eq!(status.tracked_file_count, 0);
        assert!(status
            .notice
            .as_deref()
            .unwrap_or_default()
            .contains("尚未启用"));
    }

    #[test]
    fn install_track_and_untrack_round_trip() {
        let env = sandbox("track");
        let path = path_of(&env.repo);
        let installed = install_lfs(&path).expect("install lfs");
        assert!(installed.installed_locally);
        assert!(!git::git_output(
            &env.repo,
            &["config", "--local", "--get", "filter.lfs.clean"]
        )
        .unwrap_or_default()
        .trim()
        .is_empty());

        let tracked = track_lfs_pattern(&path, "*.bin").expect("track pattern");
        assert_eq!(tracked.patterns, vec!["*.bin".to_string()]);
        let attributes =
            std::fs::read_to_string(env.repo.join(".gitattributes")).expect("gitattributes");
        assert!(attributes.contains("filter=lfs"), "{attributes}");
        assert!(
            tracked.notice.is_none(),
            "有模式后不应再有安装提示：{tracked:?}"
        );

        stage_lfs_file(&env, "asset.bin", b"binary-content");
        let page = list_lfs_files(&path, Some(10)).expect("list files");
        assert_eq!(page.files.len(), 1, "{page:?}");
        assert_eq!(page.files[0].path, "asset.bin");
        assert_eq!(page.files[0].oid.chars().count(), 64);
        assert!(page.files[0].size > 0);
        assert!(page.files[0].downloaded);
        assert!(!page.truncated);

        let untracked = untrack_lfs_pattern(&path, "*.bin").expect("untrack pattern");
        assert!(untracked.patterns.is_empty());
        let attributes =
            std::fs::read_to_string(env.repo.join(".gitattributes")).expect("gitattributes");
        assert!(!attributes.contains("*.bin filter=lfs"), "{attributes}");
    }

    #[test]
    fn list_files_truncates_at_requested_limit_and_hard_cap() {
        let env = sandbox("limit");
        let path = path_of(&env.repo);
        install_lfs(&path).expect("install lfs");
        track_lfs_pattern(&path, "*.bin").expect("track pattern");
        stage_lfs_file(&env, "one.bin", b"one");
        stage_lfs_file(&env, "two.bin", b"two");
        stage_lfs_file(&env, "three.bin", b"three");

        let page = list_lfs_files(&path, Some(2)).expect("list limited");
        assert_eq!(page.files.len(), 2);
        assert!(page.truncated, "超过上限必须显式标记 truncated");

        let full = list_lfs_files(&path, None).expect("list default");
        assert_eq!(full.files.len(), 3);
        assert!(!full.truncated);

        // 请求超过硬上限时按 2000 截断逻辑处理（这里条目不足，不应误报 truncated）。
        let over = list_lfs_files(&path, Some(MAX_FILE_LIMIT + 1)).expect("list hard cap");
        assert_eq!(over.files.len(), 3);
        assert!(!over.truncated);
    }

    #[test]
    fn invalid_pattern_is_rejected_before_git_lfs_runs() {
        let env = sandbox("invalid");
        let path = path_of(&env.repo);
        for pattern in ["", "-x", "*.bin\nmalicious", "a\0b"] {
            assert!(
                track_lfs_pattern(&path, pattern).is_err(),
                "模式 {pattern:?} 应被拒绝"
            );
            assert!(
                untrack_lfs_pattern(&path, pattern).is_err(),
                "模式 {pattern:?} 应被拒绝"
            );
        }
        assert!(!env.repo.join(".gitattributes").exists());
    }

    #[test]
    fn status_count_reflects_tracked_files() {
        let env = sandbox("count");
        let path = path_of(&env.repo);
        install_lfs(&path).expect("install lfs");
        track_lfs_pattern(&path, "*.bin").expect("track pattern");
        stage_lfs_file(&env, "counted.bin", b"counted");
        let status = read_lfs_status(&path).expect("status");
        assert_eq!(status.tracked_file_count, 1);
    }
}
