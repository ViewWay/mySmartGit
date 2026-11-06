//! W4-1 GitHub / GitLab 授权、PR/MR 与 CI 状态。
//!
//! 能力线：
//! 1. 设置存储：`<BRANCHLINE_HOME 或用户配置目录>/hosting.json`，Unix 下文件权限 600。
//!    访问令牌只保存在后端文件里，`HostingSettings` 只回传 `tokenConfigured`，永不回传明文。
//! 2. 仓库识别：读取 `git remote get-url origin`（参数数组，无 shell），解析
//!    https / http / scp-like SSH / ssh:// 四类远端，推断 GitHub 或 GitLab 以及项目路径。
//! 3. 托管平台请求：系统 curl + `--config -`（stdin 配置），令牌不出现在 argv；
//!    仅允许 https；错误文本统一脱敏，响应体上限 1MB。
//! 4. 列表 / 创建 / 详情：列表不做 N+1 检查请求（CI 状态为 unknown），详情才读取
//!    GitHub check-runs 或 GitLab pipelines 并汇总为 success / failure / pending / unknown。
//!
//! 安全红线：
//! - Git / curl 全部以参数数组启动，绝不使用 `sh -c` 或字符串拼接；
//! - 远端 URL、主机名、项目路径、分支名、令牌逐项校验，拒绝控制字符 / CRLF 注入；
//! - curl 的 url / header / body 全部走 stdin 配置，argv 只有 `--config -`；
//! - 任何返回前端的错误都经过 `redact_hosting_error`，令牌原值不会泄露。
//!
//! 集成约定：本模块的 `#[tauri::command]` 包装函数位于文件末尾；本轮不修改
//! `lib.rs` / `commands.rs`，由集成轨道统一注册。

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const PROVIDER_GITHUB: &str = "github";
const PROVIDER_GITLAB: &str = "gitlab";
const GITHUB_DEFAULT_HOST: &str = "github.com";
const GITLAB_DEFAULT_HOST: &str = "gitlab.com";
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_TOKEN_LEN: usize = 4096;
const MAX_TITLE_CHARS: usize = 256;
const MAX_BODY_CHARS: usize = 64 * 1024;
const MAX_BRANCH_CHARS: usize = 255;
const MAX_REMOTE_LEN: usize = 2048;
const CURL_MAX_TIME_SECONDS: u32 = 30;
/// curl 只通过 stdin 接收配置：令牌不会进入 argv。
const CURL_ARGUMENTS: [&str; 2] = ["--config", "-"];

// ---------------------------------------------------------------------------
// 前端契约
// ---------------------------------------------------------------------------

/// 托管设置：令牌只以布尔标记是否已配置。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostingSettings {
    /// "github" | "gitlab"
    pub provider: String,
    /// 自定义主机名；None 表示使用提供商默认主机。
    pub host: Option<String>,
    pub token_configured: bool,
}

/// 从 origin 远端识别出的托管仓库。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostingRepository {
    pub provider: String,
    pub host: String,
    /// owner/repo（GitHub）或 group/sub/repo（GitLab）。
    pub project_path: String,
    pub web_url: String,
}

/// 列表与详情共用的 PR/MR 摘要。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostingPullRequest {
    pub number: u64,
    pub title: String,
    pub author: String,
    pub state: String,
    pub draft: bool,
    pub source_branch: String,
    pub target_branch: String,
    pub web_url: String,
    pub updated_at: String,
    /// "success" | "failure" | "pending" | "unknown"
    pub ci_status: String,
}

/// 单条 CI 检查（GitHub check-run 或 GitLab 最近一条 pipeline）。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostingCheck {
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub web_url: Option<String>,
}

/// PR/MR 详情：正文、检查列表与可合并提示。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostingPullRequestDetail {
    pub number: u64,
    pub title: String,
    pub author: String,
    pub state: String,
    pub draft: bool,
    pub source_branch: String,
    pub target_branch: String,
    pub web_url: String,
    pub updated_at: String,
    pub ci_status: String,
    pub body: Option<String>,
    pub checks: Vec<HostingCheck>,
    pub mergeable: Option<bool>,
}

/// 新建 PR/MR 的输入。
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreatePullRequestInput {
    pub title: String,
    pub body: String,
    pub source_branch: String,
    pub target_branch: String,
    pub draft: bool,
}

// ---------------------------------------------------------------------------
// 磁盘格式、路径与读写
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct HostingSettingsFile {
    provider: String,
    host: Option<String>,
    /// 仅存在于后端文件；`load_settings` 永不回传。
    token: Option<String>,
}

impl Default for HostingSettingsFile {
    fn default() -> Self {
        Self {
            provider: PROVIDER_GITHUB.to_string(),
            host: None,
            token: None,
        }
    }
}

impl HostingSettingsFile {
    fn public_settings(&self) -> HostingSettings {
        HostingSettings {
            provider: normalize_provider(&self.provider),
            host: normalized_existing_host(self.host.as_deref()),
            token_configured: self
                .token
                .as_deref()
                .map(|token| !token.trim().is_empty())
                .unwrap_or(false),
        }
    }
}

/// 配置根目录：BRANCHLINE_HOME 优先（测试注入一次性目录），否则用户配置目录。
fn settings_directory() -> Result<PathBuf, String> {
    if let Some(root) = std::env::var_os("BRANCHLINE_HOME") {
        if !root.is_empty() {
            return Ok(PathBuf::from(root));
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(app_data) = std::env::var_os("APPDATA") {
            if !app_data.is_empty() {
                return Ok(PathBuf::from(app_data).join("branchline"));
            }
        }
        Err("无法定位 %APPDATA%，请设置 BRANCHLINE_HOME 指定配置目录".into())
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(home) = std::env::var_os("HOME") {
            if !home.is_empty() {
                return Ok(PathBuf::from(home).join(".config").join("branchline"));
            }
        }
        Err("无法定位 $HOME，请设置 BRANCHLINE_HOME 指定配置目录".into())
    }
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(settings_directory()?.join("hosting.json"))
}

fn read_settings_file_at(path: &Path) -> Result<HostingSettingsFile, String> {
    if !path.exists() {
        return Ok(HostingSettingsFile::default());
    }
    let raw = fs::read_to_string(path).map_err(|error| format!("读取托管设置失败：{error}"))?;
    if raw.trim().is_empty() {
        return Ok(HostingSettingsFile::default());
    }
    serde_json::from_str(&raw).map_err(|_| "托管设置文件格式无效，请重新保存设置".to_string())
}

fn read_settings_file() -> Result<HostingSettingsFile, String> {
    read_settings_file_at(&settings_path()?)
}

fn write_settings_file_at(path: &Path, file: &HostingSettingsFile) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or_else(|| "托管设置路径无效".to_string())?;
    fs::create_dir_all(directory).map_err(|error| format!("创建托管设置目录失败：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(directory, fs::Permissions::from_mode(0o700));
    }
    let bytes =
        serde_json::to_vec_pretty(file).map_err(|error| format!("序列化托管设置失败：{error}"))?;
    let temp_name = format!(
        ".hosting.json.tmp-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0)
    );
    let temp_path = directory.join(temp_name);
    let result = (|| -> Result<(), String> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut handle = options
            .open(&temp_path)
            .map_err(|error| format!("创建托管设置临时文件失败：{error}"))?;
        handle
            .write_all(&bytes)
            .map_err(|error| format!("写入托管设置失败：{error}"))?;
        handle
            .sync_all()
            .map_err(|error| format!("保存托管设置失败：{error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("设置托管设置文件权限失败：{error}"))?;
        }
        #[cfg(target_os = "windows")]
        {
            let _ = fs::remove_file(path);
        }
        fs::rename(&temp_path, path).map_err(|error| format!("保存托管设置失败：{error}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn write_settings_file(file: &HostingSettingsFile) -> Result<(), String> {
    write_settings_file_at(&settings_path()?, file)
}

fn load_settings_at(path: &Path) -> Result<HostingSettings, String> {
    Ok(read_settings_file_at(path)?.public_settings())
}

fn load_settings() -> Result<HostingSettings, String> {
    load_settings_at(&settings_path()?)
}

fn normalize_provider(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "gitlab" => PROVIDER_GITLAB.to_string(),
        _ => PROVIDER_GITHUB.to_string(),
    }
}

fn validate_provider(raw: &str) -> Result<String, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "github" => Ok(PROVIDER_GITHUB.to_string()),
        "gitlab" => Ok(PROVIDER_GITLAB.to_string()),
        _ => Err("托管平台只支持 github 或 gitlab".into()),
    }
}

fn provider_label(provider: &str) -> &'static str {
    if provider == PROVIDER_GITLAB {
        "GitLab"
    } else {
        "GitHub"
    }
}

fn default_host(provider: &str) -> &'static str {
    if provider == PROVIDER_GITLAB {
        GITLAB_DEFAULT_HOST
    } else {
        GITHUB_DEFAULT_HOST
    }
}

/// 校验并规范化裸主机名，允许可选的 `:端口`；拒绝 scheme、路径、凭据与空白。
fn normalize_host(raw: &str) -> Result<String, String> {
    let value = raw.trim().trim_end_matches('.').to_ascii_lowercase();
    if value.is_empty() {
        return Err("主机名不能为空".into());
    }
    if value.len() > 253 + 6 {
        return Err("主机名过长".into());
    }
    if value
        .chars()
        .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err("主机名不能包含空白或控制字符".into());
    }
    for rejected in ["://", "/", "\\", "@", "?", "#"] {
        if value.contains(rejected) {
            return Err("主机名必须是裸主机名，不能包含协议、路径或凭据".into());
        }
    }
    let (hostname, port) = match value.rsplit_once(':') {
        Some((hostname, port)) => (hostname, Some(port)),
        None => (value.as_str(), None),
    };
    if hostname.is_empty() {
        return Err("主机名不能为空".into());
    }
    for label in hostname.split('.') {
        if label.is_empty() || label.len() > 63 {
            return Err("主机名格式无效".into());
        }
        if label.starts_with('-') || label.ends_with('-') {
            return Err("主机名格式无效".into());
        }
        if !label
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
        {
            return Err("主机名格式无效".into());
        }
    }
    if let Some(port) = port {
        if port.is_empty() || !port.chars().all(|character| character.is_ascii_digit()) {
            return Err("主机端口格式无效".into());
        }
        match port.parse::<u16>() {
            Ok(0) | Err(_) => return Err("主机端口格式无效".into()),
            Ok(_) => {}
        }
    }
    Ok(value)
}

fn normalized_existing_host(host: Option<&str>) -> Option<String> {
    host.map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| normalize_host(value).ok())
}

fn validate_token(raw: &str) -> Result<(), String> {
    if raw.len() > MAX_TOKEN_LEN {
        return Err("访问令牌过长".into());
    }
    if raw
        .chars()
        .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err("访问令牌不能包含空白或控制字符".into());
    }
    Ok(())
}

fn save_settings_at(
    path: &Path,
    provider: &str,
    host: Option<String>,
    token: Option<String>,
) -> Result<HostingSettings, String> {
    let provider = validate_provider(provider)?;
    let host = match host {
        Some(value) if !value.trim().is_empty() => Some(normalize_host(&value)?),
        _ => None,
    };
    let mut file = read_settings_file_at(path)?;
    file.provider = provider;
    file.host = host;
    // None / 空字符串都表示保留原令牌；非空才替换。
    if let Some(value) = token {
        let value = value.trim().to_string();
        if !value.is_empty() {
            validate_token(&value)?;
            file.token = Some(value);
        }
    }
    write_settings_file_at(path, &file)?;
    Ok(file.public_settings())
}

fn save_settings(
    provider: &str,
    host: Option<String>,
    token: Option<String>,
) -> Result<HostingSettings, String> {
    save_settings_at(&settings_path()?, provider, host, token)
}

fn clear_token_at(path: &Path) -> Result<HostingSettings, String> {
    let mut file = read_settings_file_at(path)?;
    file.token = None;
    write_settings_file_at(path, &file)?;
    Ok(file.public_settings())
}

fn clear_token() -> Result<HostingSettings, String> {
    clear_token_at(&settings_path()?)
}

fn load_secret_token_at(path: &Path) -> Result<Option<String>, String> {
    let file = read_settings_file_at(path)?;
    Ok(file
        .token
        .filter(|token| !token.trim().is_empty())
        .map(|token| token.trim().to_string()))
}

fn load_secret_token() -> Result<Option<String>, String> {
    load_secret_token_at(&settings_path()?)
}

// ---------------------------------------------------------------------------
// 远端 URL 解析
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
struct ParsedRemote {
    host: String,
    project_path: String,
}

fn contains_control(value: &str) -> bool {
    value.chars().any(|character| character.is_control())
}

fn validate_project_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("远端地址缺少项目路径".into());
    }
    if path.len() > 1024 {
        return Err("项目路径过长".into());
    }
    let segments: Vec<&str> = path.split('/').collect();
    if segments.len() < 2 {
        return Err("远端地址缺少 owner/repo 或 group/repo 项目路径".into());
    }
    for segment in segments {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err("项目路径包含非法片段".into());
        }
        if segment.len() > 100 {
            return Err("项目路径片段过长".into());
        }
        if !segment.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        }) {
            return Err("项目路径包含可疑字符".into());
        }
    }
    Ok(())
}

fn normalize_remote_path(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim_end_matches('/');
    let path = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    validate_project_path(path)?;
    Ok(path.to_string())
}

fn normalize_remote_host(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.is_empty() {
        return Err("远端地址缺少主机名".into());
    }
    if value.contains('@') || value.contains('/') || value.contains('\\') {
        return Err("远端主机名格式无效".into());
    }
    normalize_host(value).map_err(|_| "远端主机名格式无效".to_string())
}

/// 解析 https://、http://、ssh:// 与 scp-like 远端地址。
fn parse_remote_url(raw: &str) -> Result<ParsedRemote, String> {
    let value = raw.trim();
    if value.is_empty() {
        return Err("origin 远端地址为空".into());
    }
    if value.len() > MAX_REMOTE_LEN {
        return Err("origin 远端地址过长".into());
    }
    if contains_control(value) {
        return Err("origin 远端地址包含控制字符".into());
    }

    let (authority, path, allow_user) = if let Some(rest) = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
    {
        let (authority, path) = rest
            .split_once('/')
            .ok_or_else(|| "远端地址缺少项目路径".to_string())?;
        (authority, path, false)
    } else if let Some(rest) = value.strip_prefix("ssh://") {
        let (authority, path) = rest
            .split_once('/')
            .ok_or_else(|| "远端地址缺少项目路径".to_string())?;
        (authority, path, true)
    } else if value.contains("://") {
        return Err("远端协议不受支持，请使用 https、ssh 或 scp-like 地址".into());
    } else {
        // scp-like：git@host:group/sub/repo.git
        let (authority, path) = value
            .split_once(':')
            .ok_or_else(|| "无法识别的远端地址格式".to_string())?;
        (authority, path, true)
    };

    if !allow_user && authority.contains('@') {
        return Err("远端地址不能内嵌用户名或凭据".into());
    }
    let host_part = authority.rsplit('@').next().unwrap_or("");
    if authority.contains('@') && host_part.is_empty() {
        return Err("远端地址缺少主机名".into());
    }
    let host = normalize_remote_host(host_part)?;
    let project_path = normalize_remote_path(path)?;
    Ok(ParsedRemote { host, project_path })
}

fn infer_provider(host: &str, configured_provider: &str) -> String {
    let host = host.to_ascii_lowercase();
    if host == GITHUB_DEFAULT_HOST {
        PROVIDER_GITHUB.to_string()
    } else if host.contains("gitlab") {
        PROVIDER_GITLAB.to_string()
    } else {
        normalize_provider(configured_provider)
    }
}

fn validate_project_for_provider(provider: &str, project_path: &str) -> Result<(), String> {
    let segments = project_path.split('/').count();
    if provider == PROVIDER_GITHUB && segments != 2 {
        return Err("GitHub 项目路径必须是 owner/repo 两段".into());
    }
    if provider == PROVIDER_GITLAB && segments < 2 {
        return Err("GitLab 项目路径至少需要 group/repo 两段".into());
    }
    Ok(())
}

fn detect_repository(
    settings: &HostingSettings,
    repository_path: &str,
) -> Result<HostingRepository, String> {
    if repository_path.trim().is_empty() {
        return Err("请先打开本地仓库".into());
    }
    let root = crate::git::repository_root(repository_path)
        .map_err(|error| format!("定位仓库根目录失败：{error}"))?;
    let remote = crate::git::git_output(&root, &["remote", "get-url", "origin"])
        .map_err(|error| format!("读取 origin 远端失败：{error}"))?;
    let parsed = parse_remote_url(remote.trim())?;
    let provider = infer_provider(&parsed.host, &settings.provider);
    validate_project_for_provider(&provider, &parsed.project_path)?;
    Ok(HostingRepository {
        provider,
        web_url: format!("https://{}/{}", parsed.host, parsed.project_path),
        host: parsed.host,
        project_path: parsed.project_path,
    })
}

// ---------------------------------------------------------------------------
// 纯映射：GitHub / GitLab JSON → 前端契约
// ---------------------------------------------------------------------------

fn string_at<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> {
    value.pointer(pointer).and_then(Value::as_str)
}

fn required_string(value: &Value, pointer: &str, label: &str) -> Result<String, String> {
    string_at(value, pointer)
        .filter(|text| !text.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("托管平台响应缺少{label}"))
}

fn map_github_pull_request(item: &Value) -> Result<HostingPullRequest, String> {
    let number = item
        .get("number")
        .and_then(Value::as_u64)
        .ok_or_else(|| "GitHub 响应缺少 PR 编号".to_string())?;
    let title = required_string(item, "/title", "PR 标题")?;
    let source_branch = required_string(item, "/head/ref", "源分支")?;
    let target_branch = required_string(item, "/base/ref", "目标分支")?;
    let web_url = required_string(item, "/html_url", "PR 链接")?;
    Ok(HostingPullRequest {
        number,
        title,
        author: string_at(item, "/user/login")
            .unwrap_or("未知作者")
            .to_string(),
        state: string_at(item, "/state").unwrap_or("open").to_string(),
        draft: item.get("draft").and_then(Value::as_bool).unwrap_or(false),
        source_branch,
        target_branch,
        web_url,
        updated_at: string_at(item, "/updated_at").unwrap_or("").to_string(),
        ci_status: "unknown".to_string(),
    })
}

fn github_pr_list_from_json(value: &Value) -> Result<Vec<HostingPullRequest>, String> {
    let items = value
        .as_array()
        .ok_or_else(|| "GitHub 返回的 PR 列表格式无效".to_string())?;
    items
        .iter()
        .map(map_github_pull_request)
        .collect::<Result<Vec<_>, _>>()
}

fn github_checks_from_json(value: &Value) -> Vec<HostingCheck> {
    value
        .get("check_runs")
        .and_then(Value::as_array)
        .map(|runs| {
            runs.iter()
                .map(|run| HostingCheck {
                    name: string_at(run, "/name").unwrap_or("检查").to_string(),
                    status: string_at(run, "/status").unwrap_or("unknown").to_string(),
                    conclusion: string_at(run, "/conclusion").map(str::to_string),
                    web_url: string_at(run, "/html_url").map(str::to_string),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn github_ci_status(checks: &[HostingCheck]) -> String {
    if checks.is_empty() {
        return "unknown".to_string();
    }
    let failed = checks.iter().any(|check| {
        matches!(
            check.conclusion.as_deref(),
            Some("failure" | "cancelled" | "timed_out" | "action_required" | "startup_failure")
        )
    });
    if failed {
        return "failure".to_string();
    }
    let pending = checks.iter().any(|check| {
        matches!(
            check.status.as_str(),
            "queued" | "in_progress" | "waiting" | "requested" | "pending"
        )
    });
    if pending {
        return "pending".to_string();
    }
    if checks
        .iter()
        .any(|check| check.conclusion.as_deref() == Some("success"))
    {
        return "success".to_string();
    }
    "unknown".to_string()
}

fn github_detail_from_json(
    item: &Value,
    checks_value: Option<&Value>,
) -> Result<HostingPullRequestDetail, String> {
    let pr = map_github_pull_request(item)?;
    let checks = checks_value
        .map(github_checks_from_json)
        .unwrap_or_default();
    Ok(HostingPullRequestDetail {
        number: pr.number,
        title: pr.title,
        author: pr.author,
        state: pr.state,
        draft: pr.draft,
        source_branch: pr.source_branch,
        target_branch: pr.target_branch,
        web_url: pr.web_url,
        updated_at: pr.updated_at,
        ci_status: github_ci_status(&checks),
        body: string_at(item, "/body")
            .filter(|body| !body.trim().is_empty())
            .map(str::to_string),
        checks,
        mergeable: item.get("mergeable").and_then(Value::as_bool),
    })
}

fn map_gitlab_merge_request(item: &Value) -> Result<HostingPullRequest, String> {
    let number = item
        .get("iid")
        .and_then(Value::as_u64)
        .ok_or_else(|| "GitLab 响应缺少 MR 编号".to_string())?;
    let title = required_string(item, "/title", "MR 标题")?;
    let source_branch = required_string(item, "/source_branch", "源分支")?;
    let target_branch = required_string(item, "/target_branch", "目标分支")?;
    let web_url = required_string(item, "/web_url", "MR 链接")?;
    let draft = item.get("draft").and_then(Value::as_bool).unwrap_or(false)
        || item
            .get("work_in_progress")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    Ok(HostingPullRequest {
        number,
        title,
        author: string_at(item, "/author/name")
            .unwrap_or("未知作者")
            .to_string(),
        state: string_at(item, "/state").unwrap_or("opened").to_string(),
        draft,
        source_branch,
        target_branch,
        web_url,
        updated_at: string_at(item, "/updated_at").unwrap_or("").to_string(),
        ci_status: "unknown".to_string(),
    })
}

fn gitlab_mr_list_from_json(value: &Value) -> Result<Vec<HostingPullRequest>, String> {
    let items = value
        .as_array()
        .ok_or_else(|| "GitLab 返回的 MR 列表格式无效".to_string())?;
    items
        .iter()
        .map(map_gitlab_merge_request)
        .collect::<Result<Vec<_>, _>>()
}

fn first_pipeline(value: &Value) -> Option<&Value> {
    value
        .as_array()
        .and_then(|items| items.first())
        .or_else(|| value.is_object().then_some(value))
}

fn pipeline_ci_status(status: &str) -> &'static str {
    match status {
        "success" => "success",
        "failed" | "canceled" | "cancelled" => "failure",
        "running"
        | "pending"
        | "created"
        | "preparing"
        | "waiting_for_resource"
        | "manual"
        | "scheduled" => "pending",
        _ => "unknown",
    }
}

fn gitlab_mergeable(item: &Value) -> Option<bool> {
    if item.get("has_conflicts").and_then(Value::as_bool) == Some(true) {
        return Some(false);
    }
    if let Some(detailed) = string_at(item, "/detailed_merge_status") {
        return match detailed {
            "mergeable" => Some(true),
            "conflict" | "not_mergeable" | "broken_status" | "need_rebase" => Some(false),
            _ => None,
        };
    }
    match string_at(item, "/merge_status") {
        Some("can_be_merged") => Some(true),
        Some("cannot_be_merged") => Some(false),
        _ => None,
    }
}

fn gitlab_detail_from_json(
    item: &Value,
    pipeline_value: Option<&Value>,
) -> Result<HostingPullRequestDetail, String> {
    let mr = map_gitlab_merge_request(item)?;
    let pipeline = pipeline_value.and_then(first_pipeline);
    let checks = match pipeline {
        Some(pipeline) => {
            let status = string_at(pipeline, "/status").unwrap_or("unknown");
            let name = pipeline
                .get("id")
                .and_then(Value::as_u64)
                .map(|id| format!("Pipeline #{id}"))
                .unwrap_or_else(|| "Pipeline".to_string());
            vec![HostingCheck {
                name,
                status: status.to_string(),
                conclusion: Some(status.to_string()),
                web_url: string_at(pipeline, "/web_url").map(str::to_string),
            }]
        }
        None => Vec::new(),
    };
    let ci_status = checks
        .first()
        .map(|check| pipeline_ci_status(&check.status).to_string())
        .unwrap_or_else(|| "unknown".to_string());
    Ok(HostingPullRequestDetail {
        number: mr.number,
        title: mr.title,
        author: mr.author,
        state: mr.state,
        draft: mr.draft,
        source_branch: mr.source_branch,
        target_branch: mr.target_branch,
        web_url: mr.web_url,
        updated_at: mr.updated_at,
        ci_status,
        body: string_at(item, "/description")
            .filter(|body| !body.trim().is_empty())
            .map(str::to_string),
        checks,
        mergeable: gitlab_mergeable(item),
    })
}

// ---------------------------------------------------------------------------
// 创建 PR/MR 的校验与请求体
// ---------------------------------------------------------------------------

fn validate_branch_name(value: &str, label: &str) -> Result<String, String> {
    let branch = value.trim();
    if branch.is_empty() {
        return Err(format!("{label}不能为空"));
    }
    if branch.chars().count() > MAX_BRANCH_CHARS {
        return Err(format!("{label}过长"));
    }
    if branch
        .chars()
        .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(format!("{label}不能包含空白或控制字符"));
    }
    if branch.starts_with('-') || branch.starts_with('/') || branch.ends_with('/') {
        return Err(format!("{label}格式无效"));
    }
    if branch.ends_with('.') || branch.ends_with(".lock") {
        return Err(format!("{label}格式无效"));
    }
    if branch.contains("..")
        || branch.contains("//")
        || branch
            .chars()
            .any(|character| matches!(character, '\\' | '~' | '^' | ':' | '?' | '*' | '['))
    {
        return Err(format!("{label}包含 Git 不允许的字符"));
    }
    Ok(branch.to_string())
}

struct ValidatedCreate {
    title: String,
    body: String,
    source_branch: String,
    target_branch: String,
}

fn validate_create_input(input: &CreatePullRequestInput) -> Result<ValidatedCreate, String> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err("PR/MR 标题不能为空".into());
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(format!("PR/MR 标题过长（上限 {MAX_TITLE_CHARS} 字符）"));
    }
    if contains_control(title) {
        return Err("PR/MR 标题不能包含换行或控制字符".into());
    }
    if input.body.chars().count() > MAX_BODY_CHARS {
        return Err("PR/MR 描述过长".into());
    }
    if input.body.contains('\0') {
        return Err("PR/MR 描述不能包含 NUL".into());
    }
    let source_branch = validate_branch_name(&input.source_branch, "源分支")?;
    let target_branch = validate_branch_name(&input.target_branch, "目标分支")?;
    if source_branch == target_branch {
        return Err("源分支与目标分支不能相同".into());
    }
    Ok(ValidatedCreate {
        title: title.to_string(),
        body: input.body.clone(),
        source_branch,
        target_branch,
    })
}

fn github_create_payload(input: &CreatePullRequestInput) -> Result<Value, String> {
    let valid = validate_create_input(input)?;
    Ok(serde_json::json!({
        "title": valid.title,
        "body": valid.body,
        "head": valid.source_branch,
        "base": valid.target_branch,
        "draft": input.draft,
    }))
}

fn gitlab_create_payload(input: &CreatePullRequestInput) -> Result<Value, String> {
    let valid = validate_create_input(input)?;
    let title =
        if input.draft && !valid.title.starts_with("Draft:") && !valid.title.starts_with("WIP:") {
            format!("Draft: {}", valid.title)
        } else {
            valid.title
        };
    Ok(serde_json::json!({
        "title": title,
        "description": valid.body,
        "source_branch": valid.source_branch,
        "target_branch": valid.target_branch,
    }))
}

// ---------------------------------------------------------------------------
// curl 与 HTTP
// ---------------------------------------------------------------------------

fn curl_quote(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}

fn validate_https_url(url: &str) -> Result<(), String> {
    let value = url.trim();
    if !value.starts_with("https://") {
        return Err("托管平台请求只允许 https".into());
    }
    if value.len() > 4096 {
        return Err("托管平台请求地址过长".into());
    }
    if value
        .chars()
        .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err("托管平台请求地址包含空白或控制字符".into());
    }
    Ok(())
}

fn build_curl_config(
    token: &str,
    provider: &str,
    method: &str,
    url: &str,
    payload: Option<&Value>,
) -> Result<String, String> {
    validate_https_url(url)?;
    validate_token(token)?;
    let accept = if provider == PROVIDER_GITHUB {
        "application/vnd.github+json"
    } else {
        "application/json"
    };
    let auth_header = if provider == PROVIDER_GITHUB {
        format!("Authorization: Bearer {token}")
    } else {
        format!("PRIVATE-TOKEN: {token}")
    };
    let mut config = String::new();
    config.push_str(&format!("url = \"{}\"\n", curl_quote(url)));
    config.push_str(&format!("request = \"{}\"\n", curl_quote(method)));
    config.push_str(&format!("header = \"{}\"\n", curl_quote(&auth_header)));
    config.push_str(&format!("header = \"Accept: {accept}\"\n"));
    config.push_str("header = \"Content-Type: application/json\"\n");
    config.push_str("header = \"User-Agent: Branchline\"\n");
    if let Some(payload) = payload {
        let body = serde_json::to_string(payload)
            .map_err(|error| format!("构造托管平台请求失败：{error}"))?;
        config.push_str(&format!("data = \"{}\"\n", curl_quote(&body)));
    }
    config.push_str("silent\n");
    config.push_str("show-error\n");
    config.push_str("write-out = \"\\n%{http_code}\"\n");
    config.push_str(&format!("max-time = {CURL_MAX_TIME_SECONDS}\n"));
    Ok(config)
}

/// 把 `prefix` 之后直到空白/引号/分隔符的值替换为 `[redacted]`（大小写不敏感）。
fn redact_after(text: &str, prefix: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let mut result = String::new();
    let mut cursor = 0usize;
    while let Some(offset) = lower[cursor..].find(prefix) {
        let start = cursor + offset;
        let mut value_start = start + prefix.len();
        // 跳过 header 名后的空白，避免把空格误判为「没有可脱敏的值」。
        while let Some(character) = text[value_start..].chars().next() {
            if character.is_whitespace() {
                value_start += character.len_utf8();
            } else {
                break;
            }
        }
        result.push_str(&text[cursor..value_start]);
        let mut end = value_start;
        for (index, character) in text[value_start..].char_indices() {
            if character.is_whitespace() || matches!(character, '"' | '\'' | ',' | '}' | ']' | ';')
            {
                break;
            }
            end = value_start + index + character.len_utf8();
        }
        if end == value_start {
            result.push_str(&text[value_start..]);
            return result;
        }
        result.push_str("[redacted]");
        cursor = end;
    }
    result.push_str(&text[cursor..]);
    result
}

fn redact_hosting_error(raw: &str, token: &str) -> String {
    let mut text = raw.to_string();
    let token = token.trim();
    if !token.is_empty() {
        text = text.replace(token, "[redacted]");
    }
    for prefix in [
        "bearer ",
        "private-token:",
        "private_token=",
        "authorization:",
    ] {
        text = redact_after(&text, prefix);
    }
    text
}

fn shorten_for_error(value: &str) -> String {
    let trimmed = value.trim();
    let mut shortened: String = trimmed.chars().take(400).collect();
    if trimmed.chars().count() > 400 {
        shortened.push('…');
    }
    shortened
}

fn parse_response_stdout(stdout: &[u8]) -> Result<(u16, String), String> {
    let text = String::from_utf8_lossy(stdout);
    let (body, status_line) = text
        .rsplit_once('\n')
        .ok_or_else(|| "托管平台未返回 HTTP 状态码".to_string())?;
    let status = status_line
        .trim()
        .parse::<u16>()
        .map_err(|_| "托管平台返回了无效的 HTTP 状态码".to_string())?;
    Ok((status, body.to_string()))
}

fn error_message_from_json(value: &Value) -> Option<String> {
    for pointer in ["/message", "/error", "/error_description"] {
        match value.pointer(pointer) {
            Some(Value::String(message)) if !message.trim().is_empty() => {
                return Some(message.clone())
            }
            Some(Value::Array(messages)) => {
                let joined = messages
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("；");
                if !joined.is_empty() {
                    return Some(joined);
                }
            }
            Some(Value::Object(fields)) => {
                let joined = fields
                    .values()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("；");
                if !joined.is_empty() {
                    return Some(joined);
                }
            }
            _ => {}
        }
    }
    None
}

fn run_curl(config: &str, token: &str) -> Result<(u16, String), String> {
    let mut command = Command::new("curl");
    command
        .args(CURL_ARGUMENTS)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 curl（托管平台请求依赖系统 curl）：{error}"))?;
    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "无法向 curl 写入请求配置".to_string())?;
        stdin
            .write_all(config.as_bytes())
            .map_err(|error| format!("无法向 curl 写入请求配置：{error}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("等待托管平台请求失败：{error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = if stderr.is_empty() {
            "无法连接托管平台".to_string()
        } else {
            shorten_for_error(&stderr)
        };
        return Err(redact_hosting_error(
            &format!(
                "托管平台请求失败（curl 退出码 {}）：{detail}",
                output.status.code().unwrap_or(-1)
            ),
            token,
        ));
    }
    if output.stdout.len() > MAX_RESPONSE_BYTES {
        return Err("托管平台响应超过 1MB 上限，已拒绝处理".into());
    }
    parse_response_stdout(&output.stdout)
}

fn request_json(
    method: &str,
    url: &str,
    token: &str,
    provider: &str,
    payload: Option<&Value>,
) -> Result<Value, String> {
    let config = build_curl_config(token, provider, method, url, payload)?;
    let (status, body) = run_curl(&config, token)?;
    if !(200..300).contains(&status) {
        let message = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|value| error_message_from_json(&value))
            .unwrap_or_else(|| "托管平台返回错误".to_string());
        return Err(redact_hosting_error(
            &format!(
                "托管平台错误（HTTP {status}）：{}",
                shorten_for_error(&message)
            ),
            token,
        ));
    }
    if body.trim().is_empty() {
        return Err("托管平台返回了空响应".into());
    }
    serde_json::from_str(&body).map_err(|_| "托管平台返回了无法解析的响应".to_string())
}

// ---------------------------------------------------------------------------
// GitHub / GitLab API 流程
// ---------------------------------------------------------------------------

fn api_base(provider: &str, host: &str) -> String {
    if provider == PROVIDER_GITHUB {
        if host.eq_ignore_ascii_case(GITHUB_DEFAULT_HOST) {
            "https://api.github.com".to_string()
        } else {
            format!("https://{host}/api/v3")
        }
    } else {
        format!("https://{host}/api/v4")
    }
}

fn github_project(project_path: &str) -> Result<(String, String), String> {
    let mut segments = project_path.split('/');
    let owner = segments.next().unwrap_or("");
    let repo = segments.next().unwrap_or("");
    if owner.is_empty() || repo.is_empty() || segments.next().is_some() {
        return Err("GitHub 项目路径必须是 owner/repo 两段".into());
    }
    Ok((owner.to_string(), repo.to_string()))
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn list_for(
    repository: &HostingRepository,
    token: &str,
) -> Result<Vec<HostingPullRequest>, String> {
    let base = api_base(&repository.provider, &repository.host);
    if repository.provider == PROVIDER_GITHUB {
        let (owner, repo) = github_project(&repository.project_path)?;
        let url = format!("{base}/repos/{owner}/{repo}/pulls?state=open&per_page=50");
        let value = request_json("GET", &url, token, &repository.provider, None)?;
        github_pr_list_from_json(&value)
    } else {
        let project_id = percent_encode(&repository.project_path);
        let url = format!("{base}/projects/{project_id}/merge_requests?state=opened&per_page=50");
        let value = request_json("GET", &url, token, &repository.provider, None)?;
        gitlab_mr_list_from_json(&value)
    }
}

fn create_for(
    repository: &HostingRepository,
    token: &str,
    input: &CreatePullRequestInput,
) -> Result<HostingPullRequest, String> {
    let base = api_base(&repository.provider, &repository.host);
    if repository.provider == PROVIDER_GITHUB {
        let (owner, repo) = github_project(&repository.project_path)?;
        let payload = github_create_payload(input)?;
        let url = format!("{base}/repos/{owner}/{repo}/pulls");
        let value = request_json("POST", &url, token, &repository.provider, Some(&payload))?;
        map_github_pull_request(&value)
    } else {
        let project_id = percent_encode(&repository.project_path);
        let payload = gitlab_create_payload(input)?;
        let url = format!("{base}/projects/{project_id}/merge_requests");
        let value = request_json("POST", &url, token, &repository.provider, Some(&payload))?;
        map_gitlab_merge_request(&value)
    }
}

fn detail_for(
    repository: &HostingRepository,
    token: &str,
    number: u64,
) -> Result<HostingPullRequestDetail, String> {
    let base = api_base(&repository.provider, &repository.host);
    if repository.provider == PROVIDER_GITHUB {
        let (owner, repo) = github_project(&repository.project_path)?;
        let url = format!("{base}/repos/{owner}/{repo}/pulls/{number}");
        let value = request_json("GET", &url, token, &repository.provider, None)?;
        let checks = string_at(&value, "/head/sha").and_then(|sha| {
            let url = format!(
                "{base}/repos/{owner}/{repo}/commits/{}/check-runs?per_page=100",
                percent_encode(sha)
            );
            request_json("GET", &url, token, &repository.provider, None).ok()
        });
        github_detail_from_json(&value, checks.as_ref())
    } else {
        let project_id = percent_encode(&repository.project_path);
        let url = format!("{base}/projects/{project_id}/merge_requests/{number}");
        let value = request_json("GET", &url, token, &repository.provider, None)?;
        let source_branch = string_at(&value, "/source_branch").unwrap_or("");
        let pipeline = if source_branch.is_empty() {
            None
        } else {
            let url = format!(
                "{base}/projects/{project_id}/pipelines?ref={}&per_page=1",
                percent_encode(source_branch)
            );
            request_json("GET", &url, token, &repository.provider, None).ok()
        };
        gitlab_detail_from_json(&value, pipeline.as_ref())
    }
}

struct HostingContext {
    repository: HostingRepository,
    token: String,
}

fn hosting_context(repository_path: &str) -> Result<HostingContext, String> {
    let settings = load_settings()?;
    let repository = detect_repository(&settings, repository_path)?;
    let token = load_secret_token()?.ok_or_else(|| {
        format!(
            "尚未配置 {} 访问令牌，请先在托管设置中保存",
            provider_label(&repository.provider)
        )
    })?;
    Ok(HostingContext { repository, token })
}

fn list_pull_requests(repository_path: &str) -> Result<Vec<HostingPullRequest>, String> {
    let context = hosting_context(repository_path)?;
    list_for(&context.repository, &context.token)
}

fn create_pull_request(
    repository_path: &str,
    input: &CreatePullRequestInput,
) -> Result<HostingPullRequest, String> {
    let context = hosting_context(repository_path)?;
    create_for(&context.repository, &context.token, input)
}

fn load_pull_request(
    repository_path: &str,
    number: u64,
) -> Result<HostingPullRequestDetail, String> {
    let context = hosting_context(repository_path)?;
    detail_for(&context.repository, &context.token, number)
}

// ---------------------------------------------------------------------------
// Tauri 命令包装（由集成轨道注册到 lib.rs）
// ---------------------------------------------------------------------------

fn task_error(action: &str, error: impl std::fmt::Display) -> String {
    format!("{action}失败：{error}")
}

#[tauri::command]
pub async fn load_hosting_settings() -> Result<HostingSettings, String> {
    tauri::async_runtime::spawn_blocking(load_settings)
        .await
        .map_err(|error| task_error("读取托管设置", error))?
}

#[tauri::command]
pub async fn save_hosting_settings(
    provider: String,
    host: Option<String>,
    token: Option<String>,
) -> Result<HostingSettings, String> {
    tauri::async_runtime::spawn_blocking(move || save_settings(&provider, host, token))
        .await
        .map_err(|error| task_error("保存托管设置", error))?
}

#[tauri::command]
pub async fn clear_hosting_token() -> Result<HostingSettings, String> {
    tauri::async_runtime::spawn_blocking(clear_token)
        .await
        .map_err(|error| task_error("清除托管令牌", error))?
}

#[tauri::command]
pub async fn detect_hosting_repository(
    repository_path: String,
) -> Result<HostingRepository, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = load_settings()?;
        detect_repository(&settings, &repository_path)
    })
    .await
    .map_err(|error| task_error("识别托管仓库", error))?
}

#[tauri::command]
pub async fn list_hosting_pull_requests(
    repository_path: String,
) -> Result<Vec<HostingPullRequest>, String> {
    tauri::async_runtime::spawn_blocking(move || list_pull_requests(&repository_path))
        .await
        .map_err(|error| task_error("读取 PR/MR 列表", error))?
}

#[tauri::command]
pub async fn create_hosting_pull_request(
    repository_path: String,
    input: CreatePullRequestInput,
) -> Result<HostingPullRequest, String> {
    tauri::async_runtime::spawn_blocking(move || create_pull_request(&repository_path, &input))
        .await
        .map_err(|error| task_error("创建 PR/MR", error))?
}

#[tauri::command]
pub async fn load_hosting_pull_request(
    repository_path: String,
    number: u64,
) -> Result<HostingPullRequestDetail, String> {
    tauri::async_runtime::spawn_blocking(move || load_pull_request(&repository_path, number))
        .await
        .map_err(|error| task_error("读取 PR/MR 详情", error))?
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn unique_test_directory(label: &str) -> PathBuf {
        static SEQUENCE: AtomicU64 = AtomicU64::new(1);
        loop {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0);
            let sequence = SEQUENCE.fetch_add(1, Ordering::SeqCst);
            let candidate = std::env::temp_dir().join(format!(
                "branchline-hosting-test-{label}-{}-{nanos}-{sequence}",
                std::process::id()
            ));
            match fs::create_dir(&candidate) {
                Ok(()) => return candidate,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("create test directory: {error}"),
            }
        }
    }

    /// 一次性目录；设置用例使用显式路径，绝不改写进程级 BRANCHLINE_HOME，
    /// 避免与其他模块的环境隔离用例并发冲突。
    struct TestDirectory(PathBuf);

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn test_directory(label: &str) -> TestDirectory {
        TestDirectory(unique_test_directory(label))
    }

    struct TestRepository {
        path: PathBuf,
    }

    impl Drop for TestRepository {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn git_ok(root: &Path, args: &[&str]) {
        let mut command = Command::new("git");
        command.arg("-C").arg(root).args(args);
        #[cfg(target_os = "windows")]
        command.creation_flags(0x08000000);
        let output = command.output().expect("start git");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn test_repository(label: &str, remote: Option<&str>) -> TestRepository {
        crate::git::isolate_test_git_environment();
        let path = unique_test_directory(&format!("{label}-repo"));
        git_ok(&path, &["init", "--quiet"]);
        if let Some(remote) = remote {
            git_ok(&path, &["remote", "add", "origin", remote]);
        }
        TestRepository { path }
    }

    fn settings_with(provider: &str, host: Option<&str>) -> HostingSettings {
        HostingSettings {
            provider: provider.to_string(),
            host: host.map(str::to_string),
            token_configured: false,
        }
    }

    // ---------------------------------------------------------------- 远端解析

    #[test]
    fn parses_https_http_ssh_and_scp_remotes() {
        let https = parse_remote_url("https://github.com/acme/widgets.git").expect("https");
        assert_eq!(https.host, "github.com");
        assert_eq!(https.project_path, "acme/widgets");

        let http = parse_remote_url("http://gitlab.example.com/group/sub/repo").expect("http");
        assert_eq!(http.host, "gitlab.example.com");
        assert_eq!(http.project_path, "group/sub/repo");

        let scp = parse_remote_url("git@gitlab.example.com:group/sub/repo.git").expect("scp");
        assert_eq!(scp.host, "gitlab.example.com");
        assert_eq!(scp.project_path, "group/sub/repo");

        let ssh = parse_remote_url("ssh://git@gitlab.com/group/repo.git").expect("ssh");
        assert_eq!(ssh.host, "gitlab.com");
        assert_eq!(ssh.project_path, "group/repo");

        let port = parse_remote_url("ssh://git@gitlab.example.com:2222/group/repo.git")
            .expect("ssh with port");
        assert_eq!(port.host, "gitlab.example.com:2222");
        assert_eq!(port.project_path, "group/repo");
    }

    #[test]
    fn rejects_suspicious_or_incomplete_remotes() {
        for rejected in [
            "",
            "https://github.com/acme",
            "https://github.com/acme/widgets.git\r\nX-Injected: 1",
            "https://user:secret@github.com/acme/widgets.git",
            "https://github.com/acme/../widgets",
            "git@github.com:widgets.git",
            "file:///tmp/repo",
            "https://github.com/acme/widgets repo",
            "https://github.com/acme/%2e%2e",
            "git://github.com/acme/widgets.git",
        ] {
            assert!(
                parse_remote_url(rejected).is_err(),
                "地址 {rejected:?} 应被拒绝"
            );
        }
    }

    #[test]
    fn infers_provider_from_host_with_configured_fallback() {
        assert_eq!(infer_provider("github.com", "gitlab"), PROVIDER_GITHUB);
        assert_eq!(
            infer_provider("gitlab.example.com", "github"),
            PROVIDER_GITLAB
        );
        assert_eq!(
            infer_provider("code.example.com", "gitlab"),
            PROVIDER_GITLAB
        );
        assert_eq!(
            infer_provider("code.example.com", "github"),
            PROVIDER_GITHUB
        );
        assert!(validate_project_for_provider(PROVIDER_GITHUB, "owner/repo").is_ok());
        assert!(validate_project_for_provider(PROVIDER_GITHUB, "group/sub/repo").is_err());
        assert!(validate_project_for_provider(PROVIDER_GITLAB, "group/sub/repo").is_ok());
    }

    #[test]
    fn detects_origin_remote_and_builds_web_url() {
        let repository = test_repository("detect", Some("git@github.com:acme/widgets.git"));
        let settings = settings_with(PROVIDER_GITHUB, None);
        let detected = detect_repository(&settings, repository.path.to_string_lossy().as_ref())
            .expect("detect");
        assert_eq!(detected.provider, PROVIDER_GITHUB);
        assert_eq!(detected.host, "github.com");
        assert_eq!(detected.project_path, "acme/widgets");
        assert_eq!(detected.web_url, "https://github.com/acme/widgets");

        let missing = test_repository("detect-missing", None);
        assert!(detect_repository(&settings, missing.path.to_string_lossy().as_ref()).is_err());

        // 自建 GitLab：主机名不含 gitlab，由配置的 provider 决定。
        let self_hosted = test_repository(
            "detect-self-hosted",
            Some("ssh://git@code.example.com/group/sub/repo.git"),
        );
        let gitlab_settings = settings_with(PROVIDER_GITLAB, Some("code.example.com"));
        let detected = detect_repository(
            &gitlab_settings,
            self_hosted.path.to_string_lossy().as_ref(),
        )
        .expect("detect self-hosted");
        assert_eq!(detected.provider, PROVIDER_GITLAB);
        assert_eq!(detected.project_path, "group/sub/repo");
        assert_eq!(detected.web_url, "https://code.example.com/group/sub/repo");
    }

    // ---------------------------------------------------------------- 设置

    #[test]
    fn validates_provider_host_and_token_rules() {
        assert!(validate_provider("GitHub").is_ok());
        assert!(validate_provider("gitlab").is_ok());
        assert!(validate_provider("bitbucket").is_err());

        assert_eq!(normalize_host(" GitHub.COM ").expect("host"), "github.com");
        assert_eq!(
            normalize_host("gitlab.example.com:8443").expect("host port"),
            "gitlab.example.com:8443"
        );
        for rejected in [
            "https://github.com",
            "github.com/owner",
            "user@github.com",
            "github.com?x=1",
            "bad host",
            "host_name.example.com",
            "github.com:abc",
        ] {
            assert!(normalize_host(rejected).is_err(), "{rejected}");
        }

        assert!(validate_token("ghp_abcdef123456").is_ok());
        assert!(validate_token("token with space").is_err());
        assert!(validate_token("token\nInjected: 1").is_err());
        assert!(validate_token(&"a".repeat(MAX_TOKEN_LEN + 1)).is_err());
    }

    #[test]
    fn settings_round_trip_keeps_token_secret_and_file_0600() {
        let directory = test_directory("settings");
        let path = directory.0.join("hosting.json");
        let token = "ghp_super_secret_token_123456";
        let saved = save_settings_at(
            &path,
            "GitHub",
            Some("GitHub.Example.com".into()),
            Some(token.into()),
        )
        .expect("save settings");
        assert_eq!(saved.provider, PROVIDER_GITHUB);
        assert_eq!(saved.host.as_deref(), Some("github.example.com"));
        assert!(saved.token_configured);
        let serialized = serde_json::to_string(&saved).expect("serialize settings");
        assert!(
            !serialized.contains(token),
            "返回前端的设置不得包含明文令牌"
        );
        assert!(
            !serde_json::to_string(&load_settings_at(&path).expect("load settings"))
                .expect("serialize loaded")
                .contains(token),
            "load 也不得回传明文令牌"
        );

        let raw = fs::read_to_string(&path).expect("read file");
        assert!(raw.contains(token), "令牌只应存在于后端配置文件中");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).expect("metadata").permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "hosting.json 必须为 0600");
        }

        // None / 空字符串保留原令牌；切换 provider 不应丢失。
        let kept = save_settings_at(&path, "gitlab", Some("gitlab.example.com".into()), None)
            .expect("save without token");
        assert_eq!(kept.provider, PROVIDER_GITLAB);
        assert!(kept.token_configured);
        assert_eq!(
            load_secret_token_at(&path).expect("load token").as_deref(),
            Some(token)
        );
        let kept_empty =
            save_settings_at(&path, "gitlab", None, Some("   ".into())).expect("keep token");
        assert!(kept_empty.token_configured);
        assert!(kept_empty.host.is_none());

        let cleared = clear_token_at(&path).expect("clear token");
        assert!(!cleared.token_configured);
        assert_eq!(cleared.provider, PROVIDER_GITLAB);
        assert!(load_secret_token_at(&path).expect("load cleared").is_none());

        assert!(save_settings_at(&path, "bitbucket", None, None).is_err());
        assert!(
            save_settings_at(&path, "github", Some("https://github.com".into()), None).is_err()
        );
    }

    // ---------------------------------------------------------------- curl

    #[test]
    fn curl_config_carries_token_in_stdin_only_and_redacts_errors() {
        let token = "ghp_curl_secret_123";
        let payload = serde_json::json!({ "title": "hello \"world\"" });
        let config = build_curl_config(
            token,
            PROVIDER_GITHUB,
            "POST",
            "https://api.github.com/repos/acme/widgets/pulls",
            Some(&payload),
        )
        .expect("curl config");
        assert!(config.contains("Authorization: Bearer"));
        assert!(config.contains(token));
        assert!(config.contains("request = \"POST\""));
        assert!(config.contains("data = \""));
        assert!(config.contains("write-out = \"\\n%{http_code}\""));
        assert!(config.contains("max-time = 30"));
        assert!(config.contains("silent"));
        assert!(config.contains("show-error"));
        assert_eq!(CURL_ARGUMENTS, ["--config", "-"]);
        assert!(
            !CURL_ARGUMENTS.iter().any(|value| value.contains(token)),
            "argv 中不得出现令牌"
        );

        let gitlab = build_curl_config(
            "glpat-secret",
            PROVIDER_GITLAB,
            "GET",
            "https://gitlab.com/api/v4/projects/group%2Frepo/merge_requests",
            None,
        )
        .expect("gitlab config");
        assert!(gitlab.contains("PRIVATE-TOKEN: glpat-secret"));
        assert!(!gitlab.contains("data ="));

        let raw = format!(
            "curl failed: Authorization: Bearer {token}; PRIVATE-TOKEN: glpat-other; token={token}"
        );
        let safe = redact_hosting_error(&raw, token);
        assert!(!safe.contains(token));
        assert!(!safe.contains("glpat-other"));
        assert!(safe.contains("[redacted]"));

        assert!(build_curl_config(
            token,
            PROVIDER_GITHUB,
            "GET",
            "http://api.github.com/repos",
            None
        )
        .is_err());
    }

    // ---------------------------------------------------------------- JSON 映射

    const GITHUB_PR_LIST: &str = r#"[
      {
        "number": 12,
        "title": "Add hosting panel",
        "user": { "login": "octocat" },
        "state": "open",
        "draft": false,
        "head": { "ref": "feature/hosting", "sha": "abc123" },
        "base": { "ref": "main" },
        "html_url": "https://github.com/acme/widgets/pull/12",
        "updated_at": "2026-01-02T03:04:05Z"
      },
      {
        "number": 13,
        "title": "WIP docs",
        "user": { "login": "hubot" },
        "state": "open",
        "draft": true,
        "head": { "ref": "docs" },
        "base": { "ref": "develop" },
        "html_url": "https://github.com/acme/widgets/pull/13",
        "updated_at": "2026-01-03T00:00:00Z"
      }
    ]"#;

    const GITHUB_PR_DETAIL: &str = r#"{
      "number": 12,
      "title": "Add hosting panel",
      "body": "Implements the hosting panel.",
      "user": { "login": "octocat" },
      "state": "open",
      "draft": false,
      "head": { "ref": "feature/hosting", "sha": "abc123" },
      "base": { "ref": "main" },
      "html_url": "https://github.com/acme/widgets/pull/12",
      "updated_at": "2026-01-02T03:04:05Z",
      "mergeable": true
    }"#;

    const GITHUB_CHECKS_FAILURE: &str = r#"{
      "total_count": 2,
      "check_runs": [
        { "name": "build", "status": "completed", "conclusion": "success", "html_url": "https://github.com/acme/widgets/runs/1" },
        { "name": "test", "status": "completed", "conclusion": "failure", "html_url": "https://github.com/acme/widgets/runs/2" }
      ]
    }"#;

    const GITHUB_CHECKS_PENDING: &str = r#"{
      "total_count": 1,
      "check_runs": [
        { "name": "test", "status": "in_progress", "conclusion": null, "html_url": null }
      ]
    }"#;

    #[test]
    fn maps_github_pr_list_and_detail_with_checks() {
        let list = github_pr_list_from_json(
            &serde_json::from_str::<Value>(GITHUB_PR_LIST).expect("list json"),
        )
        .expect("map list");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].number, 12);
        assert_eq!(list[0].author, "octocat");
        assert_eq!(list[0].source_branch, "feature/hosting");
        assert_eq!(list[0].target_branch, "main");
        assert!(!list[0].draft);
        assert_eq!(list[0].ci_status, "unknown");
        assert!(list[1].draft);

        let pr: Value = serde_json::from_str(GITHUB_PR_DETAIL).expect("detail json");
        let checks: Value = serde_json::from_str(GITHUB_CHECKS_FAILURE).expect("checks json");
        let detail = github_detail_from_json(&pr, Some(&checks)).expect("map detail");
        assert_eq!(
            detail.body.as_deref(),
            Some("Implements the hosting panel.")
        );
        assert_eq!(detail.mergeable, Some(true));
        assert_eq!(detail.ci_status, "failure");
        assert_eq!(detail.checks.len(), 2);
        assert_eq!(detail.checks[1].name, "test");
        assert_eq!(detail.checks[1].conclusion.as_deref(), Some("failure"));

        let pending: Value = serde_json::from_str(GITHUB_CHECKS_PENDING).expect("pending json");
        let detail = github_detail_from_json(&pr, Some(&pending)).expect("pending detail");
        assert_eq!(detail.ci_status, "pending");

        let success = vec![
            HostingCheck {
                name: "build".into(),
                status: "completed".into(),
                conclusion: Some("success".into()),
                web_url: None,
            },
            HostingCheck {
                name: "lint".into(),
                status: "completed".into(),
                conclusion: Some("neutral".into()),
                web_url: None,
            },
        ];
        assert_eq!(github_ci_status(&success), "success");
        assert_eq!(github_ci_status(&[]), "unknown");

        let no_checks = github_detail_from_json(&pr, None).expect("no checks");
        assert_eq!(no_checks.ci_status, "unknown");
        assert!(no_checks.checks.is_empty());
    }

    const GITLAB_MR_LIST: &str = r#"[
      {
        "iid": 7,
        "title": "Add MR panel",
        "author": { "name": "Alice" },
        "state": "opened",
        "source_branch": "feature/mr",
        "target_branch": "main",
        "web_url": "https://gitlab.com/group/sub/repo/-/merge_requests/7",
        "updated_at": "2026-02-01T10:00:00Z",
        "draft": false,
        "work_in_progress": false
      },
      {
        "iid": 8,
        "title": "WIP: docs",
        "author": { "name": "Bob" },
        "state": "opened",
        "source_branch": "docs",
        "target_branch": "main",
        "web_url": "https://gitlab.com/group/sub/repo/-/merge_requests/8",
        "updated_at": "2026-02-02T10:00:00Z",
        "work_in_progress": true
      }
    ]"#;

    const GITLAB_MR_DETAIL: &str = r#"{
      "iid": 7,
      "title": "Add MR panel",
      "description": "MR body",
      "author": { "name": "Alice" },
      "state": "opened",
      "source_branch": "feature/mr",
      "target_branch": "main",
      "web_url": "https://gitlab.com/group/sub/repo/-/merge_requests/7",
      "updated_at": "2026-02-01T10:00:00Z",
      "draft": false,
      "merge_status": "can_be_merged",
      "detailed_merge_status": "mergeable",
      "has_conflicts": false
    }"#;

    #[test]
    fn maps_gitlab_mr_list_and_pipeline_detail() {
        let list = gitlab_mr_list_from_json(
            &serde_json::from_str::<Value>(GITLAB_MR_LIST).expect("list json"),
        )
        .expect("map list");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].number, 7);
        assert_eq!(list[0].author, "Alice");
        assert_eq!(list[0].source_branch, "feature/mr");
        assert!(!list[0].draft);
        assert!(list[1].draft);
        assert_eq!(list[1].ci_status, "unknown");

        let mr: Value = serde_json::from_str(GITLAB_MR_DETAIL).expect("mr json");
        for (status, expected) in [
            ("success", "success"),
            ("failed", "failure"),
            ("canceled", "failure"),
            ("running", "pending"),
            ("pending", "pending"),
            ("skipped", "unknown"),
        ] {
            let pipeline = serde_json::json!([
                {
                    "id": 99,
                    "status": status,
                    "web_url": "https://gitlab.com/group/sub/repo/-/pipelines/99"
                }
            ]);
            let detail = gitlab_detail_from_json(&mr, Some(&pipeline)).expect("pipeline detail");
            assert_eq!(detail.ci_status, expected, "pipeline status {status}");
            assert_eq!(detail.body.as_deref(), Some("MR body"));
            assert_eq!(detail.mergeable, Some(true));
            assert_eq!(detail.checks.len(), 1);
            assert_eq!(detail.checks[0].name, "Pipeline #99");
        }

        let no_pipeline = gitlab_detail_from_json(&mr, None).expect("no pipeline");
        assert_eq!(no_pipeline.ci_status, "unknown");
        assert!(no_pipeline.checks.is_empty());

        let conflicted = serde_json::json!({
            "iid": 9, "title": "conflict", "author": { "name": "A" },
            "state": "opened", "source_branch": "a", "target_branch": "b",
            "web_url": "https://gitlab.com/g/s/r/-/merge_requests/9",
            "updated_at": "", "has_conflicts": true
        });
        let detail = gitlab_detail_from_json(&conflicted, None).expect("conflicted");
        assert_eq!(detail.mergeable, Some(false));
    }

    #[test]
    fn builds_create_payloads_and_validates_input() {
        let input = CreatePullRequestInput {
            title: "  Add hosting  ".into(),
            body: "Body text".into(),
            source_branch: "feature/hosting".into(),
            target_branch: "main".into(),
            draft: true,
        };
        let github = github_create_payload(&input).expect("github payload");
        assert_eq!(github["title"], "Add hosting");
        assert_eq!(github["head"], "feature/hosting");
        assert_eq!(github["base"], "main");
        assert_eq!(github["draft"], true);

        let gitlab = gitlab_create_payload(&input).expect("gitlab payload");
        assert_eq!(gitlab["title"], "Draft: Add hosting");
        assert_eq!(gitlab["source_branch"], "feature/hosting");
        assert!(gitlab.get("draft").is_none());
        assert!(gitlab.get("description").is_some());

        let already_draft = CreatePullRequestInput {
            title: "Draft: existing".into(),
            ..input.clone()
        };
        let gitlab = gitlab_create_payload(&already_draft).expect("existing draft");
        assert_eq!(gitlab["title"], "Draft: existing");

        for bad in [
            CreatePullRequestInput {
                title: "   ".into(),
                ..input.clone()
            },
            CreatePullRequestInput {
                source_branch: "".into(),
                ..input.clone()
            },
            CreatePullRequestInput {
                target_branch: "main".into(),
                source_branch: "main".into(),
                ..input.clone()
            },
            CreatePullRequestInput {
                source_branch: "bad branch".into(),
                ..input.clone()
            },
            CreatePullRequestInput {
                title: "bad\nInjected".into(),
                ..input.clone()
            },
        ] {
            assert!(validate_create_input(&bad).is_err(), "{bad:?}");
        }
        assert_eq!(percent_encode("group/sub/repo"), "group%2Fsub%2Frepo");
        assert_eq!(
            api_base(PROVIDER_GITHUB, "github.com"),
            "https://api.github.com"
        );
        assert_eq!(
            api_base(PROVIDER_GITHUB, "github.example.com"),
            "https://github.example.com/api/v3"
        );
        assert_eq!(
            api_base(PROVIDER_GITLAB, "gitlab.example.com"),
            "https://gitlab.example.com/api/v4"
        );
    }
}
