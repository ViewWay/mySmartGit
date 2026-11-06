//! W4-2 内置终端 + 自定义命令流水线。
//!
//! 能力线：
//! 1. **内置终端**：在仓库根目录启动真实 PTY 会话（`portable-pty`），支持写入、
//!    调整窗口大小、增量读取（字节偏移）与关闭。输出缓冲上限 256 KiB，超出时
//!    丢弃最旧约 64 KiB 并显式标记 `truncated`；同时最多 8 个会话。
//! 2. **命令流水线**：用户在 `<branchline home>/commands.json`（0600）中维护
//!    「程序 + 参数数组」形式的命令，运行时不经过 shell，带 120 秒默认超时、
//!    可取消、stdout/stderr 分流捕获（各 256 KiB）与截断标记。
//!
//! 安全红线：
//! - 所有子进程都以**参数数组**启动，绝不拼接 shell 字符串，绝不使用 `sh -c`；
//! - 命令的 `cwdRelative` 只允许仓库内的相对路径；绝对路径、`..` 与符号链接逃逸
//!   一律拒绝；
//! - 允许把 `sh` / `bash` 等 shell 作为程序名保存，但其参数仍按字面数组传递；
//!   本模块不会替用户拼接 `-c` 参数，也不会把用户输入当脚本执行。
//! - 终端写入单次上限 64 KiB；流水线输出按 UTF-8 lossy 回传，不做 ANSI 清理。
//!
//! 集成约定：`#[tauri::command]` 包装函数位于文件末尾；本轮不修改
//! `lib.rs` / `commands.rs`，由集成轨道统一注册。

#![allow(dead_code)]

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/// 终端输出缓冲上限；超出后丢弃最旧数据。
const TERMINAL_BUFFER_LIMIT: usize = 256 * 1024;
/// 每次溢出时丢弃的旧数据量（约 64 KiB）。
const TERMINAL_TRIM_BYTES: usize = 64 * 1024;
/// 终端单次写入上限。
const MAX_TERMINAL_WRITE_BYTES: usize = 64 * 1024;
/// 同时打开的终端会话上限。
const MAX_TERMINAL_SESSIONS: usize = 8;
/// 终端读线程每次读取的块大小。
const TERMINAL_READ_CHUNK: usize = 8 * 1024;

/// 命令流水线默认超时。
const DEFAULT_COMMAND_TIMEOUT_SECS: u64 = 120;
/// 命令超时下限 / 上限（秒）。
const MIN_COMMAND_TIMEOUT_SECS: u64 = 1;
const MAX_COMMAND_TIMEOUT_SECS: u64 = 600;
/// 轮询子进程状态的间隔。
const COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(50);
/// stdout / stderr 各自保留的上限。
const COMMAND_OUTPUT_LIMIT: usize = 256 * 1024;
/// 命令配置文件上限。
const MAX_COMMANDS_FILE_BYTES: usize = 64 * 1024;
/// 单条命令的参数个数与单个参数长度上限。
const MAX_COMMAND_ARGS: usize = 64;
const MAX_COMMAND_ARG_CHARS: usize = 4096;
/// id / name / description / program / cwd 的长度上限。
const MAX_COMMAND_ID_CHARS: usize = 128;
const MAX_COMMAND_NAME_CHARS: usize = 200;
const MAX_COMMAND_DESCRIPTION_CHARS: usize = 2000;
const MAX_COMMAND_PROGRAM_CHARS: usize = 4096;
const MAX_COMMAND_CWD_CHARS: usize = 1024;
/// 前端可预置的 run id 形状限制（便于 cancel 精确定位）。
const MAX_RUN_ID_CHARS: usize = 64;

/// 允许以裸名字指定的 shell；绝对路径形式另行校验文件是否存在。
const ALLOWED_SHELLS: [&str; 7] = ["zsh", "bash", "sh", "fish", "pwsh", "powershell", "cmd"];

static SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);
static RUN_COUNTER: AtomicU64 = AtomicU64::new(1);

/// 终端会话注册表。
static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<TerminalSession>>>> = OnceLock::new();

/// 正在运行的流水线命令（run id -> 取消标记）。
static ACTIVE_RUNS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, Arc<TerminalSession>>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn active_runs() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    ACTIVE_RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 锁中毒不 panic：恢复内部数据继续使用。
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---------------------------------------------------------------------------
// 前端契约：终端
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    pub session_id: String,
    pub shell: String,
    pub cwd: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutput {
    pub data: String,
    /// 下次读取应传入的偏移（已写入缓冲的总字节数）。
    pub next_offset: u64,
    /// 请求的偏移已被丢弃，或缓冲区曾发生截断。
    pub truncated: bool,
    pub alive: bool,
    pub exit_code: Option<i32>,
}

struct SessionBuffer {
    data: Vec<u8>,
    /// 已被丢弃的字节数；也是当前缓冲首字节对应的偏移。
    discarded: u64,
    /// 累计写入缓冲的字节数（含已丢弃）。
    total: u64,
    /// 是否发生过丢弃。
    truncated: bool,
}

impl Default for SessionBuffer {
    fn default() -> Self {
        Self {
            data: Vec::new(),
            discarded: 0,
            total: 0,
            truncated: false,
        }
    }
}

impl SessionBuffer {
    fn append(&mut self, chunk: &[u8]) {
        self.data.extend_from_slice(chunk);
        self.total += chunk.len() as u64;
        while self.data.len() > TERMINAL_BUFFER_LIMIT {
            let drop_len = TERMINAL_TRIM_BYTES.min(self.data.len());
            self.data.drain(..drop_len);
            self.discarded += drop_len as u64;
            self.truncated = true;
        }
    }

    /// 返回 [from_offset, total) 的保留数据；from_offset 已丢弃时返回保留的尾部。
    fn snapshot(&self, from_offset: u64) -> (Vec<u8>, u64, bool) {
        let lost = from_offset < self.discarded;
        let start = from_offset.max(self.discarded).min(self.total);
        let index = (start - self.discarded).min(self.data.len() as u64) as usize;
        let mut index = index;
        // 避免从 UTF-8 多字节字符中间开始，减少替换字符。
        while index < self.data.len() && (self.data[index] & 0xC0) == 0x80 {
            index += 1;
        }
        (self.data[index..].to_vec(), self.total, lost)
    }
}

struct TerminalSession {
    info: TerminalSessionInfo,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
    buffer: Arc<Mutex<SessionBuffer>>,
    alive: Arc<AtomicBool>,
    exit_code: Arc<Mutex<Option<i32>>>,
}

impl TerminalSession {
    /// 幂等关闭：只真正 kill 一次。
    fn shutdown(&self) {
        self.alive.store(false, Ordering::SeqCst);
        let mut guard = lock(&self.killer);
        if let Some(mut killer) = guard.take() {
            let _ = killer.kill();
        }
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn session_handle(session_id: &str) -> Result<Arc<TerminalSession>, String> {
    lock(sessions())
        .get(session_id)
        .cloned()
        .ok_or_else(|| format!("终端会话不存在或已关闭：{session_id}"))
}

/// 校验并返回要启动的 shell。
///
/// 规则：传入值必须是非空的绝对路径（且是已存在的文件），或白名单中的裸名字。
/// 未传入时：Unix 用 `$SHELL`（需为绝对路径）或 `/bin/zsh`（缺失时回退
/// `/bin/bash`、`/bin/sh`）；Windows 用 `powershell.exe`。
fn resolve_shell(requested: Option<&str>) -> Result<String, String> {
    if let Some(raw) = requested {
        let value = raw.trim();
        if value.is_empty() {
            return Err("终端 Shell 不能为空".into());
        }
        let path = Path::new(value);
        if path.is_absolute() {
            if !path.is_file() {
                return Err(format!("Shell 路径不存在或不是文件：{value}"));
            }
            return Ok(value.to_string());
        }
        if value.contains('/') || value.contains('\\') {
            return Err(
                "Shell 必须是绝对路径，或 zsh/bash/sh/fish/pwsh/powershell/cmd 之一".into(),
            );
        }
        if ALLOWED_SHELLS
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(value))
        {
            return Ok(value.to_string());
        }
        return Err(format!(
            "不支持的 Shell：{value}。请使用绝对路径，或 zsh/bash/sh/fish/pwsh/powershell/cmd 之一"
        ));
    }
    #[cfg(target_os = "windows")]
    {
        Ok("powershell.exe".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(shell) = std::env::var_os("SHELL") {
            let path = PathBuf::from(&shell);
            if !shell.is_empty() && path.is_absolute() && path.is_file() {
                return Ok(path.to_string_lossy().into_owned());
            }
        }
        for candidate in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
            if Path::new(candidate).is_file() {
                return Ok(candidate.to_string());
            }
        }
        Err("找不到可用的 Shell，请显式指定绝对路径".into())
    }
}

fn resolve_repository_root(repository_path: &str) -> Result<PathBuf, String> {
    let root = crate::git::repository_root(repository_path)?;
    if !root.is_dir() {
        return Err("仓库根目录不存在".into());
    }
    Ok(root)
}

fn terminal_size(cols: u16, rows: u16) -> Result<PtySize, String> {
    if cols == 0 || rows == 0 {
        return Err("终端尺寸必须大于 0".into());
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

fn next_session_id() -> String {
    format!("term-{}", SESSION_COUNTER.fetch_add(1, Ordering::SeqCst))
}

/// 启动终端会话。调用方负责在结束时 `close_terminal_session`。
pub fn start_terminal_session_impl(
    repository_path: &str,
    shell: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<TerminalSessionInfo, String> {
    let root = resolve_repository_root(repository_path)?;
    let program = resolve_shell(shell.as_deref())?;
    let size = terminal_size(cols, rows)?;

    // 持有注册表锁完成「计数检查 + 启动」，避免并发启动越过上限。
    let mut registry = lock(sessions());
    if registry.len() >= MAX_TERMINAL_SESSIONS {
        return Err(format!(
            "最多同时打开 {MAX_TERMINAL_SESSIONS} 个终端会话，请先关闭一个"
        ));
    }

    let pair = native_pty_system()
        .openpty(size)
        .map_err(|error| format!("创建终端失败：{error}"))?;

    let mut builder = CommandBuilder::new(&program);
    builder.cwd(&root);
    builder.env("TERM", "xterm-256color");
    let mut child = pair
        .slave
        .spawn_command(builder)
        .map_err(|error| format!("启动终端 Shell 失败：{error}"))?;
    // 子进程已启动，slave 端不再需要。
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("读取终端输出失败：{error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("连接终端输入失败：{error}"))?;
    let killer = child.clone_killer();

    let session_id = next_session_id();
    let info = TerminalSessionInfo {
        session_id: session_id.clone(),
        shell: program,
        cwd: root.to_string_lossy().into_owned(),
    };
    let buffer = Arc::new(Mutex::new(SessionBuffer::default()));
    let alive = Arc::new(AtomicBool::new(true));
    let exit_code = Arc::new(Mutex::new(None));

    let reader_buffer = Arc::clone(&buffer);
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut chunk = [0u8; TERMINAL_READ_CHUNK];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => lock(&reader_buffer).append(&chunk[..read]),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    });

    let wait_alive = Arc::clone(&alive);
    let wait_exit_code = Arc::clone(&exit_code);
    std::thread::spawn(move || {
        let code = match child.wait() {
            // 被信号终止（如 kill）时不伪造退出码，交由 timed_out/alive 状态表达。
            Ok(status) => status.signal().is_none().then(|| status.exit_code() as i32),
            Err(_) => None,
        };
        *lock(&wait_exit_code) = code;
        wait_alive.store(false, Ordering::SeqCst);
    });

    let session = Arc::new(TerminalSession {
        info: info.clone(),
        master: Mutex::new(pair.master),
        writer: Mutex::new(Some(writer)),
        killer: Mutex::new(Some(killer)),
        buffer,
        alive,
        exit_code,
    });
    registry.insert(session_id, session);
    Ok(info)
}

pub fn read_terminal_output_impl(
    session_id: &str,
    from_offset: u64,
) -> Result<TerminalOutput, String> {
    let session = session_handle(session_id)?;
    let (bytes, next_offset, lost) = lock(&session.buffer).snapshot(from_offset);
    let exit_code = *lock(&session.exit_code);
    Ok(TerminalOutput {
        data: String::from_utf8_lossy(&bytes).into_owned(),
        next_offset,
        truncated: lost,
        alive: session.alive.load(Ordering::SeqCst),
        exit_code,
    })
}

pub fn write_terminal_impl(session_id: &str, data: &str) -> Result<(), String> {
    if data.len() > MAX_TERMINAL_WRITE_BYTES {
        return Err("单次写入终端的数据不能超过 64 KiB".into());
    }
    let session = session_handle(session_id)?;
    let mut guard = lock(&session.writer);
    let writer = guard
        .as_mut()
        .ok_or_else(|| "终端已关闭，无法写入".to_string())?;
    writer
        .write_all(data.as_bytes())
        .map_err(|error| format!("写入终端失败：{error}"))?;
    writer
        .flush()
        .map_err(|error| format!("写入终端失败：{error}"))
}

pub fn resize_terminal_impl(session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let size = terminal_size(cols, rows)?;
    let session = session_handle(session_id)?;
    let result = lock(&session.master)
        .resize(size)
        .map_err(|error| format!("调整终端尺寸失败：{error}"));
    result
}

pub fn close_terminal_session_impl(session_id: &str) -> bool {
    // 先释放注册表锁，再 kill（部分平台 kill 会等待子进程退出）。
    let session = lock(sessions()).remove(session_id);
    match session {
        Some(session) => {
            session.shutdown();
            true
        }
        None => false,
    }
}

pub fn list_terminal_sessions_impl() -> Vec<TerminalSessionInfo> {
    let mut sessions: Vec<TerminalSessionInfo> = lock(sessions())
        .values()
        .map(|session| session.info.clone())
        .collect();
    sessions.sort_by(|left, right| left.session_id.cmp(&right.session_id));
    sessions
}

// ---------------------------------------------------------------------------
// 前端契约：命令流水线
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PipelineCommand {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd_relative: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct PipelineCommands {
    pub commands: Vec<PipelineCommand>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandRunReport {
    pub run_id: String,
    pub command_id: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub cancelled: bool,
    pub duration_ms: u64,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
}

// ---------------------------------------------------------------------------
// 命令配置存储（0600 JSON）
// ---------------------------------------------------------------------------

fn branchline_home() -> Result<PathBuf, String> {
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

fn commands_path() -> Result<PathBuf, String> {
    Ok(branchline_home()?.join("commands.json"))
}

fn read_commands_file(path: &Path) -> Result<PipelineCommands, String> {
    if !path.exists() {
        return Ok(PipelineCommands::default());
    }
    let bytes = fs::read(path).map_err(|error| format!("读取命令配置失败：{error}"))?;
    if bytes.len() > MAX_COMMANDS_FILE_BYTES {
        return Err("命令配置文件超过 64 KiB，已拒绝读取".into());
    }
    if bytes.iter().all(|byte| byte.is_ascii_whitespace()) {
        return Ok(PipelineCommands::default());
    }
    let parsed: PipelineCommands = serde_json::from_slice(&bytes)
        .map_err(|_| "命令配置文件格式无效，请修复或删除后重试".to_string())?;
    validate_pipeline_commands(&parsed)?;
    Ok(parsed)
}

fn write_commands_file(path: &Path, commands: &PipelineCommands) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or_else(|| "命令配置路径无效".to_string())?;
    fs::create_dir_all(directory).map_err(|error| format!("创建配置目录失败：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(directory, fs::Permissions::from_mode(0o700));
    }
    let bytes = serde_json::to_vec_pretty(commands)
        .map_err(|error| format!("序列化命令配置失败：{error}"))?;
    let temp_name = format!(
        ".commands.json.tmp-{}-{}",
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
            .map_err(|error| format!("创建命令配置临时文件失败：{error}"))?;
        handle
            .write_all(&bytes)
            .map_err(|error| format!("写入命令配置失败：{error}"))?;
        handle
            .sync_all()
            .map_err(|error| format!("保存命令配置失败：{error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("设置命令配置文件权限失败：{error}"))?;
        }
        #[cfg(target_os = "windows")]
        {
            let _ = fs::remove_file(path);
        }
        fs::rename(&temp_path, path).map_err(|error| format!("保存命令配置失败：{error}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

pub fn load_pipeline_commands_impl() -> Result<PipelineCommands, String> {
    read_commands_file(&commands_path()?)
}

pub fn save_pipeline_commands_impl(commands: PipelineCommands) -> Result<PipelineCommands, String> {
    let normalized = normalize_pipeline_commands(commands);
    validate_pipeline_commands(&normalized)?;
    let size = serde_json::to_vec_pretty(&normalized)
        .map_err(|error| format!("序列化命令配置失败：{error}"))?
        .len();
    if size > MAX_COMMANDS_FILE_BYTES {
        return Err("命令配置总大小超过 64 KiB，请减少命令或缩短参数".into());
    }
    write_commands_file(&commands_path()?, &normalized)?;
    Ok(normalized)
}

fn normalize_pipeline_commands(commands: PipelineCommands) -> PipelineCommands {
    PipelineCommands {
        commands: commands
            .commands
            .into_iter()
            .map(|command| PipelineCommand {
                id: command.id.trim().to_string(),
                name: command.name.trim().to_string(),
                description: command.description.trim().to_string(),
                program: command.program.trim().to_string(),
                args: command.args,
                cwd_relative: command
                    .cwd_relative
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
            })
            .collect(),
    }
}

fn has_control_characters(value: &str) -> bool {
    value.chars().any(|character| character.is_control())
}

fn validate_pipeline_commands(commands: &PipelineCommands) -> Result<(), String> {
    let mut ids = HashSet::new();
    for command in &commands.commands {
        if command.id.trim().is_empty() {
            return Err("命令 id 不能为空".into());
        }
        if command.id.chars().count() > MAX_COMMAND_ID_CHARS {
            return Err(format!("命令 id 过长（上限 {MAX_COMMAND_ID_CHARS} 字符）"));
        }
        if has_control_characters(&command.id) {
            return Err("命令 id 不能包含控制字符".into());
        }
        if !ids.insert(command.id.as_str()) {
            return Err(format!("命令 id 重复：{}", command.id));
        }
        if command.name.trim().is_empty() {
            return Err(format!("命令「{}」的名称不能为空", command.id));
        }
        if command.name.chars().count() > MAX_COMMAND_NAME_CHARS {
            return Err(format!(
                "命令「{}」的名称过长（上限 {MAX_COMMAND_NAME_CHARS} 字符）",
                command.id
            ));
        }
        if has_control_characters(&command.name) {
            return Err(format!("命令「{}」的名称不能包含控制字符", command.id));
        }
        if command.description.chars().count() > MAX_COMMAND_DESCRIPTION_CHARS {
            return Err(format!(
                "命令「{}」的描述过长（上限 {MAX_COMMAND_DESCRIPTION_CHARS} 字符）",
                command.id
            ));
        }
        if command.description.contains('\0') {
            return Err(format!("命令「{}」的描述不能包含 NUL", command.id));
        }
        if command.program.trim().is_empty() {
            return Err(format!("命令「{}」的程序不能为空", command.id));
        }
        if command.program.chars().count() > MAX_COMMAND_PROGRAM_CHARS {
            return Err(format!(
                "命令「{}」的程序路径过长（上限 {MAX_COMMAND_PROGRAM_CHARS} 字符）",
                command.id
            ));
        }
        if has_control_characters(&command.program) {
            return Err(format!("命令「{}」的程序不能包含控制字符", command.id));
        }
        if command.args.len() > MAX_COMMAND_ARGS {
            return Err(format!(
                "命令「{}」的参数过多（上限 {MAX_COMMAND_ARGS} 个）",
                command.id
            ));
        }
        for argument in &command.args {
            if argument.chars().count() > MAX_COMMAND_ARG_CHARS {
                return Err(format!(
                    "命令「{}」的单个参数过长（上限 {MAX_COMMAND_ARG_CHARS} 字符）",
                    command.id
                ));
            }
            if argument.contains('\0') {
                return Err(format!("命令「{}」的参数不能包含 NUL", command.id));
            }
        }
        if let Some(cwd) = &command.cwd_relative {
            if cwd.chars().count() > MAX_COMMAND_CWD_CHARS {
                return Err(format!(
                    "命令「{}」的工作目录过长（上限 {MAX_COMMAND_CWD_CHARS} 字符）",
                    command.id
                ));
            }
            validate_relative_directory(cwd)
                .map_err(|error| format!("命令「{}」的工作目录无效：{error}", command.id))?;
        }
    }
    Ok(())
}

/// `cwdRelative` 只允许仓库内的相对路径：拒绝绝对路径、前缀、`..` 与其他非普通组件。
fn validate_relative_directory(raw: &str) -> Result<(), String> {
    let value = raw.trim();
    if value.is_empty() {
        return Ok(());
    }
    if has_control_characters(value) {
        return Err("路径不能包含控制字符".into());
    }
    let path = Path::new(value);
    if path.is_absolute() {
        return Err("必须是仓库内的相对路径，不能是绝对路径".into());
    }
    for component in path.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir => return Err("不能包含 ..，工作目录必须位于仓库内".into()),
            Component::RootDir | Component::Prefix(_) => {
                return Err("必须是仓库内的相对路径".into())
            }
        }
    }
    Ok(())
}

fn resolve_command_cwd(root: &Path, cwd_relative: Option<&str>) -> Result<PathBuf, String> {
    let canonical_root =
        fs::canonicalize(root).map_err(|error| format!("无法解析仓库根目录：{error}"))?;
    let Some(raw) = cwd_relative else {
        return Ok(canonical_root);
    };
    let value = raw.trim();
    if value.is_empty() {
        return Ok(canonical_root);
    }
    validate_relative_directory(value)?;
    let candidate = canonical_root.join(value);
    let canonical =
        fs::canonicalize(&candidate).map_err(|_| format!("命令工作目录不存在：{value}"))?;
    if !canonical.starts_with(&canonical_root) {
        return Err("命令工作目录必须位于仓库内".into());
    }
    if !canonical.is_dir() {
        return Err(format!("命令工作目录不是目录：{value}"));
    }
    Ok(canonical)
}

// ---------------------------------------------------------------------------
// 命令执行
// ---------------------------------------------------------------------------

struct CaptureResult {
    bytes: Vec<u8>,
    truncated: bool,
}

fn spawn_capture<R>(mut reader: R, limit: usize) -> std::thread::JoinHandle<CaptureResult>
where
    R: Read + Send + 'static,
{
    std::thread::spawn(move || {
        let mut collected = Vec::new();
        let mut truncated = false;
        let mut chunk = [0u8; 8 * 1024];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => {
                    if collected.len() < limit {
                        let remaining = limit - collected.len();
                        let take = remaining.min(read);
                        collected.extend_from_slice(&chunk[..take]);
                        if take < read {
                            truncated = true;
                        }
                    } else {
                        // 达到上限后继续读并丢弃，避免子进程写满管道死锁。
                        truncated = true;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        CaptureResult {
            bytes: collected,
            truncated,
        }
    })
}

fn join_capture(handle: std::thread::JoinHandle<CaptureResult>) -> CaptureResult {
    handle.join().unwrap_or(CaptureResult {
        bytes: Vec::new(),
        truncated: false,
    })
}

/// 登记一次运行，Drop 时自动从注册表移除，避免错误路径泄漏。
struct RunRegistration {
    run_id: String,
    flag: Arc<AtomicBool>,
}

impl RunRegistration {
    fn new(requested: Option<&str>) -> Result<Self, String> {
        let run_id = match requested {
            Some(value) => {
                let value = value.trim();
                if value.is_empty()
                    || value.chars().count() > MAX_RUN_ID_CHARS
                    || !value.chars().all(|character| {
                        character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
                    })
                {
                    return Err("runId 只能包含字母、数字、- 和 _，且长度不超过 64".into());
                }
                value.to_string()
            }
            None => format!("run-{}", RUN_COUNTER.fetch_add(1, Ordering::SeqCst)),
        };
        if lock(active_runs()).contains_key(&run_id) {
            return Err(format!("runId 已在运行中：{run_id}"));
        }
        let flag = Arc::new(AtomicBool::new(false));
        lock(active_runs()).insert(run_id.clone(), Arc::clone(&flag));
        Ok(Self { run_id, flag })
    }
}

impl Drop for RunRegistration {
    fn drop(&mut self) {
        lock(active_runs()).remove(&self.run_id);
    }
}

fn resolve_timeout(timeout_seconds: Option<u64>) -> Duration {
    Duration::from_secs(
        timeout_seconds
            .unwrap_or(DEFAULT_COMMAND_TIMEOUT_SECS)
            .clamp(MIN_COMMAND_TIMEOUT_SECS, MAX_COMMAND_TIMEOUT_SECS),
    )
}

fn find_pipeline_command<'a>(
    commands: &'a PipelineCommands,
    command_id: &str,
) -> Result<&'a PipelineCommand, String> {
    commands
        .commands
        .iter()
        .find(|command| command.id == command_id.trim())
        .ok_or_else(|| format!("未找到命令：{command_id}"))
}

fn execute_pipeline_command(
    repository_path: &str,
    command: &PipelineCommand,
    timeout_seconds: Option<u64>,
    requested_run_id: Option<&str>,
) -> Result<CommandRunReport, String> {
    let root = resolve_repository_root(repository_path)?;
    let cwd = resolve_command_cwd(&root, command.cwd_relative.as_deref())?;
    let timeout = resolve_timeout(timeout_seconds);
    let registration = RunRegistration::new(requested_run_id)?;

    let mut builder = Command::new(&command.program);
    builder
        .args(&command.args)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    builder.creation_flags(0x08000000);

    let started = Instant::now();
    let mut child = builder
        .spawn()
        .map_err(|error| format!("无法启动命令「{}」：{error}", command.program))?;
    let stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| "无法捕获命令 stdout".to_string())?;
    let stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| "无法捕获命令 stderr".to_string())?;
    let stdout_handle = spawn_capture(stdout_pipe, COMMAND_OUTPUT_LIMIT);
    let stderr_handle = spawn_capture(stderr_pipe, COMMAND_OUTPUT_LIMIT);

    let mut timed_out = false;
    let mut cancelled = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(_) => {
                let _ = child.kill();
                break child.wait().ok();
            }
        }
        if registration.flag.load(Ordering::SeqCst) {
            cancelled = true;
            let _ = child.kill();
            break child.wait().ok();
        }
        if started.elapsed() >= timeout {
            timed_out = true;
            let _ = child.kill();
            break child.wait().ok();
        }
        std::thread::sleep(COMMAND_POLL_INTERVAL);
    };

    let duration_ms = started.elapsed().as_millis() as u64;
    let stdout = join_capture(stdout_handle);
    let stderr = join_capture(stderr_handle);
    let exit_code = status.and_then(|status| status.code());

    Ok(CommandRunReport {
        run_id: registration.run_id.clone(),
        command_id: command.id.clone(),
        exit_code,
        timed_out,
        cancelled,
        duration_ms,
        stdout: String::from_utf8_lossy(&stdout.bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr.bytes).into_owned(),
        truncated: stdout.truncated || stderr.truncated,
    })
}

fn run_pipeline_command_with_commands(
    repository_path: &str,
    commands: &PipelineCommands,
    command_id: &str,
    timeout_seconds: Option<u64>,
    run_id: Option<&str>,
) -> Result<CommandRunReport, String> {
    let command = find_pipeline_command(commands, command_id)?;
    execute_pipeline_command(repository_path, command, timeout_seconds, run_id)
}

pub fn run_pipeline_command_impl(
    repository_path: &str,
    command_id: &str,
    timeout_seconds: Option<u64>,
    run_id: Option<String>,
) -> Result<CommandRunReport, String> {
    let commands = load_pipeline_commands_impl()?;
    run_pipeline_command_with_commands(
        repository_path,
        &commands,
        command_id,
        timeout_seconds,
        run_id.as_deref(),
    )
}

pub fn cancel_pipeline_command_impl(run_id: &str) -> bool {
    match lock(active_runs()).get(run_id.trim()) {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Tauri 命令包装（集成轨道在 lib.rs / commands.rs 注册）
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn start_terminal_session(
    repository_path: String,
    shell: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<TerminalSessionInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        start_terminal_session_impl(&repository_path, shell, cols, rows)
    })
    .await
    .map_err(|error| format!("启动终端会话失败：{error}"))?
}

#[tauri::command]
pub async fn read_terminal_output(
    session_id: String,
    from_offset: u64,
) -> Result<TerminalOutput, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_terminal_output_impl(&session_id, from_offset)
    })
    .await
    .map_err(|error| format!("读取终端输出失败：{error}"))?
}

#[tauri::command]
pub async fn write_terminal(session_id: String, data: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_terminal_impl(&session_id, &data))
        .await
        .map_err(|error| format!("写入终端失败：{error}"))?
}

#[tauri::command]
pub async fn resize_terminal(session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || resize_terminal_impl(&session_id, cols, rows))
        .await
        .map_err(|error| format!("调整终端尺寸失败：{error}"))?
}

#[tauri::command]
pub async fn close_terminal_session(session_id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || close_terminal_session_impl(&session_id))
        .await
        .map_err(|error| format!("关闭终端会话失败：{error}"))
}

#[tauri::command]
pub async fn list_terminal_sessions() -> Result<Vec<TerminalSessionInfo>, String> {
    tauri::async_runtime::spawn_blocking(list_terminal_sessions_impl)
        .await
        .map_err(|error| format!("读取终端会话列表失败：{error}"))
}

#[tauri::command]
pub async fn load_pipeline_commands() -> Result<PipelineCommands, String> {
    tauri::async_runtime::spawn_blocking(load_pipeline_commands_impl)
        .await
        .map_err(|error| format!("读取命令流水线配置失败：{error}"))?
}

#[tauri::command]
pub async fn save_pipeline_commands(
    commands: PipelineCommands,
) -> Result<PipelineCommands, String> {
    tauri::async_runtime::spawn_blocking(move || save_pipeline_commands_impl(commands))
        .await
        .map_err(|error| format!("保存命令流水线配置失败：{error}"))?
}

#[tauri::command]
pub async fn run_pipeline_command(
    repository_path: String,
    command_id: String,
    timeout_seconds: Option<u64>,
    run_id: Option<String>,
) -> Result<CommandRunReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_pipeline_command_impl(&repository_path, &command_id, timeout_seconds, run_id)
    })
    .await
    .map_err(|error| format!("执行命令流水线失败：{error}"))?
}

#[tauri::command]
pub async fn cancel_pipeline_command(run_id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || cancel_pipeline_command_impl(&run_id))
        .await
        .map_err(|error| format!("取消命令流水线失败：{error}"))
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use super::{
        cancel_pipeline_command_impl as cancel_pipeline_command,
        close_terminal_session_impl as close_terminal_session,
        list_terminal_sessions_impl as list_terminal_sessions,
        read_terminal_output_impl as read_terminal_output, resize_terminal_impl as resize_terminal,
        start_terminal_session_impl as start_terminal_session,
        write_terminal_impl as write_terminal,
    };
    use std::sync::MutexGuard;

    // 终端会话共享全局注册表，用例必须串行。
    fn session_guard() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    struct TestRepository {
        path: PathBuf,
    }

    impl Drop for TestRepository {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn unique_directory(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let mut sequence = 0u64;
        loop {
            let candidate = std::env::temp_dir().join(format!(
                "branchline-terminal-{label}-{}-{nanos}-{sequence}",
                std::process::id()
            ));
            match fs::create_dir(&candidate) {
                Ok(()) => return candidate,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    sequence += 1;
                }
                Err(error) => panic!("create test directory: {error}"),
            }
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
        let path = unique_directory(&format!("{label}-repo"));
        git_ok(&path, &["init", "--quiet"]);
        fs::write(path.join("app.txt"), "line one\n").expect("write fixture");
        TestRepository { path }
    }

    fn repo_string(repository: &TestRepository) -> String {
        repository.path.to_string_lossy().into_owned()
    }

    fn command(id: &str, program: &str, args: &[&str]) -> PipelineCommand {
        PipelineCommand {
            id: id.to_string(),
            name: format!("{id} 命令"),
            description: String::new(),
            program: program.to_string(),
            args: args.iter().map(|value| value.to_string()).collect(),
            cwd_relative: None,
        }
    }

    fn commands(items: Vec<PipelineCommand>) -> PipelineCommands {
        PipelineCommands { commands: items }
    }

    // ------------------------------------------------------------ shell 校验

    #[test]
    fn shell_validation_accepts_whitelist_and_existing_absolute_paths() {
        assert_eq!(resolve_shell(Some("bash")).expect("bash"), "bash");
        assert_eq!(resolve_shell(Some("ZSH")).expect("zsh"), "ZSH");
        #[cfg(unix)]
        {
            assert_eq!(resolve_shell(Some("/bin/sh")).expect("/bin/sh"), "/bin/sh");
            assert!(resolve_shell(Some("/bin/definitely-not-a-shell")).is_err());
        }
        for rejected in [
            "",
            "   ",
            "sh -c",
            "bin/sh",
            "./sh",
            "unknown-shell",
            "bash\nrm",
        ] {
            assert!(
                resolve_shell(Some(rejected)).is_err(),
                "shell {rejected:?} 应被拒绝"
            );
        }
    }

    #[test]
    fn terminal_size_must_be_positive() {
        assert!(terminal_size(80, 24).is_ok());
        assert!(terminal_size(0, 24).is_err());
        assert!(terminal_size(80, 0).is_err());
    }

    // ------------------------------------------------------------ PTY 生命周期

    #[cfg(unix)]
    #[test]
    fn pty_session_prints_marker_and_supports_incremental_reads() {
        let _guard = session_guard();
        let repository = test_repository("marker");
        let info =
            start_terminal_session(&repo_string(&repository), Some("/bin/sh".into()), 80, 24)
                .expect("start session");
        assert_eq!(info.shell, "/bin/sh");
        assert!(info.session_id.starts_with("term-"));
        assert_eq!(
            list_terminal_sessions()
                .iter()
                .filter(|session| session.session_id == info.session_id)
                .count(),
            1
        );

        write_terminal(&info.session_id, "echo BRANCHLINE_MARKER_ONE\n").expect("write marker");
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut collected = String::new();
        let mut offset = 0;
        while Instant::now() < deadline && !collected.contains("BRANCHLINE_MARKER_ONE") {
            std::thread::sleep(Duration::from_millis(40));
            let output = read_terminal_output(&info.session_id, offset).expect("read");
            assert!(output.next_offset >= offset);
            offset = output.next_offset;
            collected.push_str(&output.data);
        }
        assert!(
            collected.contains("BRANCHLINE_MARKER_ONE"),
            "未读到标记输出：{collected:?}"
        );

        // 从旧偏移重复读取必须仍能拿到保留缓冲；新偏移只返回增量。
        let retained = read_terminal_output(&info.session_id, 0).expect("re-read");
        assert!(retained.data.contains("BRANCHLINE_MARKER_ONE"));
        let empty = read_terminal_output(&info.session_id, offset).expect("increment");
        assert!(empty.next_offset >= offset);
        assert!(empty.data.len() <= retained.data.len());

        assert!(close_terminal_session(&info.session_id));
        assert!(!close_terminal_session(&info.session_id));
        assert!(read_terminal_output(&info.session_id, 0).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn pty_resize_write_and_exit_code_round_trip() {
        let _guard = session_guard();
        let repository = test_repository("exit");
        let info =
            start_terminal_session(&repo_string(&repository), Some("/bin/sh".into()), 80, 24)
                .expect("start session");
        resize_terminal(&info.session_id, 120, 40).expect("resize");
        assert!(resize_terminal(&info.session_id, 0, 40).is_err());

        write_terminal(&info.session_id, "exit 7\n").expect("exit");
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut final_output = None;
        while Instant::now() < deadline {
            let output = read_terminal_output(&info.session_id, 0).expect("read");
            if !output.alive {
                final_output = Some(output);
                break;
            }
            std::thread::sleep(Duration::from_millis(40));
        }
        let output = final_output.expect("shell 应在超时前退出");
        assert_eq!(output.exit_code, Some(7));
        assert!(close_terminal_session(&info.session_id));
    }

    #[cfg(unix)]
    #[test]
    fn pty_rejects_ninth_session_and_cleans_up() {
        let _guard = session_guard();
        let repository = test_repository("max");
        let path = repo_string(&repository);
        let mut opened = Vec::new();
        for index in 0..MAX_TERMINAL_SESSIONS {
            match start_terminal_session(&path, Some("/bin/sh".into()), 80, 24) {
                Ok(info) => opened.push(info),
                Err(error) => panic!("第 {} 个会话应成功：{error}", index + 1),
            }
        }
        let error = start_terminal_session(&path, Some("/bin/sh".into()), 80, 24)
            .expect_err("第 9 个会话应被拒绝");
        assert!(error.contains("最多同时打开"), "{error}");
        for info in opened {
            assert!(close_terminal_session(&info.session_id));
        }
        assert!(start_terminal_session(&path, Some("/bin/sh".into()), 80, 24).is_ok());
        // 清理最后一个，避免影响后续用例。
        let remaining = list_terminal_sessions();
        for info in remaining {
            close_terminal_session(&info.session_id);
        }
    }

    #[test]
    fn buffer_drops_oldest_data_and_reports_truncation() {
        let mut buffer = SessionBuffer::default();
        buffer.append(&vec![b'a'; TERMINAL_BUFFER_LIMIT]);
        assert!(!buffer.truncated);
        buffer.append(b"tail");
        assert!(buffer.truncated);
        assert!(buffer.data.len() <= TERMINAL_BUFFER_LIMIT);
        assert!(buffer.discarded >= TERMINAL_TRIM_BYTES as u64);

        let (_, next, lost) = buffer.snapshot(0);
        assert!(lost, "请求已丢弃的偏移必须标记 truncated");
        assert_eq!(next, buffer.total);
        let (tail, _, lost) = buffer.snapshot(buffer.discarded);
        assert!(!lost);
        assert_eq!(tail.last(), Some(&b'l'));
    }

    // ------------------------------------------------------------ 命令校验

    #[test]
    fn pipeline_validation_rejects_bad_shapes() {
        let mut empty_id = command("", "/bin/echo", &["hi"]);
        assert!(validate_pipeline_commands(&commands(vec![empty_id.clone()])).is_err());
        empty_id.id = "ok".into();

        let mut empty_name = empty_id.clone();
        empty_name.name = "   ".into();
        assert!(validate_pipeline_commands(&commands(vec![empty_name])).is_err());

        let mut empty_program = empty_id.clone();
        empty_program.program = "  ".into();
        assert!(validate_pipeline_commands(&commands(vec![empty_program])).is_err());

        let mut duplicate = commands(vec![empty_id.clone(), empty_id.clone()]);
        assert!(validate_pipeline_commands(&duplicate).is_err());
        duplicate.commands[1].id = "other".into();
        assert!(validate_pipeline_commands(&duplicate).is_ok());

        let mut too_many_args = empty_id.clone();
        too_many_args.args = vec!["x".into(); MAX_COMMAND_ARGS + 1];
        assert!(validate_pipeline_commands(&commands(vec![too_many_args])).is_err());

        let mut long_arg = empty_id.clone();
        long_arg.args = vec!["x".repeat(MAX_COMMAND_ARG_CHARS + 1)];
        assert!(validate_pipeline_commands(&commands(vec![long_arg])).is_err());

        let mut nul_arg = empty_id.clone();
        nul_arg.args = vec!["a\0b".into()];
        assert!(validate_pipeline_commands(&commands(vec![nul_arg])).is_err());

        let mut bad_cwd = empty_id.clone();
        bad_cwd.cwd_relative = Some("../outside".into());
        assert!(validate_pipeline_commands(&commands(vec![bad_cwd])).is_err());
    }

    #[test]
    fn pipeline_normalization_trims_fields_and_drops_empty_cwd() {
        let normalized = normalize_pipeline_commands(commands(vec![PipelineCommand {
            id: "  status  ".into(),
            name: "  查看状态 ".into(),
            description: "  desc  ".into(),
            program: " git ".into(),
            args: vec![" status ".into()],
            cwd_relative: Some("   ".into()),
        }]));
        let item = &normalized.commands[0];
        assert_eq!(item.id, "status");
        assert_eq!(item.name, "查看状态");
        assert_eq!(item.description, "desc");
        assert_eq!(item.program, "git");
        assert_eq!(item.args, vec![" status "]);
        assert_eq!(item.cwd_relative, None);
    }

    #[test]
    fn relative_cwd_rejects_escapes_and_accepts_nested_directory() {
        let repository = test_repository("cwd");
        let root = repository.path.as_path();
        fs::create_dir_all(root.join("packages/app")).expect("create nested dir");

        assert!(resolve_command_cwd(root, None).is_ok());
        assert!(resolve_command_cwd(root, Some("packages/app")).is_ok());
        assert!(resolve_command_cwd(root, Some("./packages/app")).is_ok());
        assert!(resolve_command_cwd(root, Some("../")).is_err());
        assert!(resolve_command_cwd(root, Some("packages/../../outside")).is_err());
        assert!(resolve_command_cwd(root, Some(root.to_string_lossy().as_ref())).is_err());
        assert!(resolve_command_cwd(root, Some("missing-dir")).is_err());
        assert!(resolve_command_cwd(root, Some("packages/./app")).is_ok());

        #[cfg(unix)]
        {
            // 符号链接指向仓库外时必须拒绝。
            let outside = unique_directory("outside");
            std::os::unix::fs::symlink(&outside, root.join("escape")).expect("symlink");
            assert!(resolve_command_cwd(root, Some("escape")).is_err());
            let _ = fs::remove_dir_all(&outside);
        }
    }

    // ------------------------------------------------------------ 命令执行

    #[cfg(unix)]
    #[test]
    fn pipeline_runs_program_with_literal_args_and_captures_output() {
        let repository = test_repository("echo");
        let list = commands(vec![command(
            "echo",
            "/bin/echo",
            &["hello", "pipeline", "with space"],
        )]);
        let report = run_pipeline_command_with_commands(
            &repo_string(&repository),
            &list,
            "echo",
            None,
            None,
        )
        .expect("run echo");
        assert_eq!(report.exit_code, Some(0));
        assert_eq!(report.stdout, "hello pipeline with space\n");
        assert!(report.stderr.is_empty());
        assert!(!report.timed_out);
        assert!(!report.cancelled);
        assert!(!report.truncated);
        assert_eq!(report.command_id, "echo");
        assert!(report.run_id.starts_with("run-"));
    }

    #[test]
    fn pipeline_unknown_command_is_rejected_without_spawning() {
        let repository = test_repository("unknown");
        let error = run_pipeline_command_with_commands(
            &repo_string(&repository),
            &commands(vec![command("known", "/bin/echo", &["hi"])]),
            "missing",
            None,
            None,
        )
        .expect_err("未知命令必须报错");
        assert!(error.contains("未找到命令"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn pipeline_timeout_kills_the_command() {
        let repository = test_repository("timeout");
        let list = commands(vec![command("slow", "/bin/sleep", &["5"])]);
        let started = Instant::now();
        let report = run_pipeline_command_with_commands(
            &repo_string(&repository),
            &list,
            "slow",
            Some(1),
            None,
        )
        .expect("run sleep");
        let elapsed = started.elapsed();
        assert!(report.timed_out, "超时必须标记 timed_out：{report:?}");
        assert!(!report.cancelled);
        assert!(
            elapsed >= Duration::from_millis(900),
            "超时过早：{elapsed:?}"
        );
        assert!(elapsed < Duration::from_secs(4), "超时过晚：{elapsed:?}");
    }

    #[cfg(unix)]
    #[test]
    fn pipeline_captures_stderr_and_nonzero_exit_code() {
        let repository = test_repository("stderr");
        let list = commands(vec![command(
            "sh",
            "/bin/sh",
            &["-c", "echo oops >&2; exit 3"],
        )]);
        let report =
            run_pipeline_command_with_commands(&repo_string(&repository), &list, "sh", None, None)
                .expect("run shell");
        assert_eq!(report.exit_code, Some(3));
        assert_eq!(report.stderr, "oops\n");
        assert!(report.stdout.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn pipeline_cancellation_stops_a_running_command() {
        let repository = test_repository("cancel");
        let path = repo_string(&repository);
        let list = commands(vec![command("slow", "/bin/sleep", &["5"])]);
        let runner = std::thread::spawn(move || {
            run_pipeline_command_with_commands(&path, &list, "slow", None, Some("run-test-cancel"))
        });
        // 等待命令进入运行状态后再取消。
        std::thread::sleep(Duration::from_millis(250));
        assert!(cancel_pipeline_command_impl("run-test-cancel"));
        let report = runner
            .join()
            .expect("runner thread")
            .expect("run cancelled command");
        assert!(report.cancelled, "必须标记 cancelled：{report:?}");
        assert!(!report.timed_out);
        assert_eq!(report.run_id, "run-test-cancel");
        // 运行结束后取消令牌必须被移除。
        assert!(!cancel_pipeline_command_impl("run-test-cancel"));
    }

    #[test]
    fn run_id_registry_registers_and_cancels() {
        let registration = RunRegistration::new(Some("run-ui-1")).expect("register");
        assert!(cancel_pipeline_command("run-ui-1"));
        assert!(registration.flag.load(Ordering::SeqCst));
        assert!(!cancel_pipeline_command("run-missing"));
        assert!(RunRegistration::new(Some("bad id")).is_err());
        drop(registration);
        assert!(!cancel_pipeline_command("run-ui-1"));
    }

    // ------------------------------------------------------------ 配置存储

    #[test]
    fn commands_file_round_trip_is_0600_and_size_limited() {
        let directory = unique_directory("store");
        let path = directory.join("commands.json");
        let list = commands(vec![command("status", "git", &["status", "--short"])]);
        write_commands_file(&path, &list).expect("write");
        let loaded = read_commands_file(&path).expect("read");
        assert_eq!(loaded, list);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).expect("metadata").permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "commands.json 必须为 0600");
        }

        // 超过上限的文件直接拒绝读取。
        let huge = "x".repeat(MAX_COMMANDS_FILE_BYTES + 1);
        fs::write(&path, huge).expect("write huge");
        assert!(read_commands_file(&path).is_err());

        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn commands_file_rejects_invalid_json_and_escape_paths() {
        let directory = unique_directory("invalid");
        let path = directory.join("commands.json");
        fs::write(&path, "{not json").expect("write invalid");
        assert!(read_commands_file(&path).is_err());

        let list = commands(vec![PipelineCommand {
            id: "escape".into(),
            name: "逃逸".into(),
            description: String::new(),
            program: "/bin/pwd".into(),
            args: Vec::new(),
            cwd_relative: Some("../../".into()),
        }]);
        assert!(validate_pipeline_commands(&list).is_err());

        let _ = fs::remove_dir_all(&directory);
    }
}
