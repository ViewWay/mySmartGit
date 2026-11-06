//! W2-9 深度搜索与仓库全文替换。
//!
//! 两条能力线：
//! 1. 历史深度搜索：按提交信息 / 作者 / Hash / 差异内容（pickaxe `-S` 与逐行正则 `-G`
//!    两种语义）扫描**全量历史**，不受提交图谱 2000 条内存窗口约束，分页返回并给出总数。
//! 2. 仓库全文搜索与替换：`git grep` 的「文件:行:内容」结果 + 行号与上下文片段，
//!    内置编辑器的读取/保存，以及默认 dry-run、确认后写盘、可撤销的批量替换。
//!
//! 安全红线（与 git.rs 一致，且更严格）：
//! - Git 一律以**参数数组**启动：`Command::new("git").arg("-C").arg(root).args(...)`，
//!   绝不使用 `sh -c` 或字符串拼接。用户输入只作为 `--grep=<值>` / `-S<值>` / `-G<值>` /
//!   `-e <值>` 这类独立参数，交给 Git 自身的正则引擎（`-F` 固定串 / `-E` 扩展正则）。
//! - 引用与路径全部白名单校验：`rev-parse --verify` 必须得到 40 位十六进制对象；
//!   路径拒绝绝对路径、`..`、以 `-`/`:` 开头的取值，写盘前再做 canonicalize 前缀校验。
//! - 有界性：条数上限 + 字节上限双重约束，超限显式回 `truncated` 与 `notice`，不静默丢弃。
//! - 可取消性：同一仓库同一类型只允许一个重查询；新任务、切换仓库、关闭窗口都会置位
//!   旧任务的取消标志，读流线程 + 轮询循环会 kill 子进程，不会排队堆积。
//! - 替换的破坏性：预览不落盘；写盘前逐文件校验预览时的内容校验和；写入前整体备份到
//!   `<git-dir>/branchline-replace/<id>`；失败自动回滚；撤销时拒绝覆盖外部新改动。

use crate::git;
use crate::models::{
    CommitSearchItem, CommitSearchPage, CommitSearchQuery, CommitSearchTarget, ReplaceBackupSummary,
    ReplacePreview, ReplacePreviewFile, ReplaceReport, RepositoryTextFile, TextReplaceQuery,
    TextSearchMatch, TextSearchPage, TextSearchQuery,
};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// ---------------------------------------------------------------------------
// 上限常量：条数与字节双重上限，全部显式可追溯
// ---------------------------------------------------------------------------

/// 单次历史扫描最多索引的提交数（超过即 truncated，UI 必须提示）。
const MAX_INDEXED_COMMITS: usize = 50_000;
/// 提交 Hash 索引的字节兜底（41 字节/条 × 上限的宽松倍数）。
const MAX_COMMIT_SCAN_BYTES: usize = 128 * 1024 * 1024;
const DEFAULT_COMMIT_PAGE_SIZE: usize = 100;
const MAX_COMMIT_PAGE_SIZE: usize = 200;
/// 一次 `git show -s --no-walk` 批量取元数据的提交数（控制在 Windows 32K 命令行长度内）。
const METADATA_BATCH: usize = 50;
/// 送回前端的一页提交元数据字节预算。
const MAX_PAGE_BYTES: usize = 256 * 1024;
const MAX_TITLE_CHARS: usize = 400;
const MAX_MESSAGE_CHARS: usize = 4_000;

/// 全文搜索命中行上限（默认/硬上限）。
const DEFAULT_TEXT_MAX_MATCHES: usize = 2_000;
const MAX_TEXT_MAX_MATCHES: usize = 20_000;
const DEFAULT_TEXT_PAGE_SIZE: usize = 200;
const MAX_TEXT_PAGE_SIZE: usize = 500;
const MAX_TEXT_LINE_CHARS: usize = 1_000;
/// 单次 grep 允许读取的原始输出字节数。
const MAX_GREP_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
/// 上下文读取：单页最多读取的文件数与单文件字节数。
const MAX_CONTEXT_FILES: usize = 64;
const MAX_CONTEXT_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_CONTEXT_CHARS: usize = 500;
const MAX_CONTEXT_LINES: usize = 10;

/// 替换：文件数、命中处数、字节总量上限。
const DEFAULT_REPLACE_MAX_FILES: usize = 512;
const MAX_REPLACE_MAX_FILES: usize = 2_000;
const MAX_REPLACE_OCCURRENCES: usize = 100_000;
const MAX_REPLACE_FILE_BYTES: usize = 8 * 1024 * 1024;
const MAX_REPLACE_TOTAL_BYTES: usize = 32 * 1024 * 1024;
/// 编辑器读写上限。
const DEFAULT_EDITOR_MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_EDITOR_BYTES: usize = 8 * 1024 * 1024;

/// 搜索索引缓存的会话数（FIFO 淘汰），每会话另有字节上限。
const MAX_SEARCH_SESSIONS: usize = 8;
const MAX_INDEX_BYTES: usize = 8 * 1024 * 1024;
const MAX_PREVIEW_SESSIONS: usize = 8;
const MAX_BACKUP_SESSIONS: usize = 20;

const PATTERN_MAX_CHARS: usize = 1_000;
const REPLACEMENT_MAX_CHARS: usize = 4_000;
/// 读流轮询周期：即使 Git 长时间不产出记录，取消也能在这个粒度内生效。
const POLL: Duration = Duration::from_millis(120);
const BACKUP_ROOT_DIR: &str = "branchline-replace";
const MANIFEST_NAME: &str = "manifest";

// ---------------------------------------------------------------------------
// 通用小工具：ID / 校验和 / 转义
// ---------------------------------------------------------------------------

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn next_id(prefix: &str) -> String {
    let sequence = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    format!("{prefix}-{}-{sequence}", std::process::id())
}

fn next_sequence() -> u64 {
    NEXT_SEQUENCE.fetch_add(1, Ordering::SeqCst)
}

/// FNV-1a/64：稳定的内容校验和，避免为此引入新 crate。
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// 内容校验和：把长度域分离进摘要。
///
/// 这是替换/保存的安全前提——截断加载得到的是「前缀摘要」，若不编码长度，
/// 一次 FNV 碰撞就可能让「只读了前 N 字节」的基线通过全文校验，从而用半份内容覆盖整个文件。
fn checksum(bytes: &[u8]) -> String {
    let mut digest = fnv1a64(bytes);
    digest ^= fnv1a64(&bytes.len().to_le_bytes());
    format!("{:016x}", digest)
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn char_take(value: &str, limit: usize) -> String {
    let count = value.chars().count();
    if count <= limit {
        return value.to_string();
    }
    let mut truncated: String = value.chars().take(limit).collect();
    truncated.push('…');
    truncated
}

fn is_hex_object(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_hex_hash_line(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn normalize_newlines(value: &str) -> String {
    value.replace("\r\n", "\n").replace('\r', "\n")
}

/// manifest 里的单行取值转义：路径/模式可能包含反斜杠等字符。
fn escape_field(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\n', "\\n").replace('\t', "\\t")
}

fn unescape_field(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut characters = value.chars();
    while let Some(character) = characters.next() {
        if character != '\\' {
            result.push(character);
            continue;
        }
        match characters.next() {
            Some('n') => result.push('\n'),
            Some('t') => result.push('\t'),
            Some('\\') => result.push('\\'),
            Some(other) => result.push(other),
            None => result.push('\\'),
        }
    }
    result
}

// ---------------------------------------------------------------------------
// 输入校验：模式 / 引用 / pathspec / 文件路径
// ---------------------------------------------------------------------------

fn validated_pattern(pattern: &str) -> Result<String, String> {
    if pattern.is_empty() {
        return Err("搜索内容不能为空".to_string());
    }
    if pattern.chars().count() > PATTERN_MAX_CHARS {
        return Err(format!("搜索内容过长（上限 {PATTERN_MAX_CHARS} 字符）"));
    }
    if pattern.contains('\0') || pattern.contains(['\n', '\r']) {
        return Err("搜索内容不支持换行与控制字符".to_string());
    }
    Ok(pattern.to_string())
}

fn validated_replacement(replacement: &str, regex: bool) -> Result<String, String> {
    if replacement.chars().count() > REPLACEMENT_MAX_CHARS {
        return Err(format!("替换文本过长（上限 {REPLACEMENT_MAX_CHARS} 字符）"));
    }
    if replacement.contains('\0') || replacement.contains(['\n', '\r']) {
        return Err("替换文本不支持换行；请改用内置编辑器逐行修改".to_string());
    }
    if regex && contains_group_reference(replacement) {
        return Err("正则替换暂不支持捕获组引用（如 $1、\\1）：匹配位置由 Git 给出，请改用固定字符串或编辑器".to_string());
    }
    Ok(replacement.to_string())
}

/// 匹配文本由 Git 正则引擎给出，Rust 侧只做字节切片拼接，因此不支持回填捕获组。
fn contains_group_reference(replacement: &str) -> bool {
    let bytes = replacement.as_bytes();
    bytes.windows(2).any(|pair| {
        matches!(pair[0], b'$' | b'\\') && pair[1].is_ascii_digit()
    })
}

/// 引用白名单：分支/标签/范围/`HEAD@{1}` 等；拒绝选项注入与其他符号。
fn validated_revision_token(value: &str) -> Result<String, String> {
    let token = value.trim();
    if token.is_empty() || token.chars().count() > 200 {
        return Err("无效的引用".to_string());
    }
    if token.starts_with('-') || token.starts_with('.') || token.starts_with('/') {
        return Err(format!("引用不能以 - . / 开头：{value}"));
    }
    if !token.bytes().all(|byte| {
        byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'.' | b'_' | b'-' | b'/' | b'@' | b'{' | b'}' | b'~' | b'^' | b'[' | b']' | b':'
            )
    }) {
        return Err(format!("引用包含不支持的字符：{value}"));
    }
    Ok(token.to_string())
}

/// 校验提交范围：`main`、`main..feature`、`main...feature`、`HEAD~5`；逐端解析成提交对象。
fn validated_revision_range(root: &Path, value: &str) -> Result<String, String> {
    let token = validated_revision_token(value)?;
    let separator = if token.contains("...") {
        Some("...")
    } else if token.contains("..") {
        Some("..")
    } else {
        None
    };
    let sides: Vec<&str> = match separator {
        Some(split) => token.split(split).collect(),
        None => vec![token.as_str()],
    };
    for side in &sides {
        let side = side.trim();
        if side.is_empty() {
            continue;
        }
        resolve_commit_object(root, &validated_revision_token(side)?)?;
    }
    Ok(token)
}

fn resolve_commit_object(root: &Path, reference: &str) -> Result<String, String> {
    let token = validated_revision_token(reference)?;
    // `rev-parse --verify` 只接受**单个**版本，`^{commit}` 必须与引用拼成一段参数，
    // 分成两个参数会让 Git 报「需要一个单独的版本」。
    let output = git::git_output_owned(
        root,
        &[
            "rev-parse".into(),
            "--verify".into(),
            "--end-of-options".into(),
            format!("{token}^{{commit}}"),
        ],
    )
    .map_err(|_| format!("无效的提交或分支：{reference}"))?;
    let object = output.trim().to_string();
    if !is_hex_object(&object) {
        return Err(format!("无效的提交或分支：{reference}"));
    }
    Ok(object)
}

/// grep 的树范围：提交 / 分支 / 标签，只要能解析成 tree 对象。
fn resolve_tree_object(root: &Path, reference: &str) -> Result<String, String> {
    let token = validated_revision_token(reference)?;
    let output = git::git_output_owned(
        root,
        &[
            "rev-parse".into(),
            "--verify".into(),
            "--end-of-options".into(),
            format!("{token}^{{tree}}"),
        ],
    )
    .map_err(|_| format!("无效的分支或版本：{reference}"))?;
    let object = output.trim().to_string();
    if !is_hex_object(&object) {
        return Err(format!("无效的分支或版本：{reference}"));
    }
    Ok(object)
}

/// pathspec 校验：仓库内相对 glob，拒绝绝对路径、`..`、选项注入与 `:(magic)` 前缀。
fn validated_pathspec(pattern: &str) -> Result<String, String> {
    let value = pattern.trim().replace('\\', "/");
    if value.is_empty() || value.chars().count() > 512 {
        return Err("路径范围不能为空且不超过 512 字符".to_string());
    }
    if value.starts_with(':') || value.starts_with('-') || value.starts_with('/') {
        return Err(format!("路径范围必须是仓库内相对路径：{pattern}"));
    }
    if value.contains('\0') || value.contains(['\n', '\r']) {
        return Err("路径范围包含非法字符".to_string());
    }
    if value.split('/').any(|part| part == "..") {
        return Err(format!("路径范围超出仓库：{pattern}"));
    }
    Ok(value)
}

fn validated_pathspecs(patterns: &[String]) -> Result<Vec<String>, String> {
    let mut values = Vec::with_capacity(patterns.len());
    for pattern in patterns {
        let value = validated_pathspec(pattern)?;
        if !value.is_empty() {
            values.push(value);
        }
    }
    Ok(values)
}

/// 文件路径校验（比 pathspec 更严：不接受通配符，只针对单个文件）。
fn validated_relative_file(file_path: &str) -> Result<String, String> {
    let value = file_path.trim().replace('\\', "/");
    if value.is_empty() || value.chars().count() > 1_024 {
        return Err("文件路径无效".to_string());
    }
    if value.starts_with('/') || value.starts_with(':') || value.starts_with('-') {
        return Err(format!("文件路径超出仓库范围：{file_path}"));
    }
    if value.contains('\0') || value.contains(['\n', '\r']) {
        return Err("文件路径包含非法字符".to_string());
    }
    if value.contains(['*', '?', '[', '{']) {
        return Err("文件路径不支持通配符".to_string());
    }
    if Path::new(&value)
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(format!("文件路径超出仓库范围：{file_path}"));
    }
    Ok(value)
}

/// 解析仓库内真实路径：canonicalize 后必须仍在仓库根内（挡符号链接逃逸）。
fn resolve_inside_repo(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative_path = validated_relative_file(relative)?;
    let candidate = root.join(&relative_path);
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("无法解析仓库根目录：{error}"))?;
    let canonical = if candidate.symlink_metadata().is_ok() {
        candidate
            .canonicalize()
            .map_err(|error| format!("无法解析文件路径：{error}"))?
    } else {
        let parent = candidate
            .parent()
            .ok_or_else(|| format!("文件路径无效：{relative}"))?;
        let canonical_parent = parent
            .canonicalize()
            .map_err(|_| format!("文件所在目录不存在：{relative}"))?;
        canonical_parent.join(
            candidate
                .file_name()
                .ok_or_else(|| format!("文件路径无效：{relative}"))?,
        )
    };
    if !canonical.starts_with(&canonical_root) {
        return Err(format!("文件路径超出仓库范围：{relative}"));
    }
    Ok(canonical)
}

// ---------------------------------------------------------------------------
// 可取消任务队列：每仓库每类型单飞，新任务抢占旧任务
// ---------------------------------------------------------------------------

fn task_key(root: &Path, kind: &str) -> String {
    format!("{repo}::{kind}", repo = repository_key(root))
}

/// 仓库身份键：对路径做 canonicalize，再取摘要。
///
/// 必须是规范化路径：macOS 的临时目录 `/var/...` 是指向 `/private/var/...` 的符号链接，
/// 而 `git rev-parse --show-toplevel` 返回后者。若直接用调用方手里的字符串建键，
/// 同一个仓库的两种写法会得到两个键，**取消任务与清理缓存会静默失效**（重查询堆积），
/// 用户通过软链接添加仓库时同样中招。
fn repository_key(root: &Path) -> String {
    let canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    format!("{:016x}", fnv1a64(canonical.to_string_lossy().as_bytes()))
}

fn repository_prefix(root: &Path) -> String {
    format!("{}::", repository_key(root))
}

#[derive(Default)]
struct TaskRegistry {
    /// 任务键 -> 当前世代的取消标志；同键新任务会置位旧标志。
    active: HashMap<String, Arc<AtomicBool>>,
}

fn task_registry() -> &'static Mutex<TaskRegistry> {
    static REGISTRY: OnceLock<Mutex<TaskRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(TaskRegistry::default()))
}

/// 一次扫描的门票：Drop 时若仍是当前世代则摘除，保证不会有僵尸任务堆积。
struct SearchTask {
    key: String,
    cancelled: Arc<AtomicBool>,
}

fn begin_task(key: &str) -> SearchTask {
    let flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut registry) = task_registry().lock() {
        // 抢占：把同仓库同类型的旧任务标记为取消，避免多个重查询同时跑。
        if let Some(previous) = registry.active.insert(key.to_string(), flag.clone()) {
            previous.store(true, Ordering::SeqCst);
        }
    }
    SearchTask {
        key: key.to_string(),
        cancelled: flag,
    }
}

impl SearchTask {
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

impl Drop for SearchTask {
    fn drop(&mut self) {
        if self.key.is_empty() {
            return;
        }
        if let Ok(mut registry) = task_registry().lock() {
            if registry
                .active
                .get(&self.key)
                .is_some_and(|flag| Arc::ptr_eq(flag, &self.cancelled))
            {
                registry.active.remove(&self.key);
            }
        }
    }
}

/// 中止该仓库所有在跑的搜索任务，并丢弃其分页索引与替换预览（切换仓库 / 关闭窗口时调用）。
pub fn cancel_repository_search(repository_path: &str) -> usize {
    let root = git::repository_root(repository_path).unwrap_or_default();
    let prefix = repository_prefix(&root);
    let mut cancelled = 0;
    if let Ok(registry) = task_registry().lock() {
        for (key, flag) in registry.active.iter() {
            if key.starts_with(&prefix) {
                flag.store(true, Ordering::SeqCst);
                cancelled += 1;
            }
        }
    }
    drop_index_for(&prefix);
    drop_previews_for(&prefix);
    cancelled
}

// ---------------------------------------------------------------------------
// 搜索索引缓存：一次扫描、多次分页，游标稳定不重不漏
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct StoredMatch {
    file_path: String,
    line_number: usize,
    content: String,
    /// 二进制命中：内容已置空，但记录保留，UI 需显示「二进制文件命中」。
    binary: bool,
}

enum SearchIndex {
    /// 历史搜索：只缓存提交 Hash，元数据按需再取，避免整段历史进内存。
    Commits(Vec<String>),
    /// 全文搜索：缓存「文件:行:内容」三元组，内容按字符上限截断。
    Matches(Vec<StoredMatch>),
}

struct CachedIndex {
    repository_prefix: String,
    index: SearchIndex,
    pattern: String,
    target: Option<CommitSearchTarget>,
    revision: Option<String>,
    total: usize,
    matched_files: usize,
    truncated: bool,
    cancelled: bool,
    notice: Option<String>,
    bytes: usize,
    sequence: u64,
}

fn index_cache() -> &'static Mutex<HashMap<String, CachedIndex>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedIndex>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn store_index(entry: CachedIndex) -> String {
    let id = next_id("search");
    let mut entry = entry;
    entry.sequence = next_sequence();
    if let Ok(mut cache) = index_cache().lock() {
        while cache.len() + 1 > MAX_SEARCH_SESSIONS {
            match cache
                .iter()
                .min_by_key(|(_, value)| value.sequence)
                .map(|(key, _)| key.clone())
            {
                Some(key) => {
                    cache.remove(&key);
                }
                None => break,
            }
        }
        cache.insert(id.clone(), entry);
    }
    id
}

fn drop_index_for(prefix: &str) {
    if let Ok(mut cache) = index_cache().lock() {
        let stale: Vec<String> = cache
            .iter()
            .filter(|(_, value)| value.repository_prefix == prefix)
            .map(|(key, _)| key.clone())
            .collect();
        for key in stale {
            cache.remove(&key);
        }
    }
}

/// 读取缓存索引的一页；类型不符（把文本搜索 id 用于历史翻页）直接拒绝。
fn page_from_commit_index(
    search_id: &str,
    prefix: &str,
    offset: usize,
    page_size: usize,
) -> Result<(Vec<String>, usize, String, Option<CommitSearchTarget>, bool, bool, Option<String>), String> {
    let cache = index_cache().lock().map_err(|_| "搜索缓存不可用".to_string())?;
    let entry = cache
        .get(search_id)
        .ok_or_else(|| "搜索结果已过期，请重新搜索".to_string())?;
    if entry.repository_prefix != prefix {
        return Err("搜索标识与当前仓库不匹配".to_string());
    }
    let SearchIndex::Commits(hashes) = &entry.index else {
        return Err("搜索标识类型不匹配（历史分页）".to_string());
    };
    let start = offset.min(hashes.len());
    let end = start.saturating_add(page_size).min(hashes.len());
    Ok((
        hashes[start..end].to_vec(),
        entry.total,
        entry.pattern.clone(),
        entry.target,
        entry.truncated,
        entry.cancelled,
        entry.notice.clone(),
    ))
}

fn page_from_match_index(
    search_id: &str,
    prefix: &str,
    offset: usize,
    page_size: usize,
) -> Result<(Vec<StoredMatch>, usize, usize, String, Option<String>, bool, bool, Option<String>), String> {
    let cache = index_cache().lock().map_err(|_| "搜索缓存不可用".to_string())?;
    let entry = cache
        .get(search_id)
        .ok_or_else(|| "搜索结果已过期，请重新搜索".to_string())?;
    if entry.repository_prefix != prefix {
        return Err("搜索标识与当前仓库不匹配".to_string());
    }
    let SearchIndex::Matches(matches) = &entry.index else {
        return Err("搜索标识类型不匹配（全文分页）".to_string());
    };
    let start = offset.min(matches.len());
    let end = start.saturating_add(page_size).min(matches.len());
    Ok((
        matches[start..end].to_vec(),
        entry.total,
        entry.matched_files,
        entry.pattern.clone(),
        entry.revision.clone(),
        entry.truncated,
        entry.cancelled,
        entry.notice.clone(),
    ))
}

fn clamp_page(requested: usize, default: usize, maximum: usize) -> usize {
    if requested == 0 {
        default.min(maximum)
    } else {
        requested.clamp(1, maximum)
    }
}

// ---------------------------------------------------------------------------
// 子进程输出流式读取：独立线程读管道，主循环轮询取消标志
// ---------------------------------------------------------------------------

enum ReadEvent {
    Chunk(Vec<u8>),
    Eof,
    Failed(String),
}

enum RecordOutcome {
    Record(Vec<u8>),
    NeedMore,
    End,
}

/// 有界记录读取器：按分隔符切分，单条记录超长即截断并丢弃余下部分。
struct OutputReader {
    receiver: Receiver<ReadEvent>,
    buffer: Vec<u8>,
    delimiter: u8,
    max_record_bytes: usize,
    skipping: bool,
    eof: bool,
    read_bytes: usize,
}

impl OutputReader {
    fn next_record(&mut self) -> RecordOutcome {
        loop {
            if let Some(index) = self.buffer.iter().position(|byte| *byte == self.delimiter) {
                let mut record: Vec<u8> = self.buffer.drain(..=index).collect();
                record.pop(); // 去掉分隔符
                if self.skipping {
                    // 上一条超长记录的尾部：丢弃，不产生额外记录。
                    self.skipping = false;
                    continue;
                }
                return RecordOutcome::Record(record);
            }
            if self.skipping {
                self.buffer.clear();
            } else if self.buffer.len() > self.max_record_bytes {
                let head: Vec<u8> = self.buffer.drain(..self.max_record_bytes).collect();
                self.skipping = true;
                return RecordOutcome::Record(head);
            }
            if self.eof {
                if self.buffer.is_empty() {
                    return RecordOutcome::End;
                }
                let tail = std::mem::take(&mut self.buffer);
                self.skipping = false;
                return RecordOutcome::Record(tail);
            }
            return RecordOutcome::NeedMore;
        }
    }

    /// 最多等待一个轮询周期；返回 false 表示已 EOF。
    fn wait(&mut self) -> Result<bool, String> {
        if self.eof {
            return Ok(false);
        }
        match self.receiver.recv_timeout(POLL) {
            Ok(ReadEvent::Chunk(bytes)) => {
                self.read_bytes += bytes.len();
                self.buffer.extend_from_slice(&bytes);
                Ok(true)
            }
            Ok(ReadEvent::Eof) => {
                self.eof = true;
                Ok(false)
            }
            Ok(ReadEvent::Failed(error)) => Err(error),
            Err(RecvTimeoutError::Timeout) => Ok(true),
            Err(RecvTimeoutError::Disconnected) => {
                self.eof = true;
                Ok(false)
            }
        }
    }
}

#[derive(Default)]
struct ScanOutcome {
    cancelled: bool,
    stopped_early: bool,
    byte_budget_hit: bool,
}

struct GitStream {
    child: Child,
    reader: OutputReader,
    stderr: Option<JoinHandle<Vec<u8>>>,
    kill_on_finish: bool,
}

fn configure_git(command: &mut Command, root: &Path, args: &[String]) {
    command
        .arg("-C")
        .arg(root)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    command.creation_flags(0x0800_0000);
}

impl GitStream {
    fn start(root: &Path, args: &[String], delimiter: u8, max_record_bytes: usize) -> Result<Self, String> {
        let mut command = Command::new("git");
        configure_git(&mut command, root, args);
        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动 Git：{error}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法读取 Git 输出".to_string())?;
        let stderr_pipe: Option<ChildStderr> = child.stderr.take();
        let (sender, receiver) = channel::<ReadEvent>();
        if let Err(error) = std::thread::Builder::new()
            .name("branchline-git-search".to_string())
            .spawn(move || pipe_reader(stdout, sender))
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("无法启动读取线程：{error}"));
        }
        let stderr = stderr_pipe.map(spawn_stderr_reader);
        Ok(GitStream {
            child,
            reader: OutputReader {
                receiver,
                buffer: Vec::new(),
                delimiter,
                max_record_bytes,
                skipping: false,
                eof: false,
                read_bytes: 0,
            },
            stderr,
            kill_on_finish: false,
        })
    }

    /// 逐条消费记录：取消标志在每条记录前后都检查，字节上限在等待新数据时检查，
    /// 因此即使 Git 长时间不产出记录（如 -S 全历史扫描）取消也能及时生效。
    fn scan<F>(&mut self, cancel: &SearchTask, budget: usize, mut visit: F) -> Result<ScanOutcome, String>
    where
        F: FnMut(&[u8]) -> Result<bool, String>,
    {
        let mut outcome = ScanOutcome::default();
        loop {
            if cancel.is_cancelled() {
                outcome.cancelled = true;
                outcome.stopped_early = true;
                break;
            }
            match self.reader.next_record() {
                RecordOutcome::Record(record) => {
                    if !visit(&record)? {
                        outcome.stopped_early = true;
                        break;
                    }
                }
                RecordOutcome::End => break,
                RecordOutcome::NeedMore => {
                    if self.reader.read_bytes > budget {
                        outcome.byte_budget_hit = true;
                        outcome.stopped_early = true;
                        break;
                    }
                    self.reader.wait()?;
                }
            }
        }
        Ok(outcome)
    }

    /// 主动停止（取消/超上限）时 kill 子进程，并把这条路径视为正常结束。
    fn stop(mut self, outcome: &ScanOutcome, accepted: &[i32]) -> Result<(), String> {
        self.kill_on_finish = outcome.cancelled || outcome.stopped_early || outcome.byte_budget_hit;
        if self.kill_on_finish {
            let _ = self.child.kill();
        }
        let status = self
            .child
            .wait()
            .map_err(|error| format!("等待 Git 退出失败：{error}"))?;
        let stderr = self
            .stderr
            .take()
            .map(|handle| handle.join().unwrap_or_default())
            .unwrap_or_default();
        if self.kill_on_finish || status.success() || status.code().is_some_and(|code| accepted.contains(&code)) {
            return Ok(());
        }
        let message = String::from_utf8_lossy(&stderr).trim().to_string();
        Err(if message.is_empty() {
            "Git 命令执行失败".to_string()
        } else {
            message
        })
    }
}

impl Drop for GitStream {
    fn drop(&mut self) {
        // 任何提前返回都保证子进程被回收，不留僵尸或悬挂的重查询。
        if self.kill_on_finish || self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

fn pipe_reader(mut pipe: ChildStdout, sender: Sender<ReadEvent>) {
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(size) => {
                if sender.send(ReadEvent::Chunk(chunk[..size].to_vec())).is_err() {
                    return;
                }
            }
            Err(error) => {
                let _ = sender.send(ReadEvent::Failed(format!("读取 Git 输出失败：{error}")));
                return;
            }
        }
    }
    let _ = sender.send(ReadEvent::Eof);
}

fn spawn_stderr_reader(pipe: ChildStderr) -> JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buffer = Vec::new();
        // 只保留前 8 KB：错误信息足够定位，且绝不因 stderr 堆积而阻塞。
        let mut limited = pipe.take(8_192);
        let _ = limited.read_to_end(&mut buffer);
        buffer
    })
}

/// 一次性读取小输出（有字节上限），用于元数据批量取与 blob 读取。
fn git_capture(root: &Path, args: &[String], max_bytes: usize) -> Result<(Vec<u8>, bool), String> {
    let mut command = Command::new("git");
    configure_git(&mut command, root, args);
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 Git：{error}"))?;
    let stderr_pipe: Option<ChildStderr> = child.stderr.take();
    let mut output: Vec<u8> = Vec::new();
    let mut truncated = false;
    if let Some(mut stdout) = child.stdout.take() {
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) => break,
                Ok(size) => {
                    if output.len() + size > max_bytes {
                        let remaining = max_bytes.saturating_sub(output.len());
                        output.extend_from_slice(&chunk[..remaining]);
                        truncated = true;
                        let _ = child.kill();
                        break;
                    }
                    output.extend_from_slice(&chunk[..size]);
                }
                Err(error) => {
                    let _ = child.kill();
                    return Err(format!("读取 Git 输出失败：{error}"));
                }
            }
        }
    }
    let status = child
        .wait()
        .map_err(|error| format!("等待 Git 退出失败：{error}"))?;
    let stderr = stderr_pipe
        .map(spawn_stderr_reader)
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    if truncated {
        return Ok((output, true));
    }
    if !status.success() {
        let message = String::from_utf8_lossy(&stderr).trim().to_string();
        return Err(if message.is_empty() {
            "Git 命令执行失败".to_string()
        } else {
            message
        });
    }
    Ok((output, false))
}

// ---------------------------------------------------------------------------
// 任务一：历史深度搜索（全量历史，分页）
// ---------------------------------------------------------------------------

const HISTORY_FORMAT: &str = "%x1e%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%B";

/// 组装 `git log` 索引扫描参数：只输出 Hash，逐条流式消费。
fn commit_index_args(
    query: &CommitSearchQuery,
    pattern: &str,
    revisions: &[String],
    paths: &[String],
    excludes: &[String],
    scan_limit: usize,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-c".into(),
        "core.quotepath=false".into(),
        "log".into(),
        // 与提交图谱一致的次序偏好，保证同一查询多次分页稳定。
        "--date-order".into(),
        format!("--max-count={}", scan_limit.saturating_add(1)),
        "--format=%H".into(),
    ];
    if !query.case_sensitive {
        args.push("-i".into());
    }
    if query.whole_word {
        args.push("--word-regexp".into());
    }
    // 正则由 Git 自身引擎处理：-E 扩展正则 / -F 固定字符串，绝不进 shell。
    args.push(if query.regex { "-E".into() } else { "-F".into() });
    match query.target {
        CommitSearchTarget::CommitMessage => args.push(format!("--grep={pattern}")),
        CommitSearchTarget::CommitAuthor => args.push(format!("--author={pattern}")),
        CommitSearchTarget::DiffPickaxe => {
            args.push(format!("-S{pattern}"));
            if query.regex {
                args.push("--pickaxe-regex".into());
            }
        }
        CommitSearchTarget::DiffRegex => args.push(format!("-G{pattern}")),
        CommitSearchTarget::CommitHash => {}
    }
    if revisions.is_empty() {
        args.push("--all".into());
    } else {
        args.push("--end-of-options".into());
        args.extend(revisions.iter().cloned());
    }
    // pathspec 必须放在最后：`--` 之后的所有参数都会被当成路径。
    if !paths.is_empty() || !excludes.is_empty() {
        args.push("--".into());
        args.extend(paths.iter().cloned());
        for exclude in excludes {
            args.push(format!(":(exclude){exclude}"));
        }
    }
    args
}

fn validate_commit_scope(
    root: &Path,
    query: &CommitSearchQuery,
) -> Result<(Vec<String>, Vec<String>, Vec<String>), String> {
    let mut revisions = Vec::new();
    for revision in &query.revisions {
        revisions.push(validated_revision_range(root, revision)?);
    }
    let paths = validated_pathspecs(&query.paths)?;
    let excludes = validated_pathspecs(&query.exclude_paths)?;
    Ok((revisions, paths, excludes))
}

/// 全量历史搜索：先流式扫描命中提交（只留 Hash 进索引），再按页取元数据。
pub fn search_commits(repository_path: &str, query: CommitSearchQuery) -> Result<CommitSearchPage, String> {
    let root = git::repository_root(repository_path)?;
    let prefix = repository_prefix(&root);
    let (revisions, paths, excludes) = validate_commit_scope(&root, &query)?;

    if query.target == CommitSearchTarget::CommitHash {
        return hash_lookup_page(&root, &query);
    }

    let pattern = validated_pattern(&query.pattern)?;
    let scan_limit = query
        .max_commits
        .unwrap_or(MAX_INDEXED_COMMITS)
        .clamp(1, MAX_INDEXED_COMMITS);
    let task = begin_task(&task_key(&root, "commit"));
    let args = commit_index_args(&query, &pattern, &revisions, &paths, &excludes, scan_limit);
    let mut stream = GitStream::start(&root, &args, b'\n', 128)?;
    let mut hashes: Vec<String> = Vec::new();
    let mut overflow = false;
    let outcome = stream.scan(&task, MAX_COMMIT_SCAN_BYTES, |record| {
        let line = String::from_utf8_lossy(record).trim().to_string();
        if !is_hex_hash_line(&line) {
            return Ok(true);
        }
        if hashes.len() >= scan_limit {
            overflow = true;
            return Ok(false);
        }
        hashes.push(line);
        Ok(true)
    })?;
    stream.stop(&outcome, &[0])?;

    let truncated = overflow || outcome.byte_budget_hit;
    let notice = if outcome.cancelled {
        Some("搜索已取消，结果不完整".to_string())
    } else if truncated {
        Some(format!(
            "命中提交超过 {scan_limit} 条上限，结果已截断（仅索引前 {scan_limit} 条），请缩小分支或路径范围"
        ))
    } else {
        None
    };

    let total = hashes.len();
    let matched_files = 0;
    let search_id = store_index(CachedIndex {
        repository_prefix: prefix.clone(),
        index: SearchIndex::Commits(hashes),
        pattern: pattern.clone(),
        target: Some(query.target),
        revision: None,
        total,
        matched_files,
        truncated,
        cancelled: outcome.cancelled,
        notice: notice.clone(),
        bytes: total * 41,
        sequence: 0,
    });
    let page_size = clamp_page(query.page_size, DEFAULT_COMMIT_PAGE_SIZE, MAX_COMMIT_PAGE_SIZE);
    Ok(build_commit_page(
        &root,
        search_id,
        &prefix,
        query.offset,
        page_size,
    )?)
}

/// 翻页：直接命中缓存的提交索引，不重复扫描，因此游标稳定。
pub fn load_commit_search_page(
    repository_path: &str,
    search_id: &str,
    offset: usize,
    page_size: usize,
) -> Result<CommitSearchPage, String> {
    let root = git::repository_root(repository_path)?;
    let prefix = repository_prefix(&root);
    let page_size = clamp_page(page_size, DEFAULT_COMMIT_PAGE_SIZE, MAX_COMMIT_PAGE_SIZE);
    build_commit_page(&root, search_id.to_string(), &prefix, offset, page_size)
}

fn build_commit_page(
    root: &Path,
    search_id: String,
    prefix: &str,
    offset: usize,
    page_size: usize,
) -> Result<CommitSearchPage, String> {
    let (slice, total, pattern, target, truncated, cancelled, notice) =
        page_from_commit_index(&search_id, prefix, offset, page_size)?;
    let items = commit_items(root, &slice)?;
    Ok(CommitSearchPage {
        search_id,
        target: target.unwrap_or(CommitSearchTarget::CommitMessage),
        pattern,
        total,
        offset,
        page_size,
        has_more: offset + items.len() < total,
        truncated,
        cancelled,
        items,
        notice,
    })
}

/// 按提交 Hash 精确定位：走 rev-parse 校验，不受提交图谱窗口限制。
fn hash_lookup_page(root: &Path, query: &CommitSearchQuery) -> Result<CommitSearchPage, String> {
    let raw = query.pattern.trim();
    let page_size = clamp_page(query.page_size, DEFAULT_COMMIT_PAGE_SIZE, MAX_COMMIT_PAGE_SIZE);
    let (items, total, notice) = if raw.len() < 4 || raw.len() > 40 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        (Vec::new(), 0, Some("提交 Hash 搜索需要 4-40 位十六进制字符".to_string()))
    } else {
        match resolve_commit_object(root, raw) {
            Ok(hash) => (commit_items(root, &[hash])?, 1, None),
            Err(_) => (Vec::new(), 0, Some("仓库中不存在该提交 Hash".to_string())),
        }
    };
    Ok(CommitSearchPage {
        search_id: next_id("hash"),
        target: CommitSearchTarget::CommitHash,
        pattern: raw.to_string(),
        total,
        offset: 0,
        page_size,
        has_more: false,
        truncated: false,
        cancelled: false,
        items,
        notice,
    })
}

/// 按页取提交元数据：分批 `git show -s --no-walk`，仍受条数与字节双上限约束。
fn commit_items(root: &Path, hashes: &[String]) -> Result<Vec<CommitSearchItem>, String> {
    let mut positions: HashMap<&str, usize> = HashMap::new();
    for (index, hash) in hashes.iter().enumerate() {
        positions.insert(hash.as_str(), index);
    }
    let mut slots: Vec<Option<CommitSearchItem>> = (0..hashes.len()).map(|_| None).collect();
    let mut budget = MAX_PAGE_BYTES;
    for chunk in hashes.chunks(METADATA_BATCH) {
        if budget == 0 {
            break;
        }
        let mut args: Vec<String> = vec![
            "-c".into(),
            "core.quotepath=false".into(),
            "show".into(),
            "-s".into(),
            "--no-walk".into(),
            format!("--format={HISTORY_FORMAT}"),
            "--end-of-options".into(),
        ];
        args.extend(chunk.iter().cloned());
        let (output, truncated) = git_capture(root, &args, MAX_PAGE_BYTES)?;
        let text = String::from_utf8_lossy(&output).to_string();
        for record in text.split('\x1e') {
            let record = record.trim_matches(&['\r', '\n'][..]);
            let Some(item) = parse_history_record(record) else {
                continue;
            };
            if let Some(index) = positions.get(item.hash.as_str()).copied() {
                budget = budget.saturating_sub(item.message.len() + item.title.len() + 128);
                slots[index] = Some(item);
            }
            if budget == 0 {
                break;
            }
        }
        if truncated {
            break;
        }
    }
    // 按索引顺序回填，保证分页次序与游标一致。
    Ok(slots.into_iter().flatten().collect())
}

fn parse_history_record(record: &str) -> Option<CommitSearchItem> {
    let fields: Vec<&str> = record.splitn(8, '\x1f').collect();
    if fields.len() < 8 {
        return None;
    }
    let hash = fields[0].trim().to_string();
    if !is_hex_object(&hash) {
        return None;
    }
    Some(CommitSearchItem {
        hash,
        short_hash: fields[1].trim().to_string(),
        title: char_take(fields[2].trim(), MAX_TITLE_CHARS),
        author: fields[3].trim().to_string(),
        email: fields[4].trim().to_string(),
        date: fields[5].trim().to_string(),
        refs: decoration_refs(fields[6]),
        message: char_take(&normalize_newlines(fields[7].trim()), MAX_MESSAGE_CHARS),
    })
}

fn decoration_refs(value: &str) -> Vec<String> {
    value
        .split(", ")
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
        .map(|part| {
            if let Some(tag) = part.strip_prefix("tag: ") {
                return tag.to_string();
            }
            let head = part.split(" -> ").next().unwrap_or(part).trim();
            head.strip_prefix("heads/")
                .or_else(|| head.strip_prefix("remotes/"))
                .unwrap_or(head)
                .to_string()
        })
        .filter(|value| !value.is_empty() && value != "HEAD")
        .take(12)
        .collect()
}

// ---------------------------------------------------------------------------
// 任务二：仓库全文搜索（git grep，工作区或指定 rev）
// ---------------------------------------------------------------------------

/// 组装 `git grep` 参数。occurrences=true 时带 `-o --column`，供替换定位字节区间。
fn grep_args(
    pattern: &str,
    revision: Option<&str>,
    includes: &[String],
    excludes: &[String],
    case_sensitive: bool,
    whole_word: bool,
    regex: bool,
    occurrences: bool,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-c".into(),
        "core.quotepath=false".into(),
        "grep".into(),
        "--no-color".into(),
        // -z 让路径/行号/内容以 NUL 分隔：路径里含冒号也不会误解。
        "-z".into(),
        "-n".into(),
        // -a（--text）是关键的一行：不加它时 Git 对二进制文件只输出一行
        // 人类可读的 `Binary file X matches`，那条记录没有 NUL 字段分隔，会被
        // 我们的解析器当成垃圾**静默丢弃**——用户会误以为二进制文件里没有该文本。
        // 而且那句文案受 Git 的 l10n 影响（中文环境下会被翻译），不能作为解析依据。
        // 加上 -a 后二进制也走结构化记录，由我们自己按 NUL/UTF-8 判定并显式上报。
        "-a".into(),
    ];
    if occurrences {
        args.push("-o".into());
        args.push("--column".into());
    }
    if !case_sensitive {
        args.push("-i".into());
    }
    if whole_word {
        args.push("--word-regexp".into());
    }
    args.push(if regex { "-E".into() } else { "-F".into() });
    // -e 让模式始终留在选项位，即使模式本身以 '-' 开头也不会被当成选项。
    args.push("-e".into());
    args.push(pattern.to_string());
    if let Some(revision) = revision {
        args.push("--end-of-options".into());
        args.push(revision.to_string());
    }
    if !includes.is_empty() || !excludes.is_empty() {
        args.push("--".into());
        args.extend(includes.iter().cloned());
        for exclude in excludes {
            args.push(format!(":(exclude){exclude}"));
        }
    }
    args
}

/// 解析 `git grep -z -n -a` 的一条记录：`path\0line\0content`。
/// 返回值最后一项表示该命中是否落在二进制/非 UTF-8 内容上（内容会被置空）。
fn parse_grep_record(record: &[u8], revision: Option<&str>) -> Option<(String, usize, String, bool)> {
    let mut fields = record.split(|byte| *byte == b'\0');
    let raw_path = fields.next()?.to_vec();
    let raw_line = fields.next()?.to_vec();
    let raw_content: Vec<u8> = fields.collect::<Vec<_>>().join(&b'\0');
    // 与替换路径同一套二进制判定：NUL 或非法 UTF-8 即视为二进制。
    let binary = raw_content.contains(&0) || std::str::from_utf8(&raw_content).is_err();
    Some((
        strip_revision_prefix(&raw_path, revision),
        parse_number(&raw_line)?,
        if binary {
            String::new()
        } else {
            char_take(&String::from_utf8_lossy(&raw_content), MAX_TEXT_LINE_CHARS)
        },
        binary,
    ))
}

/// 解析 `git grep -z -n -o --column`：`path\0line\0column\0match`。
fn parse_occurrence_record(record: &[u8], revision: Option<&str>) -> Option<(String, usize, usize, Vec<u8>)> {
    let mut fields = record.split(|byte| *byte == b'\0');
    let raw_path = fields.next()?.to_vec();
    let raw_line = fields.next()?.to_vec();
    let raw_column = fields.next()?.to_vec();
    let matched: Vec<u8> = fields.collect::<Vec<_>>().join(&b'\0');
    // Git 的 column 是 1 起的字节偏移，可直接用于字节切片替换。
    Some((
        strip_revision_prefix(&raw_path, revision),
        parse_number(&raw_line)?,
        parse_number(&raw_column)?,
        matched,
    ))
}

fn strip_revision_prefix(raw_path: &[u8], revision: Option<&str>) -> String {
    let path = String::from_utf8_lossy(raw_path).to_string();
    match revision {
        Some(revision) => path
            .strip_prefix(&format!("{revision}:"))
            .map(str::to_string)
            .unwrap_or(path),
        None => path,
    }
}

fn parse_number(raw: &[u8]) -> Option<usize> {
    String::from_utf8_lossy(raw).trim().parse::<usize>().ok()
}

/// 全文搜索：流式 `git grep`，命中先入有界索引，再按页补上下文片段。
pub fn search_repository_text(repository_path: &str, query: TextSearchQuery) -> Result<TextSearchPage, String> {
    let root = git::repository_root(repository_path)?;
    let prefix = repository_prefix(&root);
    let pattern = validated_pattern(&query.pattern)?;
    let revision = match query.revision.as_deref() {
        Some(value) if !value.trim().is_empty() => {
            let token = validated_revision_token(value)?;
            resolve_tree_object(&root, &token)?;
            Some(token)
        }
        _ => None,
    };
    let includes = validated_pathspecs(&query.includes)?;
    let excludes = validated_pathspecs(&query.exclude_paths)?;
    // 记录含原文，单条上限按行宽的 UTF-8 最坏情况估算。
    let max_record_bytes = MAX_TEXT_LINE_CHARS * 4 + 512;
    let scan_limit = query
        .max_matches
        .unwrap_or(DEFAULT_TEXT_MAX_MATCHES)
        .clamp(1, MAX_TEXT_MAX_MATCHES);

    let task = begin_task(&task_key(&root, "text"));
    let args = grep_args(
        &pattern,
        revision.as_deref(),
        &includes,
        &excludes,
        query.case_sensitive,
        query.whole_word,
        query.regex,
        false,
    );
    let mut stream = GitStream::start(&root, &args, b'\n', max_record_bytes)?;
    let mut matches: Vec<StoredMatch> = Vec::new();
    let mut files: HashSet<String> = HashSet::new();
    let mut bytes = 0usize;
    // 条数上限与索引字节上限分别记账：截断提示必须说明**真实原因**，
    // 否则用户会按「行数上限」去缩小范围，而实际卡的是字节预算。
    let mut count_overflow = false;
    let mut index_byte_overflow = false;
    let outcome = stream.scan(&task, MAX_GREP_OUTPUT_BYTES, |record| {
        let Some((file_path, line_number, content, binary)) = parse_grep_record(record, revision.as_deref()) else {
            return Ok(true);
        };
        if matches.len() >= scan_limit {
            count_overflow = true;
            return Ok(false);
        }
        bytes += file_path.len() + content.len() + 24;
        if bytes > MAX_INDEX_BYTES {
            index_byte_overflow = true;
            return Ok(false);
        }
        files.insert(file_path.clone());
        matches.push(StoredMatch { file_path, line_number, content, binary });
        Ok(true)
    })?;
    stream.stop(&outcome, &[0, 1])?;

    let truncated = count_overflow || index_byte_overflow || outcome.byte_budget_hit;
    let notice = if outcome.cancelled {
        Some("搜索已取消，结果不完整".to_string())
    } else if outcome.byte_budget_hit {
        Some(format!(
            "Git 输出超过 {MAX_GREP_OUTPUT_BYTES} 字节上限，结果已截断，请缩小路径范围"
        ))
    } else if count_overflow {
        Some(format!(
            "命中超过 {scan_limit} 行上限，结果已截断（仅索引前 {scan_limit} 行），请缩小路径范围或增加过滤条件"
        ))
    } else if index_byte_overflow {
        Some(format!(
            "命中索引超过 {} 字节上限，结果已截断，请缩小路径范围或增加过滤条件",
            MAX_INDEX_BYTES
        ))
    } else {
        None
    };

    let total = matches.len();
    let matched_files = files.len();
    let search_id = store_index(CachedIndex {
        repository_prefix: prefix.clone(),
        index: SearchIndex::Matches(matches),
        pattern: pattern.clone(),
        target: None,
        revision: revision.clone(),
        total,
        matched_files,
        truncated,
        cancelled: outcome.cancelled,
        notice: notice.clone(),
        bytes,
        sequence: 0,
    });
    let page_size = clamp_page(query.page_size, DEFAULT_TEXT_PAGE_SIZE, MAX_TEXT_PAGE_SIZE);
    build_text_page(
        &root,
        search_id,
        &prefix,
        query.offset,
        page_size,
        query.context_lines,
    )
}

/// 全文搜索翻页：命中集来自缓存索引，只为本页读取上下文。
pub fn load_repository_text_page(
    repository_path: &str,
    search_id: &str,
    offset: usize,
    page_size: usize,
    context_lines: usize,
) -> Result<TextSearchPage, String> {
    let root = git::repository_root(repository_path)?;
    let prefix = repository_prefix(&root);
    let page_size = clamp_page(page_size, DEFAULT_TEXT_PAGE_SIZE, MAX_TEXT_PAGE_SIZE);
    build_text_page(&root, search_id.to_string(), &prefix, offset, page_size, context_lines)
}

fn build_text_page(
    root: &Path,
    search_id: String,
    prefix: &str,
    offset: usize,
    page_size: usize,
    context_lines: usize,
) -> Result<TextSearchPage, String> {
    let (slice, total, matched_files, pattern, revision, truncated, cancelled, notice) =
        page_from_match_index(&search_id, prefix, offset, page_size)?;
    let mut items: Vec<TextSearchMatch> = slice
        .into_iter()
        .map(|item| TextSearchMatch {
            file_path: item.file_path,
            line_number: item.line_number,
            content: item.content,
            binary: item.binary,
            context_before: Vec::new(),
            context_after: Vec::new(),
            revision: revision.clone(),
        })
        .collect();
    if context_lines > 0 {
        attach_context(root, &mut items, context_lines.min(MAX_CONTEXT_LINES));
    }
    Ok(TextSearchPage {
        search_id,
        pattern,
        revision,
        total,
        matched_files,
        offset,
        page_size,
        has_more: offset + items.len() < total,
        truncated,
        cancelled,
        items,
        notice,
    })
}

/// 为本页命中补齐上下文：每个文件只读一次，受文件数与字节上限约束。
fn attach_context(root: &Path, items: &mut [TextSearchMatch], context: usize) {
    let mut cache: HashMap<String, Vec<String>> = HashMap::new();
    for item in items.iter_mut() {
        // 二进制命中没有可读的文本上下文；跳过它，把有限的 MAX_CONTEXT_FILES 预算留给文本文件。
        if item.binary {
            continue;
        }
        if !cache.contains_key(&item.file_path) {
            if cache.len() >= MAX_CONTEXT_FILES {
                continue;
            }
            let lines = read_text_lines(root, &item.file_path, item.revision.as_deref())
                .unwrap_or_default();
            cache.insert(item.file_path.clone(), lines);
        }
        let Some(lines) = cache.get(&item.file_path) else {
            continue;
        };
        let index = item.line_number.saturating_sub(1);
        if index >= lines.len() {
            continue;
        }
        let start = index.saturating_sub(context);
        item.context_before = lines[start..index]
            .iter()
            .map(|line| char_take(line, MAX_CONTEXT_CHARS))
            .collect();
        let end = (index + 1 + context).min(lines.len());
        item.context_after = lines[index + 1..end]
            .iter()
            .map(|line| char_take(line, MAX_CONTEXT_CHARS))
            .collect();
    }
}

fn read_text_lines(root: &Path, relative: &str, revision: Option<&str>) -> Result<Vec<String>, String> {
    let bytes = read_file_bytes(root, relative, revision, MAX_CONTEXT_FILE_BYTES)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| "非文本文件，跳过上下文展示")?;
    Ok(normalize_newlines(text)
        .split('\n')
        .map(str::to_string)
        .collect())
}

/// 读取工作区文件的前 `limit` 字节并显式回报是否被截断。
///
/// 与 `read_file_bytes` 的区别：编辑器加载需要「截断也要拿到内容 + truncated=true」，
/// 让 UI 明确提示只看得到前多少字节，并据此拒绝保存（避免用半份内容覆盖全文件）。
fn read_worktree_prefix(root: &Path, relative: &str, limit: usize) -> Result<(Vec<u8>, bool), String> {
    let target = resolve_inside_repo(root, relative)?;
    let metadata = std::fs::metadata(&target).map_err(|error| format!("无法读取文件：{error}"))?;
    if !metadata.is_file() {
        return Err(format!("不是普通文件：{relative}"));
    }
    let mut file = std::fs::File::open(&target).map_err(|error| format!("无法打开文件：{error}"))?;
    // 只读 limit+1 字节：多出的 1 个哨兵字节用来判定截断，避免把超大文件整份读进内存。
    let mut buffer = Vec::with_capacity(limit.min(metadata.len() as usize).saturating_add(1));
    std::io::Read::take(&mut file, (limit + 1) as u64)
        .read_to_end(&mut buffer)
        .map_err(|error| format!("无法读取文件：{error}"))?;
    let truncated = buffer.len() > limit;
    if truncated {
        buffer.truncate(limit);
    }
    Ok((buffer, truncated))
}

/// 读取文件内容：工作区直接读磁盘（校验和在先），指定 rev 走 `git show rev:path`。
fn read_file_bytes(root: &Path, relative: &str, revision: Option<&str>, max_bytes: usize) -> Result<Vec<u8>, String> {
    if let Some(token) = revision {
        let path = validated_relative_file(relative)?;
        let (bytes, truncated) = git_capture(
            root,
            &["show".into(), "--end-of-options".into(), format!("{token}:{path}")],
            max_bytes,
        )?;
        if truncated {
            return Err(format!("文件超过 {max_bytes} 字节上限：{relative}"));
        }
        return Ok(bytes);
    }
    let target = resolve_inside_repo(root, relative)?;
    let metadata = std::fs::metadata(&target).map_err(|error| format!("无法读取文件：{error}"))?;
    if !metadata.is_file() {
        return Err(format!("不是普通文件：{relative}"));
    }
    if metadata.len() as usize > max_bytes {
        return Err(format!("文件超过 {max_bytes} 字节上限：{relative}"));
    }
    let mut file = std::fs::File::open(&target).map_err(|error| format!("无法打开文件：{error}"))?;
    let mut buffer = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut buffer)
        .map_err(|error| format!("无法读取文件：{error}"))?;
    Ok(buffer)
}

// ---------------------------------------------------------------------------
// 替换计划：dry-run 预览 -> 确认写盘 -> 备份撤销
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct PlanEdit {
    line_number: usize,
    byte_offset: usize,
    byte_length: usize,
}

#[derive(Clone)]
struct PlanFile {
    relative_path: String,
    before_checksum: String,
    after_checksum: String,
    size_bytes: usize,
    occurrences: usize,
    sample_lines: Vec<usize>,
    edits: Vec<PlanEdit>,
}

#[derive(Clone)]
struct ReplacePlan {
    repository_prefix: String,
    preview_id: String,
    pattern: String,
    replacement: String,
    files: Vec<PlanFile>,
    total_occurrences: usize,
    skipped: Vec<(String, String)>,
    truncated: bool,
    estimated_bytes: usize,
    created_at_ms: u128,
    sequence: u64,
}

fn preview_cache() -> &'static Mutex<HashMap<String, ReplacePlan>> {
    static CACHE: OnceLock<Mutex<HashMap<String, ReplacePlan>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn store_plan(plan: ReplacePlan) -> String {
    let id = plan.preview_id.clone();
    if let Ok(mut cache) = preview_cache().lock() {
        while cache.len() + 1 > MAX_PREVIEW_SESSIONS {
            match cache
                .iter()
                .min_by_key(|(_, value)| value.sequence)
                .map(|(key, _)| key.clone())
            {
                Some(key) => {
                    cache.remove(&key);
                }
                None => break,
            }
        }
        cache.insert(id.clone(), plan);
    }
    id
}

fn drop_previews_for(prefix: &str) {
    if let Ok(mut cache) = preview_cache().lock() {
        let stale: Vec<String> = cache
            .iter()
            .filter(|(_, value)| value.repository_prefix == prefix)
            .map(|(key, _)| key.clone())
            .collect();
        for key in stale {
            cache.remove(&key);
        }
    }
}

/// 取出预览计划并立即失效：一次预览只允许执行一次，避免重复点击二次生效。
fn take_plan(preview_id: &str, prefix: &str) -> Result<ReplacePlan, String> {
    let mut cache = preview_cache().lock().map_err(|_| "预览缓存不可用".to_string())?;
    let plan = cache
        .get(preview_id)
        .ok_or_else(|| "预览不存在或已过期，请重新预览后再执行替换".to_string())?;
    if plan.repository_prefix != prefix {
        return Err("预览标识与当前仓库不匹配".to_string());
    }
    if plan.truncated {
        return Err("预览范围被截断，拒绝在不确定范围内写盘；请缩小路径范围后重新预览".to_string());
    }
    let taken = plan.clone();
    cache.remove(preview_id);
    Ok(taken)
}

/// dry-run：只扫描并生成计划，绝不写盘。
pub fn preview_text_replace(repository_path: &str, query: TextReplaceQuery) -> Result<ReplacePreview, String> {
    let root = git::repository_root(repository_path)?;
    let prefix = repository_prefix(&root);
    let pattern = validated_pattern(&query.pattern)?;
    let replacement = validated_replacement(&query.replacement, query.regex)?;
    let includes = validated_pathspecs(&query.includes)?;
    let excludes = validated_pathspecs(&query.exclude_paths)?;
    let file_limit = query
        .max_files
        .unwrap_or(DEFAULT_REPLACE_MAX_FILES)
        .clamp(1, MAX_REPLACE_MAX_FILES);

    let task = begin_task(&task_key(&root, "replace-preview"));
    let args = grep_args(
        &pattern,
        None,
        &includes,
        &excludes,
        query.case_sensitive,
        query.whole_word,
        query.regex,
        true,
    );
    let max_record_bytes = MAX_TEXT_LINE_CHARS * 4 + 512;
    let mut stream = GitStream::start(&root, &args, b'\n', max_record_bytes)?;
    // 按文件聚合出现位置；条数与文件数都有上限，命中上限时 truncated=true。
    let mut grouped: HashMap<String, Vec<(usize, usize, Vec<u8>)>> = HashMap::new();
    let mut ordered_files: Vec<String> = Vec::new();
    let mut occurrences = 0usize;
    let mut overflow = false;
    let outcome = stream.scan(&task, MAX_GREP_OUTPUT_BYTES, |record| {
        let Some((file_path, line_number, column, matched)) = parse_occurrence_record(record, None) else {
            return Ok(true);
        };
        if occurrences + 1 > MAX_REPLACE_OCCURRENCES {
            overflow = true;
            return Ok(false);
        }
        if !grouped.contains_key(&file_path) && grouped.len() >= file_limit {
            overflow = true;
            return Ok(false);
        }
        occurrences += 1;
        let entry = grouped.entry(file_path.clone()).or_default();
        if entry.is_empty() {
            ordered_files.push(file_path);
        }
        entry.push((line_number, column, matched));
        Ok(true)
    })?;
    stream.stop(&outcome, &[0, 1])?;

    let mut files: Vec<PlanFile> = Vec::new();
    let mut skipped: Vec<(String, String)> = Vec::new();
    let mut estimated_bytes = 0usize;
    for file_path in &ordered_files {
        let Some(raw) = grouped.get(file_path) else { continue };
        let bytes = match read_file_bytes(&root, file_path, None, MAX_REPLACE_FILE_BYTES) {
            Ok(bytes) => bytes,
            Err(error) => {
                skipped.push((file_path.clone(), error));
                continue;
            }
        };
        if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
            skipped.push((file_path.clone(), "二进制或非 UTF-8 文件，已跳过".to_string()));
            continue;
        }
        if estimated_bytes + bytes.len() > MAX_REPLACE_TOTAL_BYTES {
            skipped.push((file_path.clone(), format!("超过替换总字节上限 {MAX_REPLACE_TOTAL_BYTES}，已跳过")));
            continue;
        }
        estimated_bytes += bytes.len();
        // 逐条校验 Git 报告的（行号, 字节列, 匹配文本）与磁盘内容一致；任何不一致都跳过该文件。
        let mut edits: Vec<PlanEdit> = Vec::with_capacity(raw.len());
        let mut mismatch = false;
        for (line_number, column, matched) in raw {
            let Some(edit) = locate_edit(&bytes, *line_number, *column, matched) else {
                mismatch = true;
                break;
            };
            edits.push(edit);
        }
        if mismatch {
            skipped.push((file_path.clone(), "命中位置与工作区内容不一致，已跳过（文件可能正在被修改）".to_string()));
            continue;
        }
        let after = match apply_edits(&bytes, &edits, &replacement) {
            Ok(bytes) => bytes,
            Err(error) => {
                skipped.push((file_path.clone(), error));
                continue;
            }
        };
        let sample_lines = raw.iter().take(8).map(|(line, _, _)| *line).collect();
        files.push(PlanFile {
            relative_path: file_path.clone(),
            before_checksum: checksum(&bytes),
            after_checksum: checksum(&after),
            size_bytes: bytes.len(),
            occurrences: edits.len(),
            sample_lines,
            edits,
        });
    }

    let total_occurrences = files.iter().map(|file| file.occurrences).sum::<usize>();
    let truncated = overflow || outcome.byte_budget_hit;
    let notice = if outcome.cancelled {
        Some("预览已取消".to_string())
    } else if truncated {
        Some(format!(
            "替换范围被截断（文件上限 {file_limit} / 命中上限 {MAX_REPLACE_OCCURRENCES}），请缩小路径范围；截断范围内禁止执行替换"
        ))
    } else if !skipped.is_empty() {
        Some(format!("{} 个文件被跳过，不会写盘", skipped.len()))
    } else if files.is_empty() {
        Some("没有可替换的命中".to_string())
    } else {
        None
    };

    let preview_id = next_id("preview");
    store_plan(ReplacePlan {
        repository_prefix: prefix,
        preview_id: preview_id.clone(),
        pattern: pattern.clone(),
        replacement: replacement.clone(),
        files: files.clone(),
        total_occurrences,
        skipped: skipped.clone(),
        truncated,
        estimated_bytes,
        created_at_ms: now_millis(),
        sequence: next_sequence(),
    });

    Ok(ReplacePreview {
        preview_id,
        pattern,
        replacement,
        files: files
            .iter()
            .map(|file| ReplacePreviewFile {
                file_path: file.relative_path.clone(),
                occurrences: file.occurrences,
                sample_lines: file.sample_lines.clone(),
                size_bytes: file.size_bytes,
                skipped: None,
            })
            .chain(skipped.iter().map(|(path, reason)| ReplacePreviewFile {
                file_path: path.clone(),
                occurrences: 0,
                sample_lines: Vec::new(),
                size_bytes: 0,
                skipped: Some(reason.clone()),
            }))
            .collect(),
        file_count: files.len(),
        total_occurrences,
        skipped_files: skipped.len(),
        truncated,
        requires_confirmation: true,
        estimated_bytes,
        notice,
    })
}

/// 用行号定位行首字节，再用 Git 报告的 1 起字节列与匹配文本逐字节校验。
/// 校验不通过返回 None：说明工作区内容与预览时不同，该文件整体跳过，绝不写盘。
fn locate_edit(bytes: &[u8], line_number: usize, column: usize, matched: &[u8]) -> Option<PlanEdit> {
    if line_number == 0 || column == 0 || matched.is_empty() {
        return None;
    }
    let mut current_line = 1usize;
    let mut start = 0usize;
    for index in 0..bytes.len() {
        if current_line == line_number {
            break;
        }
        if bytes[index] == b'\n' {
            current_line += 1;
            start = index + 1;
        }
    }
    if current_line != line_number {
        return None;
    }
    let end_of_line = bytes[start..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map(|offset| start + offset)
        .unwrap_or(bytes.len());
    let offset = start.checked_add(column - 1)?;
    let limit = offset.checked_add(matched.len())?;
    if limit > end_of_line || &bytes[offset..limit] != matched {
        return None;
    }
    Some(PlanEdit {
        line_number,
        byte_offset: offset,
        byte_length: matched.len(),
    })
}

/// 按字节偏移升序替换；重叠区间直接拒绝，绝不猜测语义。
fn apply_edits(bytes: &[u8], edits: &[PlanEdit], replacement: &str) -> Result<Vec<u8>, String> {
    let replacement = replacement.as_bytes();
    let mut sorted: Vec<PlanEdit> = edits.to_vec();
    sorted.sort_by_key(|edit| edit.byte_offset);
    for pair in sorted.windows(2) {
        if pair[0].byte_offset + pair[0].byte_length > pair[1].byte_offset {
            return Err("命中位置重叠，已拒绝写入".to_string());
        }
    }
    let mut output: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut cursor = 0usize;
    for edit in &sorted {
        output.extend_from_slice(&bytes[cursor..edit.byte_offset]);
        output.extend_from_slice(replacement);
        cursor = edit.byte_offset + edit.byte_length;
    }
    output.extend_from_slice(&bytes[cursor..]);
    Ok(output)
}

/// 确认后才写盘：先逐文件校验预览一致性，再整体备份，再原子写入，失败自动回滚。
pub fn apply_text_replace(repository_path: &str, preview_id: &str, confirm: bool) -> Result<ReplaceReport, String> {
    if !confirm {
        return Err("替换是破坏性操作：请先取回 dry-run 预览，确认后携带 confirm=true 再执行".to_string());
    }
    if preview_id.trim().is_empty() {
        return Err("缺少预览标识：拒绝在未经 dry-run 预览的情况下写盘".to_string());
    }
    let root = git::repository_root(repository_path)?;
    let prefix = repository_prefix(&root);
    let _write_guard = replace_write_lock()
        .lock()
        .map_err(|_| "替换写入锁不可用".to_string())?;
    let plan = take_plan(preview_id, &prefix)?;

    // 1) 写盘前整体校验：任一文件在预览后被改动就全部拒绝（fail-closed）。
    let mut prepared: Vec<(PlanFile, Vec<u8>, Vec<u8>)> = Vec::new();
    for file in &plan.files {
        let bytes = read_file_bytes(&root, &file.relative_path, None, MAX_REPLACE_FILE_BYTES)
            .map_err(|error| format!("{}：{error}", file.relative_path))?;
        if checksum(&bytes) != file.before_checksum {
            return Err(format!(
                "文件在预览后被修改，已拒绝写入：{}（请重新预览）",
                file.relative_path
            ));
        }
        let after = apply_edits(&bytes, &file.edits, &plan.replacement)
            .map_err(|error| format!("{}：{error}", file.relative_path))?;
        if checksum(&after) != file.after_checksum {
            return Err(format!(
                "替换结果与预览不一致，已拒绝写入：{}",
                file.relative_path
            ));
        }
        prepared.push((file.clone(), bytes, after));
    }

    // 2) 备份受影响文件的原始内容（清单 + 原文）；备份失败则不写任何文件。
    let replace_id = plan.preview_id.clone();
    let session_dir = backup_directory(&root)?.join(validated_session_id(&replace_id)?);
    let originals = session_dir.join("originals");
    std::fs::create_dir_all(&originals)
        .map_err(|error| format!("无法创建备份目录，未写入任何文件：{error}"))?;
    let mut manifest = String::from("branchline-replace-v1\n");
    manifest.push_str(&format!("id={replace_id}\n"));
    manifest.push_str(&format!("created-at-ms={}\n", plan.created_at_ms));
    manifest.push_str(&format!("pattern={}\n", escape_field(&plan.pattern)));
    manifest.push_str(&format!("replacement={}\n", escape_field(&plan.replacement)));
    for (index, (file, before, _)) in prepared.iter().enumerate() {
        if let Err(error) = std::fs::write(originals.join(index.to_string()), before) {
            let _ = std::fs::remove_dir_all(&session_dir);
            return Err(format!("备份失败，未写入任何文件：{error}"));
        }
        // 每个文件一行制表符分隔的记录。
        // 不能用 `key=value` 空格分隔：`line.split_once('=')` 会把 key 解析成 `file index`
        // 从而永远匹配不上 `file` 分支（备份清单看起来是空的）；而且路径/校验和里
        // 只要出现空格就会让后续字段整体错位。制表符已由 escape_field 转义，绝对安全。
        manifest.push_str(&format!(
            "file\t{index}\t{}\t{}\t{}\t{}\t{}\n",
            escape_field(&file.relative_path),
            file.before_checksum,
            file.after_checksum,
            file.size_bytes,
            file.occurrences
        ));
    }
    if let Err(error) = std::fs::write(session_dir.join(MANIFEST_NAME), manifest.as_bytes()) {
        let _ = std::fs::remove_dir_all(&session_dir);
        return Err(format!("备份清单写入失败，未写入任何文件：{error}"));
    }

    // 3) 原子写入；任何一步失败都按备份回滚已写入的文件。
    let mut written: Vec<usize> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    for (index, (file, _, after)) in prepared.iter().enumerate() {
        if let Err(error) = write_file_atomic(&root, &file.relative_path, after) {
            for previous in &written {
                let (previous_file, before, _) = &prepared[*previous];
                if let Err(rollback_error) = write_file_atomic(&root, &previous_file.relative_path, before) {
                    warnings.push(format!(
                        "回滚 {} 失败，请从备份恢复：{rollback_error}",
                        previous_file.relative_path
                    ));
                }
            }
            return Err(format!(
                "写入 {} 失败，已回滚 {} 个文件：{error}",
                file.relative_path,
                written.len()
            ));
        }
        written.push(index);
    }

    Ok(ReplaceReport {
        replace_id,
        executed: true,
        files_changed: prepared.iter().map(|(file, _, _)| file.relative_path.clone()).collect(),
        occurrences: plan.total_occurrences,
        warnings,
        backup_path: Some(display_backup_path(&session_dir, &root)),
        backup_available: true,
        restored_files: Vec::new(),
        skipped: plan
            .skipped
            .iter()
            .map(|(path, reason)| format!("{path}：{reason}"))
            .collect(),
        notice: Some(format!(
            "已替换 {} 个文件的 {} 处；如需撤销请使用「撤销本次替换」",
            written.len(),
            plan.total_occurrences
        )),
    })
}

fn replace_write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn backup_directory(root: &Path) -> Result<PathBuf, String> {
    let git_dir = git::git_output(root, &["rev-parse", "--absolute-git-dir"])
        .map(|value| PathBuf::from(value.trim()))
        .unwrap_or_else(|_| root.join(".git"));
    Ok(git_dir.join(BACKUP_ROOT_DIR))
}

fn display_backup_path(session: &Path, root: &Path) -> String {
    session
        .strip_prefix(root)
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|_| session.to_string_lossy().to_string())
}

/// 原子写入：同目录临时文件 + rename，避免留下半截文件。
fn write_file_atomic(root: &Path, relative: &str, bytes: &[u8]) -> Result<(), String> {
    let target = resolve_inside_repo(root, relative)?;
    let parent = target
        .parent()
        .ok_or_else(|| format!("文件目录不存在：{relative}"))?;
    if !parent.is_dir() {
        return Err(format!("文件目录不存在：{relative}"));
    }
    let temp = parent.join(format!(".branchline-{}.tmp", next_id("tmp").replace('-', "_")));
    if let Err(error) = std::fs::write(&temp, bytes) {
        return Err(format!("临时文件写入失败：{error}"));
    }
    match std::fs::rename(&temp, &target) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = std::fs::remove_file(&temp);
            Err(format!("替换写入失败：{error}"))
        }
    }
}

#[derive(Clone)]
struct ManifestEntry {
    index: usize,
    relative_path: String,
    before_checksum: String,
    after_checksum: String,
    size_bytes: usize,
    occurrences: usize,
}

struct Manifest {
    created_at_ms: u128,
    pattern: String,
    replacement: String,
    entries: Vec<ManifestEntry>,
}

fn parse_manifest(text: &str) -> Result<Manifest, String> {
    let mut manifest = Manifest {
        created_at_ms: 0,
        pattern: String::new(),
        replacement: String::new(),
        entries: Vec::new(),
    };
    for line in text.lines() {
        if line.starts_with("branchline-replace-v1") {
            continue;
        }
        // 文件记录必须在通用的 `key=value` 解析之前单独处理：路径本身可能含 '='。
        if let Some(rest) = line.strip_prefix("file\t") {
            let fields: Vec<&str> = rest.split('\t').collect();
            // index, path, before, after, size, occurrences
            if fields.len() < 6 {
                continue;
            }
            let (Ok(index), Ok(size), Ok(occurrences)) = (
                fields[0].parse::<usize>(),
                fields[4].parse::<usize>(),
                fields[5].parse::<usize>(),
            ) else {
                continue;
            };
            manifest.entries.push(ManifestEntry {
                index,
                relative_path: unescape_field(fields[1]),
                before_checksum: fields[2].to_string(),
                after_checksum: fields[3].to_string(),
                size_bytes: size,
                occurrences,
            });
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key {
            "created-at-ms" => manifest.created_at_ms = value.trim().parse().unwrap_or_default(),
            "pattern" => manifest.pattern = unescape_field(value),
            "replacement" => manifest.replacement = unescape_field(value),
            _ => {}
        }
    }
    Ok(manifest)
}

/// 撤销一次替换：只恢复「内容仍等于替换后状态」的文件，其余拒绝覆盖。
pub fn undo_text_replace(repository_path: &str, replace_id: &str) -> Result<ReplaceReport, String> {
    let root = git::repository_root(repository_path)?;
    let _write_guard = replace_write_lock()
        .lock()
        .map_err(|_| "替换写入锁不可用".to_string())?;
    let session_dir = backup_directory(&root)?.join(validated_session_id(replace_id)?);
    let manifest_path = session_dir.join(MANIFEST_NAME);
    let manifest = std::fs::read_to_string(&manifest_path)
        .map_err(|error| format!("找不到备份清单：{error}"))?;
    let manifest = parse_manifest(&manifest)?;
    let mut restored: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut occurrences = 0usize;
    for entry in &manifest.entries {
        let original_path = session_dir.join("originals").join(entry.index.to_string());
        let Ok(original) = std::fs::read(&original_path) else {
            skipped.push(format!("{}：备份缺失", entry.relative_path));
            continue;
        };
        if let Err(error) = resolve_inside_repo(&root, &entry.relative_path) {
            skipped.push(format!("{}：{error}", entry.relative_path));
            continue;
        }
        let current = read_file_bytes(&root, &entry.relative_path, None, MAX_REPLACE_FILE_BYTES)
            .unwrap_or_default();
        if checksum(&current) != entry.after_checksum {
            // 外部修改过：拒绝覆盖用户的新改动。
            skipped.push(format!("{}：文件在替换后又被修改，已拒绝覆盖", entry.relative_path));
            continue;
        }
        if let Err(error) = write_file_atomic(&root, &entry.relative_path, &original) {
            warnings.push(format!("恢复 {} 失败：{error}", entry.relative_path));
            continue;
        }
        occurrences += entry.occurrences;
        restored.push(entry.relative_path.clone());
    }
    if restored.is_empty() {
        return Err("没有文件可撤销：备份内容已被后续修改覆盖，请改用 Git 历史恢复".to_string());
    }
    let complete = skipped.is_empty() && warnings.is_empty();
    if complete {
        let _ = std::fs::remove_dir_all(&session_dir);
    } else {
        warnings.push(format!(
            "备份仍保留，可稍后手动处理：{}",
            display_backup_path(&session_dir, &root)
        ));
    }
    let restored_count = restored.len();
    Ok(ReplaceReport {
        replace_id: replace_id.to_string(),
        executed: true,
        files_changed: restored.clone(),
        occurrences,
        warnings,
        backup_path: Some(display_backup_path(&session_dir, &root)),
        // 有文件未能恢复时备份仍在，可再次尝试撤销。
        backup_available: !complete,
        restored_files: restored,
        skipped,
        notice: Some(format!(
            "已撤销 {} 个文件、{} 处替换（模式 {} -> {}）",
            restored_count,
            occurrences,
            manifest.pattern,
            manifest.replacement
        )),
    })
}

fn validated_session_id(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > 80
        || trimmed.starts_with('-')
        || trimmed.contains("..")
        || !trimmed
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("无效的替换标识".to_string());
    }
    Ok(trimmed.to_string())
}

/// 列出可撤销的备份会话，供 UI 显示撤销入口。
pub fn list_text_replace_backups(repository_path: &str) -> Result<Vec<ReplaceBackupSummary>, String> {
    let root = git::repository_root(repository_path)?;
    let directory = backup_directory(&root)?;
    let entries = match std::fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(_) => return Ok(Vec::new()),
    };
    let mut summaries: Vec<ReplaceBackupSummary> = Vec::new();
    for entry in entries.flatten() {
        let session = entry.path();
        if !session.is_dir() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if validated_session_id(&name).is_err() {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(session.join(MANIFEST_NAME)) else {
            continue;
        };
        // 单个会话清单损坏时跳过该会话：不能让一份坏文件遮住其余所有可撤销记录。
        let Ok(manifest) = parse_manifest(&text) else {
            continue;
        };
        let mut byte_size = 0usize;
        for item in &manifest.entries {
            if let Ok(metadata) = std::fs::metadata(session.join("originals").join(item.index.to_string())) {
                byte_size += metadata.len() as usize;
            }
        }
        summaries.push(ReplaceBackupSummary {
            replace_id: name,
            created_at_ms: manifest.created_at_ms,
            file_count: manifest.entries.len(),
            occurrences: manifest.entries.iter().map(|item| item.occurrences).sum(),
            byte_size,
            pattern: manifest.pattern,
            replacement: manifest.replacement,
        });
    }
    summaries.sort_by_key(|summary| std::cmp::Reverse(summary.created_at_ms));
    summaries.truncate(MAX_BACKUP_SESSIONS);
    Ok(summaries)
}

// ---------------------------------------------------------------------------
// 内置编辑器：读取 / 保存（乐观并发，凭校验和拒绝覆盖）
// ---------------------------------------------------------------------------

pub fn load_repository_text_file(
    repository_path: &str,
    file_path: &str,
    max_bytes: Option<usize>,
    revision: Option<&str>,
) -> Result<RepositoryTextFile, String> {
    let root = git::repository_root(repository_path)?;
    let limit = max_bytes
        .unwrap_or(DEFAULT_EDITOR_MAX_BYTES)
        .clamp(1_024, MAX_EDITOR_BYTES);
    let relative = validated_relative_file(file_path)?;
    let revision_token = match revision {
        Some(value) if !value.trim().is_empty() => Some(validated_revision_token(value)?),
        _ => None,
    };
    let (bytes, truncated) = if let Some(token) = revision_token.as_ref() {
        resolve_tree_object(&root, token)?;
        git_capture(
            &root,
            &["show".into(), "--end-of-options".into(), format!("{token}:{relative}")],
            limit,
        )?
    } else {
        read_worktree_prefix(&root, &relative, limit)?
    };
    let binary = bytes.contains(&0) || std::str::from_utf8(&bytes).is_err();
    let normalized = if binary {
        false
    } else {
        // 展示内容被规范化为 LF 时，校验和仍按磁盘原始字节计算，保存会写回 LF。
        let text = std::str::from_utf8(&bytes).unwrap_or_default();
        normalize_newlines(text) != text
    };
    let text = if binary {
        String::new()
    } else {
        normalize_newlines(std::str::from_utf8(&bytes).unwrap_or_default())
    };
    let notice = if binary {
        Some("二进制文件不在内置编辑器中展示".to_string())
    } else if truncated {
        Some(format!("文件超过 {limit} 字节，仅展示前 {limit} 字节；保存会被拒绝"))
    } else if normalized {
        Some("文件含 CRLF/CR 换行，展示内容已规范化为 LF；保存将以 LF 写回".to_string())
    } else {
        None
    };
    Ok(RepositoryTextFile {
        file_path: relative,
        revision: revision_token,
        content: text.clone(),
        size_bytes: bytes.len(),
        truncated,
        checksum: checksum(&bytes),
        line_count: if binary { 0 } else { text.lines().count() },
        binary,
        notice,
    })
}

pub fn save_repository_text_file(
    repository_path: &str,
    file_path: &str,
    content: &str,
    base_checksum: &str,
) -> Result<RepositoryTextFile, String> {
    let root = git::repository_root(repository_path)?;
    let relative = validated_relative_file(file_path)?;
    if content.len() > MAX_EDITOR_BYTES {
        return Err(format!("内容超过 {MAX_EDITOR_BYTES} 字节，无法通过内置编辑器保存"));
    }
    if base_checksum.trim().is_empty() {
        return Err("缺少内容校验和：拒绝在没有加载基线的情况下保存".to_string());
    }
    let current = read_file_bytes(&root, &relative, None, MAX_EDITOR_BYTES)?;
    // 二进制红线：编辑器只写文本。即便调用方误传了二进制文件的基线校验和，
    // 也不能让一段 UTF-8 文本覆写掉真实的二进制内容。
    if current.contains(&0) || std::str::from_utf8(&current).is_err() {
        return Err("二进制文件不能通过内置编辑器保存".to_string());
    }
    if checksum(&current) != base_checksum.trim() {
        return Err("文件在编辑期间已被外部修改，已拒绝覆盖（请重新加载后再改）".to_string());
    }
    let bytes = content.as_bytes();
    write_file_atomic(&root, &relative, bytes)?;
    Ok(RepositoryTextFile {
        file_path: relative,
        revision: None,
        content: content.to_string(),
        size_bytes: bytes.len(),
        truncated: false,
        checksum: checksum(bytes),
        line_count: content.lines().count(),
        binary: false,
        notice: Some("已写入工作区；未自动暂存，请在「暂存与提交」中确认后再提交".to_string()),
    })
}

// ---------------------------------------------------------------------------
// 真实仓库集成测试：临时仓库造多分支多提交历史，逐项验证搜索/替换语义与有界性
// ---------------------------------------------------------------------------

#[cfg(test)]
mod search_tests {
    use super::*;
    use std::fs;

    static REPOSITORY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestRepository(PathBuf);

    impl Drop for TestRepository {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// 独立临时仓库：禁用签名与全局模板，避免依赖开发者机器上的 git 配置。
    fn test_repository() -> TestRepository {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let sequence = REPOSITORY_SEQUENCE.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "branchline-search-test-{}-{unique}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create search test repository");
        git::git_output(&path, &["init", "--initial-branch=main"]).expect("git init");
        for (key, value) in [
            ("user.name", "Branchline Search"),
            ("user.email", "search@example.com"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
            ("color.grep", "never"),
        ] {
            git::git_output(&path, &["config", key, value]).expect("git config");
        }
        let repository = TestRepository(path);
        write_and_commit(repository.0.as_path(), "README.md", "基线内容\n", "初始提交 BASELINE");
        repository
    }

    fn write_and_commit(root: &Path, name: &str, content: &str, message: &str) -> String {
        let target = root.join(name);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).expect("create parent directory");
        }
        fs::write(&target, content).expect("write file");
        git::git_output(root, &["add", "-A"]).expect("git add");
        git::git_output(root, &["commit", "-m", message]).expect("git commit");
        head_hash(root)
    }

    fn head_hash(root: &Path) -> String {
        git::git_output(root, &["rev-parse", "HEAD"])
            .expect("head hash")
            .trim()
            .to_string()
    }

    /// 造 count 条同前缀提交，返回由旧到新的 Hash 列表。
    fn commit_series(root: &Path, count: usize, marker: &str) -> Vec<String> {
        (0..count)
            .map(|index| {
                write_and_commit(
                    root,
                    &format!("series/note-{index}.txt"),
                    &format!("第 {index} 次内容\n"),
                    &format!("{marker} 第 {index} 次提交"),
                )
            })
            .collect()
    }

    fn path_of(root: &Path) -> String {
        root.to_string_lossy().to_string()
    }

    fn read_file(root: &Path, name: &str) -> String {
        fs::read_to_string(root.join(name)).expect("read back file")
    }

    fn message_query(pattern: &str) -> CommitSearchQuery {
        CommitSearchQuery {
            pattern: pattern.to_string(),
            target: CommitSearchTarget::CommitMessage,
            ..CommitSearchQuery::default()
        }
    }

    fn target_query(pattern: &str, target: CommitSearchTarget) -> CommitSearchQuery {
        CommitSearchQuery {
            pattern: pattern.to_string(),
            target,
            ..CommitSearchQuery::default()
        }
    }

    fn text_query(pattern: &str) -> TextSearchQuery {
        TextSearchQuery {
            pattern: pattern.to_string(),
            ..TextSearchQuery::default()
        }
    }

    fn replace_query(pattern: &str, replacement: &str) -> TextReplaceQuery {
        TextReplaceQuery {
            pattern: pattern.to_string(),
            replacement: replacement.to_string(),
            ..TextReplaceQuery::default()
        }
    }

    fn hashes_of(page: &CommitSearchPage) -> Vec<String> {
        page.items.iter().map(|item| item.hash.clone()).collect()
    }

    #[test]
    fn deep_history_search_reaches_commits_outside_the_metadata_window() {
        let repository = test_repository();
        let root = repository.0.as_path();
        let path = path_of(root);
        let oldest = write_and_commit(root, "oldest.txt", "最早\n", "最早的历史提交 ROOTMARK");
        commit_series(root, 24, "后续");

        // 用同一个上限参数构造「UI 只加载 5 条」的窗口：此时最早提交不可见。
        let window = search_commits(
            &path,
            CommitSearchQuery {
                max_commits: Some(5),
                ..message_query("提交")
            },
        )
        .expect("bounded scan");
        assert_eq!(window.total, 5);
        assert!(window.truncated, "达到扫描上限必须显式标记截断");
        assert!(window.notice.is_some());
        assert!(!hashes_of(&window).contains(&oldest));

        // 全量历史搜索不受该窗口约束，能直接命中最早的提交。
        let deep = search_commits(&path, message_query("ROOTMARK")).expect("deep scan");
        assert_eq!(deep.total, 1);
        assert_eq!(deep.items[0].hash, oldest);
        assert_eq!(deep.items[0].title, "最早的历史提交 ROOTMARK");
        assert!(!deep.truncated);

        // 作者维度：同一次扫描可按作者过滤全量历史。
        let author = search_commits(
            &path,
            target_query("search@example.com", CommitSearchTarget::CommitAuthor),
        )
        .expect("author scan");
        assert_eq!(author.total, 26);
    }

    #[test]
    fn pickaxe_only_hits_commits_whose_occurrences_change() {
        let repository = test_repository();
        let root = repository.0.as_path();
        let path = path_of(root);
        let added = write_and_commit(root, "a.txt", "hotfix 标记\n其他行\n", "加入 hotfix");
        // 出现次数不变（1 -> 1）：pickaxe 不应命中，但 -G 逐行语义应命中。
        let moved = write_and_commit(root, "a.txt", "hotfix 标记\n其他行 改过\n", "调整其他行");
        let removed = write_and_commit(root, "a.txt", "只有其他行\n", "移除 hotfix");

        let pickaxe = search_commits(
            &path,
            target_query("hotfix 标记", CommitSearchTarget::DiffPickaxe),
        )
        .expect("pickaxe scan");
        assert_eq!(pickaxe.total, 2, "pickaxe 只应命中内容真正增减的提交");
        let hashes = hashes_of(&pickaxe);
        assert!(hashes.contains(&added) && hashes.contains(&removed));
        assert!(!hashes.contains(&moved));

        let line_regex = search_commits(&path, target_query("其他行", CommitSearchTarget::DiffRegex))
            .expect("line regex scan");
        let regex_hashes = hashes_of(&line_regex);
        assert_eq!(line_regex.total, 3);
        assert!(
            regex_hashes.contains(&moved),
            "-G 逐行语义应命中差异行里出现过该模式的提交"
        );
    }

    #[test]
    fn regex_and_literal_modes_keep_metacharacters_and_report_bad_patterns() {
        let repository = test_repository();
        let root = repository.0.as_path();
        let path = path_of(root);
        let literal_commit = write_and_commit(root, "code.rs", "call(a+b)\n", "加入字面量 a+b");
        let regex_commit = write_and_commit(root, "more.rs", "call(aab)\n", "加入 aab");

        // -F：模式按字面处理，只有真正含 "a+b" 的提交命中。
        let literal = search_commits(
            &path,
            target_query("a+b", CommitSearchTarget::DiffPickaxe),
        )
        .expect("literal pickaxe");
        assert_eq!(literal.total, 1);
        assert_eq!(literal.items[0].hash, literal_commit);

        // -E + --pickaxe-regex：a+b 变成一个或多个 a 后跟 b，命中的是另一个提交。
        let regex = search_commits(
            &path,
            CommitSearchQuery {
                regex: true,
                ..target_query("a+b", CommitSearchTarget::DiffPickaxe)
            },
        )
        .expect("regex pickaxe");
        assert_eq!(regex.total, 1);
        assert_eq!(regex.items[0].hash, regex_commit);

        // 提交信息里的括号按字面匹配。
        let paren = write_and_commit(root, "notes.md", "see (demo) here\n", "文档说明 (demo)");
        let message = search_commits(&path, message_query("(demo)")).expect("literal message");
        assert!(hashes_of(&message).contains(&paren));

        // 非法正则必须报错（Git 自身正则引擎的提示），而不是静默返回空集。
        let invalid = search_commits(
            &path,
            CommitSearchQuery {
                regex: true,
                ..message_query("[")
            },
        );
        let error = invalid.expect_err("非法正则必须报错");
        assert!(error.contains('['), "错误信息应保留 Git 的提示：{error}");

        // 全文搜索同样区分两种语义。
        let literal_text = search_repository_text(&path, text_query("(demo)")).expect("literal grep");
        assert_eq!(literal_text.total, 1);
        assert!(literal_text.items[0].content.contains("(demo)"));
        let invalid_text = search_repository_text(
            &path,
            TextSearchQuery {
                regex: true,
                ..text_query("(")
            },
        );
        assert!(invalid_text.is_err(), "非法正则的 grep 必须报错");
    }

    #[test]
    fn pagination_is_stable_and_covers_every_match_without_duplicates() {
        let repository = test_repository();
        let root = repository.0.as_path();
        let path = path_of(root);
        let series = commit_series(root, 12, "分页标记");

        let first = search_commits(
            &path,
            CommitSearchQuery {
                page_size: 5,
                ..message_query("分页标记")
            },
        )
        .expect("first page");
        assert_eq!(first.total, 12);
        assert_eq!(first.items.len(), 5);
        assert!(first.has_more);
        // 默认按提交时间倒序，最新提交在前。
        assert_eq!(first.items[0].hash, *series.last().expect("newest"));

        let mut collected = hashes_of(&first);
        let mut offset = first.items.len();
        while offset < first.total {
            let page = load_commit_search_page(&path, &first.search_id, offset, 5).expect("next page");
            collected.extend(hashes_of(&page));
            offset += page.items.len();
        }
        assert_eq!(collected.len(), 12, "分页拼接后必须覆盖全部命中");
        let unique: HashSet<String> = collected.iter().cloned().collect();
        assert_eq!(unique.len(), 12, "分页不得重复");
        let expected: HashSet<String> = series.iter().cloned().collect();
        assert_eq!(unique, expected, "分页不得漏项");

        // 翻页期间新增提交，已建立的索引游标不漂移：既不多也不少。
        let late = write_and_commit(root, "late.txt", "迟到\n", "分页标记 迟到提交");
        let tail = load_commit_search_page(&path, &first.search_id, 10, 5).expect("tail page");
        assert_eq!(tail.total, 12);
        assert_eq!(tail.items.len(), 2);
        assert!(!hashes_of(&tail).contains(&late));
        assert!(!tail.has_more);

        // 越界偏移返回空页而不是报错，前端可以安全地「再翻一页」。
        let beyond = load_commit_search_page(&path, &first.search_id, 99, 5).expect("beyond page");
        assert!(beyond.items.is_empty());
        assert!(!beyond.has_more);

        // 搜索标识与仓库绑定：换仓库使用同一 id 必须被拒绝。
        let other = test_repository();
        let rejected = load_commit_search_page(&path_of(&other.0), &first.search_id, 0, 5);
        assert!(rejected.is_err());
    }

    #[test]
    fn hash_target_locates_commits_beyond_the_loaded_window() {
        let repository = test_repository();
        let root = repository.0.as_path();
        let path = path_of(root);
        let series = commit_series(root, 8, "定位标记");
        let oldest = series.first().cloned().expect("oldest of series");

        // 短 Hash（8 位）也能精确定位，且不依赖已加载的提交列表。
        let short: String = oldest.chars().take(8).collect();
        let page = search_commits(
            &path,
            CommitSearchQuery {
                pattern: short,
                target: CommitSearchTarget::CommitHash,
                ..CommitSearchQuery::default()
            },
        )
        .expect("hash lookup");
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].hash, oldest);
        assert!(!page.truncated);

        let invalid = search_commits(
            &path,
            CommitSearchQuery {
                pattern: "not-a-hex!!".into(),
                target: CommitSearchTarget::CommitHash,
                ..CommitSearchQuery::default()
            },
        )
        .expect("non hex hash is a normal empty result");
        assert_eq!(invalid.total, 0);
        assert!(invalid.notice.is_some());

        let missing = search_commits(
            &path,
            CommitSearchQuery {
                pattern: "deadbeefdead".into(),
                target: CommitSearchTarget::CommitHash,
                ..CommitSearchQuery::default()
            },
        )
        .expect("unknown hash is a normal empty result");
        assert_eq!(missing.total, 0);
    }

    #[test]
    fn text_search_returns_line_numbers_and_context_snippets() {
        let repository = test_repository();
        let root = repository.0.as_path();
        let path = path_of(root);
        write_and_commit(
            root,
            "src/main.rs",
            "第一行\n第二行\n目标 行\n第四行\n第五行\n",
            "加入目标行",
        );

        let page = search_repository_text(
            &path,
            TextSearchQuery {
                pattern: "目标".into(),
                context_lines: 2,
                ..TextSearchQuery::default()
            },
        )
        .expect("grep search");
        assert_eq!(page.total, 1);
        assert_eq!(page.matched_files, 1);
        let hit = &page.items[0];
        assert_eq!(hit.file_path, "src/main.rs");
        assert_eq!(hit.line_number, 3);
        assert!(hit.content.contains("目标"));
        assert_eq!(hit.context_before, vec!["第一行".to_string(), "第二行".to_string()]);
        assert_eq!(hit.context_after, vec!["第四行".to_string(), "第五行".to_string()]);
        assert_eq!(hit.revision, None);
    }

    #[test]
    fn text_search_scope_respects_ignore_and_revision() {
        let repository = test_repository();
        let root = repository.0.as_path();
        let path = path_of(root);
        write_and_commit(root, "keep.txt", "隐藏内容 keep\n", "跟踪文件");
        write_and_commit(root, ".gitignore", "ignored.txt\n", "忽略生成物");
        // 被 .gitignore 忽略的文件与未跟踪文件都不参与工作区搜索。
        fs::write(root.join("ignored.txt"), "隐藏内容 ignored\n").expect("write ignored");
        fs::write(root.join("temp.txt"), "隐藏内容 temp\n").expect("write untracked");

        let worktree = search_repository_text(&path, text_query("隐藏内容")).expect("worktree grep");
        assert_eq!(worktree.total, 1, "被忽略与未跟踪的文件不应进入 git grep 结果");
        assert_eq!(worktree.items[0].file_path, "keep.txt");

        // 工作区改动只在 worktree 范围命中；指定 rev 读取的是提交快照。
        fs::write(root.join("keep.txt"), "隐藏内容 已改动\n").expect("dirty worktree");
        let dirty = search_repository_text(&path, text_query("已改动")).expect("dirty grep");
        assert_eq!(dirty.total, 1);
        let at_head = search_repository_text(
            &path,
            TextSearchQuery {
                pattern: "已改动".into(),
                revision: Some("HEAD".into()),
                ..TextSearchQuery::default()
            },
        )
        .expect("rev grep");
        assert_eq!(at_head.total, 0, "未提交的内容不应出现在指定 rev 的结果里");
        let committed = search_repository_text(
            &path,
            TextSearchQuery {
                pattern: "隐藏内容".into(),
                revision: Some("HEAD".into()),
                context_lines: 1,
                ..TextSearchQuery::default()
            },
        )
        .expect("rev grep with context");
        assert_eq!(committed.total, 1);
        assert_eq!(committed.items[0].revision.as_deref(), Some("HEAD"));
        assert!(committed.items[0].content.contains("keep"));
        assert_eq!(committed.items[0].file_path, "keep.txt", "rev 前缀需要被剥离");

        // include/exclude pathspec 生效。
        write_and_commit(root, "docs/note.md", "隐藏内容 文档\n", "文档命中");
        let only_docs = search_repository_text(
            &path,
            TextSearchQuery {
                pattern: "隐藏内容".into(),
                includes: vec!["docs/**".into()],
                ..TextSearchQuery::default()
            },
        )
        .expect("include pathspec");
        assert_eq!(only_docs.total, 1);
        assert_eq!(only_docs.items[0].file_path, "docs/note.md");
        let without_docs = search_repository_text(
            &path,
            TextSearchQuery {
                pattern: "隐藏内容".into(),
                exclude_paths: vec!["docs/**".into()],
                ..TextSearchQuery::default()
            },
        )
        .expect("exclude pathspec");
        assert!(!without_docs.items.iter().any(|item| item.file_path == "docs/note.md"));
    }

    #[test]
    fn text_search_marks_truncation_and_pages_all_matches() {
        let repository = test_repository();
        let root = repository.0.as_path();
        let path = path_of(root);
        let body = (1..=12)
            .map(|index| format!("第 {index} 行 命中标记"))
            .collect::<Vec<_>>()
            .join("\n");
        write_and_commit(root, "many.txt", &format!("{body}\n"), "多行文件");

        let capped = search_repository_text(
            &path,
            TextSearchQuery {
                pattern: "命中标记".into(),
                max_matches: Some(4),
                page_size: 3,
                context_lines: 0,
                ..TextSearchQuery::default()
            },
        )
        .expect("capped grep");
        assert_eq!(capped.total, 4);
        assert!(capped.truncated, "超过命中上限必须标记截断");
        let notice = capped.notice.clone().expect("notice");
        assert!(notice.contains("截断"), "提示必须写明截断：{notice}");
        assert_eq!(capped.items.len(), 3);
        assert!(capped.has_more);

        let full = search_repository_text(&path, text_query("命中标记")).expect("full grep");
        assert_eq!(full.total, 12);
        assert!(!full.truncated);

        let mut seen: Vec<(String, usize)> = Vec::new();
        let mut offset = 0usize;
        while offset < full.total {
            let page = load_repository_text_page(&path, &full.search_id, offset, 5, 0).expect("page");
            if page.items.is_empty() {
                break;
            }
            seen.extend(page.items.iter().map(|item| (item.file_path.clone(), item.line_number)));
            offset += page.items.len();
        }
        assert_eq!(seen.len(), 12, "全文分页必须覆盖全部命中");
        let unique: HashSet<(String, usize)> = seen.into_iter().collect();
        assert_eq!(unique.len(), 12, "全文分页不得重复");
    }

    #[test]
    fn replace_preview_is_dry_run_and_needs_explicit_confirmation() {
        let repository = test_repository();
        let root = repository.0.as_path();
        let path = path_of(root);
        let original = "旧值 一\n二 旧值\n旧值\n";
        write_and_commit(root, "app.txt", original, "引入旧值");

        let preview = preview_text_replace(&path, replace_query("旧值", "新值")).expect("preview");
        assert_eq!(preview.file_count, 1);
        assert_eq!(preview.total_occurrences, 3);
        assert!(preview.requires_confirmation);
        assert!(!preview.truncated);
        assert_eq!(preview.files[0].file_path, "app.txt");
        assert_eq!(preview.files[0].sample_lines, vec![1, 2, 3]);
        assert_eq!(read_file(root, "app.txt"), original, "dry-run 预览绝不写盘");

        let refused = apply_text_replace(&path, &preview.preview_id, false)
            .expect_err("未确认时必须拒绝写盘");
        assert!(refused.contains("确认"), "{refused}");
        assert_eq!(read_file(root, "app.txt"), original);

        // 未确认的调用不应消耗预览：确认后续仍可执行。
        let applied = apply_text_replace(&path, &preview.preview_id, true).expect("apply");
        assert!(applied.executed);
        assert_eq!(applied.files_changed, vec!["app.txt".to_string()]);
        assert_eq!(applied.occurrences, 3);
        assert_eq!(read_file(root, "app.txt"), "新值 一\n二 新值\n新值\n");

        // 一次预览只允许执行一次，避免重复点击造成二次替换。
        assert!(apply_text_replace(&path, &preview.preview_id, true).is_err());
        // 没有预览标识直接写盘同样被拒绝。
        assert!(apply_text_replace(&path, "", true).is_err());
    }

    #[test]
    fn replace_writes_backup_and_undo_restores_original_bytes() {
        let repository = test_repository();
        let root = repository.0.as_path();
        let path = path_of(root);
        let original = "旧值 alpha\nbeta 旧值\n";
        write_and_commit(root, "dir/i18n.txt", original, "两个文件各两处");
        write_and_commit(root, "dir/other.txt", "gamma 旧值\n", "另一文件一处");

        let preview = preview_text_replace(&path, replace_query("旧值", "新值")).expect("preview");
        assert_eq!(preview.file_count, 2);
        assert_eq!(preview.total_occurrences, 3);

        let report = apply_text_replace(&path, &preview.preview_id, true).expect("apply");
        assert_eq!(report.occurrences, 3);
        assert!(report.backup_available);
        assert_eq!(read_file(root, "dir/i18n.txt"), "新值 alpha\nbeta 新值\n");
        assert_eq!(read_file(root, "dir/other.txt"), "gamma 新值\n");

        let backups = list_text_replace_backups(&path).expect("backups");
        assert_eq!(backups.len(), 1);
        assert_eq!(backups[0].replace_id, report.replace_id);
        assert_eq!(backups[0].file_count, 2);
        assert_eq!(backups[0].occurrences, 3);
        assert!(backups[0].byte_size > 0);

        let undo = undo_text_replace(&path, &report.replace_id).expect("undo");
        assert_eq!(undo.restored_files.len(), 2);
        assert_eq!(read_file(root, "dir/i18n.txt"), original);
        assert_eq!(read_file(root, "dir/other.txt"), "gamma 旧值\n");
        // 撤销成功后备份被清理，重复撤销只会得到明确错误。
        assert!(list_text_replace_backups(&path).expect("after undo").is_empty());
        assert!(undo_text_replace(&path, &report.replace_id).is_err());
    }

    #[test]
    fn replace_refuses_stale_preview_and_truncated_scope() {
        let repository = test_repository();
        let root = repository.0.as_path();
        let path = path_of(root);
        write_and_commit(root, "one.txt", "旧值 one\n", "文件一");
        write_and_commit(root, "two.txt", "旧值 two\n", "文件二");
        write_and_commit(root, "three.txt", "旧值 three\n", "文件三");

        // 预览后被外部修改：整体拒绝写盘（fail-closed）。
        let preview = preview_text_replace(&path, replace_query("旧值", "新值")).expect("preview");
        let external = "旧值 one\n用户自己加的一行\n";
        fs::write(root.join("one.txt"), external).expect("external edit");
        let stale = apply_text_replace(&path, &preview.preview_id, true).expect_err("stale preview");
        assert!(stale.contains("预览后被修改"), "{stale}");
        assert_eq!(read_file(root, "one.txt"), external, "被拒后必须保留用户的外部改动");
        assert_eq!(read_file(root, "two.txt"), "旧值 two\n");

        // 预览范围被截断：拒绝在不确定范围内写盘。
        let capped = preview_text_replace(
            &path,
            TextReplaceQuery {
                pattern: "旧值".into(),
                replacement: "新值".into(),
                max_files: Some(2),
                ..TextReplaceQuery::default()
            },
        )
        .expect("capped preview");
        assert!(capped.truncated, "文件数被上限截断时必须标记");
        assert!(capped.files.len() <= 2);
        let refused = apply_text_replace(&path, &capped.preview_id, true)
            .expect_err("截断的预览不允许写盘");
        assert!(refused.contains("截断"), "{refused}");
        assert_eq!(read_file(root, "two.txt"), "旧值 two\n");
    }

    #[test]
    fn regex_replace_splices_at_git_columns_and_rejects_group_refs() {
        let repository = test_repository();
        let root = repository.0.as_path();
        let path = path_of(root);
        write_and_commit(root, "ids.txt", "id=12 id=34\n中文 id=56\n", "带数字的行");

        let preview = preview_text_replace(
            &path,
            TextReplaceQuery {
                pattern: "[0-9]+".into(),
                replacement: "N".into(),
                regex: true,
                ..TextReplaceQuery::default()
            },
        )
        .expect("regex preview");
        assert_eq!(preview.total_occurrences, 3, "同一行的多个命中都要计入");

        let report = apply_text_replace(&path, &preview.preview_id, true).expect("regex apply");
        assert_eq!(report.occurrences, 3);
        assert_eq!(read_file(root, "ids.txt"), "id=N id=N\n中文 id=N\n");

        // 捕获组引用无法由本模块回填：明确拒绝而不是静默写成字面量。
        let rejected = preview_text_replace(
            &path,
            TextReplaceQuery {
                pattern: "id=([0-9]+)".into(),
                replacement: "id=$1".into(),
                regex: true,
                ..TextReplaceQuery::default()
            },
        )
        .expect_err("捕获组引用必须被拒绝");
        assert!(rejected.contains("捕获组"), "{rejected}");

        // 大小写不敏感命中后，替换文本按用户给定内容写入。
        write_and_commit(root, "case.txt", "Beta\nBETA\nbeta\n", "三种大小写");
        let insensitive = preview_text_replace(
            &path,
            TextReplaceQuery {
                pattern: "beta".into(),
                replacement: "alpha".into(),
                case_sensitive: false,
                includes: vec!["case.txt".into()],
                ..TextReplaceQuery::default()
            },
        )
        .expect("case insensitive preview");
        assert_eq!(insensitive.total_occurrences, 3);
        apply_text_replace(&path, &insensitive.preview_id, true).expect("apply insensitive");
        assert_eq!(read_file(root, "case.txt"), "alpha\nalpha\nalpha\n");
    }

    #[test]
    fn replace_skips_binary_and_oversized_files_without_touching_them() {
        let repository = test_repository();
        let root = repository.0.as_path();
        let path = path_of(root);
        write_and_commit(root, "text.txt", "旧值 文本\n", "文本文件");
        // 二进制内容：NUL 控制字节 + UTF-8 中文，明确不是文本。
        let mut blob: Vec<u8> = vec![0x00, 0x01];
        blob.extend_from_slice("旧值".as_bytes());
        blob.extend_from_slice(&[0x02, 0x03]);
        fs::write(root.join("blob.bin"), blob).expect("write binary");
        git::git_output(root, &["add", "blob.bin"]).expect("add binary");
        git::git_output(root, &["commit", "-m", "二进制文件"]).expect("commit binary");

        let preview = preview_text_replace(&path, replace_query("旧值", "新值")).expect("preview");
        assert_eq!(preview.file_count, 1, "二进制文件不参与替换");
        assert_eq!(preview.skipped_files, 1);
        let bytes = fs::read(root.join("blob.bin")).expect("read binary");
        assert!(bytes.contains(&0), "被跳过的文件内容保持原样");
        let report = apply_text_replace(&path, &preview.preview_id, true).expect("apply");
        assert_eq!(report.files_changed, vec!["text.txt".to_string()]);
        assert!(!report.skipped.is_empty());
    }

    #[test]
    fn editor_load_and_save_guard_against_concurrent_edits() {
        let repository = test_repository();
        let root = repository.0.as_path();
        let path = path_of(root);
        write_and_commit(root, "edit.txt", "编辑内容\n第二行\n", "可编辑文件");

        let loaded = load_repository_text_file(&path, "edit.txt", None, None).expect("load");
        assert_eq!(loaded.content, "编辑内容\n第二行\n");
        assert_eq!(loaded.line_count, 2);
        assert!(!loaded.binary);
        assert!(!loaded.truncated);
        assert_eq!(loaded.checksum.chars().count(), 16);

        let saved = save_repository_text_file(&path, "edit.txt", "编辑内容\n改过的第二行\n", &loaded.checksum)
            .expect("save");
        assert_eq!(read_file(root, "edit.txt"), "编辑内容\n改过的第二行\n");
        assert_ne!(saved.checksum, loaded.checksum);
        // 保存不自动暂存：改动留在工作区。
        assert_eq!(git::git_output(root, &["diff", "--cached", "--name-only"]).expect("staged").trim(), "");

        // 外部修改后用旧校验和保存必须被拒绝。
        fs::write(root.join("edit.txt"), "外部改动\n").expect("external write");
        let conflict = save_repository_text_file(&path, "edit.txt", "我要覆盖\n", &saved.checksum)
            .expect_err("乐观并发必须拒绝覆盖");
        assert!(conflict.contains("外部修改"), "{conflict}");
        assert_eq!(read_file(root, "edit.txt"), "外部改动\n");

        // 指定 rev 读取提交快照，不受工作区脏改动影响。
        let at_head = load_repository_text_file(&path, "edit.txt", None, Some("HEAD")).expect("load rev");
        assert_eq!(at_head.revision.as_deref(), Some("HEAD"));
        assert_eq!(at_head.content, "编辑内容\n第二行\n");

        // 超大文件读取被截断；用截断基线保存会被校验和挡下。
        write_and_commit(root, "big.txt", &"字".repeat(3_000), "较大的文件");
        let small = load_repository_text_file(&path, "big.txt", Some(1_024), None).expect("load truncated");
        assert!(small.truncated);
        assert!(small.notice.is_some());
        assert!(save_repository_text_file(&path, "big.txt", "覆盖\n", &small.checksum).is_err());

        // 空校验和与二进制都拒绝保存。
        assert!(save_repository_text_file(&path, "edit.txt", "覆盖\n", "").is_err());
        let mut blob: Vec<u8> = vec![0x00, 0x01];
        blob.extend_from_slice("旧值".as_bytes());
        blob.extend_from_slice(&[0x02, 0x03]);
        fs::write(root.join("blob.bin"), blob).expect("write binary");
        git::git_output(root, &["add", "blob.bin"]).expect("add binary");
        git::git_output(root, &["commit", "-m", "二进制文件"]).expect("commit binary");
        let binary = load_repository_text_file(&path, "blob.bin", None, None).expect("load binary");
        assert!(binary.binary);
        assert!(binary.content.is_empty());
        // 二进制文件即便带着合法校验和也拒绝写回：内置编辑器只处理文本。
        assert!(save_repository_text_file(&path, "blob.bin", "覆盖\n", &binary.checksum).is_err());
    }

    #[test]
    fn invalid_revisions_paths_and_patterns_are_rejected() {
        let repository = test_repository();
        let root = repository.0.as_path();
        let path = path_of(root);
        write_and_commit(root, "safe.txt", "内容 beta\n", "安全文件");

        // 引用：选项注入、越界路径、不存在的分支都必须失败。
        for bad in [
            "--output=/tmp/pwn",
            "../../etc/passwd",
            "not-a-branch",
            "-Sdanger",
            "refs/heads/main;rm -rf /",
        ] {
            let error = search_commits(
                &path,
                CommitSearchQuery {
                    pattern: "beta".into(),
                    revisions: vec![bad.to_string()],
                    ..CommitSearchQuery::default()
                },
            )
            .expect_err("非法引用必须被拒绝");
            assert!(!error.is_empty(), "{bad} 应给出拒绝原因");
        }

        // pathspec：绝对路径、越界、magic 前缀都被拒绝。
        for bad in ["/etc/passwd", "../secret", ":(exclude)src", ".."] {
            assert!(search_commits(
                &path,
                CommitSearchQuery {
                    pattern: "beta".into(),
                    paths: vec![bad.to_string()],
                    ..CommitSearchQuery::default()
                },
            )
            .is_err());
            assert!(search_repository_text(
                &path,
                TextSearchQuery {
                    pattern: "beta".into(),
                    includes: vec![bad.to_string()],
                    ..TextSearchQuery::default()
                },
            )
            .is_err());
            assert!(preview_text_replace(
                &path,
                TextReplaceQuery {
                    pattern: "beta".into(),
                    replacement: "alpha".into(),
                    includes: vec![bad.to_string()],
                    ..TextReplaceQuery::default()
                },
            )
            .is_err());
        }

        // 空模式、含换行模式、超长模式。
        assert!(search_commits(&path, message_query("")).is_err());
        assert!(search_repository_text(&path, text_query("a\nb")).is_err());
        assert!(search_repository_text(&path, text_query(&"x".repeat(PATTERN_MAX_CHARS + 1))).is_err());

        // rev 不存在与越界文件路径。
        assert!(search_repository_text(
            &path,
            TextSearchQuery {
                pattern: "beta".into(),
                revision: Some("no-such-rev".into()),
                ..TextSearchQuery::default()
            },
        )
        .is_err());
        for bad in ["../outside.txt", "/etc/hosts", "src/*", "-rf"] {
            assert!(load_repository_text_file(&path, bad, None, None).is_err(), "{bad}");
            assert!(save_repository_text_file(&path, bad, "x", "0000000000000000").is_err(), "{bad}");
        }
        assert!(undo_text_replace(&path, "../escape").is_err());
        assert!(preview_text_replace(
            &path,
            TextReplaceQuery {
                pattern: "beta".into(),
                replacement: "多\n行".into(),
                ..TextReplaceQuery::default()
            },
        )
        .is_err());
        // 合法范围的搜索仍然正常返回。
        let ok = search_repository_text(&path, text_query("beta")).expect("valid search");
        assert_eq!(ok.total, 1);
    }

    #[test]
    fn cancelled_task_stops_the_stream_immediately_and_leaves_no_zombie() {
        let repository = test_repository();
        let root = repository.0.as_path();
        let path = path_of(root);
        commit_series(root, 6, "流式取消");

        let task = begin_task(&task_key(root, "commit"));
        assert_eq!(cancel_repository_search(&path), 1, "在跑的任务必须被登记");
        assert!(task.is_cancelled());

        // 用已取消的门票跑一次真实扫描：立即判定取消，一条结果都不收。
        let log_args: Vec<String> = ["log", "--format=%H", "--all"]
            .iter()
            .map(|arg| (*arg).to_string())
            .collect();
        let mut stream = GitStream::start(root, &log_args, b'\n', 128).expect("start log");
        let mut visited = 0usize;
        let outcome = stream
            .scan(&task, usize::MAX, |_| {
                visited += 1;
                Ok(true)
            })
            .expect("scan");
        stream.stop(&outcome, &[0]).expect("stop");
        assert!(outcome.cancelled);
        assert_eq!(visited, 0, "取消后不得再消费任何记录");

        // 门票释放后队列不留僵尸。
        drop(task);
        assert_eq!(active_task_count_for(root), 0);
        let fresh = begin_task(&task_key(root, "commit"));
        assert!(!fresh.is_cancelled());
        drop(fresh);
    }

    #[test]
    fn a_new_search_preempts_the_previous_one_for_the_same_repository() {
        let repository = test_repository();
        let root = repository.0.as_path();
        // 先造出可被搜索命中的历史，否则后半段断言的是空仓库。
        commit_series(root, 6, "流式取消");
        let first = begin_task(&task_key(root, "commit"));
        assert!(!first.is_cancelled());

        let second = begin_task(&task_key(root, "commit"));
        assert!(first.is_cancelled(), "同仓库同类型的新搜索应抢占旧搜索");
        assert!(!second.is_cancelled());

        // 不同类型（全文搜索）与不同类型的键互不影响，不会互相误杀。
        let text = begin_task(&task_key(root, "text"));
        assert!(!second.is_cancelled());
        assert_eq!(active_task_count_for(root), 2);

        assert_eq!(cancel_repository_search(&path_of(root)), 2);
        assert!(second.is_cancelled() && text.is_cancelled());

        // 真实搜索跑完后队列为空，且两次连续搜索都能拿到完整结果。
        drop((first, second, text));
        let path = path_of(root);
        let first_page = search_commits(&path, message_query("流式取消")).expect("first search");
        assert_eq!(first_page.total, 6);
        assert!(!first_page.cancelled);
        let second_page = search_commits(&path, message_query("流式取消")).expect("second search");
        assert_eq!(second_page.total, 6);
        assert_eq!(active_task_count_for(root), 0);
    }

    #[test]
    fn search_caches_are_bounded_and_dropped_on_repository_switch() {
        let repository = test_repository();
        let root = repository.0.as_path();
        let path = path_of(root);
        commit_series(root, 3, "缓存上限");
        // 先拿到真实命中数，作为「是否应当被截断」的判据。
        let all = search_commits(&path, message_query("缓存上限")).expect("all matches");
        assert_eq!(all.total, 3);

        // 连开 MAX_SEARCH_SESSIONS + 4 次搜索：缓存条目数不得增长超过上限。
        let searches = MAX_SEARCH_SESSIONS + 4;
        let mut last_search_id = String::new();
        for index in 0..searches {
            let page = search_commits(
                &path,
                CommitSearchQuery {
                    pattern: "缓存上限".into(),
                    revisions: vec!["main".into()],
                    max_commits: Some(index + 1),
                    ..CommitSearchQuery::default()
                },
            )
            .expect("bounded session search");
            assert!(page.total <= index + 1);
            // 截断必须与上限的真实关系一致：只有命中数确实超过上限时才标记截断，
            // 反过来也绝不能漏标——这是「不静默」契约的可执行形式。
            assert_eq!(
                page.truncated,
                all.total > index + 1,
                "上限 {} 对 {} 条命中的截断标记不正确",
                index + 1,
                all.total
            );
            last_search_id = page.search_id;
        }
        // 索引缓存是**全局** FIFO，并行跑的其他测试也会往里塞条目并触发淘汰，
        // 因此这里断言真正的契约而不是精确条数：有上限、超限确实淘汰、最新条目仍在。
        let retained = cached_index_count_for(root);
        assert!(
            retained <= MAX_SEARCH_SESSIONS,
            "索引缓存必须有条数上限：本仓库保留了 {retained} 条，上限 {MAX_SEARCH_SESSIONS}"
        );
        assert!(
            retained < searches,
            "开了 {searches} 次搜索却一条都没淘汰，说明上限没有生效"
        );
        assert!(
            load_commit_search_page(&path, &last_search_id, 0, 10).is_ok(),
            "FIFO 必须保留最新会话，被淘汰的只能是最旧的"
        );

        // 切换仓库等价于清理：该仓库的分页索引与替换预览全部失效。
        let preview = preview_text_replace(&path, replace_query("内容", "内容2")).expect("preview");
        assert!(cached_preview_count_for(root) >= 1);
        assert!(cancel_repository_search(&path) >= 0);
        assert_eq!(cached_index_count_for(root), 0);
        assert_eq!(cached_preview_count_for(root), 0);
        assert!(load_commit_search_page(&path, &preview.preview_id, 0, 10).is_err());
        assert!(apply_text_replace(&path, &preview.preview_id, true).is_err());
    }

    #[cfg(test)]
    fn active_task_count_for(root: &Path) -> usize {
        let prefix = repository_prefix(root);
        task_registry()
            .lock()
            .map(|registry| registry.active.keys().filter(|key| key.starts_with(&prefix)).count())
            .unwrap_or(0)
    }

    #[cfg(test)]
    fn cached_index_count_for(root: &Path) -> usize {
        let prefix = repository_prefix(root);
        index_cache()
            .lock()
            .map(|cache| cache.values().filter(|entry| entry.repository_prefix == prefix).count())
            .unwrap_or(0)
    }

    #[cfg(test)]
    fn cached_preview_count_for(root: &Path) -> usize {
        let prefix = repository_prefix(root);
        preview_cache()
            .lock()
            .map(|cache| cache.values().filter(|plan| plan.repository_prefix == prefix).count())
            .unwrap_or(0)
    }
}
