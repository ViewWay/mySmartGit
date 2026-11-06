//! Git 运行时探测、SSH 密钥管理与凭据助手（credential.helper）配置。
//!
//! 安全约束（红线，与 git_remote.rs 保持一致）：
//! - 所有 Git / SSH 子进程都以参数数组发起，绝不拼接 shell 字符串，绝不使用 `sh -c`；
//! - 文件名 / 密钥类型 / 位数 / 凭据助手先在 Rust 侧按白名单校验，非法输入不进入子进程；
//! - 私钥口令永远不经过本模块：只生成空口令密钥，口令保护必须在终端里用 `ssh-keygen -p` 完成；
//! - 凭据助手最终由 Git 通过 shell 执行，因此只接受固定白名单，杜绝任意命令注入；
//! - 本模块不记录任何命令行日志，错误信息里只有路径 / Git 输出，不包含私钥内容。
//!
//! 关于「内置 Git」的诚实说明：本模块只**探测**安装包旁边是否已有
//! `Resources/git/bin/git`（或可执行文件旁的 `git/bin/git`），并把该目录前置到 PATH。
//! 仓库本身不附带、也不下载 Git 二进制；没有内置 Git 时会回落到系统 PATH 里的 git。
//! 同理，这里不会替用户安装 OpenSSH 或 Git LFS，缺失时对应能力降级为空值。

use serde::{Deserialize, Serialize};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// 运行时探测结果。所有字段在探测失败时降级为 None / 空列表，不阻断设置页。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitRuntimeInfo {
    pub git_version: Option<String>,
    pub git_path: Option<String>,
    pub ssh_version: Option<String>,
    pub git_lfs_version: Option<String>,
    pub credential_helpers: Vec<String>,
    pub ssh_agent_running: bool,
    pub ssh_agent_keys: Vec<String>,
    pub custom_git_dir: Option<String>,
    pub bundled_git_present: bool,
}

/// 单个 SSH 密钥对（以 base 文件名为单位，`.pub` 只作为配对文件出现）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyInfo {
    pub file_name: String,
    pub key_type: String,
    pub bits: Option<u32>,
    pub fingerprint: Option<String>,
    pub comment: String,
    pub has_private: bool,
    pub has_public: bool,
    pub path: String,
}

/// 设置凭据助手后的回报：实际落地的配置值与风险提示。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CredentialHelperReport {
    pub configured_helpers: Vec<String>,
    pub notice: Option<String>,
}

/// 自定义 Git 配置文件的磁盘结构。缺失 / 损坏一律视为「未配置」。
#[derive(Serialize, Deserialize, Default, Clone)]
struct GitRuntimeConfig {
    #[serde(default)]
    custom_git_dir: Option<String>,
}

/// 单个目录最多列出的密钥对数，避免异常目录拖慢设置页。
const MAX_SSH_KEYS: usize = 500;
/// 公钥读取上限（16KB），超过即拒绝。
const MAX_PUBLIC_KEY_BYTES: usize = 16 * 1024;
/// 公钥注释长度上限。
const MAX_COMMENT_CHARS: usize = 200;

// =============================================================================================
// 基础路径与子进程
// =============================================================================================

/// 生产环境主目录：BRANCHLINE_HOME 优先，否则 HOME。
/// 测试通过 BRANCHLINE_HOME 指向一次性临时目录，绝不触碰真实 ~/.ssh 或 ~/.gitconfig。
fn home_root() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("BRANCHLINE_HOME") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn runtime_config_path() -> Option<PathBuf> {
    home_root().map(|home| home.join(".config").join("branchline").join("git-runtime.json"))
}

fn read_runtime_config() -> GitRuntimeConfig {
    let Some(path) = runtime_config_path() else {
        return GitRuntimeConfig::default();
    };
    let Ok(raw) = fs::read(&path) else {
        return GitRuntimeConfig::default();
    };
    serde_json::from_slice(&raw).unwrap_or_default()
}

fn write_runtime_config(config: &GitRuntimeConfig) -> Result<(), String> {
    let path = runtime_config_path().ok_or_else(|| "无法确定用户主目录，不能保存 Git 运行时配置".to_string())?;
    match &config.custom_git_dir {
        None => {
            // None 即清除：删掉配置文件，让后续读取自然降级为「未配置」。
            if path.exists() {
                fs::remove_file(&path).map_err(|error| format!("清除自定义 Git 配置失败：{error}"))?;
            }
            Ok(())
        }
        Some(_) => {
            let parent = path
                .parent()
                .ok_or_else(|| "Git 运行时配置路径无效".to_string())?;
            fs::create_dir_all(parent).map_err(|error| format!("创建配置目录失败：{error}"))?;
            let body = serde_json::to_vec_pretty(config)
                .map_err(|error| format!("序列化 Git 运行时配置失败：{error}"))?;
            fs::write(&path, body).map_err(|error| format!("保存 Git 运行时配置失败：{error}"))
        }
    }
}

/// 以参数数组启动进程（绝不经过 shell），stdin 固定为 null，避免任何交互式提问挂住。
fn run_command(program: &Path, args: &[OsString], working_directory: Option<&Path>) -> Result<std::process::Output, String> {
    let mut command = Command::new(program);
    if let Some(directory) = working_directory {
        command.arg("-C").arg(directory);
    }
    command.args(args);
    command.stdin(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    // 测试进程与 git.rs 共用同一套隔离环境（GIT_CONFIG_GLOBAL / GIT_TERMINAL_PROMPT 等），
    // 保证这里读写 global 配置落到夹具而不是开发机的 ~/.gitconfig。
    #[cfg(test)]
    crate::git::isolate_test_git_environment();
    command
        .output()
        .map_err(|error| format!("无法启动 {}：{error}", program.display()))
}

fn output_text(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        return stdout;
    }
    String::from_utf8_lossy(&output.stderr).trim().to_string()
}

fn command_error(program: &Path, output: &std::process::Output) -> String {
    let text = output_text(output);
    let shortened: String = text.chars().take(400).collect();
    if shortened.is_empty() {
        format!("{} 执行失败", program.display())
    } else {
        format!("{} 执行失败：{shortened}", program.display())
    }
}

// =============================================================================================
// 自定义 / 内置 Git
// =============================================================================================

/// 在给定目录内定位 git 可执行文件：只接受「目录 + 内部固定文件名」，不接收指向二进制的路径。
fn git_in_dir(directory: &Path) -> PathBuf {
    let plain = directory.join("git");
    if plain.is_file() {
        return plain;
    }
    #[cfg(target_os = "windows")]
    {
        let executable = directory.join("git.exe");
        if executable.is_file() {
            return executable;
        }
    }
    plain
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// 安装包旁的内置 Git 目录：macOS 为 `../Resources/git/bin`，其他布局为可执行文件旁的 `git/bin`。
fn bundled_git_bin_dir() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let base = executable.parent()?;
    for candidate in [base.join("../Resources/git/bin"), base.join("git/bin")] {
        if is_executable_file(&git_in_dir(&candidate)) {
            return Some(candidate);
        }
    }
    None
}

fn find_on_path(program: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        let candidate = directory.join(program);
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
        #[cfg(target_os = "windows")]
        {
            let executable = directory.join(format!("{program}.exe"));
            if is_executable_file(&executable) {
                return Some(executable);
            }
        }
    }
    None
}

/// 校验用户选择的自定义 Git 目录：必须是目录、内含可执行 git、且 `git --version` 能成功。
fn validate_custom_git_dir(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("自定义 Git 目录不能为空".to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_dir() {
        return Err(format!("自定义 Git 目录不存在或不是目录：{trimmed}"));
    }
    let git = git_in_dir(&path);
    if !is_executable_file(&git) {
        return Err(format!("目录中没有可执行的 git：{trimmed}"));
    }
    let output = run_command(&git, &[OsString::from("--version")], None)?;
    if !output.status.success() {
        return Err(command_error(&git, &output));
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !version.starts_with("git version") {
        return Err(format!("该目录下的 git 未返回有效版本信息：{trimmed}"));
    }
    fs::canonicalize(&path).map_err(|error| format!("无法解析自定义 Git 目录：{error}"))
}

/// 设置或清除自定义 Git 目录。`None` / 空串表示清除。
pub fn set_custom_git_dir(path: Option<&str>) -> Result<Option<String>, String> {
    let custom = match path.map(str::trim).filter(|value| !value.is_empty()) {
        None => None,
        Some(raw) => Some(validate_custom_git_dir(raw)?),
    };
    let config = GitRuntimeConfig {
        custom_git_dir: custom
            .as_ref()
            .map(|directory| directory.to_string_lossy().to_string()),
    };
    write_runtime_config(&config)?;
    Ok(config.custom_git_dir)
}

/// 当前应使用的 git 可执行文件：已配置且仍有效的自定义目录优先，其次内置目录，最后回落到 PATH。
fn effective_git_binary() -> PathBuf {
    if let Some(configured) = read_runtime_config().custom_git_dir {
        let directory = PathBuf::from(&configured);
        let candidate = git_in_dir(&directory);
        if is_executable_file(&candidate) {
            return candidate;
        }
    }
    if let Some(directory) = bundled_git_bin_dir() {
        return git_in_dir(&directory);
    }
    PathBuf::from("git")
}

fn prepend_path(current: &OsStr, directory: &Path) -> OsString {
    let entries: Vec<PathBuf> = std::env::split_paths(current).collect();
    if entries.first().map(|entry| entry == directory).unwrap_or(false) {
        return current.to_os_string();
    }
    let mut updated = Vec::with_capacity(entries.len() + 1);
    updated.push(directory.to_path_buf());
    updated.extend(entries.into_iter().filter(|entry| entry != directory));
    std::env::join_paths(updated).unwrap_or_else(|_| current.to_os_string())
}

/// 把自定义 / 内置 Git 目录前置到本进程 PATH。幂等、无 panic；返回被前置的目录。
pub fn configure_process_path() -> Option<String> {
    let directory = read_runtime_config()
        .custom_git_dir
        .map(PathBuf::from)
        .filter(|directory| is_executable_file(&git_in_dir(directory)))
        .or_else(bundled_git_bin_dir)?;
    // 环境变量值含 NUL 时 set_var 会 panic；这类路径直接跳过，保证「never panics」。
    if directory.to_string_lossy().contains('\0') {
        return None;
    }
    let current = std::env::var_os("PATH").unwrap_or_default();
    let updated = prepend_path(&current, &directory);
    if updated != current {
        std::env::set_var("PATH", updated);
    }
    Some(directory.to_string_lossy().to_string())
}

fn git_version_of(binary: &Path) -> Option<String> {
    let output = run_command(binary, &[OsString::from("--version")], None).ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!version.is_empty()).then_some(version)
}

fn ssh_version() -> Option<String> {
    let output = run_command(Path::new("ssh"), &[OsString::from("-V")], None).ok()?;
    // OpenSSH 把版本写到 stderr；两者都取，取第一条非空。
    let text = output_text(&output);
    let first = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    Some(first.to_string())
}

fn git_lfs_version(binary: &Path) -> Option<String> {
    let args = [OsString::from("lfs"), OsString::from("version")];
    if let Ok(output) = run_command(binary, &args, None) {
        if output.status.success() {
            let text = output_text(&output);
            if !text.is_empty() {
                return Some(text);
            }
        }
    }
    let output = run_command(Path::new("git-lfs"), &[OsString::from("version")], None).ok()?;
    if !output.status.success() {
        return None;
    }
    let text = output_text(&output);
    (!text.is_empty()).then_some(text)
}

fn ssh_agent_status() -> (bool, Vec<String>) {
    let Ok(output) = run_command(Path::new("ssh-add"), &[OsString::from("-l")], None) else {
        return (false, Vec::new());
    };
    // 0 = 有密钥；1 = agent 在跑但没有密钥；2 = agent 未运行 / 无法连接。
    let running = output.status.success() || output.status.code() == Some(1);
    if !output.status.success() {
        return (running, Vec::new());
    }
    let keys = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(200)
        .map(ToString::to_string)
        .collect();
    (running, keys)
}

/// 只读探测 Git / SSH / LFS / 凭据助手 / agent 状态；任何单项失败都降级为空值。
pub fn git_runtime_info() -> GitRuntimeInfo {
    let config = read_runtime_config();
    let binary = effective_git_binary();
    let git_path = if binary.is_absolute() {
        Some(binary.to_string_lossy().to_string())
    } else {
        find_on_path("git").map(|path| path.to_string_lossy().to_string())
    };
    let (ssh_agent_running, ssh_agent_keys) = ssh_agent_status();
    GitRuntimeInfo {
        git_version: git_version_of(&binary),
        git_path,
        ssh_version: ssh_version(),
        git_lfs_version: git_lfs_version(&binary),
        credential_helpers: credential_helpers(None),
        ssh_agent_running,
        ssh_agent_keys,
        custom_git_dir: config.custom_git_dir,
        bundled_git_present: bundled_git_bin_dir().is_some(),
    }
}

// =============================================================================================
// SSH 密钥
// =============================================================================================

/// 生成密钥时的文件名校验：`[A-Za-z0-9._-]{1,64}`，不得以 `-` 开头（选项注入），不得是 `.` / `..`。
pub(crate) fn validate_generated_file_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("密钥文件名不能为空".to_string());
    }
    if name.chars().count() > 64 {
        return Err("密钥文件名过长（上限 64 字符）".to_string());
    }
    if name.starts_with('-') {
        return Err("密钥文件名不能以 - 开头，否则会被当成命令选项".to_string());
    }
    if name == "." || name == ".." {
        return Err("密钥文件名不能是 . 或 ..".to_string());
    }
    if !name
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'))
    {
        return Err("密钥文件名只能包含字母、数字、点、下划线和短横线".to_string());
    }
    Ok(name.to_string())
}

/// 操作既有文件时的较宽松校验（仍禁止分隔符 / 前导 `-` / 点目录跳转）。
fn validate_existing_file_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() || name.chars().count() > 200 {
        return Err("密钥文件名无效".to_string());
    }
    if name.starts_with('-') || name == "." || name == ".." {
        return Err("密钥文件名无效".to_string());
    }
    if !name
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'))
    {
        return Err("密钥文件名包含不允许的字符".to_string());
    }
    Ok(name.to_string())
}

fn base_key_name(file_name: &str) -> &str {
    file_name.strip_suffix(".pub").unwrap_or(file_name)
}

/// `.ssh` 目录必须真实存在（create 时创建）且规范化后仍位于主目录内，防止 `.ssh` 本身是软链逃逸。
fn ssh_dir(create: bool) -> Result<PathBuf, String> {
    let home = home_root().ok_or_else(|| "无法确定用户主目录".to_string())?;
    let directory = home.join(".ssh");
    let mut created = false;
    if !directory.is_dir() {
        if !create {
            return Err("SSH 目录不存在".to_string());
        }
        fs::create_dir_all(&directory).map_err(|error| format!("创建 SSH 目录失败：{error}"))?;
        created = true;
    }
    #[cfg(unix)]
    if created {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&directory, fs::Permissions::from_mode(0o700));
    }
    let canonical_home = fs::canonicalize(&home).unwrap_or_else(|_| home.clone());
    let canonical_dir = fs::canonicalize(&directory)
        .map_err(|error| format!("无法解析 SSH 目录：{error}"))?;
    if !canonical_dir.starts_with(&canonical_home) {
        return Err("SSH 目录不在用户主目录内，已拒绝操作".to_string());
    }
    Ok(canonical_dir)
}

fn describe(buf: &[u8]) -> String {
    String::from_utf8_lossy(buf).to_string()
}

fn regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        .unwrap_or(false)
}

fn looks_like_public_key(path: &Path) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut buffer = [0u8; 256];
    let read = file.read(&mut buffer).unwrap_or(0);
    let text = describe(&buffer[..read]);
    let text = text.trim_start();
    text.starts_with("ssh-")
        || text.starts_with("ecdsa-")
        || text.starts_with("sk-")
        || text.starts_with("ssh-ed25519")
}

fn looks_like_private_key(path: &Path) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut buffer = [0u8; 256];
    let read = file.read(&mut buffer).unwrap_or(0);
    let text = describe(&buffer[..read]);
    text.contains("-----BEGIN ") && text.contains("PRIVATE KEY-----")
}

/// 解析 `ssh-keygen -l -E sha256 -f` 的输出：`256 SHA256:… comment (ED25519)`。
fn parse_fingerprint_output(raw: &str) -> Option<(Option<u32>, String, String, String)> {
    let line = raw.lines().map(str::trim).find(|line| !line.is_empty())?;
    let mut parts = line.split_whitespace();
    let bits = parts.next().and_then(|value| value.parse::<u32>().ok());
    let fingerprint = parts.next()?.to_string();
    if !fingerprint.starts_with("SHA256:") && !fingerprint.starts_with("MD5:") {
        return None;
    }
    let remainder: Vec<&str> = parts.collect();
    let mut key_type = String::new();
    let mut comment_parts = &remainder[..];
    if let Some(last) = remainder.last() {
        if last.starts_with('(') && last.ends_with(')') && last.len() > 2 {
            key_type = last[1..last.len() - 1].to_ascii_uppercase();
            comment_parts = &remainder[..remainder.len() - 1];
        }
    }
    Some((bits, fingerprint, key_type, comment_parts.join(" ")))
}

/// 从公钥文本解析类型 / 位数 / 注释；解析失败返回 None。
fn parse_public_key_text(raw: &str) -> Option<(String, Option<u32>, String)> {
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let token = parts.next()?;
        let _blob = parts.next()?;
        let comment = parts.collect::<Vec<_>>().join(" ");
        let (kind, bits) = match token {
            "ssh-ed25519" => ("ED25519", Some(256)),
            "ssh-rsa" => ("RSA", None),
            "ecdsa-sha2-nistp256" => ("ECDSA", Some(256)),
            "ecdsa-sha2-nistp384" => ("ECDSA", Some(384)),
            "ecdsa-sha2-nistp521" => ("ECDSA", Some(521)),
            "ssh-dss" => ("DSA", Some(1024)),
            value if value.starts_with("sk-ssh-ed25519") => ("ED25519-SK", Some(256)),
            value if value.starts_with("sk-ecdsa-") => ("ECDSA-SK", Some(256)),
            _ => continue,
        };
        return Some((kind.to_string(), bits, comment));
    }
    None
}

/// 私钥没有配对公钥时的类型兜底（位数只能靠 ssh-keygen，缺失时为 None）。
fn private_key_type(path: &Path) -> String {
    let Ok(mut file) = fs::File::open(path) else {
        return String::new();
    };
    let mut buffer = [0u8; 256];
    let read = file.read(&mut buffer).unwrap_or(0);
    let text = describe(&buffer[..read]);
    if text.contains("BEGIN OPENSSH PRIVATE KEY") {
        String::new()
    } else if text.contains("BEGIN RSA PRIVATE KEY") {
        "RSA".to_string()
    } else if text.contains("BEGIN EC PRIVATE KEY") {
        "ECDSA".to_string()
    } else if text.contains("BEGIN DSA PRIVATE KEY") {
        "DSA".to_string()
    } else {
        String::new()
    }
}

fn key_material(directory: &Path, base: &str) -> Option<PathBuf> {
    let public = directory.join(format!("{base}.pub"));
    if regular_file(&public) {
        return Some(public);
    }
    let private = directory.join(base);
    regular_file(&private).then_some(private)
}

/// 组装单个密钥对的信息；所有外部探测失败都只影响对应字段。
fn describe_key(directory: &Path, base: &str, has_private: bool, has_public: bool) -> Option<SshKeyInfo> {
    let material = key_material(directory, base)?;
    let mut key_type = String::new();
    let mut bits = None;
    let mut fingerprint = None;
    let mut comment = String::new();

    if let Ok(output) = run_command(
        Path::new("ssh-keygen"),
        &[
            OsString::from("-l"),
            OsString::from("-E"),
            OsString::from("sha256"),
            OsString::from("-f"),
            material.as_os_str().to_os_string(),
        ],
        None,
    ) {
        if output.status.success() {
            if let Some((parsed_bits, parsed_fingerprint, parsed_type, parsed_comment)) =
                parse_fingerprint_output(&String::from_utf8_lossy(&output.stdout))
            {
                bits = parsed_bits;
                fingerprint = Some(parsed_fingerprint);
                key_type = parsed_type;
                comment = parsed_comment;
            }
        }
    }

    let public_path = directory.join(format!("{base}.pub"));
    if regular_file(&public_path) {
        if let Ok(raw) = fs::read(&public_path) {
            if let Some((parsed_type, parsed_bits, parsed_comment)) = parse_public_key_text(&describe(&raw)) {
                if key_type.is_empty() {
                    key_type = parsed_type;
                }
                if bits.is_none() {
                    bits = parsed_bits;
                }
                if comment.is_empty() {
                    comment = parsed_comment;
                }
            }
        }
    }
    if key_type.is_empty() && has_private {
        key_type = private_key_type(&directory.join(base));
    }

    Some(SshKeyInfo {
        file_name: base.to_string(),
        key_type,
        bits,
        fingerprint,
        comment,
        has_private,
        has_public,
        // path 指向私钥（口令保护 / 删除都针对它）；只有公钥时才回落到公钥文件。
        path: if has_private && regular_file(&directory.join(base)) {
            directory.join(base)
        } else {
            material
        }
        .to_string_lossy()
        .to_string(),
    })
}

/// 列出 `<home>/.ssh` 下的密钥对：仅普通文件（跳过符号链接与目录），按文件名排序，最多 500 对。
pub fn list_ssh_keys() -> Vec<SshKeyInfo> {
    let Ok(directory) = ssh_dir(false) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&directory) else {
        return Vec::new();
    };
    // BTreeMap 天然按 base 名排序，输出稳定。
    let mut pairs: std::collections::BTreeMap<String, (bool, bool)> = std::collections::BTreeMap::new();
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            continue;
        }
        let base = base_key_name(file_name);
        if validate_existing_file_name(base).is_err() {
            continue;
        }
        let path = entry.path();
        let (has_private, has_public) = if file_name.ends_with(".pub") {
            if !looks_like_public_key(&path) {
                continue;
            }
            (false, true)
        } else if looks_like_private_key(&path) {
            (true, false)
        } else if looks_like_public_key(&path) {
            (false, true)
        } else {
            continue;
        };
        let state = pairs.entry(base.to_string()).or_insert((false, false));
        state.0 |= has_private;
        state.1 |= has_public;
    }

    let mut keys: Vec<SshKeyInfo> = pairs
        .into_iter()
        .filter_map(|(base, (has_private, has_public))| describe_key(&directory, &base, has_private, has_public))
        .collect();
    keys.truncate(MAX_SSH_KEYS);
    keys
}

fn normalize_comment(raw: &str) -> Result<Option<String>, String> {
    let comment = raw.trim();
    if comment.is_empty() {
        return Ok(None);
    }
    if comment.chars().count() > MAX_COMMENT_CHARS {
        return Err(format!("密钥注释过长（上限 {MAX_COMMENT_CHARS} 字符）"));
    }
    if comment.chars().any(char::is_control) {
        return Err("密钥注释不能包含控制字符或换行".to_string());
    }
    Ok(Some(comment.to_string()))
}

#[cfg(unix)]
fn enforce_private_key_mode(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(path)
        .map_err(|error| format!("无法读取私钥权限：{error}"))?
        .permissions()
        .mode()
        & 0o777;
    if mode != 0o600 {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("无法把私钥权限设置为 600：{error}"))?;
    }
    let mode = fs::metadata(path)
        .map_err(|error| format!("无法读取私钥权限：{error}"))?
        .permissions()
        .mode()
        & 0o777;
    if mode != 0o600 {
        return Err(format!("私钥权限未达到 600（当前 {:o}）", mode));
    }
    Ok(())
}

#[cfg(not(unix))]
fn enforce_private_key_mode(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// 生成 SSH 密钥对（ed25519 / rsa）。
///
/// 只支持**空口令**：`-N ""` 是这里的唯一用法。带口令保护需要交互式输入，
/// 必须由用户在终端里执行 `ssh-keygen -p -f <私钥路径>` 完成；本模块不接收、不传递口令。
pub fn generate_ssh_key(
    file_name: &str,
    key_type: &str,
    bits: Option<u32>,
    comment: Option<&str>,
    overwrite: bool,
) -> Result<SshKeyInfo, String> {
    let name = validate_generated_file_name(file_name)?;
    if name.ends_with(".pub") {
        return Err("密钥文件名不要带 .pub 后缀，公钥会自动生成".to_string());
    }
    let kind = key_type.trim().to_ascii_lowercase();
    let rsa_bits = match kind.as_str() {
        "ed25519" => {
            // ed25519 位数固定，忽略传入值（接口保留 bits 只为前端表单统一）。
            None
        }
        "rsa" => {
            let value = bits.unwrap_or(3072);
            if ![2048, 3072, 4096].contains(&value) {
                return Err("RSA 密钥位数只能是 2048 / 3072 / 4096".to_string());
            }
            Some(value)
        }
        _ => return Err("密钥类型只能是 ed25519 或 rsa".to_string()),
    };
    let comment = normalize_comment(comment.unwrap_or(""))?;
    let directory = ssh_dir(true)?;
    let private = directory.join(&name);
    let public = directory.join(format!("{name}.pub"));

    for path in [&private, &public] {
        if let Ok(metadata) = fs::symlink_metadata(path) {
            if metadata.is_dir() {
                return Err(format!("目标路径是目录，已拒绝：{}", path.display()));
            }
            if !overwrite {
                return Err(format!(
                    "密钥文件已存在：{}。如需覆盖请显式开启覆盖选项",
                    path.file_name().unwrap_or_default().to_string_lossy()
                ));
            }
            // 覆盖时先移除（包括符号链接本身），避免 ssh-keygen 跟随链接写到目录外。
            fs::remove_file(path).map_err(|error| format!("覆盖旧密钥文件失败：{error}"))?;
        }
    }

    let mut args: Vec<OsString> = vec![
        OsString::from("-q"),
        OsString::from("-t"),
        OsString::from(&kind),
        OsString::from("-f"),
        private.as_os_str().to_os_string(),
        OsString::from("-N"),
        OsString::from(""),
    ];
    if let Some(value) = rsa_bits {
        args.push(OsString::from("-b"));
        args.push(OsString::from(value.to_string()));
    }
    if let Some(comment) = &comment {
        args.push(OsString::from("-C"));
        args.push(OsString::from(comment));
    }

    let output = run_command(Path::new("ssh-keygen"), &args, None)
        .map_err(|error| format!("无法启动 ssh-keygen：{error}"))?;
    if !output.status.success() {
        return Err(command_error(Path::new("ssh-keygen"), &output));
    }
    if !regular_file(&private) {
        return Err("ssh-keygen 未生成私钥文件".to_string());
    }
    enforce_private_key_mode(&private)?;
    describe_key(&directory, &name, true, regular_file(&public))
        .ok_or_else(|| "密钥已生成，但无法读取其信息".to_string())
}

/// 读取 SSH 公钥：优先 `.pub`，只有私钥时用 `ssh-keygen -y` 推导；上限 16KB。
pub fn read_ssh_public_key(file_name: &str) -> Result<String, String> {
    let name = validate_existing_file_name(file_name)?;
    let base = base_key_name(&name);
    let directory = ssh_dir(false)?;

    // 少数用户会把公钥存成不带 .pub 的文件；此时按内容识别，直接读取该文件。
    let exact = directory.join(&name);
    if regular_file(&exact) && looks_like_public_key(&exact) {
        return read_capped_text(&exact, "公钥");
    }

    let public = directory.join(format!("{base}.pub"));
    if regular_file(&public) {
        return read_capped_text(&public, "公钥");
    }
    let private = directory.join(base);
    if regular_file(&private) {
        let output = run_command(
            Path::new("ssh-keygen"),
            &[
                OsString::from("-y"),
                OsString::from("-f"),
                private.as_os_str().to_os_string(),
            ],
            None,
        )?;
        if !output.status.success() {
            return Err(command_error(Path::new("ssh-keygen"), &output));
        }
        if output.stdout.len() > MAX_PUBLIC_KEY_BYTES {
            return Err("推导出的公钥超过 16KB，已拒绝读取".to_string());
        }
        return Ok(describe(&output.stdout));
    }
    Err(format!("未找到公钥：{base}"))
}

fn read_capped_text(path: &Path, label: &str) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| format!("读取{label}失败：{error}"))?;
    let mut buffer = Vec::new();
    file.by_ref()
        .take((MAX_PUBLIC_KEY_BYTES + 1) as u64)
        .read_to_end(&mut buffer)
        .map_err(|error| format!("读取{label}失败：{error}"))?;
    if buffer.len() > MAX_PUBLIC_KEY_BYTES {
        return Err(format!("{label}文件超过 16KB，已拒绝读取"));
    }
    Ok(describe(&buffer))
}

/// 删除密钥文件：只允许 `.ssh` 下的普通文件；拒绝目录、符号链接与 `../` 逃逸。
/// `also_public=true` 时一并删除配对的 `.pub`。
pub fn delete_ssh_key(file_name: &str, also_public: bool) -> Result<Vec<String>, String> {
    let name = validate_existing_file_name(file_name)?;
    let base = base_key_name(&name);
    let directory = ssh_dir(false)?;
    let private = directory.join(base);
    let public = directory.join(format!("{base}.pub"));

    for path in [&private, &public] {
        if let Ok(metadata) = fs::symlink_metadata(path) {
            if metadata.file_type().is_symlink() {
                return Err(format!("拒绝删除符号链接：{}", path.display()));
            }
            if metadata.is_dir() {
                return Err(format!("拒绝删除目录：{}", path.display()));
            }
        }
    }

    let mut removed = Vec::new();
    if regular_file(&private) {
        fs::remove_file(&private).map_err(|error| format!("删除私钥失败：{error}"))?;
        removed.push(base.to_string());
    }
    if also_public && regular_file(&public) {
        fs::remove_file(&public).map_err(|error| format!("删除公钥失败：{error}"))?;
        removed.push(format!("{base}.pub"));
    }
    if removed.is_empty() {
        return Err("没有找到可删除的密钥文件".to_string());
    }
    Ok(removed)
}

// =============================================================================================
// 凭据助手
// =============================================================================================

const SIMPLE_HELPERS: [&str; 7] = [
    "osxkeychain",
    "manager",
    "manager-core",
    "libsecret",
    "wincred",
    "store",
    "cache",
];

/// 凭据助手白名单：Git 会通过 shell 执行 credential.helper，因此绝不接受任意字符串。
/// 允许空串（清除）、固定助手名，以及 `cache --timeout=<1-5 位数字>` 这一种带参数形式。
pub(crate) fn validate_credential_helper(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if trimmed.chars().any(char::is_control) {
        return Err("凭据助手不能包含控制字符或换行".to_string());
    }
    let normalized = trimmed.split_whitespace().collect::<Vec<_>>().join(" ");
    if SIMPLE_HELPERS.contains(&normalized.as_str()) {
        return Ok(normalized);
    }
    if let Some(timeout) = normalized.strip_prefix("cache --timeout=") {
        if !timeout.is_empty() && timeout.len() <= 5 && timeout.chars().all(|character| character.is_ascii_digit()) {
            return Ok(normalized);
        }
    }
    Err("不支持的凭据助手。允许：osxkeychain、manager、manager-core、libsecret、wincred、store、cache、cache --timeout=<1-5 位秒数>".to_string())
}

/// 白名单内的风险提示（store 明文落盘、cache 仅内存）。
fn credential_helper_notice(helper: &str) -> Option<String> {
    if helper == "store" {
        return Some(
            "store 会把用户名和密码以明文写入 ~/.git-credentials，任何能读该文件的程序都能看到凭据；请仅在受控环境中使用。".to_string(),
        );
    }
    if helper == "cache" || helper.starts_with("cache --timeout=") {
        return Some("cache 只在内存中临时缓存凭据，Git 进程结束后失效。".to_string());
    }
    None
}

fn git_config_args(scope: &str, repository: Option<&Path>, args: &[&str]) -> Vec<OsString> {
    let mut output: Vec<OsString> = Vec::new();
    if scope == "local" {
        if let Some(repository) = repository {
            output.push(OsString::from("-C"));
            output.push(repository.as_os_str().to_os_string());
        }
    }
    output.push(OsString::from("config"));
    output.push(OsString::from(if scope == "local" { "--local" } else { "--global" }));
    output.extend(args.iter().map(OsString::from));
    output
}

fn git_config_run(scope: &str, repository: Option<&Path>, args: &[&str]) -> Result<std::process::Output, String> {
    let binary = effective_git_binary();
    run_command(&binary, &git_config_args(scope, repository, args), None)
}

fn credential_helpers(repository_path: Option<&str>) -> Vec<String> {
    let repository = match repository_path {
        Some(path) => match crate::git::repository_root(path) {
            Ok(root) => Some(root),
            Err(_) => return Vec::new(),
        },
        None => None,
    };
    let scope = if repository.is_some() { "local" } else { "global" };
    let Ok(output) = git_config_run(scope, repository.as_deref(), &["--get-all", "credential.helper"]) else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect()
}

/// 读取 global（或指定仓库的 local）凭据助手列表；失败视为未配置。
pub fn get_credential_helpers(repository_path: Option<&str>) -> Vec<String> {
    credential_helpers(repository_path)
}

/// 设置凭据助手：先整体清空同作用域的 credential.helper，再写入单个白名单值。
/// `scope` 只能是 global / local；local 必须提供有效仓库路径。
pub fn set_credential_helper(
    scope: &str,
    repository_path: Option<&str>,
    helper: &str,
) -> Result<CredentialHelperReport, String> {
    let scope = scope.trim().to_ascii_lowercase();
    if scope != "global" && scope != "local" {
        return Err("作用域只能是 global 或 local".to_string());
    }
    let helper = validate_credential_helper(helper)?;
    let repository = if scope == "local" {
        let path = repository_path
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "设置仓库级凭据助手需要仓库路径".to_string())?;
        Some(crate::git::repository_root(path)?)
    } else {
        None
    };

    // 忽略 unset 的退出码：键不存在时 Git 返回非零，但语义上已经达到「没有配置」。
    let _ = git_config_run(&scope, repository.as_deref(), &["--unset-all", "credential.helper"]);
    if !helper.is_empty() {
        let output = git_config_run(&scope, repository.as_deref(), &["--add", "credential.helper", &helper])?;
        if !output.status.success() {
            return Err(command_error(&effective_git_binary(), &output));
        }
    }

    let configured_helpers = credential_helpers(repository.as_deref().map(|path| path.to_string_lossy()).as_deref());
    let notice = if helper.is_empty() {
        Some(format!("已清除 {scope} 作用域的 credential.helper 配置。"))
    } else {
        credential_helper_notice(&helper)
    };
    Ok(CredentialHelperReport {
        configured_helpers,
        notice,
    })
}

// =============================================================================================
// Tauri 命令包装
// =============================================================================================

/// 命令包装独立成子模块，避免与同名业务函数冲突；接线时使用
/// `git_credentials::api::…` 注册到 `generate_handler!`。
pub mod api {
    use super::*;

    fn command_error(action: &str, error: impl std::fmt::Display) -> String {
        format!("{action}失败：{error}")
    }

    #[tauri::command]
    pub async fn load_git_runtime_info() -> Result<GitRuntimeInfo, String> {
        tauri::async_runtime::spawn_blocking(git_runtime_info)
            .await
            .map_err(|error| command_error("读取 Git 运行时信息", error))
    }

    #[tauri::command]
    pub async fn set_custom_git_directory(path: Option<String>) -> Result<Option<String>, String> {
        tauri::async_runtime::spawn_blocking(move || set_custom_git_dir(path.as_deref()))
            .await
            .map_err(|error| command_error("设置自定义 Git 目录", error))?
    }

    #[tauri::command]
    pub async fn load_ssh_keys() -> Result<Vec<SshKeyInfo>, String> {
        tauri::async_runtime::spawn_blocking(|| Ok(list_ssh_keys()))
            .await
            .map_err(|error| command_error("读取 SSH 密钥", error))?
    }

    #[tauri::command]
    pub async fn generate_ssh_key(
        file_name: String,
        key_type: String,
        bits: Option<u32>,
        comment: Option<String>,
        overwrite: bool,
    ) -> Result<SshKeyInfo, String> {
        tauri::async_runtime::spawn_blocking(move || {
            super::generate_ssh_key(&file_name, &key_type, bits, comment.as_deref(), overwrite)
        })
        .await
        .map_err(|error| command_error("生成 SSH 密钥", error))?
    }

    #[tauri::command]
    pub async fn read_ssh_public_key(file_name: String) -> Result<String, String> {
        tauri::async_runtime::spawn_blocking(move || super::read_ssh_public_key(&file_name))
            .await
            .map_err(|error| command_error("读取 SSH 公钥", error))?
    }

    #[tauri::command]
    pub async fn delete_ssh_key(file_name: String, also_public: bool) -> Result<Vec<String>, String> {
        tauri::async_runtime::spawn_blocking(move || super::delete_ssh_key(&file_name, also_public))
            .await
            .map_err(|error| command_error("删除 SSH 密钥", error))?
    }

    #[tauri::command]
    pub async fn set_credential_helper(
        scope: String,
        repository_path: Option<String>,
        helper: String,
    ) -> Result<CredentialHelperReport, String> {
        tauri::async_runtime::spawn_blocking(move || {
            super::set_credential_helper(&scope, repository_path.as_deref(), &helper)
        })
        .await
        .map_err(|error| command_error("设置凭据助手", error))?
    }

    #[tauri::command]
    pub async fn get_credential_helpers(repository_path: Option<String>) -> Result<Vec<String>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            Ok(super::get_credential_helpers(repository_path.as_deref()))
        })
        .await
        .map_err(|error| command_error("读取凭据助手", error))?
    }
}

// =============================================================================================
// 测试
// =============================================================================================

#[cfg(test)]
fn isolate_credentials_home() {
    use std::sync::OnceLock;
    static HOME: OnceLock<PathBuf> = OnceLock::new();
    let home = HOME.get_or_init(|| {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "branchline-credentials-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("create isolated credentials home");
        directory
    });
    // 每个用例进来都重设一次：中途若有别的模块改动环境变量，也能拉回隔离目录。
    std::env::set_var("BRANCHLINE_HOME", home);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 凭据 / SSH 用例共享同一个 BRANCHLINE_HOME 与隔离 global gitconfig，必须串行；
    /// 锁与其他会改写 BRANCHLINE_HOME 的模块（如 AI 设置）共用。
    fn test_guard() -> std::sync::MutexGuard<'static, ()> {
        crate::git::test_environment_lock()
    }

    fn isolated() -> std::sync::MutexGuard<'static, ()> {
        let guard = test_guard();
        crate::git::isolate_test_git_environment();
        isolate_credentials_home();
        guard
    }

    fn home() -> PathBuf {
        home_root().expect("isolated home")
    }

    fn ssh_path(name: &str) -> PathBuf {
        home().join(".ssh").join(name)
    }

    fn scratch_repository(label: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "branchline-credentials-repo-{label}-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("create scratch repository");
        crate::git::git_output(&directory, &["init", "--quiet"]).expect("git init");
        directory
    }

    #[test]
    fn validates_generated_key_file_names() {
        let _guard = isolated();
        for valid in ["id_ed25519", "work-key.v2", "A1", "my_key_2026"] {
            assert!(validate_generated_file_name(valid).is_ok(), "{valid} 应合法");
        }
        for invalid in ["", "-key", "a/b", "..", ".", "ключ", "has space", "a".repeat(65).as_str()] {
            assert!(validate_generated_file_name(invalid).is_err(), "{invalid:?} 应被拒绝");
        }
    }

    #[test]
    fn ed25519_key_generation_lists_fingerprint_and_reads_public_key() {
        let _guard = isolated();
        let name = "id_test_ed25519";
        let info = generate_ssh_key(name, "ed25519", None, Some("branchline test"), false)
            .expect("generate ed25519 key");
        assert_eq!(info.file_name, name);
        assert_eq!(info.key_type, "ED25519");
        assert_eq!(info.bits, Some(256));
        assert_eq!(info.comment, "branchline test");
        assert!(info.has_private);
        assert!(info.has_public);
        assert!(info.path.ends_with(name), "path 应指向私钥：{}", info.path);
        let fingerprint = info.fingerprint.as_deref().expect("fingerprint");
        assert!(fingerprint.starts_with("SHA256:"), "{fingerprint}");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(ssh_path(name)).expect("private key").permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "私钥权限必须是 600");
        }

        let public = read_ssh_public_key(name).expect("read public key");
        assert!(public.starts_with("ssh-ed25519 "), "{public}");
        assert!(public.contains("branchline test"));

        let listed = list_ssh_keys();
        let row = listed.iter().find(|key| key.file_name == name).expect("key listed");
        assert_eq!(row.fingerprint, info.fingerprint);
        assert!(row.has_private && row.has_public);

        // 不带 .pub 后缀的公钥文件也应按内容识别并可读取。
        fs::copy(ssh_path(&format!("{name}.pub")), ssh_path("plain_public")).expect("copy public key");
        let plain = read_ssh_public_key("plain_public").expect("read extensionless public key");
        assert_eq!(plain.trim(), public.trim());
        assert!(list_ssh_keys()
            .iter()
            .any(|key| key.file_name == "plain_public" && key.has_public && !key.has_private));

        // 已存在且未开启覆盖：必须拒绝。
        assert!(generate_ssh_key(name, "ed25519", None, None, false).is_err());
        let replaced = generate_ssh_key(name, "ed25519", None, None, true).expect("overwrite key");
        assert_ne!(replaced.fingerprint, info.fingerprint, "覆盖后应是全新的密钥");
    }

    #[test]
    fn rsa_key_generation_enforces_allowed_bits() {
        let _guard = isolated();
        assert!(generate_ssh_key("id_bad_rsa", "rsa", Some(1024), None, false).is_err());
        assert!(generate_ssh_key("id_bad_type", "dsa", None, None, false).is_err());
        let info = generate_ssh_key("id_test_rsa", "rsa", Some(2048), Some("rsa 2048"), false)
            .expect("generate rsa key");
        assert_eq!(info.key_type, "RSA");
        assert_eq!(info.bits, Some(2048));
    }

    #[test]
    fn delete_refuses_directories_symlinks_and_traversal() {
        let _guard = isolated();
        let _ = generate_ssh_key("id_to_delete", "ed25519", None, None, false).expect("generate");
        assert!(delete_ssh_key("../id_to_delete", true).is_err());
        assert!(delete_ssh_key("id_to_delete/sub", true).is_err());

        let directory = homes_ssh_dir();
        fs::create_dir_all(directory.join("not-a-key")).expect("create directory fixture");
        let error = delete_ssh_key("not-a-key", true).expect_err("目录必须拒绝");
        assert!(error.contains("目录"), "{error}");

        #[cfg(unix)]
        {
            let outside = home().join("outside.txt");
            fs::write(&outside, "outside").expect("write outside file");
            std::os::unix::fs::symlink(&outside, directory.join("linked-key")).expect("create symlink");
            let error = delete_ssh_key("linked-key", false).expect_err("符号链接必须拒绝");
            assert!(error.contains("符号链接"), "{error}");
            assert!(outside.exists(), "链接目标不能被删除");
            fs::remove_file(directory.join("linked-key")).ok();
        }

        let removed = delete_ssh_key("id_to_delete", true).expect("delete pair");
        assert_eq!(removed, vec!["id_to_delete".to_string(), "id_to_delete.pub".to_string()]);
        assert!(!ssh_path("id_to_delete").exists());
        assert!(!ssh_path("id_to_delete.pub").exists());
    }

    fn homes_ssh_dir() -> PathBuf {
        let directory = home().join(".ssh");
        fs::create_dir_all(&directory).expect("create ssh directory");
        directory
    }

    #[cfg(unix)]
    #[test]
    fn custom_git_dir_requires_executable_git_and_round_trips_config() {
        use std::os::unix::fs::PermissionsExt;
        let _guard = isolated();
        let fake = home().join("fake-git");
        fs::create_dir_all(&fake).expect("create fake git dir");
        fs::write(fake.join("git"), "#!/bin/sh\necho 'git version 9.9.9'\n").expect("write fake git");
        fs::set_permissions(fake.join("git"), fs::Permissions::from_mode(0o755)).expect("chmod fake git");

        let missing = home().join("missing-git");
        fs::create_dir_all(&missing).expect("create empty dir");
        assert!(set_custom_git_dir(Some(missing.to_string_lossy().as_ref())).is_err());
        assert!(set_custom_git_dir(Some("/definitely/not/here")).is_err());

        let saved = set_custom_git_dir(Some(fake.to_string_lossy().as_ref()))
            .expect("save custom git dir")
            .expect("stored path");
        assert_eq!(PathBuf::from(&saved), fs::canonicalize(&fake).expect("canonical fake"));
        let info = git_runtime_info();
        assert_eq!(info.custom_git_dir.as_deref(), Some(saved.as_str()));
        assert_eq!(info.git_version.as_deref(), Some("git version 9.9.9"));
        assert!(!info.bundled_git_present);

        let cleared = set_custom_git_dir(None).expect("clear custom git dir");
        assert!(cleared.is_none());
        assert!(git_runtime_info().custom_git_dir.is_none());
    }

    #[test]
    fn configure_path_prepend_is_idempotent() {
        let _guard = isolated();
        let dir = PathBuf::from("/opt/branchline-git/bin");
        let current = OsString::from("/usr/bin:/bin");
        let once = prepend_path(&current, &dir);
        let twice = prepend_path(&once, &dir);
        assert_eq!(once, twice);
        let entries: Vec<PathBuf> = std::env::split_paths(&once).collect();
        assert_eq!(entries.first(), Some(&dir));
        assert_eq!(entries.iter().filter(|entry| **entry == dir).count(), 1);
        // 未配置自定义目录、也没有内置 Git 时，不应误改 PATH。
        let before = std::env::var_os("PATH");
        assert_eq!(configure_process_path(), None);
        assert_eq!(std::env::var_os("PATH"), before);
    }

    #[test]
    fn credential_helper_allowlist_rejects_shell_payloads() {
        let _guard = isolated();
        for allowed in ["", "osxkeychain", "manager", "manager-core", "libsecret", "wincred", "store", "cache"] {
            assert_eq!(validate_credential_helper(allowed).expect("allowed helper"), allowed);
        }
        assert_eq!(
            validate_credential_helper("  cache   --timeout=3600 ").expect("cache with timeout"),
            "cache --timeout=3600"
        );
        for rejected in [
            "!sh",
            "store; rm -rf /",
            "cache --timeout=123456",
            "cache --timeout=abc",
            "cache --timeout=",
            "osxkeychain --foo",
            "manager\nextra",
            " helper",
            "unknown",
        ] {
            assert!(validate_credential_helper(rejected).is_err(), "{rejected:?} 应被拒绝");
        }
    }

    #[test]
    fn sets_reads_and_resets_credential_helpers_without_touching_real_config() {
        let _guard = isolated();
        let repository = scratch_repository("credential-helper");
        let repository_path = repository.to_string_lossy().to_string();

        let report = set_credential_helper("local", Some(&repository_path), "store").expect("set local store");
        assert_eq!(report.configured_helpers, vec!["store".to_string()]);
        assert!(report.notice.as_deref().unwrap_or("").contains("明文"), "{:?}", report.notice);
        assert_eq!(get_credential_helpers(Some(&repository_path)), vec!["store".to_string()]);
        assert!(get_credential_helpers(None).is_empty(), "local 配置不应出现在 global");

        assert!(set_credential_helper("local", None, "cache").is_err());
        assert!(set_credential_helper("weird", Some(&repository_path), "cache").is_err());
        assert!(set_credential_helper("local", Some(&repository_path), "store; rm").is_err());
        assert_eq!(get_credential_helpers(Some(&repository_path)), vec!["store".to_string()]);

        let global = set_credential_helper("global", None, "cache --timeout=300").expect("set global cache");
        assert_eq!(global.configured_helpers, vec!["cache --timeout=300".to_string()]);
        assert!(global.notice.as_deref().unwrap_or("").contains("内存"), "{:?}", global.notice);
        assert_eq!(get_credential_helpers(None), vec!["cache --timeout=300".to_string()]);

        let reset = set_credential_helper("global", None, "").expect("reset global");
        assert!(reset.configured_helpers.is_empty());
        assert!(get_credential_helpers(None).is_empty());
        let reset_local = set_credential_helper("local", Some(&repository_path), "").expect("reset local");
        assert!(reset_local.configured_helpers.is_empty());

        let _ = fs::remove_dir_all(&repository);
    }

    #[test]
    fn runtime_info_degrades_without_panicking() {
        let _guard = isolated();
        let info = git_runtime_info();
        assert!(info.git_version.as_deref().unwrap_or("").starts_with("git version"));
        assert!(info.git_path.is_some());
        assert!(info.custom_git_dir.is_none());
        // SSH / LFS / agent 是否存在取决于机器，只验证调用不 panic 且列表有界。
        assert!(info.ssh_agent_keys.len() <= 200);
        assert!(info.credential_helpers.len() < 1000);
    }
}
