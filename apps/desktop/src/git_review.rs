//! 子项目 B1（Gerrit 式代码审查）：本地行级评论线程存储。
//!
//! 设计文档：docs/superpowers/specs/2026-11-07-code-review-design.md
//!
//! 存储布局：`<settings_directory()>/reviews/<repository_key>.json`，与 hosting.json
//! 同目录、同读写模式（临时文件 + rename 原子替换，Unix 权限 600）。
//!
//! 约定：
//! - 纯本地 CRUD，无网络；同步命令在 B4/B5 落到 git_hosting.rs。
//! - 文件损坏返回 `review.storeCorrupted`，绝不清空既有数据。
//! - 读取忽略未知字段；`schemaVersion` 高于当前版本视为损坏（未来版本无法安全解释）。
//! - `repository_key` = 规范化仓库绝对路径（去尾分隔符）SHA-256 前 16 位 hex。
//!
//! 集成约定：与 git_hosting.rs 相同，`#[tauri::command]` 包装位于文件末尾，
//! 由 lib.rs 统一注册。

use crate::error::CommandError;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const SCHEMA_VERSION: u32 = 1;
const KEY_HEX_LEN: usize = 16;
/// 线程体量防御上限：超出即拒绝，避免误操作把 UI 卡死或文件膨胀。
const MAX_THREADS: usize = 20_000;
const MAX_COMMENTS_PER_THREAD: usize = 500;
const MAX_BODY_CHARS: usize = 32 * 1024;
const MAX_FILE_PATH_CHARS: usize = 4_096;
const MAX_REFERENCE_CHARS: usize = 1_024;
const MAX_ID_CHARS: usize = 128;
const MAX_AUTHOR_CHARS: usize = 256;

// ---------------------------------------------------------------------------
// 前端契约（与 packages/git-models 的 Review* 类型同构，camelCase）
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    pub id: String,
    /// 写入时刻的 git config user.name（可能为空串）。
    pub author: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThreadRemote {
    /// "github" | "gitlab"
    pub provider: String,
    pub pull_number: u64,
    /// GitHub comment id / GitLab discussion id。
    pub remote_id: String,
    pub web_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThread {
    /// uuid v4（前端生成，后端校验非空）。
    pub id: String,
    /// 仓库相对路径，统一 '/' 分隔。
    pub file_path: String,
    /// 锚定的 ref：提交 hash / 分支 / 标签。
    pub reference: String,
    /// 1 起；side=new 时为该版本文件行号或 diff 新侧行号。
    pub line: u32,
    /// "new" | "old"（树预览恒为 "new"）。
    pub side: String,
    pub resolved: bool,
    pub created_at: String,
    pub updated_at: String,
    pub comments: Vec<ReviewComment>,
    pub remote: Option<ReviewThreadRemote>,
}

/// 每仓库一个 JSON 文件的顶层结构。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewStoreFile {
    #[serde(default)]
    schema_version: u32,
    #[serde(default)]
    threads: Vec<ReviewThread>,
}

impl Default for ReviewStoreFile {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            threads: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// SHA-256（内联实现，避免为 16 位 hex key 引入新依赖）
// ---------------------------------------------------------------------------

fn sha256_hex_prefix(input: &[u8]) -> String {
    let k: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    // 填充：0x80 + 0…0 + 8 字节大端位长。
    let bit_len = (input.len() as u64).wrapping_mul(8);
    let mut padded = input.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    for block in padded.chunks(64) {
        let mut w = [0u32; 64];
        for (index, word) in block.chunks(4).enumerate() {
            w[index] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for index in 16..64 {
            let s0 = w[index - 15].rotate_right(7)
                ^ w[index - 15].rotate_right(18)
                ^ (w[index - 15] >> 3);
            let s1 = w[index - 2].rotate_right(17)
                ^ w[index - 2].rotate_right(19)
                ^ (w[index - 2] >> 10);
            w[index] = w[index - 16]
                .wrapping_add(s0)
                .wrapping_add(w[index - 7])
                .wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for index in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(k[index])
                .wrapping_add(w[index]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut hex = String::with_capacity(64);
    for word in h {
        hex.push_str(&format!("{word:08x}"));
    }
    hex.truncate(KEY_HEX_LEN);
    hex
}

// ---------------------------------------------------------------------------
// 时间戳（RFC3339 UTC，无外部依赖）
// ---------------------------------------------------------------------------

fn now_rfc3339() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0);
    format_rfc3339(seconds)
}

/// Unix 秒 → "YYYY-MM-DDTHH:MM:SSZ"（Howard Hinnant 的 civil_from_days）。
fn format_rfc3339(unix_seconds: i64) -> String {
    let days = unix_seconds.div_euclid(86_400);
    let seconds_of_day = unix_seconds.rem_euclid(86_400);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;

    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

// ---------------------------------------------------------------------------
// 路径与读写
// ---------------------------------------------------------------------------

/// 仓库存储键：规范化绝对路径（能 canonicalize 则解析符号链接）去尾分隔符后
/// 取 SHA-256 前 16 位 hex，避免路径特殊字符进文件名。
pub(crate) fn repository_key(repository_path: &str) -> String {
    let trimmed = repository_path.trim();
    let canonical = fs::canonicalize(trimmed).unwrap_or_else(|_| PathBuf::from(trimmed));
    let mut text = canonical.to_string_lossy().into_owned();
    while text.len() > 1 && (text.ends_with('/') || text.ends_with('\\')) {
        text.pop();
    }
    sha256_hex_prefix(text.as_bytes())
}

fn reviews_directory() -> Result<PathBuf, CommandError> {
    let base = crate::git_hosting::settings_directory()
        .map_err(|error| CommandError::new("review.storeUnavailable").detail(error))?;
    Ok(base.join("reviews"))
}

fn store_path_at(base: &Path, repository_path: &str) -> PathBuf {
    base.join(format!("{}.json", repository_key(repository_path)))
}

fn store_io_error(action: &str, error: std::io::Error) -> CommandError {
    CommandError::new("review.storeIoFailed").detail(format!("{action}失败：{error}"))
}

fn corrupted_error(path: &Path, reason: &str) -> CommandError {
    CommandError::new("review.storeCorrupted")
        .param("path", path.to_string_lossy().into_owned())
        .detail(format!("审查数据文件无法解析（{reason}），原文件未被修改"))
}

fn read_store_at(path: &Path) -> Result<ReviewStoreFile, CommandError> {
    if !path.exists() {
        return Ok(ReviewStoreFile::default());
    }
    let raw = fs::read_to_string(path).map_err(|error| store_io_error("读取审查数据", error))?;
    if raw.trim().is_empty() {
        return Ok(ReviewStoreFile::default());
    }
    let file: ReviewStoreFile =
        serde_json::from_str(&raw).map_err(|error| corrupted_error(path, &error.to_string()))?;
    if file.schema_version > SCHEMA_VERSION {
        return Err(corrupted_error(
            path,
            &format!("未知的 schemaVersion {}", file.schema_version),
        ));
    }
    Ok(file)
}

fn write_store_at(path: &Path, file: &ReviewStoreFile) -> Result<(), CommandError> {
    let directory = path
        .parent()
        .ok_or_else(|| CommandError::new("review.storeUnavailable").detail("审查数据路径无效"))?;
    fs::create_dir_all(directory).map_err(|error| store_io_error("创建审查数据目录", error))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(directory, fs::Permissions::from_mode(0o700));
    }
    let bytes = serde_json::to_vec_pretty(file).map_err(|error| {
        CommandError::new("review.storeIoFailed").detail(format!("序列化审查数据失败：{error}"))
    })?;
    let temp_name = format!(
        ".reviews-{}-{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0),
    );
    let temp_path = directory.join(temp_name);
    let result = (|| -> Result<(), CommandError> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut handle = options
            .open(&temp_path)
            .map_err(|error| store_io_error("创建审查数据临时文件", error))?;
        handle
            .write_all(&bytes)
            .map_err(|error| store_io_error("写入审查数据", error))?;
        handle
            .sync_all()
            .map_err(|error| store_io_error("落盘审查数据", error))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o600))
                .map_err(|error| store_io_error("设置审查数据权限", error))?;
        }
        #[cfg(target_os = "windows")]
        {
            let _ = fs::remove_file(path);
        }
        fs::rename(&temp_path, path).map_err(|error| store_io_error("保存审查数据", error))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

// ---------------------------------------------------------------------------
// 校验与规整
// ---------------------------------------------------------------------------

fn invalid_thread(field: &str, detail: impl Into<String>) -> CommandError {
    CommandError::new("review.invalidThread")
        .param("field", field)
        .detail(detail.into())
}

fn validate_thread(thread: &ReviewThread) -> Result<(), CommandError> {
    if thread.id.trim().is_empty() || thread.id.len() > MAX_ID_CHARS {
        return Err(invalid_thread("id", "线程 id 必须是 1-128 个字符"));
    }
    if thread.file_path.trim().is_empty() || thread.file_path.len() > MAX_FILE_PATH_CHARS {
        return Err(invalid_thread(
            "filePath",
            format!("文件路径必须是 1-{MAX_FILE_PATH_CHARS} 个字符"),
        ));
    }
    if thread.reference.trim().is_empty() || thread.reference.len() > MAX_REFERENCE_CHARS {
        return Err(invalid_thread(
            "reference",
            format!("锚定 ref 必须是 1-{MAX_REFERENCE_CHARS} 个字符"),
        ));
    }
    if thread.line == 0 {
        return Err(invalid_thread("line", "行号从 1 开始"));
    }
    if thread.side != "new" && thread.side != "old" {
        return Err(invalid_thread("side", "side 只能是 new 或 old"));
    }
    if thread.comments.is_empty() || thread.comments.len() > MAX_COMMENTS_PER_THREAD {
        return Err(invalid_thread(
            "comments",
            format!("线程必须包含 1-{MAX_COMMENTS_PER_THREAD} 条评论"),
        ));
    }
    for comment in &thread.comments {
        if comment.id.trim().is_empty() || comment.id.len() > MAX_ID_CHARS {
            return Err(invalid_thread("commentId", "评论 id 必须是 1-128 个字符"));
        }
        if comment.body.trim().is_empty() || comment.body.len() > MAX_BODY_CHARS {
            return Err(invalid_thread(
                "commentBody",
                format!("评论内容必须是 1-{MAX_BODY_CHARS} 个字符"),
            ));
        }
        if comment.author.len() > MAX_AUTHOR_CHARS {
            return Err(invalid_thread("author", "作者名过长"));
        }
    }
    if let Some(remote) = &thread.remote {
        if remote.provider != "github" && remote.provider != "gitlab" {
            return Err(invalid_thread(
                "remote.provider",
                "远端 provider 只能是 github 或 gitlab",
            ));
        }
        if remote.remote_id.trim().is_empty() || remote.remote_id.len() > MAX_ID_CHARS {
            return Err(invalid_thread("remote.remoteId", "远端 id 不能为空"));
        }
    }
    Ok(())
}

/// 规整线程字段：路径统一 '/' 分隔并去尾分隔符；ref/side 去首尾空白；
/// 空的 created_at 由后端补时间戳（覆盖已有线程时保留旧 created_at）；
/// updated_at 恒为当前时刻。
fn normalize_thread(thread: &mut ReviewThread, existing: Option<&ReviewThread>) {
    let now = now_rfc3339();
    thread.file_path = thread.file_path.replace('\\', "/");
    while thread.file_path.len() > 1 && thread.file_path.ends_with('/') {
        thread.file_path.pop();
    }
    thread.reference = thread.reference.trim().to_string();
    thread.side = thread.side.trim().to_string();
    if thread.created_at.trim().is_empty() {
        thread.created_at = existing
            .map(|previous| previous.created_at.clone())
            .unwrap_or_else(|| now.clone());
    }
    for comment in &mut thread.comments {
        if comment.created_at.trim().is_empty() {
            comment.created_at = now.clone();
        }
    }
    thread.updated_at = now;
}

// ---------------------------------------------------------------------------
// CRUD 核心（base 注入以便测试；命令包装在文件末尾）
// ---------------------------------------------------------------------------

fn list_threads_at(base: &Path, repository_path: &str) -> Result<Vec<ReviewThread>, CommandError> {
    Ok(read_store_at(&store_path_at(base, repository_path))?.threads)
}

fn upsert_thread_at(
    base: &Path,
    repository_path: &str,
    mut thread: ReviewThread,
) -> Result<ReviewThread, CommandError> {
    validate_thread(&thread)?;
    let path = store_path_at(base, repository_path);
    let mut store = read_store_at(&path)?;
    if store.threads.len() >= MAX_THREADS && !store.threads.iter().any(|item| item.id == thread.id)
    {
        return Err(invalid_thread(
            "threads",
            format!("审查线程数量已达上限 {MAX_THREADS}"),
        ));
    }
    let existing = store
        .threads
        .iter()
        .find(|item| item.id == thread.id)
        .cloned();
    normalize_thread(&mut thread, existing.as_ref());
    // 校验规整后的最终形态（例如规整后 filePath 变为空）。
    validate_thread(&thread)?;
    store.threads.retain(|item| item.id != thread.id);
    store.threads.push(thread.clone());
    write_store_at(&path, &store)?;
    Ok(thread)
}

fn delete_thread_at(
    base: &Path,
    repository_path: &str,
    thread_id: &str,
) -> Result<(), CommandError> {
    if thread_id.trim().is_empty() {
        return Err(invalid_thread("threadId", "线程 id 不能为空"));
    }
    let path = store_path_at(base, repository_path);
    let mut store = read_store_at(&path)?;
    let before = store.threads.len();
    store.threads.retain(|item| item.id != thread_id);
    if store.threads.len() == before {
        // 幂等删除：目标不存在视作成功。
        return Ok(());
    }
    write_store_at(&path, &store)
}

fn set_resolved_at(
    base: &Path,
    repository_path: &str,
    thread_id: &str,
    resolved: bool,
) -> Result<ReviewThread, CommandError> {
    if thread_id.trim().is_empty() {
        return Err(invalid_thread("threadId", "线程 id 不能为空"));
    }
    let path = store_path_at(base, repository_path);
    let mut store = read_store_at(&path)?;
    let thread = store
        .threads
        .iter_mut()
        .find(|item| item.id == thread_id)
        .ok_or_else(|| {
            CommandError::new("review.threadNotFound")
                .param("threadId", thread_id)
                .detail("未找到要标记的评论线程")
        })?;
    thread.resolved = resolved;
    thread.updated_at = now_rfc3339();
    let updated = thread.clone();
    write_store_at(&path, &store)?;
    Ok(updated)
}

// ---------------------------------------------------------------------------
// B5 发布接缝：git_hosting 的发布流程读取并回填远端信息
// ---------------------------------------------------------------------------

/// 读取仓库全部线程（含锚在其他 ref 上的，由调用方按 reference 过滤）。
pub(crate) fn load_all_threads(repository_path: &str) -> Result<Vec<ReviewThread>, CommandError> {
    let base = reviews_directory()?;
    list_threads_at(&base, repository_path)
}

/// 覆盖保存线程（发布成功后回填 remote 用；校验与规整与 upsert 一致）。
pub(crate) fn store_thread(
    repository_path: &str,
    thread: ReviewThread,
) -> Result<ReviewThread, CommandError> {
    let base = reviews_directory()?;
    upsert_thread_at(&base, repository_path, thread)
}

// ---------------------------------------------------------------------------
// Tauri 命令包装（由 lib.rs 注册）
// ---------------------------------------------------------------------------

fn task_error(action: &str, error: impl std::fmt::Display) -> CommandError {
    CommandError::new("review.storeIoFailed").detail(format!("{action}失败：{error}"))
}

#[tauri::command]
pub async fn list_review_threads(
    repository_path: String,
) -> Result<Vec<ReviewThread>, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = reviews_directory()?;
        list_threads_at(&base, &repository_path)
    })
    .await
    .map_err(|error| task_error("读取评论线程", error))?
}

#[tauri::command]
pub async fn upsert_review_thread(
    repository_path: String,
    thread: ReviewThread,
) -> Result<ReviewThread, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = reviews_directory()?;
        upsert_thread_at(&base, &repository_path, thread)
    })
    .await
    .map_err(|error| task_error("保存评论线程", error))?
}

#[tauri::command]
pub async fn delete_review_thread(
    repository_path: String,
    thread_id: String,
) -> Result<(), CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = reviews_directory()?;
        delete_thread_at(&base, &repository_path, &thread_id)
    })
    .await
    .map_err(|error| task_error("删除评论线程", error))?
}

#[tauri::command]
pub async fn set_review_thread_resolved(
    repository_path: String,
    thread_id: String,
    resolved: bool,
) -> Result<ReviewThread, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = reviews_directory()?;
        set_resolved_at(&base, &repository_path, &thread_id, resolved)
    })
    .await
    .map_err(|error| task_error("标记评论线程", error))?
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
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
                "branchline-review-test-{label}-{}-{nanos}-{sequence}",
                std::process::id()
            ));
            match fs::create_dir(&candidate) {
                Ok(()) => return candidate,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("create test directory: {error}"),
            }
        }
    }

    struct TestDirectory(PathBuf);

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn test_directory(label: &str) -> TestDirectory {
        TestDirectory(unique_test_directory(label))
    }

    fn sample_thread(id: &str) -> ReviewThread {
        ReviewThread {
            id: id.to_string(),
            file_path: "src/main.rs".to_string(),
            reference: "feature-branch".to_string(),
            line: 42,
            side: "new".to_string(),
            resolved: false,
            created_at: "2026-11-07T02:00:00Z".to_string(),
            updated_at: "2026-11-07T02:00:00Z".to_string(),
            comments: vec![ReviewComment {
                id: format!("{id}-c1"),
                author: "dev".to_string(),
                body: "这里建议提取成函数".to_string(),
                created_at: "2026-11-07T02:00:00Z".to_string(),
            }],
            remote: None,
        }
    }

    // ---------------------------------------------------------------- SHA-256

    #[test]
    fn sha256_matches_known_vectors() {
        assert_eq!(sha256_hex_prefix(b"abc"), "ba7816bf8f01cfea");
        assert_eq!(sha256_hex_prefix(b""), "e3b0c44298fc1c14");
        assert_eq!(
            sha256_hex_prefix(b"The quick brown fox jumps over the lazy dog"),
            "d7a8fbb307d78094"
        );
    }

    // ---------------------------------------------------------------- RFC3339

    #[test]
    fn formats_rfc3339_timestamps() {
        assert_eq!(format_rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_rfc3339(1_000_000_000), "2001-09-09T01:46:40Z");
        assert_eq!(format_rfc3339(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(format_rfc3339(1_730_937_600), "2024-11-07T00:00:00Z");
    }

    // ------------------------------------------------------------ repository_key

    #[test]
    fn repository_key_is_stable_across_trailing_separators() {
        let base = repository_key("/tmp/branchline/widgets");
        assert_eq!(base, repository_key("/tmp/branchline/widgets/"));
        assert_eq!(base.len(), 16);
        assert!(base.chars().all(|character| character.is_ascii_hexdigit()));
    }

    #[test]
    fn repository_key_distinguishes_different_repositories() {
        assert_ne!(
            repository_key("/tmp/branchline/widgets"),
            repository_key("/tmp/branchline/gadgets")
        );
    }

    #[cfg(unix)]
    #[test]
    fn repository_key_resolves_symlinks_to_the_same_physical_directory() {
        let directory = test_directory("symlink-key");
        let real = directory.0.join("real");
        let link = directory.0.join("link");
        fs::create_dir_all(&real).expect("create real");
        std::os::unix::fs::symlink(&real, &link).expect("symlink");
        assert_eq!(
            repository_key(&real.to_string_lossy()),
            repository_key(&link.to_string_lossy())
        );
    }

    // ---------------------------------------------------------------- CRUD

    #[test]
    fn missing_store_returns_empty_list() {
        let base = test_directory("missing-store");
        let threads = list_threads_at(&base.0, "/repos/alpha").expect("list");
        assert!(threads.is_empty());
    }

    #[test]
    fn upsert_inserts_then_updates_by_id() {
        let base = test_directory("upsert");
        let stored =
            upsert_thread_at(&base.0, "/repos/alpha", sample_thread("t1")).expect("insert");
        assert_eq!(stored.comments.len(), 1);

        let mut updated = sample_thread("t1");
        updated.comments.push(ReviewComment {
            id: "t1-c2".to_string(),
            author: "reviewer".to_string(),
            body: "同意，我来改".to_string(),
            created_at: String::new(),
        });
        updated.resolved = true;
        let stored_update = upsert_thread_at(&base.0, "/repos/alpha", updated).expect("update");
        assert_eq!(stored_update.comments.len(), 2);
        assert!(stored_update.resolved);
        // 原 created_at 保留，updated_at 被刷新。
        assert_eq!(stored_update.created_at, "2026-11-07T02:00:00Z");
        assert_ne!(stored_update.updated_at, "2026-11-07T02:00:00Z");

        let threads = list_threads_at(&base.0, "/repos/alpha").expect("list");
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].comments.len(), 2);
    }

    #[test]
    fn upsert_backfills_empty_comment_created_at() {
        let base = test_directory("backfill");
        let mut thread = sample_thread("t9");
        thread.comments[0].created_at = String::new();
        let stored = upsert_thread_at(&base.0, "/repos/alpha", thread).expect("insert");
        assert!(stored.comments[0].created_at.ends_with('Z'));
        assert!(!stored.comments[0].created_at.is_empty());
    }

    #[test]
    fn stores_are_isolated_per_repository() {
        let base = test_directory("isolation");
        upsert_thread_at(&base.0, "/repos/alpha", sample_thread("t1")).expect("insert alpha");
        upsert_thread_at(&base.0, "/repos/beta", sample_thread("t2")).expect("insert beta");
        let alpha = list_threads_at(&base.0, "/repos/alpha").expect("alpha");
        let beta = list_threads_at(&base.0, "/repos/beta").expect("beta");
        assert_eq!(alpha.len(), 1);
        assert_eq!(beta.len(), 1);
        assert_eq!(alpha[0].id, "t1");
        assert_eq!(beta[0].id, "t2");
    }

    #[test]
    fn delete_is_idempotent_and_scoped() {
        let base = test_directory("delete");
        upsert_thread_at(&base.0, "/repos/alpha", sample_thread("t1")).expect("insert");
        delete_thread_at(&base.0, "/repos/alpha", "t1").expect("delete");
        delete_thread_at(&base.0, "/repos/alpha", "t1").expect("delete again");
        assert!(list_threads_at(&base.0, "/repos/alpha")
            .expect("list")
            .is_empty());
        // 空 id 拒绝。
        let error = delete_thread_at(&base.0, "/repos/alpha", "").unwrap_err();
        assert_eq!(error.code, "review.invalidThread");
    }

    #[test]
    fn set_resolved_updates_flag_and_errors_when_missing() {
        let base = test_directory("resolve");
        upsert_thread_at(&base.0, "/repos/alpha", sample_thread("t1")).expect("insert");
        let updated = set_resolved_at(&base.0, "/repos/alpha", "t1", true).expect("resolve");
        assert!(updated.resolved);

        let error = set_resolved_at(&base.0, "/repos/alpha", "missing", true).unwrap_err();
        assert_eq!(error.code, "review.threadNotFound");
        assert_eq!(
            error.params.get("threadId").map(String::as_str),
            Some("missing")
        );
    }

    // ---------------------------------------------------------------- 校验

    #[test]
    fn rejects_invalid_threads_field_by_field() {
        let base = test_directory("validate");

        let mut thread = sample_thread("t1");
        thread.id = "  ".to_string();
        assert_eq!(
            upsert_thread_at(&base.0, "/repos/alpha", thread)
                .unwrap_err()
                .params["field"],
            "id"
        );

        let mut thread = sample_thread("t1");
        thread.file_path = String::new();
        assert_eq!(
            upsert_thread_at(&base.0, "/repos/alpha", thread)
                .unwrap_err()
                .params["field"],
            "filePath"
        );

        let mut thread = sample_thread("t1");
        thread.line = 0;
        assert_eq!(
            upsert_thread_at(&base.0, "/repos/alpha", thread)
                .unwrap_err()
                .params["field"],
            "line"
        );

        let mut thread = sample_thread("t1");
        thread.side = "middle".to_string();
        assert_eq!(
            upsert_thread_at(&base.0, "/repos/alpha", thread)
                .unwrap_err()
                .params["field"],
            "side"
        );

        let mut thread = sample_thread("t1");
        thread.comments.clear();
        assert_eq!(
            upsert_thread_at(&base.0, "/repos/alpha", thread)
                .unwrap_err()
                .params["field"],
            "comments"
        );

        let mut thread = sample_thread("t1");
        thread.comments[0].body = "   ".to_string();
        assert_eq!(
            upsert_thread_at(&base.0, "/repos/alpha", thread)
                .unwrap_err()
                .params["field"],
            "commentBody"
        );

        let mut thread = sample_thread("t1");
        thread.remote = Some(ReviewThreadRemote {
            provider: "gitea".to_string(),
            pull_number: 1,
            remote_id: "x".to_string(),
            web_url: None,
        });
        assert_eq!(
            upsert_thread_at(&base.0, "/repos/alpha", thread)
                .unwrap_err()
                .params["field"],
            "remote.provider"
        );
    }

    #[test]
    fn normalizes_windows_separators_and_trailing_slash() {
        let base = test_directory("normalize");
        let mut thread = sample_thread("t1");
        thread.file_path = "src\\components\\App.tsx".to_string();
        let stored = upsert_thread_at(&base.0, "/repos/alpha", thread).expect("insert");
        assert_eq!(stored.file_path, "src/components/App.tsx");
    }

    // ---------------------------------------------------------------- 存储

    #[test]
    fn corrupted_store_reports_structured_error_and_keeps_file() {
        let base = test_directory("corrupted");
        let path = store_path_at(&base.0, "/repos/alpha");
        fs::create_dir_all(path.parent().unwrap()).expect("mkdir");
        fs::write(&path, "{ not json !!").expect("write");

        let error = list_threads_at(&base.0, "/repos/alpha").unwrap_err();
        assert_eq!(error.code, "review.storeCorrupted");
        assert_eq!(error.params["path"], path.to_string_lossy());
        // 原文件保持原样，没有被清空。
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ not json !!");
    }

    #[test]
    fn unknown_future_schema_version_is_rejected() {
        let base = test_directory("future-schema");
        let path = store_path_at(&base.0, "/repos/alpha");
        fs::create_dir_all(path.parent().unwrap()).expect("mkdir");
        fs::write(&path, r#"{"schemaVersion":99,"threads":[]}"#).expect("write");
        let error = list_threads_at(&base.0, "/repos/alpha").unwrap_err();
        assert_eq!(error.code, "review.storeCorrupted");
    }

    #[test]
    fn empty_file_reads_as_default_store() {
        let base = test_directory("empty-file");
        let path = store_path_at(&base.0, "/repos/alpha");
        fs::create_dir_all(path.parent().unwrap()).expect("mkdir");
        fs::write(&path, "   \n").expect("write");
        assert!(list_threads_at(&base.0, "/repos/alpha")
            .expect("list")
            .is_empty());
    }

    #[test]
    fn unknown_fields_are_ignored_on_read() {
        let base = test_directory("unknown-fields");
        let path = store_path_at(&base.0, "/repos/alpha");
        fs::create_dir_all(path.parent().unwrap()).expect("mkdir");
        fs::write(
            &path,
            r#"{
              "schemaVersion": 1,
              "futureField": {"nested": true},
              "threads": [{
                "id": "t1", "filePath": "a.rs", "reference": "main", "line": 3,
                "side": "new", "resolved": false,
                "createdAt": "2026-11-07T00:00:00Z", "updatedAt": "2026-11-07T00:00:00Z",
                "comments": [{"id": "c1", "author": "", "body": "note", "createdAt": "2026-11-07T00:00:00Z"}],
                "remote": null, "extraThreadField": 1
              }]
            }"#,
        )
        .expect("write");
        let threads = list_threads_at(&base.0, "/repos/alpha").expect("list");
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].id, "t1");
    }

    #[test]
    fn write_is_atomic_and_leaves_no_temp_files() {
        let base = test_directory("atomic");
        // 命令包装传入的 base 已是 reviews 子目录。
        let reviews = base.0.join("reviews");
        upsert_thread_at(&reviews, "/repos/alpha", sample_thread("t1")).expect("insert");
        let entries: Vec<String> = fs::read_dir(&reviews)
            .expect("read dir")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert_eq!(entries.len(), 1, "临时文件未清理：{entries:?}");
        assert!(entries[0].ends_with(".json"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(reviews.join(&entries[0]))
                .expect("stat")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn stored_json_uses_camel_case_and_schema_version() {
        let base = test_directory("camel-case");
        upsert_thread_at(&base.0, "/repos/alpha", sample_thread("t1")).expect("insert");
        let path = store_path_at(&base.0, "/repos/alpha");
        let raw = fs::read_to_string(&path).expect("read");
        assert!(raw.contains("\"schemaVersion\": 1"));
        assert!(raw.contains("\"filePath\": \"src/main.rs\""));
        assert!(raw.contains("\"createdAt\":"));
        // remote 为 null 时不应出现 pullNumber 键。
        assert!(!raw.contains("\"pullNumber\""));
        let parsed: Value = serde_json::from_str(&raw).expect("parse");
        assert!(parsed["threads"][0]["comments"][0]["body"].is_string());
    }
}
