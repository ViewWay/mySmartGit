//! 仓库层 RepositoryService：打开仓库的生命周期、三类缓存与文件监听。
//!
//! 对应 README「后续实现路线」的仓库层与「性能边界」：
//! - 打开回显：generation 未变的仓库直接回缓存快照，切换回访不再重读；
//! - 轮询降本：状态 token 在 generation 未变时不再起 git 子进程；
//! - 文件监听：notify 监听工作树与 .git，事件失效缓存并向前端推送 repository-changed；
//! - 三缓存独立：token（状态）、快照（提交图谱）、Diff 各自维护，条目+字节双上限；
//! - 驻留上限：同持仓库数上限，逐出时停监听并中止该仓库的历史流。
//!
//! 并发协议：命令线程 `begin_read` 取当前 generation → 无锁计算 → `finish_*` 按
//! 计算开始时的 generation 落缓存。若计算期间监听线程失效过缓存（generation 已
//! 前进），结果直接丢弃并保留 dirty 标记，下一次轮询重新计算——不会把监听事件
//! 之前的旧数据缓存成新数据。

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use notify_debouncer_full::{
    new_debouncer, notify::RecursiveMode, DebounceEventResult, Debouncer, RecommendedCache,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::git;
use crate::models::{DiffLine, RepositorySnapshot};

/// 同时驻留缓存的仓库数上限（README 性能边界：空闲内存 ~100 MB 目标）。
pub const OPENED_REPOSITORY_LIMIT: usize = 3;
/// 单仓库快照缓存字节上限：超过则本次快照不缓存（仍正常返回给前端）。
pub const SNAPSHOT_CACHE_MAX_BYTES: usize = 48 * 1024 * 1024;
/// Diff 缓存条目与字节上限。
pub const DIFF_CACHE_MAX_ENTRIES: usize = 64;
pub const DIFF_CACHE_MAX_BYTES: usize = 4 * 1024 * 1024;
/// 文件监听防抖窗口。
pub const WATCH_DEBOUNCE_MS: u64 = 300;
/// 定时 Fetch 默认间隔与允许范围（分钟）：前端提供 1/5/10/15/30 档，上限放宽到 60。
pub const AUTO_FETCH_DEFAULT_MINUTES: u64 = 5;
pub const AUTO_FETCH_MIN_MINUTES: u64 = 1;
pub const AUTO_FETCH_MAX_MINUTES: u64 = 60;
/// 失败退避封顶档：interval × 2^2 = 4 倍间隔（连续失败时最长等待可控）。
pub const AUTO_FETCH_BACKOFF_MAX_STEP: u32 = 2;
/// 自动 Fetch 超时：凭据提问已被非交互环境拦下，此值为网络停滞等残余挂起
/// 的熔断线（大仓库慢链路留足余量）。
pub const AUTO_FETCH_TIMEOUT_SECS: u64 = 120;
/// 定时线程的兜底唤醒周期：即使漏掉一次事件唤醒，调度最多延迟这么久。
const FETCH_TICK_MAX: Duration = Duration::from_secs(30);

/// `repository-auto-fetched` 事件载荷：后台定时 Fetch 完成（含结果）。
/// 前端据此更新「上次获取」时间戳；快照刷新仍走 repository-changed 推送。
/// `reason` 仅在失败时有值（"auth" / "timeout" / "other"），驱动凭据引导。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RepositoryAutoFetchedEvent {
    repository_path: String,
    ok: bool,
    reason: Option<String>,
}

/// 定时 Fetch 配置：默认开启、5 分钟——与历史前端行为一致。
#[derive(Clone, Copy)]
struct AutoFetchConfig {
    enabled: bool,
    interval: Duration,
}

impl Default for AutoFetchConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            interval: Duration::from_secs(AUTO_FETCH_DEFAULT_MINUTES * 60),
        }
    }
}

/// 系统通知文案：跟随原生菜单的模式，由前端按当前语言下发（配置接口携带），
/// Rust 只存储与发送，不做翻译。默认给双语兜底（语言未同步前不发转换通知也
/// 不致出现空文案）。
#[derive(Clone)]
pub struct NotifyTexts {
    pub failed: String,
    pub recovered: String,
}

impl Default for NotifyTexts {
    fn default() -> Self {
        Self {
            failed: "后台获取失败 / Background fetch failed".into(),
            recovered: "后台获取已恢复 / Background fetch recovered".into(),
        }
    }
}

/// 状态转换判定（纯函数，便于单测）：上一结果已知且与本次不同时通知——
/// 稳态静默（连续失败不重复打扰），只在「成功→失败」「失败→成功」跳变时
/// 提示。`None` 起始（首次结果）不通知。
fn fetch_notify_transition(prev: Option<bool>, ok: bool) -> Option<bool> {
    match prev {
        Some(previous) if previous != ok => Some(!ok),
        _ => None,
    }
}

/// 网络任务结果：决定收尾策略（退避只针对仓库侧故障；离线走环境重试）。
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum FetchResult {
    /// fetch + 快照重读成功。
    Success,
    /// fetch 或重读失败（网络错误、凭据拒绝等仓库侧原因）。
    Failed,
    /// 自动任务前置探测判定当前离线（未发起 git fetch）。
    Offline,
}

/// 连通性探测目标：任一可 TCP 连通即视为在线。探测只证明「有网」，不挑托管
/// 平台；防火墙特殊环境最坏情况是本轮拉取被延迟到下一周期，不会破坏拉取。
const NETWORK_PROBE_TARGETS: [(&str, u16); 2] = [("github.com", 443), ("gitee.com", 443)];
const NETWORK_PROBE_TIMEOUT_MS: u64 = 1500;

/// TCP 连通性探测（可注入目标与超时，便于单测）：逐地址短超时连接，
/// 任一成功即为在线。
fn probe_tcp_targets(targets: &[(&str, u16)], timeout: Duration) -> bool {
    use std::net::ToSocketAddrs;
    for (host, port) in targets {
        let Ok(addrs) = (*host, *port).to_socket_addrs() else {
            continue;
        };
        for addr in addrs {
            if std::net::TcpStream::connect_timeout(&addr, timeout).is_ok() {
                return true;
            }
        }
    }
    false
}

/// 自动任务前置门控：判定当前是否在线。
fn probe_network_reachable() -> bool {
    probe_tcp_targets(
        &NETWORK_PROBE_TARGETS,
        Duration::from_millis(NETWORK_PROBE_TIMEOUT_MS),
    )
}

/// 电池降频参数：基础间隔 × 3，封顶 30 分钟（间隔 30 分钟时不放大）。
const AUTO_FETCH_BATTERY_MULTIPLIER: u32 = 3;
const AUTO_FETCH_BATTERY_MAX_MINUTES: u64 = 30;

/// 电池供电推迟间隔（纯函数，便于单测）。
fn battery_delay(base: Duration) -> Duration {
    (base * AUTO_FETCH_BATTERY_MULTIPLIER)
        .min(Duration::from_secs(AUTO_FETCH_BATTERY_MAX_MINUTES * 60))
}

/// 电池供电探测：Some(true)=电池供电（自动 Fetch 降频），Some(false)=接电，
/// None=未知（台式机/探测失败——策略不介入）。探测可能起子进程/读 sysfs，
/// 只允许在后台调度线程调用，不进锁。
fn probe_on_battery() -> Option<bool> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("pmset")
            .arg("-g")
            .arg("batt")
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        parse_pmset_battery(&text)
    }
    #[cfg(target_os = "linux")]
    {
        parse_linux_power_supply(Path::new("/sys/class/power_supply"))
    }
    // Windows 需 GetSystemPowerStatus FFI；本机无法编译验证，暂不盲写 unsafe，
    // 返回 None 表示策略不介入（待有 Windows 构建反馈后再接）。
    #[cfg(target_os = "windows")]
    {
        None
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        None
    }
}

/// 解析 `pmset -g batt` 输出（纯函数，便于单测）：电源来源行含
/// 'Battery Power' → 电池，'AC Power' → 接电，其余未知。
#[cfg(target_os = "macos")]
fn parse_pmset_battery(output: &str) -> Option<bool> {
    let lowercase = output.to_lowercase();
    if lowercase.contains("battery power") {
        Some(true)
    } else if lowercase.contains("ac power") {
        Some(false)
    } else {
        None
    }
}

/// 解析 Linux 电源供应 sysfs 目录（纯函数，便于单测）：任一 AC 适配器在线 →
/// 接电；否则任一电池 Discharging → 电池；无电源供应信息 → 未知。
#[cfg(target_os = "linux")]
fn parse_linux_power_supply(dir: &Path) -> Option<bool> {
    let Ok(entries) = fs::read_dir(dir) else {
        return None;
    };
    let mut discharging = false;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy().to_string();
        if name.starts_with('A') {
            if let Ok(online) = fs::read_to_string(entry.path().join("online")) {
                if online.trim() == "1" {
                    return Some(false);
                }
            }
        }
        if let Ok(status) = fs::read_to_string(entry.path().join("status")) {
            if status.trim() == "Discharging" {
                discharging = true;
            }
        }
    }
    if discharging {
        Some(true)
    } else {
        None
    }
}

/// 展示路径 → 通知标题（取末段目录名；与快照 name 同源口径）。
fn notify_title(display: &str) -> String {
    display
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(display)
        .to_string()
}

/// 自动 Fetch 失败原因分类（纯函数，便于单测）：凭据类 → "auth"（前端给
/// 「检查 SSH 与凭据」引导）；超时熔断 → "timeout"；其余 → "other"。
/// 凭据关键词覆盖 https（Authentication failed / could not read Username /
/// terminal prompts disabled / HTTP 40x）与 ssh（Permission denied
/// (publickey)）两类传输。
fn classify_fetch_failure(error: &str) -> &'static str {
    let lowercase = error.to_lowercase();
    let auth_marker = [
        "authentication failed",
        "could not read username",
        "terminal prompts disabled",
        "permission denied",
        "http 401",
        "http 403",
        "403 forbidden",
        "http basic: access denied",
    ];
    if auth_marker.iter().any(|marker| lowercase.contains(marker)) {
        "auth"
    } else if lowercase.contains("超时")
        || lowercase.contains("timed out")
        || lowercase.contains("timeout")
    {
        "timeout"
    } else {
        "other"
    }
}

/// `repository-changed` 事件载荷。`repository_path` 是前端持有的展示路径
/// （与 `RepositorySnapshot.path` 同口径），前端用 repositoryCacheKey 归一后匹配。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RepositoryChangedEvent {
    repository_path: String,
    generation: u64,
}

/// 忽略的目录段：与 `repository_management::scan_skipped_directory` 同清单；
/// `.git` 虽以点开头但必须监听（分支/索引/refs 变化都发生在这里）。
fn ignored_segment(name: &str) -> bool {
    if name == ".git" {
        return false;
    }
    matches!(
        name,
        "node_modules" | "target" | "dist" | "build" | "vendor" | ".venv" | "venv"
    ) || name.starts_with('.')
}

/// 服务内部键：canonicalize 失败（路径暂不可达）时退回原字符串，保证一致性。
fn service_key(path: &str) -> String {
    fs::canonicalize(path)
        .map(|canonical| canonical.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string())
}

/// 事件路径是否落在监听范围内（工作树根或独立 .git 目录），且不经过忽略目录段。
fn event_relevant(path: &Path, root: &Path, git_dir: &Path) -> bool {
    let Some(relative) = path
        .strip_prefix(root)
        .or_else(|_| path.strip_prefix(git_dir))
        .ok()
    else {
        return false;
    };
    relative
        .components()
        .all(|component| match component.as_os_str().to_str() {
            Some(name) => !ignored_segment(name),
            None => true,
        })
}

/// 解析仓库的 git 目录：`.git` 是目录直接用；是文件（worktree/submodule）时按
/// `gitdir:` 指针解析，可能指向父仓库的 .git/modules。
fn resolve_git_dir(root: &Path) -> Option<PathBuf> {
    let git_entry = root.join(".git");
    let metadata = fs::metadata(&git_entry).ok()?;
    if metadata.is_dir() {
        return Some(git_entry);
    }
    if metadata.is_file() {
        let content = fs::read_to_string(&git_entry).ok()?;
        let line = content.lines().next()?;
        let target = line.strip_prefix("gitdir: ")?.trim();
        let path = PathBuf::from(target);
        return Some(if path.is_absolute() {
            path
        } else {
            root.join(path)
        });
    }
    None
}

/// Diff 缓存：条目+字节双上限，整体随 generation 失效清空。
#[derive(Default)]
struct DiffCache {
    entries: HashMap<String, (usize, Vec<DiffLine>)>,
    order: VecDeque<String>,
    total_bytes: usize,
}

impl DiffCache {
    fn weight(lines: &[DiffLine]) -> usize {
        lines
            .iter()
            .map(|line| {
                line.code.len()
                    + line.old_code.as_ref().map_or(0, |value| value.len())
                    + line.new_code.as_ref().map_or(0, |value| value.len())
                    + 64
            })
            .sum()
    }

    fn get(&self, key: &str) -> Option<&Vec<DiffLine>> {
        self.entries.get(key).map(|(_, lines)| lines)
    }

    fn insert(&mut self, key: String, lines: &[DiffLine]) {
        let weight = Self::weight(lines);
        if weight > DIFF_CACHE_MAX_BYTES {
            return;
        }
        if let Some((existing, _)) = self.entries.get(&key) {
            self.total_bytes = self.total_bytes.saturating_sub(*existing);
        }
        self.total_bytes += weight;
        self.entries.insert(key.clone(), (weight, lines.to_vec()));
        self.order.push_back(key);
        while self.entries.len() > DIFF_CACHE_MAX_ENTRIES || self.total_bytes > DIFF_CACHE_MAX_BYTES
        {
            match self.order.pop_front() {
                Some(evicted) => {
                    if let Some((weight, _)) = self.entries.remove(&evicted) {
                        self.total_bytes = self.total_bytes.saturating_sub(weight);
                    }
                }
                None => break,
            }
        }
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
        self.total_bytes = 0;
    }
}

/// 单个已打开仓库的驻留状态。全部字段仅在服务锁内读写。
struct OpenedRepository {
    /// 前端持有的展示路径（事件载荷口径）。
    display: String,
    watcher: Option<Debouncer<notify_debouncer_full::notify::RecommendedWatcher, RecommendedCache>>,
    /// 失效代数：监听事件 +1。
    generation: u64,
    token_cache: Option<(u64, String)>,
    token_dirty: bool,
    snapshot_cache: Option<(u64, RepositorySnapshot)>,
    snapshot_dirty: bool,
    diff_cache: DiffCache,
    /// LRU 时钟。
    last_used: u64,
    /// 定时 Fetch 到期时刻（驻留时置 now+interval；完成时按结果重排；None=不排程）。
    next_fetch_due: Option<Instant>,
    /// 连续失败退避档（0 = 正常间隔；每失败 +1 封顶，成功清零）。
    fetch_backoff_step: u32,
    /// 上一次网络任务结果（None=尚无）：通知只在转换跳变时发。
    prev_fetch_ok: Option<bool>,
}

/// 仓库层服务，由 Tauri `manage` 托管（lib.rs setup）。
pub struct RepositoryServiceState {
    app: Option<AppHandle>,
    inner: Mutex<RepositoryServiceInner>,
    /// 定时线程与 Fetch 完成回调的唤醒通道（发端失败仅表示接收端已不在，可忽略）。
    fetch_wake: mpsc::Sender<()>,
}

#[derive(Default)]
struct RepositoryServiceInner {
    opened: HashMap<String, OpenedRepository>,
    use_counter: u64,
    /// 定时 Fetch 配置（默认开、5 分钟）。
    fetch_config: AutoFetchConfig,
    /// 单飞集合：键 = service_key。定时线程与手动 `fetch_repository` 命令共用，
    /// 同一仓库任意时刻至多一个网络任务（README 性能边界）。
    fetch_in_flight: HashSet<String>,
    /// 系统通知文案（前端按语言下发；默认双语兜底）。
    notify_texts: NotifyTexts,
}

impl RepositoryServiceInner {
    /// 确保仓库已驻留（必要时起文件监听），刷新 LRU 时钟并返回当前 generation。
    fn begin_read(&mut self, path: &str, app: Option<AppHandle>) -> u64 {
        let key = service_key(path);
        if !self.opened.contains_key(&key) {
            // 首次驻留即入队定时 Fetch：到期 = now + 当前间隔（成功时完成回调
            // 会按同间隔重排；禁用时 due = None）。
            let fetch_due = self
                .fetch_config
                .enabled
                .then(|| Instant::now() + self.fetch_config.interval);
            self.opened.insert(
                key.clone(),
                OpenedRepository {
                    display: path.to_string(),
                    watcher: None,
                    generation: 0,
                    token_cache: None,
                    token_dirty: false,
                    snapshot_cache: None,
                    snapshot_dirty: false,
                    diff_cache: DiffCache::default(),
                    last_used: 0,
                    next_fetch_due: fetch_due,
                    fetch_backoff_step: 0,
                    prev_fetch_ok: None,
                },
            );
        }
        let next = self.use_counter.wrapping_add(1);
        self.use_counter = next;
        let entry = self.opened.get_mut(&key).expect("entry just ensured");
        entry.last_used = next;
        if entry.watcher.is_none() {
            // 首次驻留（或上次监听启动失败）时补挂文件监听。
            entry.watcher = start_watcher(&key, app);
        }
        let generation = entry.generation;
        // 逐出不会命中刚刷新时钟的当前仓库，generation 取值后再逐出即可。
        self.evict_beyond_limit(&key);
        generation
    }

    /// 驻留数超上限时按 LRU 逐出：停监听并中止该仓库的历史流。
    fn evict_beyond_limit(&mut self, keep: &str) {
        while self.opened.len() > OPENED_REPOSITORY_LIMIT {
            let Some(victim) = self
                .opened
                .iter()
                .filter(|(key, _)| key.as_str() != keep)
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some(entry) = self.opened.remove(&victim) {
                // entry 被 drop 即停监听（Debouncer 的 Drop 负责收尾）。
                let _ = git::cancel_repository_history(&entry.display);
            }
        }
    }

    /// 监听线程入口：失效缓存，返回是否确有变化（用于决定是否推送事件）。
    fn invalidate(&mut self, key: &str) -> bool {
        let Some(entry) = self.opened.get_mut(key) else {
            return false;
        };
        entry.generation = entry.generation.wrapping_add(1);
        entry.token_dirty = true;
        entry.snapshot_dirty = true;
        entry.diff_cache.clear();
        true
    }
}

impl RepositoryServiceState {
    pub fn new(app: AppHandle) -> Self {
        let (wake, wake_receiver) = mpsc::channel::<()>();
        let state = Self {
            app: Some(app.clone()),
            inner: Mutex::new(RepositoryServiceInner::default()),
            fetch_wake: wake,
        };
        // 定时线程：阻塞等待「到期唤醒 / 配置变更 / Fetch 完成回调」，醒来后
        // 到期任务收割并计算下一次唤醒。try_state 在 manage 之前的极短窗口内为
        // None，退避 100ms 重试即可。
        std::thread::Builder::new()
            .name("repository-auto-fetch".into())
            .spawn(move || loop {
                let timeout = {
                    let Some(state) = app.try_state::<RepositoryServiceState>() else {
                        std::thread::sleep(Duration::from_millis(100));
                        continue;
                    };
                    state.collect_due_fetches()
                };
                match wake_receiver.recv_timeout(timeout) {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            })
            .expect("spawn repository auto-fetch thread");
        state
    }

    /// 测试与无 Tauri 环境用的裸实例（不推送事件、不起监听回调、不起定时线程）。
    #[cfg(test)]
    fn detached() -> Self {
        let (wake, _receiver) = mpsc::channel::<()>();
        Self {
            app: None,
            inner: Mutex::new(RepositoryServiceInner::default()),
            fetch_wake: wake,
        }
    }

    /// 打开仓库：generation 未变且缓存新鲜时直接回快照，切换回访零成本。
    pub fn snapshot(&self, path: &str) -> Option<RepositorySnapshot> {
        let mut inner = self.inner.lock().ok()?;
        let key = service_key(path);
        let next = inner.use_counter.wrapping_add(1);
        inner.use_counter = next;
        let entry = inner.opened.get_mut(&key)?;
        entry.last_used = next;
        if entry.snapshot_dirty {
            return None;
        }
        let (generation, snapshot) = entry.snapshot_cache.as_ref()?;
        if *generation == entry.generation {
            Some(snapshot.clone())
        } else {
            None
        }
    }

    /// 轮询降本：generation 未变且未失效时直接回上次 token，不再起 git 子进程。
    pub fn token(&self, path: &str) -> Option<String> {
        let mut inner = self.inner.lock().ok()?;
        let key = service_key(path);
        let next = inner.use_counter.wrapping_add(1);
        inner.use_counter = next;
        let entry = inner.opened.get_mut(&key)?;
        entry.last_used = next;
        if entry.token_dirty {
            return None;
        }
        let (generation, token) = entry.token_cache.as_ref()?;
        if *generation == entry.generation {
            Some(token.clone())
        } else {
            None
        }
    }

    /// Diff 命中：随 generation 失效整体清空，这里只做查表。
    pub fn diff(&self, path: &str, cache_key: &str) -> Option<Vec<DiffLine>> {
        let inner = self.inner.lock().ok()?;
        let key = service_key(path);
        inner.opened.get(&key)?.diff_cache.get(cache_key).cloned()
    }

    /// 计算开始：确保驻留（含首次挂监听）并取当前 generation，计算期间无锁。
    pub fn begin_read(&self, path: &str) -> u64 {
        let mut inner = self.inner.lock().expect("repository service lock");
        inner.begin_read(path, self.app.clone())
    }

    /// token 计算完成：仅当 generation 未前进才落缓存，否则保留 dirty。
    pub fn finish_token(&self, path: &str, generation: u64, token: String) {
        let mut inner = self.inner.lock().expect("repository service lock");
        let key = service_key(path);
        let Some(entry) = inner.opened.get_mut(&key) else {
            return;
        };
        if entry.generation == generation {
            entry.token_cache = Some((generation, token));
            entry.token_dirty = false;
        }
    }

    /// 快照计算完成：仅当 generation 未前进才落缓存；超重快照只返回不缓存。
    pub fn finish_snapshot(&self, path: &str, generation: u64, snapshot: &RepositorySnapshot) {
        let mut inner = self.inner.lock().expect("repository service lock");
        let key = service_key(path);
        let Some(entry) = inner.opened.get_mut(&key) else {
            return;
        };
        if entry.generation != generation {
            return;
        }
        entry.snapshot_dirty = false;
        let weight = snapshot_weight(snapshot);
        if weight <= SNAPSHOT_CACHE_MAX_BYTES {
            entry.snapshot_cache = Some((generation, snapshot.clone()));
        } else {
            entry.snapshot_cache = None;
        }
    }

    /// Diff 计算完成：仅当 generation 未前进才落缓存。
    pub fn finish_diff(&self, path: &str, generation: u64, cache_key: &str, lines: &[DiffLine]) {
        let mut inner = self.inner.lock().expect("repository service lock");
        let key = service_key(path);
        let Some(entry) = inner.opened.get_mut(&key) else {
            return;
        };
        if entry.generation == generation {
            entry.diff_cache.insert(cache_key.to_string(), lines);
        }
    }

    /// 监听事件入口（生产路径由监听线程调用，测试直接调用）。
    pub fn invalidate(&self, path: &str) -> bool {
        let mut inner = self.inner.lock().expect("repository service lock");
        let key = service_key(path);
        let changed = inner.invalidate(&key);
        if changed {
            let display = inner
                .opened
                .get(&key)
                .map(|entry| entry.display.clone())
                .unwrap_or_else(|| path.to_string());
            let generation = inner
                .opened
                .get(&key)
                .map(|entry| entry.generation)
                .unwrap_or(0);
            if let Some(app) = &self.app {
                let _ = app.emit(
                    "repository-changed",
                    RepositoryChangedEvent {
                        repository_path: display,
                        generation,
                    },
                );
            }
        }
        changed
    }

    /// 更新定时 Fetch 配置（前端设置面板下发）。重排全部驻留仓库的到期时刻，
    /// 唤醒定时线程立即生效。通知文案随配置一并同步（语言切换时前端会重发）。
    pub fn set_auto_fetch_config(
        &self,
        enabled: bool,
        interval_minutes: u64,
        notify_texts: Option<NotifyTexts>,
    ) -> Result<(), String> {
        let minutes = interval_minutes.clamp(AUTO_FETCH_MIN_MINUTES, AUTO_FETCH_MAX_MINUTES);
        let interval = Duration::from_secs(minutes * 60);
        let mut inner = self.inner.lock().map_err(|_| "repository service lock")?;
        inner.fetch_config = AutoFetchConfig { enabled, interval };
        if let Some(texts) = notify_texts {
            inner.notify_texts = texts;
        }
        let now = Instant::now();
        for entry in inner.opened.values_mut() {
            entry.next_fetch_due = enabled.then(|| now + interval);
            entry.fetch_backoff_step = 0;
        }
        let _ = self.fetch_wake.send(());
        Ok(())
    }

    /// 声明网络任务单飞键。返回 false 表示同仓库已有网络任务在跑（定时或手动），
    /// 调用方应跳过发起。手动路径紧随其后 begin_read 确保驻留。
    pub fn try_claim_fetch(&self, path: &str) -> bool {
        let mut inner = self.inner.lock().expect("repository service lock");
        inner.fetch_in_flight.insert(service_key(path))
    }

    /// 收割到期任务：单飞领取、置空 due（完成回调重排）、后台线程执行。
    /// 返回下一次应唤醒的等待时长（已封顶到兜底周期）。
    fn collect_due_fetches(&self) -> Duration {
        self.collect_due_fetches_inner(probe_on_battery())
    }

    /// 可注入电池状态的收割入口（便于单测）。电池探测只在确有到期任务时执行
    ///（子进程开销不进空转周期），且不在锁内做。
    fn collect_due_fetches_inner(&self, on_battery: Option<bool>) -> Duration {
        let mut tasks: Vec<(String, String, u64)> = Vec::new();
        let mut earliest: Option<Duration> = None;
        {
            let mut inner = self.inner.lock().expect("repository service lock");
            let now = Instant::now();
            // 第一遍只读扫描：收集到期项与最近唤醒时刻（避免 iter_mut 与单飞集合
            // 的借用冲突）。
            let due: Vec<(String, String, u64)> = if inner.fetch_config.enabled {
                inner
                    .opened
                    .iter()
                    .filter_map(|(key, entry)| {
                        let Some(due) = entry.next_fetch_due else {
                            return None;
                        };
                        if due <= now {
                            Some((key.clone(), entry.display.clone(), entry.generation))
                        } else {
                            let wait = due - now;
                            earliest =
                                Some(earliest.map_or(wait, |current: Duration| current.min(wait)));
                            None
                        }
                    })
                    .collect()
            } else {
                Vec::new()
            };
            // 第二遍领取：单飞失败（手动任务在跑）同样置空 due——完成回调会按
            // 结果重排，避免本周期重复收割。
            for (key, display, generation) in due {
                if inner.fetch_in_flight.insert(key.clone()) {
                    if let Some(entry) = inner.opened.get_mut(&key) {
                        entry.next_fetch_due = None;
                        tasks.push((key, display, generation));
                    }
                } else if let Some(entry) = inner.opened.get_mut(&key) {
                    entry.next_fetch_due = None;
                }
            }
        }
        // 电池供电降频：已领取的任务整体推迟到电池间隔，不发起 fetch、不发事件、
        // 不动 prev_fetch_ok（电池跳过不是失败）。探测放在锁外、仅在有任务时。
        if !tasks.is_empty() && on_battery == Some(true) {
            let delay = self.battery_deferred_delay();
            {
                let mut inner = self.inner.lock().expect("repository service lock");
                let now = Instant::now();
                for (key, _, _) in &tasks {
                    inner.fetch_in_flight.remove(key);
                    if let Some(entry) = inner.opened.get_mut(key) {
                        entry.next_fetch_due = Some(now + delay);
                    }
                }
            }
            return delay.min(FETCH_TICK_MAX);
        }
        for (_, display, generation) in tasks {
            let app = self.app.clone();
            let wake = self.fetch_wake.clone();
            // 低优先级：后台独立线程执行；CLI 子进程本就不占 UI 线程。
            std::thread::spawn(move || run_fetch_task(app, wake, display, generation, true));
        }
        earliest.unwrap_or(FETCH_TICK_MAX)
    }

    /// 电池供电下的推迟间隔：基础间隔 × 3，封顶 30 分钟。
    fn battery_deferred_delay(&self) -> Duration {
        let inner = self.inner.lock().expect("repository service lock");
        battery_delay(inner.fetch_config.interval)
    }

    /// 网络任务收尾：释放单飞、按结果重排到期（成功/离线 = 基础间隔；失败 =
    /// 退避倍增——离线是环境状态而非仓库故障，恢复在线后立即以基础间隔重试）、
    /// 推送 repository-auto-fetched 事件（仅定时任务，手动路径前端已知结果）、
    /// 状态转换时发系统通知（稳态静默——连续失败不重复打扰）。
    pub fn complete_fetch(
        &self,
        path: &str,
        result: FetchResult,
        auto: bool,
        reason: Option<&str>,
    ) {
        let key = service_key(path);
        let mut inner = self.inner.lock().expect("repository service lock");
        inner.fetch_in_flight.remove(&key);
        let interval = inner.fetch_config.interval;
        let ok = result == FetchResult::Success;
        let backoff = match result {
            FetchResult::Success => 0,
            FetchResult::Failed => inner
                .opened
                .get(&key)
                .map(|entry| (entry.fetch_backoff_step + 1).min(AUTO_FETCH_BACKOFF_MAX_STEP))
                .unwrap_or(0),
            // 离线不升级退避：保持当前档位，到点即以基础间隔重试。
            FetchResult::Offline => inner
                .opened
                .get(&key)
                .map(|entry| entry.fetch_backoff_step)
                .unwrap_or(0),
        };
        // 退避倍增只作用于仓库侧故障；成功与离线均按基础间隔重排（离线的档位
        // 仅保留给下一次失败使用）。
        let delay = match result {
            FetchResult::Failed => interval * 2u32.saturating_pow(backoff),
            _ => interval,
        };
        let next_due = inner.fetch_config.enabled.then(|| Instant::now() + delay);
        let mut notify_failure: Option<bool> = None;
        if let Some(entry) = inner.opened.get_mut(&key) {
            notify_failure = fetch_notify_transition(entry.prev_fetch_ok, ok);
            entry.prev_fetch_ok = Some(ok);
            entry.fetch_backoff_step = backoff;
            entry.next_fetch_due = next_due;
        }
        if auto {
            if let Some(app) = &self.app {
                let _ = app.emit(
                    "repository-auto-fetched",
                    RepositoryAutoFetchedEvent {
                        repository_path: path.to_string(),
                        ok,
                        reason: reason.map(String::from),
                    },
                );
                if let Some(failure) = notify_failure {
                    let texts = &inner.notify_texts;
                    let body = if failure {
                        texts.failed.as_str()
                    } else {
                        texts.recovered.as_str()
                    };
                    let _ = app
                        .notification()
                        .builder()
                        .title(notify_title(path))
                        .body(body)
                        .show();
                }
            }
        }
        let _ = self.fetch_wake.send(());
    }

    /// 仓库发现并入服务：DFS 引擎复用 repository_management，不重复实现。
    /// 扫描是无状态发现（不驻留、不挂监听），做成关联函数以便命令侧在
    /// spawn_blocking 里调用。
    pub fn scan(
        root: &str,
        max_depth: Option<u32>,
    ) -> Result<Vec<crate::repository_management::ScannedRepository>, String> {
        crate::repository_management::scan_git_repositories(
            root,
            max_depth.unwrap_or(crate::repository_management::SCAN_DEFAULT_DEPTH),
        )
    }
}

/// 定时 Fetch 任务体：自动任务先做连通性探测（离线则不发起 git fetch），
/// 之后 fetch + 重读快照 → 按 generation 协议落缓存 → 收尾。单飞领取已在
/// collect_due_fetches（定时）或命令侧 try_claim_fetch（手动）完成。
fn run_fetch_task(
    app: Option<AppHandle>,
    wake: mpsc::Sender<()>,
    display: String,
    generation: u64,
    auto: bool,
) {
    // 手动任务不设门控：用户显式操作就该尝试，离线由 git 报错直达前端。
    let offline = auto && !probe_network_reachable();
    if let Some(state) = app
        .as_ref()
        .and_then(|app| app.try_state::<RepositoryServiceState>())
    {
        if offline {
            state.complete_fetch(&display, FetchResult::Offline, auto, None);
        } else {
            // 自动任务走非交互 + 超时熔断的专用路径；手动任务保留交互行为。
            let fetch_outcome = if auto {
                git::fetch_repository_for_automation(
                    &display,
                    Duration::from_secs(AUTO_FETCH_TIMEOUT_SECS),
                )
            } else {
                git::fetch_repository(&display)
            };
            let outcome = fetch_outcome.and_then(|()| git::read_repository(&display));
            if let Ok(snapshot) = &outcome {
                state.finish_snapshot(&display, generation, snapshot);
            }
            let reason = outcome
                .as_ref()
                .err()
                .map(|error| classify_fetch_failure(error));
            let result = if outcome.is_ok() {
                FetchResult::Success
            } else {
                FetchResult::Failed
            };
            state.complete_fetch(&display, result, auto, reason);
        }
    }
    let _ = wake.send(());
}

/// 快照缓存权重：直接量一次序列化字节数（fresh read 本就以百毫秒计，开销可忽略）。
fn snapshot_weight(snapshot: &RepositorySnapshot) -> usize {
    serde_json::to_vec(snapshot)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX)
}

/// 挂文件监听：工作树根递归 + 独立 git 目录（worktree/submodule 的 .git 文件指向
/// 父仓库 .git/modules）递归。防抖事件批量判定相关性，命中即失效并推送事件。
fn start_watcher(
    key: &str,
    app: Option<AppHandle>,
) -> Option<Debouncer<notify_debouncer_full::notify::RecommendedWatcher, RecommendedCache>> {
    let root = PathBuf::from(key);
    if !root.is_dir() {
        return None;
    }
    let Some(git_dir) = resolve_git_dir(&root) else {
        return None;
    };
    let Some(app) = app else {
        return None;
    };
    let watch_root = root.clone();
    let watch_git_dir = git_dir.clone();
    let event_key = key.to_string();
    let (sender, receiver) = mpsc::channel();
    let mut debouncer = new_debouncer(
        Duration::from_millis(WATCH_DEBOUNCE_MS),
        None,
        move |events: DebounceEventResult| {
            let _ = sender.send(events);
        },
    )
    .ok()?;
    // 防抖回调线程只入队；失效与事件推送移到排水线程，缩短回调线程的持锁窗口。
    std::thread::spawn(move || {
        while let Ok(events) = receiver.recv() {
            let Ok(events) = events else { continue };
            let relevant = events.iter().any(|event| {
                event
                    .paths
                    .iter()
                    .any(|path| event_relevant(path, &watch_root, &watch_git_dir))
            });
            if !relevant {
                continue;
            }
            if let Some(state) = app.try_state::<RepositoryServiceState>() {
                state.invalidate(&event_key);
            }
        }
    });
    if debouncer.watch(&root, RecursiveMode::Recursive).is_err() {
        return None;
    }
    // git 目录在根内（普通仓库）时已被递归监听覆盖，不重复挂。
    if git_dir != root
        && !git_dir.starts_with(&root)
        && debouncer.watch(&git_dir, RecursiveMode::Recursive).is_err()
    {
        return None;
    }
    Some(debouncer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap as StdHashMap;

    fn test_snapshot(path: &str) -> RepositorySnapshot {
        RepositorySnapshot {
            name: "demo".into(),
            path: path.into(),
            superproject_path: None,
            branch: "main".into(),
            remote: None,
            ahead: 0,
            behind: 0,
            worktree_count: 0,
            submodule_count: 0,
            commits: Vec::new(),
            files: Vec::new(),
            worktrees: Vec::new(),
            submodules: Vec::new(),
            branches: Vec::new(),
            remote_branches: Vec::new(),
            branch_tracking: StdHashMap::new(),
            tags: Vec::new(),
            stashes: Vec::new(),
            commit_template: None,
            undo_commit_message: None,
            operation: None,
        }
    }

    fn test_diff_line(code: &str) -> DiffLine {
        DiffLine {
            old: None,
            next: None,
            kind: "context".into(),
            code: code.into(),
            old_code: None,
            new_code: None,
            old_no_newline: false,
            new_no_newline: false,
        }
    }

    #[test]
    fn token_cache_short_circuits_until_invalidation() {
        let service = RepositoryServiceState::detached();
        let generation = service.begin_read("/nonexistent/demo");
        service.finish_token("/nonexistent/demo", generation, "tok-1".into());
        assert_eq!(service.token("/nonexistent/demo"), Some("tok-1".into()));
        assert!(service.invalidate("/nonexistent/demo"));
        assert_eq!(service.token("/nonexistent/demo"), None);
    }

    #[test]
    fn snapshot_cache_hit_and_invalidation() {
        let service = RepositoryServiceState::detached();
        let generation = service.begin_read("/nonexistent/demo");
        let snapshot = test_snapshot("/nonexistent/demo");
        service.finish_snapshot("/nonexistent/demo", generation, &snapshot);
        let cached = service.snapshot("/nonexistent/demo").expect("cached");
        assert_eq!(cached.path, snapshot.path);
        assert!(service.invalidate("/nonexistent/demo"));
        assert!(service.snapshot("/nonexistent/demo").is_none());
    }

    #[test]
    fn stale_compute_result_is_dropped_after_invalidation() {
        let service = RepositoryServiceState::detached();
        let generation = service.begin_read("/nonexistent/demo");
        // 计算期间发生监听事件：generation 前进，旧代数据不得落缓存。
        service.invalidate("/nonexistent/demo");
        service.finish_token("/nonexistent/demo", generation, "stale".into());
        assert_eq!(service.token("/nonexistent/demo"), None);
        let snapshot = test_snapshot("/nonexistent/demo");
        service.finish_snapshot("/nonexistent/demo", generation, &snapshot);
        assert!(service.snapshot("/nonexistent/demo").is_none());
    }

    #[test]
    fn lru_evicts_oldest_opened_repository() {
        let service = RepositoryServiceState::detached();
        let generation = service.begin_read("/nonexistent/a");
        let snapshot = test_snapshot("/nonexistent/a");
        service.finish_snapshot("/nonexistent/a", generation, &snapshot);
        for name in ["b", "c", "d"] {
            let generation = service.begin_read(&format!("/nonexistent/{name}"));
            service.finish_snapshot(
                &format!("/nonexistent/{name}"),
                generation,
                &test_snapshot(&format!("/nonexistent/{name}")),
            );
        }
        // 上限 3：最早驻留的 a 被逐出，其余保留。
        assert!(service.snapshot("/nonexistent/a").is_none());
        assert!(service.snapshot("/nonexistent/b").is_some());
        assert!(service.snapshot("/nonexistent/c").is_some());
        assert!(service.snapshot("/nonexistent/d").is_some());
        // 回访 b 刷新 LRU 时钟后再驻留 e，被逐出的是 c 而不是 b。
        assert!(service.snapshot("/nonexistent/b").is_some());
        let generation = service.begin_read("/nonexistent/e");
        service.finish_snapshot(
            "/nonexistent/e",
            generation,
            &test_snapshot("/nonexistent/e"),
        );
        assert!(service.snapshot("/nonexistent/c").is_none());
        assert!(service.snapshot("/nonexistent/b").is_some());
    }

    #[test]
    fn diff_cache_caps_and_invalidation() {
        let service = RepositoryServiceState::detached();
        let generation = service.begin_read("/nonexistent/demo");
        let lines = vec![test_diff_line("hello")];
        service.finish_diff(
            "/nonexistent/demo",
            generation,
            "unstaged\u{1f}a.rs\u{1f}false",
            &lines,
        );
        let cached = service
            .diff("/nonexistent/demo", "unstaged\u{1f}a.rs\u{1f}false")
            .expect("cached");
        assert_eq!(cached.len(), lines.len());
        assert_eq!(cached[0].code, lines[0].code);
        // 超过单条字节上限的结果只返回不缓存。
        let huge: Vec<DiffLine> = (0..60_000)
            .map(|index| test_diff_line(&format!("line-{index}-{}", "x".repeat(120))))
            .collect();
        assert!(DiffCache::weight(&huge) > DIFF_CACHE_MAX_BYTES);
        service.finish_diff("/nonexistent/demo", generation, "big", &huge);
        assert!(service.diff("/nonexistent/demo", "big").is_none());
        // 失效整体清空。
        service.invalidate("/nonexistent/demo");
        assert!(service
            .diff("/nonexistent/demo", "unstaged\u{1f}a.rs\u{1f}false")
            .is_none());
    }

    #[test]
    fn event_relevance_filters_ignored_segments() {
        let root = Path::new("/repo");
        let git_dir = Path::new("/repo/.git");
        assert!(event_relevant(
            Path::new("/repo/src/main.rs"),
            root,
            git_dir
        ));
        assert!(event_relevant(Path::new("/repo/.git/HEAD"), root, git_dir));
        assert!(!event_relevant(
            Path::new("/repo/node_modules/pkg/index.js"),
            root,
            git_dir
        ));
        assert!(!event_relevant(
            Path::new("/repo/.venv/lib.py"),
            root,
            git_dir
        ));
        assert!(!event_relevant(
            Path::new("/elsewhere/file.txt"),
            root,
            git_dir
        ));
    }

    /// scan 入口的接线测试：真实 git init 一个临时仓库，经 service.scan 命中。
    #[test]
    fn scan_via_service_finds_fixture_repository() {
        use std::time::{SystemTime, UNIX_EPOCH};
        struct Sandbox(std::path::PathBuf);
        impl Sandbox {
            fn new() -> Self {
                let unique = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos();
                let path = std::env::temp_dir().join(format!(
                    "branchline-service-{}-{unique}",
                    std::process::id()
                ));
                std::fs::create_dir_all(&path).unwrap();
                Self(path)
            }
        }
        impl Drop for Sandbox {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let sandbox = Sandbox::new();
        let repo = sandbox.0.join("demo-repo");
        std::fs::create_dir_all(&repo).unwrap();
        let initialized = std::process::Command::new("git")
            .arg("init")
            .arg("-q")
            .current_dir(&repo)
            .output()
            .expect("git 可用");
        assert!(initialized.status.success(), "git init 失败");

        let found = RepositoryServiceState::scan(sandbox.0.to_str().unwrap(), Some(1))
            .expect("扫描不应报错");
        assert!(
            found.iter().any(|repo| repo.name == "demo-repo"),
            "应命中 demo-repo：{:?}",
            found
        );
    }

    /// 定时 Fetch 排程与退避：驻留即入队；单飞领取互斥；手动完成按结果重排
    /// （成功清退避，失败退避倍增）；配置下发重排全部到期并清退避。
    #[test]
    fn auto_fetch_schedules_claims_and_backs_off() {
        let service = RepositoryServiceState::detached();
        let path = "/tmp/branchline-fetch-schedule-demo";
        let interval = Duration::from_secs(AUTO_FETCH_DEFAULT_MINUTES * 60);

        // 驻留即入队：due ≈ now + 默认间隔。
        let _generation = service.begin_read(path);
        let key = service_key(path);
        let due = {
            let inner = service.inner.lock().unwrap();
            let entry = inner.opened.get(&key).expect("驻留条目");
            let due = entry.next_fetch_due.expect("默认配置应排程");
            let wait = due - Instant::now();
            assert!(wait <= interval, "due 应在默认间隔内：{wait:?}");
            entry.fetch_backoff_step
        };
        assert_eq!(due, 0, "初始退避档为 0");

        // 单飞互斥：首次领取成功，重复领取被拒。
        assert!(service.try_claim_fetch(path), "首次领取应成功");
        assert!(!service.try_claim_fetch(path), "重复领取应被拒");

        // 手动任务失败收尾：退避升档，due ≈ now + 2×间隔。
        service.complete_fetch(path, FetchResult::Failed, false, None);
        {
            let inner = service.inner.lock().unwrap();
            let entry = inner.opened.get(&key).expect("驻留条目");
            assert_eq!(entry.fetch_backoff_step, 1, "失败后退避升到 1");
            let wait = entry.next_fetch_due.expect("失败后仍排程") - Instant::now();
            assert!(wait > interval, "退避后等待应超过单倍间隔：{wait:?}");
        }

        // 再失败一次到封顶档 2（×4），随后成功清零退避。
        assert!(service.try_claim_fetch(path));
        service.complete_fetch(path, FetchResult::Failed, false, None);
        {
            let inner = service.inner.lock().unwrap();
            assert_eq!(
                inner.opened.get(&key).unwrap().fetch_backoff_step,
                AUTO_FETCH_BACKOFF_MAX_STEP,
                "退避封顶档"
            );
        }
        assert!(service.try_claim_fetch(path));
        service.complete_fetch(path, FetchResult::Success, false, None);
        {
            let inner = service.inner.lock().unwrap();
            let entry = inner.opened.get(&key).unwrap();
            assert_eq!(entry.fetch_backoff_step, 0, "成功清零退避");
            let wait = entry.next_fetch_due.unwrap() - Instant::now();
            assert!(wait <= interval, "成功后回到单倍间隔：{wait:?}");
        }

        // 配置下发：禁用清空排程；改间隔重排并清退避；超范围夹取到 60 分钟。
        service
            .set_auto_fetch_config(false, 5, None)
            .expect("禁用配置");
        {
            let inner = service.inner.lock().unwrap();
            let entry = inner.opened.get(&key).unwrap();
            assert!(entry.next_fetch_due.is_none(), "禁用后不排程");
        }
        service
            .set_auto_fetch_config(true, 3, None)
            .expect("改 3 分钟");
        {
            let inner = service.inner.lock().unwrap();
            let entry = inner.opened.get(&key).unwrap();
            let wait = entry.next_fetch_due.unwrap() - Instant::now();
            assert!(
                wait <= Duration::from_secs(3 * 60),
                "按新间隔重排：{wait:?}"
            );
        }
        service
            .set_auto_fetch_config(true, 999, None)
            .expect("超限配置");
        {
            let inner = service.inner.lock().unwrap();
            let entry = inner.opened.get(&key).unwrap();
            let wait = entry.next_fetch_due.unwrap() - Instant::now();
            assert!(
                wait <= Duration::from_secs(AUTO_FETCH_MAX_MINUTES * 60)
                    && wait > Duration::from_secs(30 * 60),
                "夹取到 60 分钟上限：{wait:?}"
            );
        }
    }

    /// 收割逻辑：未到期只产出最近唤醒时长；到期且单飞空闲则领取并置空 due；
    /// 到期但单飞被占（手动任务在跑）只置空 due、不重复领取。注入接电状态
    /// 保证确定性（真实探测随宿主机电池状态翻转）。
    #[test]
    fn collect_due_fetches_claims_once_and_reports_earliest_wake() {
        let service = RepositoryServiceState::detached();
        let path = "/tmp/branchline-fetch-collect-demo";
        let key = service_key(path);
        let _ = service.begin_read(path);

        // 未到期：无任务领取，返回最近唤醒（默认 5 分钟内）。
        let wake = service.collect_due_fetches_inner(Some(false));
        assert!(wake <= Duration::from_secs(AUTO_FETCH_DEFAULT_MINUTES * 60));
        {
            let inner = service.inner.lock().unwrap();
            assert!(!inner.fetch_in_flight.contains(&key), "未到期不领取");
        }

        // 到期 + 单飞空闲：领取成功（真实 fetch 线程会跑但 detached 无 app，不回写状态）。
        {
            let mut inner = service.inner.lock().unwrap();
            inner.opened.get_mut(&key).unwrap().next_fetch_due = Some(Instant::now());
        }
        let _ = service.collect_due_fetches_inner(Some(false));
        {
            let inner = service.inner.lock().unwrap();
            assert!(inner.fetch_in_flight.contains(&key), "到期应领取单飞");
            assert!(
                inner.opened.get(&key).unwrap().next_fetch_due.is_none(),
                "领取后置空 due"
            );
        }

        // 到期 + 单飞被占：只置空 due，不再领取。
        //（先完成释放单飞，再预占一次模拟手动任务，然后置 due=now。）
        service.complete_fetch(path, FetchResult::Success, false, None);
        assert!(service.try_claim_fetch(path), "预占手动任务");
        {
            let mut inner = service.inner.lock().unwrap();
            inner.opened.get_mut(&key).unwrap().next_fetch_due = Some(Instant::now());
        }
        let wake = service.collect_due_fetches_inner(Some(false));
        assert_eq!(wake, FETCH_TICK_MAX, "无可领取任务时回兜底周期");
        {
            let inner = service.inner.lock().unwrap();
            assert!(
                inner.opened.get(&key).unwrap().next_fetch_due.is_none(),
                "被占时置空 due 留待完成回调重排"
            );
        }
        service.complete_fetch(path, FetchResult::Success, false, None);
    }

    /// 电池降频：到期任务整体推迟到电池间隔（×3 封顶 30 分钟），不发事件、
    /// 不动 prev_fetch_ok、不占用单飞；接电状态不推迟。
    #[test]
    fn collect_due_fetches_defers_on_battery() {
        let service = RepositoryServiceState::detached();
        let path = "/tmp/branchline-battery-demo";
        let key = service_key(path);
        let _ = service.begin_read(path);
        let interval = Duration::from_secs(AUTO_FETCH_DEFAULT_MINUTES * 60);

        // 纯函数：降频公式（×3 封顶 30 分钟）。
        assert_eq!(battery_delay(interval), interval * 3);
        assert_eq!(
            battery_delay(Duration::from_secs(60 * 20)),
            Duration::from_secs(60 * 30)
        );
        assert_eq!(
            battery_delay(Duration::from_secs(60 * 30)),
            Duration::from_secs(60 * 30),
            "间隔 30 分钟时不放大"
        );

        // 到期 + 电池供电：不领取、due 推迟到电池间隔。
        {
            let mut inner = service.inner.lock().unwrap();
            inner.opened.get_mut(&key).unwrap().next_fetch_due = Some(Instant::now());
        }
        let delay = service.collect_due_fetches_inner(Some(true));
        assert_eq!(
            delay,
            battery_delay(interval).min(FETCH_TICK_MAX),
            "返回电池推迟等待时长"
        );
        {
            let inner = service.inner.lock().unwrap();
            assert!(!inner.fetch_in_flight.contains(&key), "电池推迟不占用单飞");
            let entry = inner.opened.get(&key).unwrap();
            let wait = entry.next_fetch_due.expect("推迟后应重排 due") - Instant::now();
            assert!(wait > interval, "推迟后等待超过基础间隔：{wait:?}");
            assert_eq!(
                entry.prev_fetch_ok, None,
                "电池跳过不动转换基线（不算失败）"
            );
        }

        // 电池未知（台式机等）：策略不介入，照常领取。
        service.complete_fetch(path, FetchResult::Success, false, None);
        {
            let mut inner = service.inner.lock().unwrap();
            inner.opened.get_mut(&key).unwrap().next_fetch_due = Some(Instant::now());
        }
        let _ = service.collect_due_fetches_inner(None);
        let inner = service.inner.lock().unwrap();
        assert!(inner.fetch_in_flight.contains(&key), "未知状态照常领取");
    }

    /// 失败原因分类：https 与 ssh 两类凭据关键词 → "auth"；超时熔断报错 →
    /// "timeout"；其余 → "other"。
    #[test]
    fn classify_fetch_failure_buckets_reasons() {
        assert_eq!(
            classify_fetch_failure("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
            "auth",
            "终端提问被禁（凭据缺失）→ auth"
        );
        assert_eq!(
            classify_fetch_failure(
                "fatal: Authentication failed for 'https://example.com/repo.git'"
            ),
            "auth",
            "https 认证失败 → auth"
        );
        assert_eq!(
            classify_fetch_failure("git@github.com: Permission denied (publickey)."),
            "auth",
            "ssh 公钥被拒 → auth"
        );
        assert_eq!(
            classify_fetch_failure("error: http 403 forbidden"),
            "auth",
            "http 403 → auth"
        );
        assert_eq!(
            classify_fetch_failure("后台 Fetch 超时（超过 120 秒）已被中止"),
            "timeout",
            "超时熔断 → timeout"
        );
        assert_eq!(
            classify_fetch_failure(
                "fatal: unable to access 'https://example.com': Failed to connect"
            ),
            "other",
            "普通网络错误 → other"
        );
        assert_eq!(classify_fetch_failure(""), "other", "空错误归 other");
    }

    /// pmset 输出解析（macOS）：电源来源行区分电池/接电/未知。
    #[cfg(target_os = "macos")]
    #[test]
    fn parse_pmset_battery_distinguishes_sources() {
        let battery = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=123)\t100%; discharging; 5:00 remaining present: true\n";
        assert_eq!(parse_pmset_battery(battery), Some(true));
        let ac = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=123)\t98%; charging; 0:10 remaining present: true\n";
        assert_eq!(parse_pmset_battery(ac), Some(false));
        assert_eq!(parse_pmset_battery(""), None, "空输出未知");
        assert_eq!(parse_pmset_battery("garbage"), None, "无法解析未知");
    }

    /// Linux sysfs 解析：AC 在线优先判接电；无 AC 且电池 Discharging 判电池；
    /// 目录缺失未知。
    #[cfg(target_os = "linux")]
    #[test]
    fn parse_linux_power_supply_reads_sysfs_fixture() {
        let base = std::env::temp_dir().join(format!("branchline-psu-{}", std::process::id()));
        let ac = base.join("AC");
        let bat = base.join("BAT0");
        fs::create_dir_all(&ac).unwrap();
        fs::create_dir_all(&bat).unwrap();
        fs::write(ac.join("online"), "1").unwrap();
        fs::write(bat.join("status"), "Discharging").unwrap();
        assert_eq!(
            parse_linux_power_supply(&base),
            Some(false),
            "AC 在线优先判接电"
        );

        fs::write(ac.join("online"), "0").unwrap();
        assert_eq!(
            parse_linux_power_supply(&base),
            Some(true),
            "电池放电判电池"
        );

        fs::write(bat.join("status"), "Charging").unwrap();
        assert_eq!(
            parse_linux_power_supply(&base),
            None,
            "有电池但充电且 AC 离线 → 未知（保守不介入）"
        );

        assert_eq!(
            parse_linux_power_supply(&base.join("nonexistent")),
            None,
            "目录缺失未知"
        );
        let _ = fs::remove_dir_all(&base);
    }

    /// 通知转换判定：首结果（None 起始）不通知；稳态（连续同结果）不通知；
    /// 只有成功↔失败跳变时通知，极性 = 本次失败与否。
    #[test]
    fn fetch_notify_transition_only_on_flips() {
        assert_eq!(fetch_notify_transition(None, true), None, "首次成功不通知");
        assert_eq!(fetch_notify_transition(None, false), None, "首次失败不通知");
        assert_eq!(
            fetch_notify_transition(Some(true), true),
            None,
            "连续成功静默"
        );
        assert_eq!(
            fetch_notify_transition(Some(false), false),
            None,
            "连续失败静默（退避期不重复打扰）"
        );
        assert_eq!(
            fetch_notify_transition(Some(true), false),
            Some(true),
            "成功→失败：通知失败"
        );
        assert_eq!(
            fetch_notify_transition(Some(false), true),
            Some(false),
            "失败→成功：通知恢复"
        );
    }

    /// prev_fetch_ok 跟踪所有完成路径（含手动），文案随配置存储；手动完成
    /// 参与转换基线但不发通知（auto=false），detached 实例无 app 不出系统弹窗。
    #[test]
    fn complete_fetch_tracks_prev_result_and_stores_notify_texts() {
        let service = RepositoryServiceState::detached();
        let path = "/tmp/branchline-notify-demo";
        let key = service_key(path);
        let _ = service.begin_read(path);

        // 手动成功 → prev 更新但不通知（auto=false 路径同样登记基线）。
        assert!(service.try_claim_fetch(path));
        service.complete_fetch(path, FetchResult::Success, false, None);
        assert_eq!(
            service.inner.lock().unwrap().opened[&key].prev_fetch_ok,
            Some(true),
            "手动结果计入转换基线"
        );

        // 配置下发携带文案：存储可读回。
        service
            .set_auto_fetch_config(
                true,
                5,
                Some(NotifyTexts {
                    failed: "获取失败（测试）".into(),
                    recovered: "获取恢复（测试）".into(),
                }),
            )
            .expect("下发文案");
        {
            let inner = service.inner.lock().unwrap();
            assert_eq!(inner.notify_texts.failed, "获取失败（测试）");
            assert_eq!(inner.notify_texts.recovered, "获取恢复（测试）");
            // 重排行为不变：due 仍按新间隔设置。
            assert!(inner.opened[&key].next_fetch_due.is_some());
        }

        // 通知标题取展示路径末段。
        assert_eq!(
            notify_title("/tmp/branchline-notify-demo"),
            "branchline-notify-demo"
        );
        assert_eq!(notify_title("/tmp/rt/"), "rt");
    }

    /// TCP 探测：监听中的端口判在线；拒绝连接的端口判离线（连接被拒 = 无监听，
    /// 立即返回，不耗时）。
    #[test]
    fn probe_tcp_targets_discriminates_open_and_closed_ports() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("绑定随机端口");
        let addr = listener.local_addr().unwrap();
        assert!(probe_tcp_targets(
            &[(addr.ip().to_string().as_str(), addr.port())],
            Duration::from_millis(500)
        ));
        assert!(
            !probe_tcp_targets(&[("127.0.0.1", 1)], Duration::from_millis(500)),
            "端口 1 无监听，连接被拒应判离线"
        );
    }

    /// 离线收尾策略：不升级退避档（环境状态而非仓库故障），重排仍按基础间隔
    /// ——恢复在线后下一周期立即重试；prev_fetch_ok 照常登记（离线计为失败，
    /// 转换通知语义不变）。
    #[test]
    fn complete_fetch_offline_keeps_backoff_and_reschedules_at_base_interval() {
        let service = RepositoryServiceState::detached();
        let path = "/tmp/branchline-offline-demo";
        let key = service_key(path);
        let _ = service.begin_read(path);

        // 先制造一次失败，退避升到 1（due ≈ 2×间隔）。
        assert!(service.try_claim_fetch(path));
        service.complete_fetch(path, FetchResult::Failed, false, None);
        assert_eq!(
            service.inner.lock().unwrap().opened[&key].fetch_backoff_step,
            1,
            "失败升档"
        );

        // 随后一轮判定为离线：档位保持，due 回到基础间隔附近。
        assert!(service.try_claim_fetch(path));
        service.complete_fetch(path, FetchResult::Offline, false, None);
        {
            let inner = service.inner.lock().unwrap();
            let entry = inner.opened.get(&key).unwrap();
            assert_eq!(entry.fetch_backoff_step, 1, "离线不升级退避（保持当前档）");
            let wait = entry.next_fetch_due.unwrap() - Instant::now();
            let interval = Duration::from_secs(AUTO_FETCH_DEFAULT_MINUTES * 60);
            assert!(
                wait <= interval,
                "离线后按基础间隔重排（非 2×间隔）：{wait:?}"
            );
            assert!(
                wait >= interval - Duration::from_secs(10),
                "重排无额外延迟：{wait:?}"
            );
            assert_eq!(entry.prev_fetch_ok, Some(false), "离线计为未成功");
        }

        // 在线成功后清零退避，回到稳态。
        assert!(service.try_claim_fetch(path));
        service.complete_fetch(path, FetchResult::Success, false, None);
        let inner = service.inner.lock().unwrap();
        assert_eq!(inner.opened[&key].fetch_backoff_step, 0, "成功清零退避");
    }
}
