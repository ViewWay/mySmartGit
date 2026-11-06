//! W3-5 AI 提交消息生成。
//!
//! 能力线：
//! 1. 配置存储：`$HOME/.config/branchline/ai.json`（Windows `%APPDATA%/branchline/ai.json`，
//!    `BRANCHLINE_HOME` 可覆盖配置根目录）。Unix 下文件权限固定 600。
//!    API Key 只存后端文件，`AiSettings` 只回传 `api_key_configured`，永不回传明文。
//! 2. 提交消息生成：读取暂存区 diff（为空时回退工作区 diff），附最近 5 条提交标题，
//!    通过 OpenAI 兼容 `POST {base_url}/chat/completions` 生成 subject/body。
//!
//! 安全红线：
//! - Git 与 curl 一律以**参数数组**启动，绝不使用 `sh -c` 或字符串拼接；
//!   curl 的 url/header/body 全部经 `--config -` 的 stdin 配置传入，API Key 不进入 argv。
//! - curl 错误、非 2xx 响应在返回前端前统一脱敏（Bearer token、`sk-...`、配置的 key 原值）。
//! - 请求体/响应体写入 0600 临时文件，离开作用域即删除（`TempFile` 的 Drop）。
//! - base_url 只允许 https；http 仅允许 127.0.0.1 / localhost（本机假服务端测试）。
//! - diff 上下文预算 64KB 或 600 行（先到者），超限显式标记并告知模型与前端。
//!
//! 集成约定：本模块的 `#[tauri::command]` 包装函数位于文件末尾；本轮不修改
//! `lib.rs` / `commands.rs`，由集成轨道统一注册。

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_MODEL: &str = "gpt-4o-mini";
const DEFAULT_MAX_SUBJECT_CHARS: usize = 72;
const MIN_SUBJECT_CHARS: usize = 16;
const MAX_SUBJECT_CHARS: usize = 200;

/// diff 上下文预算：字节与行数先到者生效。
const DIFF_BYTE_BUDGET: usize = 64 * 1024;
const DIFF_LINE_BUDGET: usize = 600;
/// 最近提交标题条数（风格参考）。
const RECENT_COMMIT_LIMIT: usize = 5;
/// HTTP 响应体上限。
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const CURL_MAX_TIME_SECONDS: &str = "60";
const TRUNCATION_MARKER: &str = "\n[上下文已截断：仅保留预算内的改动，请只依据以上可见内容总结]";

// ---------------------------------------------------------------------------
// 前端契约
// ---------------------------------------------------------------------------

/// 对前端暴露的设置：API Key 只以布尔标记是否已配置。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    pub base_url: String,
    pub model: String,
    /// "zh" | "en"
    pub language: String,
    /// "conventional" | "plain"
    pub style: String,
    pub include_body: bool,
    pub max_subject_chars: usize,
    pub api_key_configured: bool,
}

/// 保存设置时的输入；API Key 单独传入，避免混入设置对象。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsInput {
    pub base_url: String,
    pub model: String,
    pub language: String,
    pub style: String,
    pub include_body: bool,
    pub max_subject_chars: usize,
}

/// 单次生成的可选覆盖项；缺省时沿用已保存设置。
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiGenerateOptions {
    pub language: Option<String>,
    pub style: Option<String>,
    pub include_body: Option<bool>,
    pub max_subject_chars: Option<usize>,
}

/// 生成结果。`note` 标明降级来源（工作区 diff）与截断信息，`truncated` 为机器标记。
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiCommitMessage {
    pub subject: String,
    pub body: Option<String>,
    pub model: String,
    pub note: Option<String>,
    pub truncated: bool,
}

// ---------------------------------------------------------------------------
// 磁盘格式
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AiSettingsFile {
    base_url: String,
    model: String,
    language: String,
    style: String,
    include_body: bool,
    max_subject_chars: usize,
    /// 仅存在于后端文件；`load` 永不回传。
    api_key: Option<String>,
}

impl Default for AiSettingsFile {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_BASE_URL.to_string(),
            model: DEFAULT_MODEL.to_string(),
            language: "zh".to_string(),
            style: "conventional".to_string(),
            include_body: true,
            max_subject_chars: DEFAULT_MAX_SUBJECT_CHARS,
            api_key: None,
        }
    }
}

impl AiSettingsFile {
    fn public_settings(&self) -> AiSettings {
        AiSettings {
            base_url: self.base_url.trim().to_string(),
            model: self.model.trim().to_string(),
            language: normalize_language(&self.language),
            style: normalize_style(&self.style),
            include_body: self.include_body,
            max_subject_chars: clamp_subject_chars(self.max_subject_chars),
            api_key_configured: self
                .api_key
                .as_deref()
                .map(|key| !key.trim().is_empty())
                .unwrap_or(false),
        }
    }
}

fn normalize_language(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "en" => "en".into(),
        _ => "zh".into(),
    }
}

fn normalize_style(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "plain" => "plain".into(),
        _ => "conventional".into(),
    }
}

fn clamp_subject_chars(value: usize) -> usize {
    value.clamp(MIN_SUBJECT_CHARS, MAX_SUBJECT_CHARS)
}

// ---------------------------------------------------------------------------
// 配置路径与读写
// ---------------------------------------------------------------------------

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
    Ok(settings_directory()?.join("ai.json"))
}

fn read_settings_file() -> Result<AiSettingsFile, String> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(AiSettingsFile::default());
    }
    let raw = fs::read_to_string(&path).map_err(|error| format!("读取 AI 设置失败：{error}"))?;
    if raw.trim().is_empty() {
        return Ok(AiSettingsFile::default());
    }
    serde_json::from_str(&raw).map_err(|_| "AI 设置文件格式无效，请重新保存设置".to_string())
}

fn write_settings_file(file: &AiSettingsFile) -> Result<(), String> {
    let path = settings_path()?;
    let directory = path.parent().ok_or_else(|| "AI 设置路径无效".to_string())?;
    fs::create_dir_all(directory).map_err(|error| format!("创建 AI 设置目录失败：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // 配置目录可能含密钥，尽量收紧到仅当前用户可访问；失败不阻断保存。
        let _ = fs::set_permissions(directory, fs::Permissions::from_mode(0o700));
    }
    let bytes =
        serde_json::to_vec_pretty(file).map_err(|error| format!("序列化 AI 设置失败：{error}"))?;
    let temp_name = format!(
        ".ai.json.tmp-{}-{}",
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
            .map_err(|error| format!("创建 AI 设置临时文件失败：{error}"))?;
        handle
            .write_all(&bytes)
            .map_err(|error| format!("写入 AI 设置失败：{error}"))?;
        handle
            .sync_all()
            .map_err(|error| format!("保存 AI 设置失败：{error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("设置 AI 设置文件权限失败：{error}"))?;
        }
        #[cfg(target_os = "windows")]
        {
            // Windows 的 rename 不覆盖既有文件。
            let _ = fs::remove_file(&path);
        }
        fs::rename(&temp_path, &path).map_err(|error| format!("保存 AI 设置失败：{error}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn load_settings() -> Result<AiSettings, String> {
    Ok(read_settings_file()?.public_settings())
}

fn save_settings(input: AiSettingsInput, api_key: Option<String>) -> Result<AiSettings, String> {
    let base_url = input.base_url.trim().trim_end_matches('/').to_string();
    validate_base_url(&base_url)?;
    let model = input.model.trim().to_string();
    if model.is_empty() {
        return Err("模型名称不能为空".into());
    }
    if model.chars().any(|character| character.is_control()) {
        return Err("模型名称包含非法字符".into());
    }
    let mut file = read_settings_file()?;
    file.base_url = base_url;
    file.model = model;
    file.language = normalize_language(&input.language);
    file.style = normalize_style(&input.style);
    file.include_body = input.include_body;
    file.max_subject_chars = clamp_subject_chars(input.max_subject_chars);
    // None = 保留原 key；空字符串 = 清除；非空 = 替换（去掉首尾空白）。
    file.api_key = match api_key {
        None => file.api_key,
        Some(value) => {
            let value = value.trim().to_string();
            if value.is_empty() {
                None
            } else {
                if value.chars().any(|character| character.is_control()) {
                    return Err("API Key 包含非法字符".into());
                }
                Some(value)
            }
        }
    };
    write_settings_file(&file)?;
    Ok(file.public_settings())
}

fn clear_api_key() -> Result<AiSettings, String> {
    let mut file = read_settings_file()?;
    file.api_key = None;
    write_settings_file(&file)?;
    Ok(file.public_settings())
}

fn load_secret_key() -> Result<Option<String>, String> {
    let file = read_settings_file()?;
    Ok(file
        .api_key
        .filter(|key| !key.trim().is_empty())
        .map(|key| key.trim().to_string()))
}

// ---------------------------------------------------------------------------
// base_url 校验
// ---------------------------------------------------------------------------

/// 允许 https 任意主机；http 仅允许本机（127.0.0.1 / localhost），供端到端测试。
fn validate_base_url(raw: &str) -> Result<(), String> {
    let value = raw.trim();
    if value.is_empty() {
        return Err("AI 服务地址不能为空".into());
    }
    if value
        .chars()
        .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err("AI 服务地址不能包含空白或控制字符".into());
    }
    if value.contains('?') || value.contains('#') {
        return Err("AI 服务地址不能包含查询串或片段".into());
    }
    let (scheme, rest) = value
        .split_once("://")
        .ok_or_else(|| "AI 服务地址必须以 https:// 开头（http 仅允许本机）".to_string())?;
    if rest.is_empty() {
        return Err("AI 服务地址缺少主机名".into());
    }
    let authority = rest.split('/').next().unwrap_or("");
    if authority.is_empty() {
        return Err("AI 服务地址缺少主机名".into());
    }
    if authority.contains('@') {
        return Err("AI 服务地址不能内嵌用户名或凭据".into());
    }
    if scheme.eq_ignore_ascii_case("https") {
        return Ok(());
    }
    if scheme.eq_ignore_ascii_case("http") {
        let host = authority
            .split(':')
            .next()
            .unwrap_or("")
            .trim_start_matches('[')
            .trim_end_matches(']');
        if host.eq_ignore_ascii_case("127.0.0.1") || host.eq_ignore_ascii_case("localhost") {
            return Ok(());
        }
        return Err("出于安全考虑，http 只允许连接到 127.0.0.1 或 localhost".into());
    }
    Err("AI 服务地址只支持 https（http 仅限本机）".into())
}

// ---------------------------------------------------------------------------
// Git 上下文
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
enum DiffSource {
    Staged,
    Worktree,
}

#[derive(Clone, Debug)]
struct DiffContext {
    text: String,
    truncated: bool,
    source: DiffSource,
    /// 被哪一项预算截断（用于 note）。
    byte_truncated: bool,
    line_truncated: bool,
}

impl DiffContext {
    fn source_label(&self) -> &'static str {
        match self.source {
            DiffSource::Staged => "暂存区",
            DiffSource::Worktree => "工作区未暂存改动",
        }
    }
}

fn run_git(root: &Path, args: &[&str]) -> Result<String, String> {
    #[cfg(test)]
    crate::git::isolate_test_git_environment();
    let mut command = Command::new("git");
    command.arg("-C").arg(root).args(args);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    let output = command
        .output()
        .map_err(|error| format!("无法启动 Git：{error}"))?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            "Git 命令执行失败".into()
        } else {
            format!("Git 命令执行失败：{message}")
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn validate_repository(repository_path: &str) -> Result<PathBuf, String> {
    if repository_path.trim().is_empty() {
        return Err("请先打开本地仓库".into());
    }
    let path =
        fs::canonicalize(repository_path).map_err(|_| "仓库路径不存在或不可访问".to_string())?;
    if !path.is_dir() {
        return Err("仓库路径不是目录".into());
    }
    let inside = run_git(&path, &["rev-parse", "--is-inside-work-tree"])?;
    if inside.trim() != "true" {
        return Err("所选目录不是 Git 工作区".into());
    }
    Ok(path)
}

/// 拼接 stat 与 diff，并按「64KB 或 600 行」预算截断；两种预算分别标记。
fn truncate_diff_text(stat: &str, diff: &str) -> (String, bool, bool) {
    let mut text = String::new();
    if !stat.trim().is_empty() {
        text.push_str(stat.trim_end());
        text.push_str("\n\n");
    }
    text.push_str(diff);

    let mut line_truncated = false;
    if text.lines().count() > DIFF_LINE_BUDGET {
        let kept: Vec<&str> = text.lines().take(DIFF_LINE_BUDGET).collect();
        text = kept.join("\n");
        line_truncated = true;
    }
    let mut byte_truncated = false;
    if text.len() > DIFF_BYTE_BUDGET {
        let mut end = DIFF_BYTE_BUDGET;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        byte_truncated = true;
    }
    if line_truncated || byte_truncated {
        text.push_str(TRUNCATION_MARKER);
    }
    (text, byte_truncated, line_truncated)
}

/// 优先暂存区；暂存区为空时回退工作区，并在响应 note 中标明来源。
fn collect_diff_context(root: &Path) -> Result<DiffContext, String> {
    let staged_diff = run_git(root, &["diff", "--cached"])?;
    let (stat, diff, source) = if !staged_diff.trim().is_empty() {
        (
            run_git(root, &["diff", "--cached", "--stat"])?,
            staged_diff,
            DiffSource::Staged,
        )
    } else {
        let worktree_diff = run_git(root, &["diff"])?;
        if worktree_diff.trim().is_empty() {
            return Err("没有可用于生成提交信息的改动：暂存区和工作区都是干净的".into());
        }
        (
            run_git(root, &["diff", "--stat"])?,
            worktree_diff,
            DiffSource::Worktree,
        )
    };
    let (text, byte_truncated, line_truncated) = truncate_diff_text(&stat, &diff);
    Ok(DiffContext {
        text,
        truncated: byte_truncated || line_truncated,
        source,
        byte_truncated,
        line_truncated,
    })
}

fn recent_commit_titles(root: &Path) -> Vec<String> {
    // 空仓库（还没有 HEAD）时 git log 失败，按「无历史」处理即可。
    match run_git(root, &["log", "-5", "--format=%s"]) {
        Ok(output) => output
            .lines()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .take(RECENT_COMMIT_LIMIT)
            .collect(),
        Err(_) => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// 提示词与响应解析
// ---------------------------------------------------------------------------

struct PromptSettings<'a> {
    language: &'a str,
    style: &'a str,
    include_body: bool,
    max_subject_chars: usize,
}

fn build_prompt(
    context: &DiffContext,
    recent_titles: &[String],
    settings: &PromptSettings<'_>,
) -> (String, String) {
    let language_line = if settings.language == "en" {
        "Write the commit message in English."
    } else {
        "使用简体中文撰写提交消息。"
    };
    let style_line = if settings.style == "plain" {
        "使用简洁的普通风格 subject，不加 type(scope): 前缀。"
    } else {
        "遵循 Conventional Commits：subject 形如 type(scope): summary，type 使用 feat/fix/docs/refactor/test/chore/perf/build/ci 等。"
    };
    let body_line = if settings.include_body {
        "先输出一行 subject，空一行后输出正文；正文每行以 \"- \" 开头，只列 diff 支持得住的要点。"
    } else {
        "只输出一行 subject，不要输出正文。"
    };
    let truncated_line = if context.truncated {
        "注意：下面的 diff 已按预算截断，只能依据可见部分总结，不要推测被截掉的内容。"
    } else {
        ""
    };
    let system = format!(
        "你是 Git 提交消息助手。只输出提交消息本身，不要输出解释、Markdown 代码围栏或任何前后缀。\n\
         {language_line}\n\
         {style_line}\n\
         subject 不得超过 {max_chars} 个字符（中文按字计数），不得换行。\n\
         {body_line}\n\
         不得编造 diff 中未出现的内容；不确定的细节不要写。\n\
         {truncated_line}",
        max_chars = settings.max_subject_chars
    );

    let mut user = String::new();
    user.push_str("以下是仓库最近的提交标题，仅作风格参考，不要照抄：\n");
    if recent_titles.is_empty() {
        user.push_str("（暂无历史提交）\n");
    } else {
        for title in recent_titles {
            user.push_str("- ");
            user.push_str(title);
            user.push('\n');
        }
    }
    user.push_str("\n以下为本次 Git 改动（来源：");
    user.push_str(context.source_label());
    user.push_str("）：\n");
    user.push_str(&context.text);
    (system, user)
}

/// 去掉模型可能包裹的 Markdown 代码围栏。
fn strip_code_fence(content: &str) -> String {
    let mut value = content.trim();
    if value.starts_with("```") {
        value = match value.find('\n') {
            Some(index) => &value[index + 1..],
            None => value.trim_start_matches('`'),
        };
        if let Some(end) = value.rfind("```") {
            if value[end + 3..].trim().is_empty() {
                value = &value[..end];
            }
        }
    }
    value.trim().to_string()
}

fn truncate_subject(subject: &str, max_chars: usize) -> (String, bool) {
    let count = subject.chars().count();
    if count <= max_chars {
        return (subject.to_string(), false);
    }
    let keep = max_chars.saturating_sub(1);
    let mut truncated: String = subject.chars().take(keep).collect();
    truncated.push('…');
    (truncated, true)
}

/// 拆分 subject/body 并按设置截断 subject、按需丢弃正文。
fn parse_commit_message(
    content: &str,
    max_subject_chars: usize,
    include_body: bool,
) -> Result<(String, Option<String>, bool), String> {
    let cleaned = strip_code_fence(content);
    let mut subject: Option<String> = None;
    let mut body_lines: Vec<&str> = Vec::new();
    for line in cleaned.lines() {
        if subject.is_none() {
            if line.trim().is_empty() {
                continue;
            }
            subject = Some(line.trim().to_string());
        } else {
            body_lines.push(line);
        }
    }
    let subject = subject.ok_or_else(|| "AI 未返回提交信息".to_string())?;
    let (subject, truncated) = truncate_subject(&subject, max_subject_chars);
    let body = if include_body {
        let joined = body_lines.join("\n");
        let body = joined.trim().to_string();
        if body.is_empty() {
            None
        } else {
            Some(body)
        }
    } else {
        None
    };
    Ok((subject, body, truncated))
}

// ---------------------------------------------------------------------------
// 错误脱敏
// ---------------------------------------------------------------------------

/// 把 Bearer token、`sk-...`、API Key 原值等凭据从错误文本中抹掉。
fn redact_ai_error(raw: &str, api_key: &str) -> String {
    let mut text = raw.to_string();
    let key = api_key.trim();
    if !key.is_empty() {
        text = text.replace(key, "[redacted]");
    }
    text = redact_token_after(&text, "bearer ");
    text = redact_sk_tokens(&text);
    for prefix in ["api_key=", "api-key=", "apikey="] {
        text = redact_token_after(&text, prefix);
    }
    text
}

/// 把 `prefix` 之后直到空白/引号/分隔符的 token 替换为 `[redacted]`（大小写不敏感）。
fn redact_token_after(text: &str, prefix: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let mut result = String::new();
    let mut cursor = 0usize;
    while let Some(offset) = lower[cursor..].find(prefix) {
        let start = cursor + offset;
        let value_start = start + prefix.len();
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
            // 没有可脱敏的值，原样保留剩余文本。
            result.push_str(&text[value_start..]);
            return result;
        }
        result.push_str("[redacted]");
        cursor = end;
    }
    result.push_str(&text[cursor..]);
    result
}

/// 单独处理 `sk-...`，同时要求前缀边界，避免误伤 `task-` 这类普通单词。
fn redact_sk_tokens(text: &str) -> String {
    let mut result = String::new();
    let mut cursor = 0usize;
    let bytes = text.as_bytes();
    while cursor < bytes.len() {
        let rest = &text[cursor..];
        if rest.starts_with("sk-") {
            let boundary = cursor == 0
                || !text[..cursor]
                    .chars()
                    .next_back()
                    .map(|character| character.is_ascii_alphanumeric())
                    .unwrap_or(false);
            if boundary {
                let token_start = cursor + 3;
                let mut value_end = token_start;
                for (index, character) in text[token_start..].char_indices() {
                    if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
                        value_end = token_start + index + character.len_utf8();
                    } else {
                        break;
                    }
                }
                let token = &text[cursor..value_end];
                result.push_str(if token.len() > 3 { "[redacted]" } else { token });
                cursor = value_end;
                continue;
            }
        }
        let character = rest.chars().next().unwrap_or_default();
        result.push(character);
        cursor += character.len_utf8();
    }
    result
}

fn shorten_for_error(value: &str) -> String {
    let trimmed = value.trim();
    let mut shortened: String = trimmed.chars().take(400).collect();
    if trimmed.chars().count() > 400 {
        shortened.push('…');
    }
    shortened
}

// ---------------------------------------------------------------------------
// curl 与 HTTP
// ---------------------------------------------------------------------------

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn next_temp_path(prefix: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!(
        "branchline-ai-{prefix}-{}-{nanos}-{sequence}.tmp",
        std::process::id()
    ))
}

/// 0600 临时文件；离开作用域自动删除（即「finally 删除」）。
struct TempFile {
    path: PathBuf,
}

impl TempFile {
    fn create(prefix: &str, contents: &[u8]) -> Result<Self, String> {
        let path = next_temp_path(prefix);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut handle = options
            .open(&path)
            .map_err(|error| format!("创建 AI 临时文件失败：{error}"))?;
        handle
            .write_all(contents)
            .map_err(|error| format!("写入 AI 临时文件失败：{error}"))?;
        handle
            .flush()
            .map_err(|error| format!("写入 AI 临时文件失败：{error}"))?;
        Ok(Self { path })
    }

    fn create_empty(prefix: &str) -> Result<Self, String> {
        Self::create(prefix, &[])
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn curl_quote(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn parse_http_status(stdout: &str) -> Option<u16> {
    stdout
        .lines()
        .last()
        .map(|line| line.trim())
        .and_then(|line| line.parse::<u16>().ok())
}

fn request_completion(
    base_url: &str,
    api_key: &str,
    payload: &serde_json::Value,
) -> Result<String, String> {
    validate_base_url(base_url)?;
    if api_key.trim().is_empty() {
        return Err("尚未配置 AI API Key，请先在 AI 设置中保存".into());
    }
    if api_key.chars().any(|character| character.is_control()) {
        return Err("API Key 包含非法字符，请重新保存".into());
    }

    let body = serde_json::to_vec(payload).map_err(|error| format!("构造 AI 请求失败：{error}"))?;
    let request_file = TempFile::create("request", &body)?;
    let response_file = TempFile::create_empty("response")?;

    let url = format!("{}/chat/completions", base_url.trim().trim_end_matches('/'));
    // url / header / body / output 全部从 stdin 配置传入：API Key 不出现在 argv。
    let config = format!(
        "url = \"{}\"\nrequest = \"POST\"\nheader = \"Content-Type: application/json\"\nheader = \"Authorization: Bearer {}\"\ndata-binary = \"@{}\"\noutput = \"{}\"\nwrite-out = \"%{{http_code}}\"\n",
        curl_quote(&url),
        curl_quote(api_key),
        curl_quote(&request_file.path().to_string_lossy()),
        curl_quote(&response_file.path().to_string_lossy())
    );

    let mut command = Command::new("curl");
    command
        .args([
            "--silent",
            "--show-error",
            "--max-time",
            CURL_MAX_TIME_SECONDS,
            "--config",
            "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 curl（AI 请求依赖系统 curl）：{error}"))?;
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
        .map_err(|error| format!("等待 AI 请求失败：{error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = if stderr.is_empty() {
            "无法连接 AI 服务".to_string()
        } else {
            shorten_for_error(&stderr)
        };
        return Err(redact_ai_error(
            &format!(
                "AI 请求失败（curl 退出码 {}）：{detail}",
                output.status.code().unwrap_or(-1)
            ),
            api_key,
        ));
    }

    let status = parse_http_status(&String::from_utf8_lossy(&output.stdout))
        .ok_or_else(|| "AI 服务未返回 HTTP 状态码".to_string())?;
    let metadata = fs::metadata(response_file.path())
        .map_err(|error| format!("读取 AI 服务响应失败：{error}"))?;
    if metadata.len() > MAX_RESPONSE_BYTES as u64 {
        return Err("AI 服务响应超过 1MB 上限，已拒绝处理".into());
    }
    let bytes =
        fs::read(response_file.path()).map_err(|error| format!("读取 AI 服务响应失败：{error}"))?;

    if !(200..300).contains(&status) {
        let message = serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|value| {
                value
                    .pointer("/error/message")
                    .and_then(|item| item.as_str())
                    .map(ToString::to_string)
            })
            .unwrap_or_else(|| "AI 服务返回错误".to_string());
        return Err(redact_ai_error(
            &format!(
                "AI 服务错误（HTTP {status}）：{}",
                shorten_for_error(&message)
            ),
            api_key,
        ));
    }

    if bytes.is_empty() {
        return Err("AI 服务返回了空响应".into());
    }
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "AI 服务返回了无法解析的响应".to_string())?;
    let content = value
        .pointer("/choices/0/message/content")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .to_string();
    if content.trim().is_empty() {
        return Err("AI 服务没有返回提交消息内容".into());
    }
    Ok(content)
}

// ---------------------------------------------------------------------------
// 生成入口
// ---------------------------------------------------------------------------

fn generate_message(
    repository_path: &str,
    options: &AiGenerateOptions,
) -> Result<AiCommitMessage, String> {
    let settings = load_settings()?;
    let api_key = load_secret_key()?
        .ok_or_else(|| "尚未配置 AI API Key，请先在 AI 设置中保存".to_string())?;
    let repository = validate_repository(repository_path)?;
    let context = collect_diff_context(&repository)?;
    let recent_titles = recent_commit_titles(&repository);

    let language = options
        .language
        .as_deref()
        .map(normalize_language)
        .unwrap_or_else(|| settings.language.clone());
    let style = options
        .style
        .as_deref()
        .map(normalize_style)
        .unwrap_or_else(|| settings.style.clone());
    let include_body = options.include_body.unwrap_or(settings.include_body);
    let max_subject_chars = clamp_subject_chars(
        options
            .max_subject_chars
            .unwrap_or(settings.max_subject_chars),
    );

    let prompt_settings = PromptSettings {
        language: &language,
        style: &style,
        include_body,
        max_subject_chars,
    };
    let (system, user) = build_prompt(&context, &recent_titles, &prompt_settings);

    let payload = serde_json::json!({
        "model": settings.model,
        "temperature": 0.2,
        "stream": false,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
    });
    let content = request_completion(&settings.base_url, &api_key, &payload)?;
    let (subject, body, subject_truncated) =
        parse_commit_message(&content, max_subject_chars, include_body)?;

    let mut notes: Vec<String> = Vec::new();
    if context.source == DiffSource::Worktree {
        notes.push("暂存区为空，已使用工作区未暂存改动生成".to_string());
    }
    if context.truncated {
        let mut budgets = Vec::new();
        if context.line_truncated {
            budgets.push(format!("{DIFF_LINE_BUDGET} 行"));
        }
        if context.byte_truncated {
            budgets.push(format!("{}KB", DIFF_BYTE_BUDGET / 1024));
        }
        notes.push(format!(
            "改动内容超出 {} 预算，已截断后发送给模型",
            budgets.join(" / ")
        ));
    }
    if subject_truncated {
        notes.push(format!("subject 已截断到 {max_subject_chars} 个字符"));
    }

    Ok(AiCommitMessage {
        subject,
        body,
        model: settings.model,
        note: if notes.is_empty() {
            None
        } else {
            Some(notes.join("；"))
        },
        truncated: context.truncated || subject_truncated,
    })
}

// ---------------------------------------------------------------------------
// Tauri 命令包装（由集成轨道注册到 lib.rs）
// ---------------------------------------------------------------------------

fn task_error(action: &str, error: impl std::fmt::Display) -> String {
    format!("{action}失败：{error}")
}

#[tauri::command]
pub async fn load_ai_settings() -> Result<AiSettings, String> {
    tauri::async_runtime::spawn_blocking(load_settings)
        .await
        .map_err(|error| task_error("读取 AI 设置", error))?
}

#[tauri::command]
pub async fn save_ai_settings(
    settings: AiSettingsInput,
    api_key: Option<String>,
) -> Result<AiSettings, String> {
    tauri::async_runtime::spawn_blocking(move || save_settings(settings, api_key))
        .await
        .map_err(|error| task_error("保存 AI 设置", error))?
}

#[tauri::command]
pub async fn clear_ai_api_key() -> Result<AiSettings, String> {
    tauri::async_runtime::spawn_blocking(clear_api_key)
        .await
        .map_err(|error| task_error("清除 AI API Key", error))?
}

#[tauri::command]
pub async fn generate_commit_message(
    repository_path: String,
    options: AiGenerateOptions,
) -> Result<AiCommitMessage, String> {
    tauri::async_runtime::spawn_blocking(move || generate_message(&repository_path, &options))
        .await
        .map_err(|error| task_error("生成 AI 提交信息", error))?
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::time::Duration;

    fn unique_test_directory(label: &str) -> PathBuf {
        static SEQUENCE: AtomicU64 = AtomicU64::new(1);
        loop {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0);
            let sequence = SEQUENCE.fetch_add(1, Ordering::SeqCst);
            let candidate = std::env::temp_dir().join(format!(
                "branchline-ai-test-{label}-{}-{nanos}-{sequence}",
                std::process::id()
            ));
            match fs::create_dir(&candidate) {
                Ok(()) => return candidate,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("create test directory: {error}"),
            }
        }
    }

    /// 独占 BRANCHLINE_HOME 并持有跨模块环境锁；Drop 时恢复环境与清理目录。
    struct TestHome {
        _guard: std::sync::MutexGuard<'static, ()>,
        previous: Option<std::ffi::OsString>,
        root: PathBuf,
    }

    impl TestHome {
        fn new(label: &str) -> Self {
            crate::git::isolate_test_git_environment();
            let guard = crate::git::test_environment_lock();
            let root = unique_test_directory(label);
            let previous = std::env::var_os("BRANCHLINE_HOME");
            std::env::set_var("BRANCHLINE_HOME", &root);
            Self {
                _guard: guard,
                previous,
                root,
            }
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(value) => std::env::set_var("BRANCHLINE_HOME", value),
                None => std::env::remove_var("BRANCHLINE_HOME"),
            }
            let _ = fs::remove_dir_all(&self.root);
        }
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

    fn test_repository(label: &str) -> TestRepository {
        crate::git::isolate_test_git_environment();
        let path = unique_test_directory(&format!("{label}-repo"));
        git_ok(&path, &["init", "--quiet"]);
        fs::write(path.join("app.txt"), "line one\n").expect("write fixture");
        git_ok(&path, &["add", "app.txt"]);
        git_ok(&path, &["commit", "--quiet", "-m", "feat: initial fixture"]);
        TestRepository { path }
    }

    fn settings_input(base_url: &str, model: &str) -> AiSettingsInput {
        AiSettingsInput {
            base_url: base_url.to_string(),
            model: model.to_string(),
            language: "zh".to_string(),
            style: "conventional".to_string(),
            include_body: true,
            max_subject_chars: 72,
        }
    }

    fn test_context(text: &str) -> DiffContext {
        DiffContext {
            text: text.to_string(),
            truncated: false,
            source: DiffSource::Staged,
            byte_truncated: false,
            line_truncated: false,
        }
    }

    #[test]
    fn builds_prompt_with_language_style_budget_and_recent_titles() {
        crate::git::isolate_test_git_environment();
        let context = test_context(" app.txt | 1 +\n\n+hello");
        let recent = vec![
            "feat: one".to_string(),
            "fix: two".to_string(),
            "docs: three".to_string(),
            "test: four".to_string(),
            "chore: five".to_string(),
        ];
        let settings = PromptSettings {
            language: "zh",
            style: "conventional",
            include_body: true,
            max_subject_chars: 50,
        };
        let (system, user) = build_prompt(&context, &recent, &settings);
        assert!(system.contains("简体中文"));
        assert!(system.contains("type(scope): summary"));
        assert!(system.contains("50 个字符"));
        assert!(system.contains("不得编造"));
        assert!(system.contains("- "));
        assert!(user.contains("feat: one"));
        assert!(user.contains("chore: five"));
        assert!(user.contains("暂存区"));
        assert!(user.contains("+hello"));

        let subject_only = PromptSettings {
            language: "en",
            style: "plain",
            include_body: false,
            max_subject_chars: 72,
        };
        let (system, _) = build_prompt(&context, &[], &subject_only);
        assert!(system.contains("English"));
        assert!(!system.contains("type(scope): summary"));
        assert!(system.contains("只输出一行 subject"));
    }

    #[test]
    fn diff_budget_truncates_by_lines_and_bytes_with_explicit_marker() {
        crate::git::isolate_test_git_environment();
        let long_lines: String = (0..900).map(|index| format!("+line {index}\n")).collect();
        let (text, byte_truncated, line_truncated) = truncate_diff_text("", &long_lines);
        assert!(line_truncated);
        assert!(!byte_truncated, "900 行不应触发字节预算");
        assert!(text.contains(TRUNCATION_MARKER.trim()));
        assert_eq!(
            text.lines()
                .filter(|line| line.starts_with("+line"))
                .count(),
            DIFF_LINE_BUDGET
        );

        // 单行超长：只触发字节预算，且必须落在字符边界上。
        let huge_line = format!("+{}", "中".repeat(DIFF_BYTE_BUDGET));
        let (text, byte_truncated, line_truncated) = truncate_diff_text("", &huge_line);
        assert!(byte_truncated);
        assert!(!line_truncated);
        assert!(text.len() <= DIFF_BYTE_BUDGET + TRUNCATION_MARKER.len());
        assert!(text.contains(TRUNCATION_MARKER.trim()));
        assert!(
            text.trim_end_matches(TRUNCATION_MARKER.trim())
                .trim_end()
                .len()
                > 0
        );
    }

    #[test]
    fn strips_code_fences_and_truncates_subject_by_characters() {
        crate::git::isolate_test_git_environment();
        let (subject, body, truncated) = parse_commit_message(
            "```text\nfeat(core): add cache\n\n- reduce lookups\n- add tests\n```",
            72,
            true,
        )
        .expect("parse fenced message");
        assert_eq!(subject, "feat(core): add cache");
        assert_eq!(body.as_deref(), Some("- reduce lookups\n- add tests"));
        assert!(!truncated);

        let long_subject = format!("feat: {}", "长".repeat(40));
        let (subject, body, truncated) =
            parse_commit_message(&long_subject, 20, false).expect("parse long subject");
        assert!(truncated);
        assert_eq!(subject.chars().count(), 20);
        assert!(subject.ends_with('…'));
        assert!(body.is_none());

        assert!(parse_commit_message("```\n\n```", 72, true).is_err());
    }

    #[test]
    fn validates_base_url_scheme_and_loopback_http() {
        crate::git::isolate_test_git_environment();
        assert!(validate_base_url("https://api.openai.com/v1").is_ok());
        assert!(validate_base_url("https://gateway.example.com/openai").is_ok());
        assert!(validate_base_url("http://127.0.0.1:8080/v1").is_ok());
        assert!(validate_base_url("http://localhost:8787").is_ok());
        for rejected in [
            "http://example.com/v1",
            "http://127.0.0.1.evil.com/v1",
            "ftp://example.com/v1",
            "https://user:secret@example.com/v1",
            "https://api.openai.com/v1?token=1",
            "https://",
            "",
            "api.openai.com/v1",
        ] {
            assert!(validate_base_url(rejected).is_err(), "{rejected}");
        }
    }

    #[test]
    fn settings_file_is_0600_and_api_key_never_returned() {
        let home = TestHome::new("settings");
        let key = "sk-live-1234567890secret";
        let saved = save_settings(
            settings_input("https://api.example.com/v1", "gpt-test"),
            Some(key.into()),
        )
        .expect("save settings");
        assert!(saved.api_key_configured);
        let serialized = serde_json::to_string(&saved).expect("serialize settings");
        assert!(
            !serialized.contains(key),
            "返回给前端的设置不得包含明文 key"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = settings_path().expect("settings path");
            let mode = fs::metadata(&path)
                .expect("settings metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "ai.json 必须为 0600");
        }

        // None：保留原 key（只能后端读到）；空字符串：清除。
        save_settings(
            settings_input("https://api.example.com/v1", "gpt-test"),
            None,
        )
        .expect("save without replacing key");
        assert_eq!(load_secret_key().expect("load key").as_deref(), Some(key));
        assert!(load_settings().expect("load").api_key_configured);

        let cleared = save_settings(
            settings_input("https://api.example.com/v1", "gpt-test"),
            Some("   ".into()),
        )
        .expect("clear key");
        assert!(!cleared.api_key_configured);
        assert!(load_secret_key().expect("load cleared").is_none());
        let _ = home;
    }

    #[test]
    fn settings_normalize_values_and_reject_bad_urls() {
        let _home = TestHome::new("settings-normalize");
        let mut input = settings_input("http://127.0.0.1:9999/v1", "m");
        input.language = "EN".into();
        input.style = "plain".into();
        input.max_subject_chars = 5;
        let saved = save_settings(input, None).expect("save normalized settings");
        assert_eq!(saved.language, "en");
        assert_eq!(saved.style, "plain");
        assert_eq!(saved.max_subject_chars, MIN_SUBJECT_CHARS);
        assert!(!saved.api_key_configured);
        assert!(save_settings(settings_input("http://example.com", "m"), None).is_err());
        assert!(save_settings(settings_input("https://api.example.com/v1", "  "), None).is_err());
    }

    #[test]
    fn redacts_bearer_sk_and_configured_key_values() {
        crate::git::isolate_test_git_environment();
        let key = "sk-live-configured-secret";
        let raw = format!(
            "HTTP 401: Authorization Bearer abcdef123456 failed; key={key}; token sk-proj-abcdefgh123456; api_key=plain-secret"
        );
        let safe = redact_ai_error(&raw, key);
        assert!(!safe.contains(key));
        assert!(!safe.contains("abcdef123456"));
        assert!(!safe.contains("sk-proj-abcdefgh123456"));
        assert!(!safe.contains("plain-secret"));
        assert!(safe.contains("[redacted]"));
        // 普通单词不受 sk- 规则误伤。
        assert_eq!(
            redact_ai_error("task-list is fine", ""),
            "task-list is fine"
        );
    }

    #[test]
    fn diff_context_prefers_staged_then_falls_back_to_worktree() {
        let repository = test_repository("diff-context");
        let root = repository.path.as_path();

        // 只有工作区改动：回退工作区并标记来源。
        fs::write(root.join("app.txt"), "line one\nworktree only\n").expect("write worktree");
        let context = collect_diff_context(root).expect("worktree context");
        assert_eq!(context.source, DiffSource::Worktree);
        assert!(context.text.contains("worktree only"));

        // 暂存一个改动后优先暂存区。
        git_ok(root, &["add", "app.txt"]);
        fs::write(
            root.join("app.txt"),
            "line one\nworktree only\nunstaged tail\n",
        )
        .expect("write unstaged");
        let context = collect_diff_context(root).expect("staged context");
        assert_eq!(context.source, DiffSource::Staged);
        assert!(context.text.contains("worktree only"));
        assert!(!context.text.contains("unstaged tail"));

        // 干净仓库必须明确报错。
        git_ok(root, &["reset", "--hard", "--quiet", "HEAD"]);
        assert!(collect_diff_context(root).is_err());
    }

    #[test]
    fn recent_titles_are_limited_to_five() {
        let repository = test_repository("recent-titles");
        let root = repository.path.as_path();
        for index in 0..7 {
            fs::write(root.join("app.txt"), format!("line {index}\n")).expect("write");
            git_ok(root, &["add", "app.txt"]);
            git_ok(
                root,
                &["commit", "--quiet", "-m", &format!("feat: change {index}")],
            );
        }
        let titles = recent_commit_titles(root);
        assert_eq!(titles.len(), 5);
        assert_eq!(titles.first().map(String::as_str), Some("feat: change 6"));
    }

    fn curl_available() -> bool {
        Command::new("curl")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    fn read_http_request(stream: &mut std::net::TcpStream) -> (String, String) {
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .expect("set timeout");
        let mut buffer: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let read = stream.read(&mut chunk).expect("read request");
            if read == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..read]);
            if let Some(header_end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&buffer[..header_end]).to_string();
                if headers
                    .to_ascii_lowercase()
                    .contains("expect: 100-continue")
                {
                    stream
                        .write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
                        .expect("write continue");
                    stream.flush().expect("flush continue");
                }
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        if name.eq_ignore_ascii_case("content-length") {
                            value.trim().parse::<usize>().ok()
                        } else {
                            None
                        }
                    })
                    .unwrap_or(0);
                let body_start = header_end + 4;
                while buffer.len() < body_start + content_length {
                    let read = stream.read(&mut chunk).expect("read body");
                    if read == 0 {
                        break;
                    }
                    buffer.extend_from_slice(&chunk[..read]);
                }
                let body_end = (body_start + content_length).min(buffer.len());
                return (
                    headers,
                    String::from_utf8_lossy(&buffer[body_start..body_end]).to_string(),
                );
            }
        }
        (String::new(), String::new())
    }

    #[test]
    fn generates_message_against_local_openai_compatible_server() {
        if !curl_available() {
            eprintln!(
                "跳过 generates_message_against_local_openai_compatible_server：系统未找到 curl"
            );
            return;
        }
        crate::git::isolate_test_git_environment();
        let _home = TestHome::new("http-e2e");
        let repository = test_repository("http-e2e-workspace");
        let root = repository.path.as_path();
        fs::write(root.join("app.txt"), "line one\nstaged change\n").expect("write change");
        git_ok(root, &["add", "app.txt"]);

        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind fake server");
        let port = listener.local_addr().expect("server addr").port();
        let (sender, receiver) = mpsc::channel::<(String, String)>();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let (headers, body) = read_http_request(&mut stream);
            let response_body = serde_json::json!({
                "choices": [{
                    "message": {
                        "content": "```\nfeat(ai): 接入提交消息生成助手，并补充本地服务端端到端测试以验证脱敏与截断行为\n\n- 新增 AI 设置存储\n- 生成提交消息\n```"
                    }
                }]
            })
            .to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
            let _ = sender.send((headers, body));
        });

        let key = "sk-test-local-secret-123456";
        save_settings(
            settings_input(&format!("http://127.0.0.1:{port}/v1"), "fake-model"),
            Some(key.into()),
        )
        .expect("save settings");

        let message = generate_message(
            root.to_string_lossy().as_ref(),
            &AiGenerateOptions {
                language: Some("zh".into()),
                style: Some("conventional".into()),
                include_body: Some(true),
                max_subject_chars: Some(40),
            },
        )
        .expect("generate message");

        server.join().expect("server thread");
        let (headers, body) = receiver.recv().expect("captured request");
        assert!(
            headers.starts_with("POST /v1/chat/completions "),
            "必须请求 OpenAI 兼容端点：{headers}"
        );
        assert!(
            headers.contains(&format!("Authorization: Bearer {key}")),
            "必须携带鉴权头"
        );
        assert!(!body.contains(key), "请求体不得包含 API Key");
        assert!(body.contains("staged change"), "请求体应包含暂存 diff");
        assert!(body.contains("messages"), "必须是 chat/completions 请求体");
        assert_eq!(message.model, "fake-model");
        assert!(message.subject.chars().count() <= 40);
        assert!(message.subject.starts_with("feat(ai)"));
        assert!(message
            .body
            .as_deref()
            .unwrap_or("")
            .contains("- 新增 AI 设置存储"));
        assert!(message.truncated, "subject 超过 40 字符应标记截断");
        assert!(message
            .note
            .as_deref()
            .unwrap_or("")
            .contains("subject 已截断"));
    }

    #[test]
    fn temporary_request_files_are_removed_on_drop() {
        crate::git::isolate_test_git_environment();
        let path = {
            let file = TempFile::create("request", b"{\"secret\":\"value\"}").expect("temp file");
            let path = file.path().to_path_buf();
            assert!(path.exists());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = fs::metadata(&path).expect("metadata").permissions().mode() & 0o777;
                assert_eq!(mode, 0o600, "临时请求体必须为 0600");
            }
            path
        };
        assert!(!path.exists(), "临时文件离开作用域后必须删除");
    }

    #[test]
    fn non_2xx_error_message_is_redacted() {
        if !curl_available() {
            eprintln!("跳过 non_2xx_error_message_is_redacted：系统未找到 curl");
            return;
        }
        crate::git::isolate_test_git_environment();
        let _home = TestHome::new("http-error");
        let repository = test_repository("http-error-workspace");
        let root = repository.path.as_path();
        fs::write(root.join("app.txt"), "line one\nerror change\n").expect("write change");
        git_ok(root, &["add", "app.txt"]);

        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind fake server");
        let port = listener.local_addr().expect("server addr").port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let _ = read_http_request(&mut stream);
            let response_body = serde_json::json!({
                "error": { "message": "invalid api key sk-test-local-secret-123456" }
            })
            .to_string();
            let response = format!(
                "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
        });

        let key = "sk-test-local-secret-123456";
        save_settings(
            settings_input(&format!("http://127.0.0.1:{port}/v1"), "fake-model"),
            Some(key.into()),
        )
        .expect("save settings");
        let error = generate_message(
            root.to_string_lossy().as_ref(),
            &AiGenerateOptions::default(),
        )
        .expect_err("401 必须失败");
        server.join().expect("server thread");
        assert!(!error.contains(key), "错误文本不得包含 API Key：{error}");
        assert!(error.contains("HTTP 401"));
        assert!(error.contains("[redacted]"));
    }
}
