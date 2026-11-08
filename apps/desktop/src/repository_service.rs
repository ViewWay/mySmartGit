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
/// 定时线程的兜底唤醒周期：即使漏掉一次事件唤醒，调度最多延迟这么久。
const FETCH_TICK_MAX: Duration = Duration::from_secs(30);

/// `repository-auto-fetched` 事件载荷：后台定时 Fetch 完成（含结果）。
/// 前端据此更新「上次获取」时间戳；快照刷新仍走 repository-changed 推送。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RepositoryAutoFetchedEvent {
    repository_path: String,
    ok: bool,
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
    /// 唤醒定时线程立即生效。
    pub fn set_auto_fetch_config(
        &self,
        enabled: bool,
        interval_minutes: u64,
    ) -> Result<(), String> {
        let minutes = interval_minutes.clamp(AUTO_FETCH_MIN_MINUTES, AUTO_FETCH_MAX_MINUTES);
        let interval = Duration::from_secs(minutes * 60);
        let mut inner = self.inner.lock().map_err(|_| "repository service lock")?;
        inner.fetch_config = AutoFetchConfig { enabled, interval };
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
        let mut tasks: Vec<(String, u64)> = Vec::new();
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
                        tasks.push((display, generation));
                    }
                } else if let Some(entry) = inner.opened.get_mut(&key) {
                    entry.next_fetch_due = None;
                }
            }
        }
        for (display, generation) in tasks {
            let app = self.app.clone();
            let wake = self.fetch_wake.clone();
            // 低优先级：后台独立线程执行；CLI 子进程本就不占 UI 线程。
            std::thread::spawn(move || run_fetch_task(app, wake, display, generation, true));
        }
        earliest.unwrap_or(FETCH_TICK_MAX)
    }

    /// 网络任务收尾：释放单飞、按结果重排到期（成功 = 间隔；失败 = 退避倍增）、
    /// 推送 repository-auto-fetched 事件（仅定时任务，手动路径前端已知结果）。
    pub fn complete_fetch(&self, path: &str, ok: bool, auto: bool, _elapsed: Duration) {
        let key = service_key(path);
        let mut inner = self.inner.lock().expect("repository service lock");
        inner.fetch_in_flight.remove(&key);
        let interval = inner.fetch_config.interval;
        let backoff = if ok {
            0
        } else {
            inner
                .opened
                .get(&key)
                .map(|entry| (entry.fetch_backoff_step + 1).min(AUTO_FETCH_BACKOFF_MAX_STEP))
                .unwrap_or(0)
        };
        let delay = interval * 2u32.saturating_pow(backoff);
        let next_due = inner.fetch_config.enabled.then(|| Instant::now() + delay);
        if let Some(entry) = inner.opened.get_mut(&key) {
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
                    },
                );
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

/// 定时 Fetch 任务体：fetch + 重读快照 → 按 generation 协议落缓存 → 收尾。
/// 单飞领取已在 collect_due_fetches（定时）或命令侧 try_claim_fetch（手动）完成。
fn run_fetch_task(
    app: Option<AppHandle>,
    wake: mpsc::Sender<()>,
    display: String,
    generation: u64,
    auto: bool,
) {
    let started = Instant::now();
    let outcome = git::fetch_repository(&display).and_then(|()| git::read_repository(&display));
    let elapsed = started.elapsed();
    if let Some(state) = app
        .as_ref()
        .and_then(|app| app.try_state::<RepositoryServiceState>())
    {
        if let Ok(snapshot) = &outcome {
            state.finish_snapshot(&display, generation, snapshot);
        }
        state.complete_fetch(&display, outcome.is_ok(), auto, elapsed);
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
        service.complete_fetch(path, false, false, Duration::ZERO);
        {
            let inner = service.inner.lock().unwrap();
            let entry = inner.opened.get(&key).expect("驻留条目");
            assert_eq!(entry.fetch_backoff_step, 1, "失败后退避升到 1");
            let wait = entry.next_fetch_due.expect("失败后仍排程") - Instant::now();
            assert!(wait > interval, "退避后等待应超过单倍间隔：{wait:?}");
        }

        // 再失败一次到封顶档 2（×4），随后成功清零退避。
        assert!(service.try_claim_fetch(path));
        service.complete_fetch(path, false, false, Duration::ZERO);
        {
            let inner = service.inner.lock().unwrap();
            assert_eq!(
                inner.opened.get(&key).unwrap().fetch_backoff_step,
                AUTO_FETCH_BACKOFF_MAX_STEP,
                "退避封顶档"
            );
        }
        assert!(service.try_claim_fetch(path));
        service.complete_fetch(path, true, false, Duration::ZERO);
        {
            let inner = service.inner.lock().unwrap();
            let entry = inner.opened.get(&key).unwrap();
            assert_eq!(entry.fetch_backoff_step, 0, "成功清零退避");
            let wait = entry.next_fetch_due.unwrap() - Instant::now();
            assert!(wait <= interval, "成功后回到单倍间隔：{wait:?}");
        }

        // 配置下发：禁用清空排程；改间隔重排并清退避；超范围夹取到 60 分钟。
        service.set_auto_fetch_config(false, 5).expect("禁用配置");
        {
            let inner = service.inner.lock().unwrap();
            let entry = inner.opened.get(&key).unwrap();
            assert!(entry.next_fetch_due.is_none(), "禁用后不排程");
        }
        service.set_auto_fetch_config(true, 3).expect("改 3 分钟");
        {
            let inner = service.inner.lock().unwrap();
            let entry = inner.opened.get(&key).unwrap();
            let wait = entry.next_fetch_due.unwrap() - Instant::now();
            assert!(
                wait <= Duration::from_secs(3 * 60),
                "按新间隔重排：{wait:?}"
            );
        }
        service.set_auto_fetch_config(true, 999).expect("超限配置");
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
    /// 到期但单飞被占（手动任务在跑）只置空 due、不重复领取。
    #[test]
    fn collect_due_fetches_claims_once_and_reports_earliest_wake() {
        let service = RepositoryServiceState::detached();
        let path = "/tmp/branchline-fetch-collect-demo";
        let key = service_key(path);
        let _ = service.begin_read(path);

        // 未到期：无任务领取，返回最近唤醒（默认 5 分钟内）。
        let wake = service.collect_due_fetches();
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
        let _ = service.collect_due_fetches();
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
        service.complete_fetch(path, true, false, Duration::ZERO);
        assert!(service.try_claim_fetch(path), "预占手动任务");
        {
            let mut inner = service.inner.lock().unwrap();
            inner.opened.get_mut(&key).unwrap().next_fetch_due = Some(Instant::now());
        }
        let wake = service.collect_due_fetches();
        assert_eq!(wake, FETCH_TICK_MAX, "无可领取任务时回兜底周期");
        {
            let inner = service.inner.lock().unwrap();
            assert!(
                inner.opened.get(&key).unwrap().next_fetch_due.is_none(),
                "被占时置空 due 留待完成回调重排"
            );
        }
        service.complete_fetch(path, true, false, Duration::ZERO);
    }
}
