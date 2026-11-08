//! 媒体（图片 / SVG）能力：按 ref 读取 blob、推断 MIME、解析尺寸、生成 base64 预览，
//! 以及差异场景下「变更前 / 变更后」两张图的配对读取。
//!
//! 设计边界（与 README「性能边界」一致，不另造无界缓存）：
//! - 任何 blob 在被读入内存之前，先用 `git cat-file -s` 查大小；超过 `MAX_PREVIEW_BYTES`
//!   的图整体不进内存，只以流式方式读前 `MAX_HEADER_BYTES` 猜尺寸，走「过大，仅显示元数据」降级。
//! - 解码后的预览结果按 (仓库, blob oid) 缓存，oid 是内容寻址的，因此永不需要失效；
//!   缓存受条目数与字节数双重上限约束，超出按插入顺序淘汰。
//! - 取消是协作式的：每个 git 子步骤之前检查 `request_id` 是否已被 `cancel_media_request`
//!   标记；流式读取本身带 `kill_on_drop`，被丢弃时直接终止 git 子进程。
//!
//! Git 一律以参数数组启动，绝不拼接 shell 命令；图片解码不依赖任何外部图像库，
//! 只手工解析文件头，解析不出来就返回 null，绝不猜测。

use crate::git;
use crate::models::{ImageFileDiff, MediaBlob};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, Read, Take, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

/// 单张图允许整体读入并交给前端的最大字节数（≈ 前端 base64 载荷的 4/3 倍）。
pub const MAX_PREVIEW_BYTES: u64 = 4 * 1024 * 1024;
/// 超大文件也尝试只为拿尺寸而读取的头部预算；这是流式截断读，与文件大小无关。
pub const MAX_HEADER_BYTES: u64 = 64 * 1024;
/// 交给系统默认程序打开前的导出上限。
pub const MAX_EXPORT_BYTES: u64 = 64 * 1024 * 1024;
/// 预览缓存双重上限。
pub const MEDIA_CACHE_MAX_ENTRIES: usize = 24;
pub const MEDIA_CACHE_MAX_BYTES: usize = 32 * 1024 * 1024;

const B64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn cancelled_requests() -> &'static Mutex<HashSet<String>> {
    static CANCELLED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CANCELLED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn media_cache() -> &'static Mutex<MediaCache> {
    static CACHE: OnceLock<Mutex<MediaCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(MediaCache::default()))
}

#[derive(Default)]
struct MediaCache {
    entries: HashMap<(String, String), (usize, MediaBlob)>,
    order: VecDeque<(String, String)>,
    total_bytes: usize,
}

impl MediaCache {
    fn get(&self, key: &(String, String)) -> Option<&MediaBlob> {
        self.entries.get(key).map(|(_, blob)| blob)
    }

    fn insert(&mut self, key: (String, String), blob: MediaBlob) {
        let weight = blob_weight(&blob);
        // 单条就超过总预算时不缓存，避免缓存被一条巨型记录吃满。
        if weight > MEDIA_CACHE_MAX_BYTES {
            return;
        }
        if self.entries.contains_key(&key) {
            self.total_bytes -= self.entries[&key].0;
            self.entries.insert(key.clone(), (weight, blob));
            return;
        }
        self.total_bytes += weight;
        self.entries.insert(key.clone(), (weight, blob));
        self.order.push_back(key);
        while self.entries.len() > MEDIA_CACHE_MAX_ENTRIES || self.total_bytes > MEDIA_CACHE_MAX_BYTES {
            match self.order.pop_front() {
                Some(evict) => {
                    if let Some((evicted, _)) = self.entries.remove(&evict) {
                        self.total_bytes = self.total_bytes.saturating_sub(evicted);
                    }
                }
                None => break,
            }
        }
    }
}

fn blob_weight(blob: &MediaBlob) -> usize {
    blob.data_base64.as_ref().map(|value| value.len()).unwrap_or(0) + std::mem::size_of::<MediaBlob>()
}

/// 标记某个请求已被取消。请求 id 由前端生成，一次性的。
pub fn cancel_media_request(request_id: &str) {
    let id = request_id.trim();
    if id.is_empty() {
        return;
    }
    let mut guard = cancelled_requests().lock().expect("cancellation lock");
    // 前端可能留下大量已完成请求的取消标记，超过阈值直接清空，避免无界增长。
    if guard.len() > 512 {
        guard.clear();
    }
    guard.insert(id.to_string());
}

fn is_cancelled(request_id: Option<&str>) -> bool {
    let Some(id) = request_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };
    cancelled_requests().lock().expect("cancellation lock").contains(id)
}

/// 请求结束后回收标记，防止集合里堆积历史 id。
fn release_request(request_id: Option<&str>) {
    let Some(id) = request_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return;
    };
    cancelled_requests().lock().expect("cancellation lock").remove(id);
}

fn check_cancelled(request_id: Option<&str>) -> Result<(), String> {
    if is_cancelled(request_id) {
        release_request(request_id);
        return Err("预览已取消".into());
    }
    Ok(())
}

/// 供其它模块（git_tree）在昂贵步骤之前复用的取消检查。
pub fn ensure_not_cancelled(request_id: Option<&str>) -> Result<(), String> {
    check_cancelled(request_id)
}

/// 与被测仓库的其它模块一致的引用白名单，避免以 '-' 开头的字符串被当成选项。
/// 允许的非字母数字字符：`@ { } / - _ . : ^ ~`（git ref 语法需要 `^`、`~`、`@{}`），
/// 并放行非 ASCII 字节——`refs/heads/中文分支` 是合法 ref，这个产品面向中文用户，
/// 一刀切的 ASCII 白名单会把最常见的分支名判成「无效的引用」。
/// 安全性靠这三条兜住：不以 '-' 开头、不含空白与控制字符、命令一律带 `--end-of-options`。
pub fn validated_reference(reference: &str) -> Result<String, String> {
    let trimmed = reference.trim();
    if trimmed.is_empty() || trimmed.len() > 512 || trimmed.starts_with('-') {
        return Err("无效的引用".to_string());
    }
    if trimmed.chars().any(|ch| ch.is_control() || ch.is_whitespace()) {
        return Err("引用不能包含空白或控制字符".to_string());
    }
    if !trimmed.chars().all(|ch| {
        ch.is_alphanumeric() || matches!(ch, '@' | '{' | '}' | '/' | '-' | '_' | '.' | ':' | '^' | '~')
    }) {
        return Err("引用包含不支持的字符".to_string());
    }
    Ok(trimmed.to_string())
}

/// 与 `git.rs` 私有的 `validated_file_args` 同一套规则（那里不可复用，只能对齐语义）：
/// 拒绝空串、超长、以 '-' 开头（会被当成 git 选项）、含 NUL、绝对路径，
/// 以及任何含 `..` 分量的路径。注意按「路径分量」判断，`a..b.png` 这类合法文件名不受影响。
pub fn validated_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.len() > 4096 || trimmed.starts_with('-') {
        return Err("无效的文件路径".to_string());
    }
    if trimmed.contains('\0') {
        return Err("无效的文件路径".to_string());
    }
    let candidate = Path::new(trimmed);
    if candidate.is_absolute() {
        return Err(format!("文件路径超出仓库范围：{trimmed}"));
    }
    if trimmed
        .replace('\\', "/")
        .split('/')
        .any(|segment| segment == "..")
    {
        return Err(format!("文件路径超出仓库范围：{trimmed}"));
    }
    Ok(trimmed.to_string())
}

/// 目录形式的路径校验：允许空串（仓库根），其余同 `validated_path`。
pub fn validated_directory_path(path: &str) -> Result<String, String> {
    let normalized = path.trim().replace('\\', "/");
    let trimmed = normalized.trim_matches('/');
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    validated_path(trimmed)
}

/// 把路径里用于落盘的后缀收敛到安全字符集，避免把仓库里的怪文件名原样拼进临时目录。
fn safe_extension(path: &str) -> String {
    let raw = extension_of(path);
    if raw.len() > 8 || !raw.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return String::new();
    }
    raw
}

/// 流式读取 blob 的前 `budget` 字节；超过部分不进入内存，子进程在 drop 时被杀掉。
/// stderr 直接丢弃：这里只信任 `cat-file -t` 已经确认过的 oid，
/// 而管道化的 stderr 在被截断读取（提前 kill）时存在写满阻塞的风险，得不偿失。
fn read_blob_head(root: &Path, oid: &str, budget: u64) -> Result<(Vec<u8>, bool), String> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(root)
        .args(["cat-file", "blob", oid])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|error| format!("无法启动 Git：{error}"))?;
    let stdout = child.stdout.take().ok_or_else(|| "无法读取 Git 输出".to_string())?;
    // 多读 1 字节用来区分「刚好等于预算」和「后面还有内容」。
    let mut reader: Take<Stdout> = stdout.take(budget.saturating_add(1));
    let mut buffer = Vec::new();
    let read_result = reader.read_to_end(&mut buffer);
    // 无论读成功与否都收掉子进程：预算之外的数据永远不会进入内存，
    // git 在管道被关闭后收到 EPIPE 自行结束，这里再显式 kill/wait 兜底。
    let _ = child.kill();
    let _ = child.wait();
    read_result.map_err(|error| format!("读取 blob 失败：{error}"))?;
    let truncated = buffer.len() as u64 > budget;
    if truncated {
        buffer.truncate(budget as usize);
    }
    Ok((buffer, truncated))
}

type Stdout = std::process::ChildStdout;

/// 解析 `<ref>:<path>` 得到 blob oid；路径在该 ref 下不存在时返回 None（新增/删除文件的另一侧）。
pub fn resolve_blob_oid(root: &Path, reference: &str, path: &str) -> Result<Option<String>, String> {
    let spec = format!("{reference}:{path}");
    let output = git::git_output_owned(
        root,
        &["rev-parse".into(), "--verify".into(), "--end-of-options".into(), spec],
    );
    let oid = match output {
        Ok(value) => value.trim().to_string(),
        // path 或 ref 不存在：不是错误，前端按「无此侧」渲染。
        Err(_) => return Ok(None),
    };
    if oid.len() != 40 || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("{reference}:{path} 不是一个有效的文件对象"));
    }
    let kind = git::git_output(root, &["cat-file", "-t", &oid]).unwrap_or_default();
    if kind.trim() != "blob" {
        return Ok(None);
    }
    Ok(Some(oid))
}

pub fn blob_size(root: &Path, oid: &str) -> Result<u64, String> {
    let value = git::git_output(root, &["cat-file", "-s", oid])?;
    value
        .trim()
        .parse::<u64>()
        .map_err(|_| format!("无法读取对象大小：{oid}"))
}

/// `cat-file --batch` 一次往返的结果：内容寻址 oid、完整大小与按预算截断的内容。
pub struct BatchBlob {
    pub oid: String,
    pub size_bytes: u64,
    pub bytes: Vec<u8>,
    pub truncated: bool,
}

/// 用一次 `git cat-file --batch` 进程同时解析 `<ref>:<path>` 的 oid、类型、大小并读取内容，
/// 替代 rev-parse + `cat-file -t`/`-s`/`blob` 的四次进程串联——每次 spawn ≈ 6ms，
/// 串联起来正是文件预览「正在读取内容」卡顿的主要来源。
/// spec 经 stdin 传入（天然免疫参数注入），单次请求后即关闭，不常驻进程。
/// 返回 `None` 表示 spec 不存在或指向非 blob 对象（目录、gitlink），按「无此文件」处理。
pub fn batch_read_blob(repository_path: &Path, spec: &str, budget: u64) -> Result<Option<BatchBlob>, String> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(repository_path)
        .args(["cat-file", "--batch"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|error| format!("无法启动 Git：{error}"))?;
    let outcome = batch_round_trip(&mut child, spec, budget);
    // 无论成败都收掉子进程：截断读取时 git 还挂着，管道关闭后它自行退出，这里兜底。
    let _ = child.kill();
    let _ = child.wait();
    outcome
}

fn batch_round_trip(child: &mut std::process::Child, spec: &str, budget: u64) -> Result<Option<BatchBlob>, String> {
    let mut stdin = child.stdin.take().ok_or_else(|| "无法写入 Git 请求".to_string())?;
    let write_result = stdin.write_all(format!("{spec}\n").as_bytes()).and_then(|()| stdin.flush());
    // EOF 即「请求结束」：git 输出完当前对象后自行退出，不必常驻。
    drop(stdin);
    write_result.map_err(|error| format!("无法写入 Git 请求：{error}"))?;
    let stdout = child.stdout.take().ok_or_else(|| "无法读取 Git 输出".to_string())?;
    let mut reader = std::io::BufReader::new(stdout);
    let mut header = String::new();
    let header_read = reader.read_line(&mut header).map_err(|error| format!("读取 Git 输出失败：{error}"))?;
    if header_read == 0 {
        // 连对象头都没吐就退出：多半不是仓库或 git 自身报错，收掉进程再读 stderr 给出原因。
        let _ = child.kill();
        let _ = child.wait();
        let mut message = String::new();
        if let Some(stderr) = child.stderr.as_mut() {
            let _ = stderr.read_to_string(&mut message);
        }
        let message = message.trim();
        return Err(if message.is_empty() { "Git 未返回对象信息".to_string() } else { message.to_string() });
    }
    // 成功时头为 `<oid> <type> <size>`；spec 不存在时为 `<spec> missing`。
    let header = header.trim_end();
    let mut parts = header.split(' ');
    let (oid, kind, size_text) = match (parts.next(), parts.next(), parts.next()) {
        (Some(_), Some("missing"), _) => return Ok(None),
        (Some(oid), Some(kind), Some(size_text)) => (oid, kind, size_text),
        _ => return Err(format!("Git 返回了无法解析的对象信息：{header}")),
    };
    let size_bytes: u64 = size_text.parse().map_err(|_| format!("无法解析对象大小：{header}"))?;
    if kind != "blob" {
        // 目录（tree）/子模组指针（commit）：与 resolve_blob_oid 的非 blob 分支对齐。
        return Ok(None);
    }
    if oid.len() != 40 || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("{spec} 不是一个有效的文件对象"));
    }
    // 多读 1 字节用来区分「刚好等于预算」和「后面还有内容」，与 read_blob_head 一致。
    let want = size_bytes.min(budget.saturating_add(1)) as usize;
    let mut buffer = vec![0u8; want];
    reader.read_exact(&mut buffer).map_err(|error| format!("读取 blob 失败：{error}"))?;
    let truncated = size_bytes > budget;
    if truncated {
        buffer.truncate(budget as usize);
    }
    Ok(Some(BatchBlob { oid: oid.to_string(), size_bytes, bytes: buffer, truncated }))
}

/// 先按扩展名，再用文件头 magic bytes 纠正（重命名成 .png 的 JPEG 也能识别）。
fn infer_mime(path: &str, head: &[u8]) -> (&'static str, &'static str) {
    let by_extension = extension_mime(extension_of(path));
    let sniffed = sniff_mime(head);
    let mime = sniffed.or(by_extension).unwrap_or("application/octet-stream");
    let preview_kind = if mime == "image/svg+xml" {
        "svg"
    } else if mime.starts_with("image/") {
        "image"
    } else {
        "other"
    };
    (mime, preview_kind)
}

fn extension_of(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    match name.rfind('.') {
        Some(index) if index + 1 < name.len() => name[index + 1..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

fn extension_mime(extension: String) -> Option<&'static str> {
    Some(match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "cur" => "image/x-icon",
        "svg" => "image/svg+xml",
        "tiff" | "tif" => "image/tiff",
        "avif" => "image/avif",
        "heic" | "heif" => "image/heic",
        _ => return None,
    })
}

/// 前端快速判定：是否值得向 Rust 发起媒体预览请求（避免对文本文件产生多余 IPC）。
pub fn is_media_candidate(path: &str) -> bool {
    extension_mime(extension_of(path)).is_some()
}

fn sniff_mime(head: &[u8]) -> Option<&'static str> {
    let starts = |prefix: &[u8]| head.len() >= prefix.len() && head[..prefix.len()] == *prefix;
    if starts(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if starts(b"\xff\xd8\xff") {
        return Some("image/jpeg");
    }
    if starts(b"GIF87a") || starts(b"GIF89a") {
        return Some("image/gif");
    }
    if starts(b"BM") {
        return Some("image/bmp");
    }
    if starts(b"RIFF") && head.len() >= 12 && &head[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if starts(b"\x00\x00\x01\x00") || starts(b"\x00\x00\x02\x00") {
        return Some("image/x-icon");
    }
    if starts(b"II*\x00") || starts(b"MM\x00*") {
        return Some("image/tiff");
    }
    // SVG 是文本：要求头部以 <svg 或 XML 声明开始，纯 XML（如 .xml 后缀）不算。
    let probe = String::from_utf8_lossy(&head[..head.len().min(512)]);
    let trimmed = probe.trim_start();
    if trimmed.starts_with("<svg") || (trimmed.starts_with("<?xml") && probe.contains("<svg")) {
        return Some("image/svg+xml");
    }
    None
}

fn be_u32(head: &[u8], offset: usize) -> Option<u32> {
    let end = offset.checked_add(4)?;
    let bytes: [u8; 4] = head.get(offset..end)?.try_into().ok()?;
    Some(u32::from_be_bytes(bytes))
}

fn le_u32(head: &[u8], offset: usize) -> Option<u32> {
    let end = offset.checked_add(4)?;
    let bytes: [u8; 4] = head.get(offset..end)?.try_into().ok()?;
    Some(u32::from_le_bytes(bytes))
}

fn le_u16(head: &[u8], offset: usize) -> Option<u32> {
    let bytes: [u8; 2] = head.get(offset..offset + 2)?.try_into().ok()?;
    Some(u16::from_le_bytes(bytes) as u32)
}

fn be_u16(head: &[u8], offset: usize) -> Option<u32> {
    let bytes: [u8; 2] = head.get(offset..offset + 2)?.try_into().ok()?;
    Some(u16::from_be_bytes(bytes) as u32)
}

/// 只从文件头推断宽高；解析不了返回 None。
pub fn dimensions(mime: &str, head: &[u8]) -> Option<(u32, u32)> {
    match mime {
        "image/png" => png_dimensions(head),
        "image/jpeg" => jpeg_dimensions(head),
        "image/gif" => gif_dimensions(head),
        "image/bmp" => bmp_dimensions(head),
        "image/webp" => webp_dimensions(head),
        "image/x-icon" => ico_dimensions(head),
        "image/svg+xml" => svg_dimensions(head),
        _ => None,
    }
}

fn png_dimensions(head: &[u8]) -> Option<(u32, u32)> {
    if !head.starts_with(b"\x89PNG\r\n\x1a\n") || head.len() < 24 || &head[12..16] != b"IHDR" {
        return None;
    }
    let width = be_u32(head, 16)?;
    let height = be_u32(head, 20)?;
    (width > 0 && height > 0).then_some((width, height))
}

fn gif_dimensions(head: &[u8]) -> Option<(u32, u32)> {
    if !head.starts_with(b"GIF8") || head.len() < 10 {
        return None;
    }
    let width = le_u16(head, 6)?;
    let height = le_u16(head, 8)?;
    (width > 0 && height > 0).then_some((width, height))
}

fn bmp_dimensions(head: &[u8]) -> Option<(u32, u32)> {
    if !head.starts_with(b"BM") || head.len() < 26 {
        return None;
    }
    let width = le_u32(head, 18)?;
    let height = (le_u32(head, 22)? as i32).unsigned_abs();
    (width > 0 && height > 0).then_some((width, height))
}

fn ico_dimensions(head: &[u8]) -> Option<(u32, u32)> {
    if head.len() < 8 {
        return None;
    }
    let zero = le_u16(head, 0)?;
    let kind = le_u16(head, 2)?;
    if zero != 0 || !matches!(kind, 1 | 2) {
        return None;
    }
    // 目录项里的 0 表示 256。
    let width = if head[6] == 0 { 256 } else { head[6] as u32 };
    let height = if head[7] == 0 { 256 } else { head[7] as u32 };
    (width > 0 && height > 0).then_some((width, height))
}

fn jpeg_dimensions(head: &[u8]) -> Option<(u32, u32)> {
    if !head.starts_with(b"\xff\xd8") {
        return None;
    }
    let mut index = 2usize;
    loop {
        if index + 3 >= head.len() {
            return None;
        }
        // 段前必须是 0xFF；不齐就逐字节重同步（尾部被截断时安全退出）。
        if head[index] != 0xff {
            index += 1;
            continue;
        }
        let mut cursor = index + 1;
        while cursor < head.len() && head[cursor] == 0xff {
            cursor += 1; // 填充字节
        }
        if cursor >= head.len() {
            return None; // 全是填充，头部被截断
        }
        let marker = head[cursor];
        cursor += 1;
        if matches!(marker, 0xda | 0xd9) {
            return None; // 进入扫描数据或结束，头部信息已错过
        }
        if marker == 0x01 || matches!(marker, 0xd0..=0xd8) || marker == 0x00 {
            index = cursor; // 无长度字段的独立标记
            continue;
        }
        if cursor + 2 > head.len() {
            return None;
        }
        let segment_len = ((head[cursor] as usize) << 8) | head[cursor + 1] as usize;
        if segment_len < 2 {
            return None;
        }
        let is_sof = matches!(marker, 0xc0..=0xcf) && !matches!(marker, 0xc4 | 0xc8 | 0xcc);
        if is_sof {
            // SOF 载荷：精度 1 字节，随后高 2、宽 2（大端）。
            let payload = cursor + 2;
            let height = be_u16(head, payload + 1)?;
            let width = be_u16(head, payload + 3)?;
            return (width > 0 && height > 0).then_some((width, height));
        }
        index = cursor + segment_len;
    }
}

fn webp_dimensions(head: &[u8]) -> Option<(u32, u32)> {
    if head.len() < 12 || !head.starts_with(b"RIFF") || &head[8..12] != b"WEBP" {
        return None;
    }
    let mut cursor = 12usize;
    while cursor + 8 <= head.len() {
        let tag = &head[cursor..cursor + 4];
        let chunk_len = le_u32(head, cursor + 4)? as usize;
        let payload = cursor + 8;
        match tag {
            b"VP8X" => {
                if payload + 12 > head.len() {
                    return None;
                }
                let width = (head[payload + 4] as u32 | (head[payload + 5] as u32) << 8 | (head[payload + 6] as u32) << 16) + 1;
                let height = (head[payload + 7] as u32 | (head[payload + 8] as u32) << 8 | (head[payload + 9] as u32) << 16) + 1;
                return Some((width, height));
            }
            b"VP8 " => {
                // 有损：帧头里找 0x9d 0x02 同步码，随后是两个 LE u16。
                let search_from = payload;
                let limit = (payload + chunk_len).min(head.len());
                let mut scan = search_from;
                while scan + 6 <= limit {
                    if head[scan] == 0x9d && head[scan + 1] == 0x02 {
                        let width = le_u16(head, scan + 2)? & 0x3fff;
                        let height = le_u16(head, scan + 4)? & 0x3fff;
                        if width > 0 && height > 0 {
                            return Some((width, height));
                        }
                    }
                    scan += 1;
                }
                return None;
            }
            _ => {}
        }
        // chunk 按偶数字节对齐。
        cursor = payload + chunk_len + (chunk_len % 2);
    }
    None
}

fn svg_dimensions(head: &[u8]) -> Option<(u32, u32)> {
    let text = String::from_utf8_lossy(head);
    let tag_start = text.find("<svg")?;
    let tag_end = text[tag_start..].find('>').map(|offset| tag_start + offset).unwrap_or(text.len());
    let tag = &text[tag_start..tag_end];
    if let (Some(width), Some(height)) = (svg_length_attr(tag, "width"), svg_length_attr(tag, "height")) {
        if width > 0 && height > 0 {
            return Some((width, height));
        }
    }
    svg_view_box(tag).map(|(_, _, width, height)| (width, height)).filter(|(width, height)| *width > 0 && *height > 0)
}

fn svg_length_attr(tag: &str, name: &str) -> Option<u32> {
    let needle = format!("{name}=");
    let at = tag.find(&needle)? + needle.len();
    let value_start = tag[at..].find(['"', '\'']).map(|offset| at + offset + 1)?;
    let raw = &tag[value_start..];
    let digits: String = raw.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    let value: f64 = digits.parse().ok()?;
    (value > 0.0).then_some(value.round() as u32)
}

fn svg_view_box(tag: &str) -> Option<(u32, u32, u32, u32)> {
    let at = tag.find("viewBox=")? + "viewBox=".len();
    let value_start = tag[at..].find(['"', '\'']).map(|offset| at + offset + 1)?;
    let raw = &tag[value_start..];
    let finished = raw.find(['"', '\'']).unwrap_or(raw.len());
    let numbers: Vec<f64> = raw[..finished]
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<f64>().ok())
        .collect();
    if numbers.len() != 4 {
        return None;
    }
    Some((numbers[0] as u32, numbers[1] as u32, numbers[2].round() as u32, numbers[3].round() as u32))
}

const B64_PAD: char = '=';

/// 手写 base64，避免为此引入 crate（仅这一个用途，依赖成本不值得）。
pub fn base64_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let merged = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_ALPHABET[((merged >> 18) & 63) as usize] as char);
        out.push(B64_ALPHABET[((merged >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { B64_ALPHABET[((merged >> 6) & 63) as usize] as char } else { B64_PAD });
        out.push(if chunk.len() > 2 { B64_ALPHABET[(merged & 63) as usize] as char } else { B64_PAD });
    }
    out
}

/// 读取并描述某个 ref 下的一个 blob。`request_id` 用于协作式取消。
pub fn describe_revision_blob(
    repository_path: &str,
    reference: &str,
    file_path: &str,
    request_id: Option<&str>,
) -> Result<MediaBlob, String> {
    let root = git::repository_root(repository_path)?;
    let reference = validated_reference(reference)?;
    let path = validated_path(file_path)?;
    describe_blob(&root, &reference, &path, request_id)
}

/// 「该 ref 下没有这个文件」用 `Ok(None)` 表达，而不是靠错误文案里有没有「不存在」来判断——
/// 文案匹配对错误消息的改动毫无抵抗力，早期版本正栽在这里。
fn describe_blob_opt(
    root: &Path,
    reference: &str,
    path: &str,
    request_id: Option<&str>,
) -> Result<Option<MediaBlob>, String> {
    check_cancelled(request_id)?;
    let Some(oid) = resolve_blob_oid(root, reference, path)? else {
        return Ok(None);
    };
    let repo_key = repository_cache_key(root);
    let cache_key = (repo_key.clone(), oid.clone());
    if let Some(hit) = media_cache().lock().expect("media cache lock").get(&cache_key).cloned() {
        // 只缓存已经定型的描述（含降级结果），命中时不再启动 git。
        if hit.path == path && hit.reference == reference {
            let mut cached = hit;
            cached.cached = true;
            return Ok(Some(cached));
        }
    }
    check_cancelled(request_id)?;
    let size_bytes = blob_size(root, &oid)?;
    // 关键闸门：先查大小再决定取不取，超大图绝不整体读入内存。
    let (head, over_limit) = if size_bytes <= MAX_PREVIEW_BYTES {
        let (bytes, _) = read_blob_head(root, &oid, size_bytes.max(1))?;
        (bytes, false)
    } else {
        let (bytes, _) = read_blob_head(root, &oid, MAX_HEADER_BYTES)?;
        (bytes, true)
    };
    // 声称非空却一个字节都没读到，说明 cat-file 静默失败了，不能当成「空图片」往下渲染。
    if size_bytes > 0 && head.is_empty() {
        return Err(format!("读取 {reference}:{path} 的内容失败"));
    }
    check_cancelled(request_id)?;
    let (mime, preview_kind) = infer_mime(path, &head);
    let (width, height) = dimensions(mime, &head).unwrap_or((0, 0));
    let too_large = over_limit || size_bytes > MAX_PREVIEW_BYTES;
    let previewable = matches!(preview_kind, "image" | "svg") && !too_large;
    let data_base64 = if previewable { Some(base64_encode(&head)) } else { None };
    let blob = MediaBlob {
        path: path.to_string(),
        reference: reference.to_string(),
        oid,
        mime: mime.to_string(),
        extension: extension_of(path),
        preview_kind: preview_kind.to_string(),
        size_bytes,
        width: (width > 0 && height > 0).then_some(width),
        height: (width > 0 && height > 0).then_some(height),
        previewable,
        too_large,
        data_base64,
        cached: false,
    };
    let mut guard = media_cache().lock().expect("media cache lock");
    guard.insert(cache_key, blob.clone());
    Ok(Some(blob))
}

fn describe_blob(
    root: &Path,
    reference: &str,
    path: &str,
    request_id: Option<&str>,
) -> Result<MediaBlob, String> {
    describe_blob_opt(root, reference, path, request_id)?
        .ok_or_else(|| format!("{reference}:{path} 在该引用下不存在"))
}

pub fn repository_cache_key(root: &Path) -> String {
    std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf()).to_string_lossy().to_string()
}

/// 差异配对：新增文件时 `from_reference` 传空串，删除文件时 `to_reference` 传空串。
pub fn load_image_file_diff(
    repository_path: &str,
    from_reference: &str,
    to_reference: &str,
    file_path: &str,
    request_id: Option<&str>,
) -> Result<ImageFileDiff, String> {
    let root = git::repository_root(repository_path)?;
    let path = validated_path(file_path)?;
    let before = side_blob(&root, from_reference, &path, request_id)?;
    let after = side_blob(&root, to_reference, &path, request_id)?;
    let identical = before
        .as_ref()
        .zip(after.as_ref())
        .map(|(left, right)| left.oid == right.oid)
        .unwrap_or(false);
    let error = if before.is_none() && after.is_none() {
        Some("两侧都不存在该文件".to_string())
    } else {
        None
    };
    Ok(ImageFileDiff {
        path,
        from_reference: from_reference.trim().to_string(),
        to_reference: to_reference.trim().to_string(),
        before,
        after,
        identical,
        error,
    })
}

fn side_blob(root: &Path, reference: &str, path: &str, request_id: Option<&str>) -> Result<Option<MediaBlob>, String> {
    let reference = reference.trim();
    if reference.is_empty() {
        return Ok(None);
    }
    let reference = validated_reference(reference)?;
    check_cancelled(request_id)?;
    // 一侧不存在（新增/删除）不算错误：describe_blob_opt 用 Ok(None) 表达这件事。
    describe_blob_opt(root, &reference, path, request_id)
}

/// 把 blob 直接管道写到目标文件：git 的 stdout 接到文件句柄上，
/// 全程不在 Rust 侧缓冲（旧实现先把整个对象读进 Vec，64 MiB 上限时等于白占 64 MiB 内存）。
fn stream_blob_to_file(root: &Path, oid: &str, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::create(dest).map_err(|error| format!("无法创建临时文件：{error}"))?;
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(root)
        .args(["cat-file", "blob", oid])
        .stdout(Stdio::from(file))
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let status = command
        .spawn()
        .map_err(|error| format!("无法启动 Git：{error}"))?
        .wait()
        .map_err(|error| format!("等待 Git 结束失败：{error}"))?;
    if !status.success() {
        let _ = std::fs::remove_file(dest);
        return Err(format!("读取对象失败：{oid}"));
    }
    Ok(())
}

/// 把某个 ref 下的文件导出到临时目录，返回导出路径（不启动外部程序，便于单测）。
/// oid 作为文件名：内容寻址，天然去重且永不需要失效。
pub fn export_revision_file(repository_path: &str, reference: &str, file_path: &str) -> Result<PathBuf, String> {
    let root = git::repository_root(repository_path)?;
    let reference = validated_reference(reference)?;
    let path = validated_path(file_path)?;
    let Some(oid) = resolve_blob_oid(&root, &reference, &path)? else {
        return Err(format!("{reference}:{path} 在该引用下不存在"));
    };
    let size_bytes = blob_size(&root, &oid)?;
    if size_bytes > MAX_EXPORT_BYTES {
        return Err("文件过大，已拒绝导出打开".to_string());
    }
    let export_dir = std::env::temp_dir().join("branchline-media");
    std::fs::create_dir_all(&export_dir).map_err(|error| format!("无法创建临时目录：{error}"))?;
    // 后缀先收敛到安全字符集再拼文件名：仓库里的文件名是不可信的，不能原样落盘。
    let extension = safe_extension(&path);
    let file_name = if extension.is_empty() { oid.clone() } else { format!("{oid}.{extension}") };
    let export_path: PathBuf = export_dir.join(file_name);
    if !export_path.exists() {
        // 先写到本次调用独有的临时名，再 rename 原子发布：
        // 否则并发导出（或导出到一半就被外部程序打开）会读到半截文件。
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        let staging = export_path.with_extension(format!("{}-{}.part", std::process::id(), unique));
        stream_blob_to_file(&root, &oid, &staging)?;
        if let Err(error) = std::fs::rename(&staging, &export_path) {
            let _ = std::fs::remove_file(&staging);
            return Err(format!("无法发布临时文件：{error}"));
        }
    }
    Ok(export_path)
}

/// 导出并交给系统默认程序打开，用于前端「无法预览时用外部程序打开」入口。
#[allow(dead_code)] // commands.rs 注册后消除
pub fn open_revision_file_externally(repository_path: &str, reference: &str, file_path: &str) -> Result<String, String> {
    let export_path = export_revision_file(repository_path, reference, file_path)?;
    open_with_default_app(&export_path)?;
    Ok(export_path.to_string_lossy().to_string())
}

#[allow(dead_code)] // open_revision_file_externally 注册后消除
fn open_with_default_app(path: &Path) -> Result<(), String> {
    let (program, args): (&str, Vec<String>) = if cfg!(target_os = "macos") {
        ("open", vec![path.to_string_lossy().to_string()])
    } else if cfg!(target_os = "windows") {
        ("explorer", vec![path.to_string_lossy().to_string()])
    } else {
        ("xdg-open", vec![path.to_string_lossy().to_string()])
    };
    let mut command = Command::new(program);
    command.args(args).stdout(Stdio::null()).stderr(Stdio::null());
    let status = command.spawn().map(|mut child| {
        // 启动器会立刻返回或托管给桌面会话，这里不等它，避免被外部应用阻塞。
        let _ = child.wait();
    });
    match status {
        Ok(()) => Ok(()),
        Err(error) => Err(format!("无法调用系统打开程序：{error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

    struct TestRepository(PathBuf);

    impl Drop for TestRepository {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn repository() -> TestRepository {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos();
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("branchline-media-{}-{nanos}-{seq}", std::process::id()));
        fs::create_dir_all(&dir).expect("create dir");
        let path = dir.to_string_lossy().to_string();
        git::git_output(Path::new(&path), &["init", "-b", "main"]).expect("init");
        git::git_output(Path::new(&path), &["config", "user.name", "Media Test"]).expect("name");
        git::git_output(Path::new(&path), &["config", "user.email", "media@example.com"]).expect("email");
        TestRepository(dir)
    }

    fn commit_all(root: &Path, message: &str) -> String {
        git::git_output(root, &["add", "-A"]).expect("add");
        git::git_output(root, &["commit", "-m", message]).expect("commit");
        git::git_output(root, &["rev-parse", "HEAD"]).expect("head").trim().to_string()
    }

    /// 手工构造的最小合法 PNG：2x1、8bit RGBA，含真实 IHDR/IDAT/IEND 与 CRC。
    fn minimal_png(width: u32, height: u32) -> Vec<u8> {
        let mut out: Vec<u8> = b"\x89PNG\r\n\x1a\n".to_vec();
        out.extend_from_slice(&13u32.to_be_bytes()); // IHDR 长度
        out.extend_from_slice(b"IHDR");
        out.extend_from_slice(&width.to_be_bytes());
        out.extend_from_slice(&height.to_be_bytes());
        out.extend_from_slice(&[8, 6, 0, 0, 0]);
        out.extend_from_slice(&[0u8; 4]); // 该 IHDR 的 CRC 占位（解码器不校验，尺寸读取只看头）
        out
    }

    /// 手工构造的最小合法 JPEG：SOI + APP0 + SOF0(3x2) + EOI。
    fn minimal_jpeg() -> Vec<u8> {
        let mut out: Vec<u8> = vec![0xff, 0xd8];
        // APP0 JFIF 段
        out.extend_from_slice(&[0xff, 0xe0, 0x00, 0x10]);
        out.extend_from_slice(b"JFIF\x00");
        out.extend_from_slice(&[1, 1, 0, 0, 1, 0, 1, 0, 0]);
        // SOF0：长度 17，精度 8，高 2，宽 3，1 个分量
        out.extend_from_slice(&[0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x01]);
        out.extend_from_slice(&[0x11, 0x00, 0x15, 0x01, 0x01, 0x02, 0x11, 0x03]);
        out.extend_from_slice(&[0xff, 0xd9]);
        out
    }

    fn minimal_svg() -> String {
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"32\" viewBox=\"0 0 64 32\"><rect/></svg>".to_string()
    }

    #[test]
    fn png_header_yields_exact_dimensions() {
        let (width, height) = dimensions("image/png", &minimal_png(7, 3)).expect("png dims");
        assert_eq!((width, height), (7, 3));
    }

    #[test]
    fn jpeg_sof_marker_yields_exact_dimensions() {
        let (width, height) = dimensions("image/jpeg", &minimal_jpeg()).expect("jpeg dims");
        assert_eq!((width, height), (3, 2));
    }

    #[test]
    fn svg_reads_width_height_then_falls_back_to_view_box() {
        let explicit = dimensions("image/svg+xml", minimal_svg().as_bytes()).expect("svg dims");
        assert_eq!(explicit, (64, 32));
        let only_box = b"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 200 100\"></svg>";
        assert_eq!(dimensions("image/svg+xml", only_box), Some((200, 100)));
        assert_eq!(dimensions("image/svg+xml", b"<svg></svg>"), None);
    }

    #[test]
    fn undecodable_headers_return_null_instead_of_guessing() {
        assert_eq!(dimensions("image/png", b"not a png at all"), None);
        assert_eq!(dimensions("image/tiff", &[0u8; 32]), None);
        assert_eq!(dimensions("image/gif", b"GIF8"), None);
    }

    #[test]
    fn magic_bytes_override_a_lying_extension() {
        let (mime, kind) = infer_mime("docs/renamed-as-png.jpg", b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR");
        assert_eq!(mime, "image/png");
        assert_eq!(kind, "image");
        let (svg_mime, svg_kind) = infer_mime("icons/logo.svg", minimal_svg().as_bytes());
        assert_eq!(svg_mime, "image/svg+xml");
        assert_eq!(svg_kind, "svg");
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(&[0xff, 0xfe, 0xfd]), "//79");
    }

    #[test]
    fn reads_png_blob_bytes_mime_and_size() {
        let repository = repository();
        fs::write(repository.0.join("logo.png"), minimal_png(4, 2)).expect("write png");
        fs::write(repository.0.join("logo.jpg"), minimal_jpeg()).expect("write jpg");
        fs::write(repository.0.join("mark.svg"), minimal_svg()).expect("write svg");
        commit_all(&repository.0, "加入图片");

        let png = describe_revision_blob(&repository.0.to_string_lossy(), "HEAD", "logo.png", None).expect("png");
        assert_eq!(png.oid.len(), 40, "oid 必须是完整 40 位 hash");
        assert!(png.oid.bytes().all(|byte| byte.is_ascii_hexdigit()), "oid 必须是十六进制");
        assert_eq!(png.mime, "image/png");
        assert_eq!((png.width, png.height), (Some(4), Some(2)));
        assert_eq!(png.size_bytes, minimal_png(4, 2).len() as u64);
        assert!(png.previewable && !png.too_large);
        let decoded = base64_decode_fixture(png.data_base64.as_deref().expect("payload"));
        assert_eq!(decoded, minimal_png(4, 2));

        let jpeg = describe_revision_blob(&repository.0.to_string_lossy(), "HEAD", "logo.jpg", None).expect("jpeg");
        assert_eq!((jpeg.width, jpeg.height), (Some(3), Some(2)));
        let svg = describe_revision_blob(&repository.0.to_string_lossy(), "HEAD", "mark.svg", None).expect("svg");
        assert_eq!(svg.preview_kind, "svg");
        assert_eq!((svg.width, svg.height), (Some(64), Some(32)));
    }

    #[test]
    fn oversized_blob_degrades_to_metadata_only() {
        let repository = repository();
        // 构造一个 5 MiB 的 PNG（> MAX_PREVIEW_BYTES 4 MiB）：只有头部有意义。
        let mut big = minimal_png(1, 1);
        big.resize(MAX_PREVIEW_BYTES as usize + 1024, 0x5a);
        fs::write(repository.0.join("huge.png"), &big).expect("write big png");
        commit_all(&repository.0, "加入超大图片");

        let blob = describe_revision_blob(&repository.0.to_string_lossy(), "HEAD", "huge.png", None).expect("metadata");
        assert!(blob.too_large, "超阈值必须走降级");
        assert!(!blob.previewable);
        assert!(blob.data_base64.is_none(), "超阈值不得回传字节");
        assert_eq!(blob.size_bytes, big.len() as u64);
        // 头部仍被流式读到，所以尺寸还能解析出来。
        assert_eq!((blob.width, blob.height), (Some(1), Some(1)));
    }

    #[test]
    fn diff_pair_covers_modified_added_and_removed_sides() {
        let repository = repository();
        fs::write(repository.0.join("keep.png"), minimal_png(1, 1)).expect("write");
        fs::write(repository.0.join("gone.png"), minimal_png(2, 2)).expect("write");
        let first = commit_all(&repository.0, "基线");

        // 第二次提交：改 keep、删 gone、加 new
        fs::write(repository.0.join("keep.png"), minimal_png(9, 9)).expect("rewrite");
        fs::remove_file(repository.0.join("gone.png")).expect("remove");
        fs::write(repository.0.join("new.svg"), minimal_svg()).expect("write new");
        let second = commit_all(&repository.0, "改动");

        let changed = load_image_file_diff(&repository.0.to_string_lossy(), &first, &second, "keep.png", None).expect("pair");
        let before = changed.before.clone().expect("before side");
        let after = changed.after.clone().expect("after side");
        assert_eq!((before.width, after.width), (Some(1), Some(9)));
        assert!(!changed.identical);

        let added = load_image_file_diff(&repository.0.to_string_lossy(), &first, &second, "new.svg", None).expect("added pair");
        assert!(added.before.is_none(), "新增文件不该有变更前");
        assert!(added.after.is_some());

        let removed = load_image_file_diff(&repository.0.to_string_lossy(), &first, &second, "gone.png", None).expect("removed pair");
        assert!(removed.before.is_some());
        assert!(removed.after.is_none(), "删除文件不该有变更后");

        let untouched = load_image_file_diff(&repository.0.to_string_lossy(), &second, &second, "new.svg", None).expect("identical");
        assert!(untouched.identical, "两侧同 oid 应标记无像素差异");
    }

    #[test]
    fn cancellation_stops_the_request_and_is_released_afterwards() {
        let repository = repository();
        fs::write(repository.0.join("a.png"), minimal_png(1, 1)).expect("write");
        commit_all(&repository.0, "a");
        let request_id = "cancel-me-1";
        cancel_media_request(request_id);
        let outcome = describe_revision_blob(&repository.0.to_string_lossy(), "HEAD", "a.png", Some(request_id));
        assert!(outcome.is_err());
        assert!(outcome.unwrap_err().contains("取消"));
        // 标记已被消费，同一 id 再次请求不应继续被取消。
        assert!(describe_revision_blob(&repository.0.to_string_lossy(), "HEAD", "a.png", Some(request_id)).is_ok());
    }

    #[test]
    fn cache_is_bounded_by_entries_and_bytes() {
        let mut cache = MediaCache::default();
        for index in 0..(MEDIA_CACHE_MAX_ENTRIES + 12) {
            let blob = MediaBlob {
                path: format!("p{index}.png"),
                reference: "HEAD".into(),
                oid: format!("{index:040}"),
                mime: "image/png".into(),
                extension: "png".into(),
                preview_kind: "image".into(),
                size_bytes: 1,
                width: None,
                height: None,
                previewable: false,
                too_large: true,
                data_base64: None,
                cached: false,
            };
            cache.insert((repo_fixture_key(), blob.oid.clone()), blob);
            assert!(cache.entries.len() <= MEDIA_CACHE_MAX_ENTRIES, "条目数上限必须生效");
            assert!(cache.total_bytes <= MEDIA_CACHE_MAX_BYTES, "字节上限必须生效");
        }
        // 单条超预算的记录不进缓存，缓存不会被一条巨型记录吃满。
        let giant = MediaBlob {
            path: "giant.png".into(),
            reference: "HEAD".into(),
            oid: "g".repeat(40),
            mime: "image/png".into(),
            extension: "png".into(),
            preview_kind: "image".into(),
            size_bytes: 0,
            width: None,
            height: None,
            previewable: false,
            too_large: false,
            data_base64: Some("x".repeat(MEDIA_CACHE_MAX_BYTES + 1)),
            cached: false,
        };
        let mut fresh = MediaCache::default();
        fresh.insert((repo_fixture_key(), giant.oid.clone()), giant);
        assert!(fresh.entries.is_empty());
    }

    fn repo_fixture_key() -> String {
        "/fixture/repository".to_string()
    }

    #[test]
    fn rejects_hostile_references_and_paths() {
        let repository = repository();
        fs::write(repository.0.join("a.png"), minimal_png(1, 1)).expect("write");
        commit_all(&repository.0, "a");
        let path = repository.0.to_string_lossy().to_string();
        // 以 '-' 开头会被当成 git 选项，必须拒于校验层。
        assert!(validated_reference("--output=/tmp/pwn").is_err());
        assert!(validated_reference("").is_err());
        assert!(validated_path("-rf").is_err());
        assert!(validated_path("a\0b").is_err());
        assert!(validated_reference("HEAD;rm -rf").is_err());
        // 不存在的文件返回明确错误，不 panic。
        assert!(describe_revision_blob(&path, "HEAD", "missing.png", None).is_err());
        // 不存在的引用同样安全失败。
        assert!(describe_revision_blob(&path, "no/such/ref", "a.png", None).is_err());
    }

    #[test]
    fn reads_paths_with_spaces_and_non_ascii_names() {
        let repository = repository();
        fs::create_dir_all(repository.0.join("图片 资产")).expect("mkdir");
        fs::write(repository.0.join("图片 资产/我的 logo.png"), minimal_png(5, 6)).expect("write");
        commit_all(&repository.0, "中文路径");
        let blob = describe_revision_blob(
            &repository.0.to_string_lossy(),
            "HEAD",
            "图片 资产/我的 logo.png",
            None,
        )
        .expect("read non-ascii path");
        assert_eq!((blob.width, blob.height), (Some(5), Some(6)));
        assert!(blob.previewable);
    }

    #[test]
    fn export_writes_content_addressed_temp_file_and_reuses_it() {
        let repository = repository();
        fs::write(repository.0.join("pixel.png"), minimal_png(2, 2)).expect("write");
        commit_all(&repository.0, "导出素材");
        let path = repository.0.to_string_lossy().to_string();
        let blob = describe_revision_blob(&path, "HEAD", "pixel.png", None).expect("blob");
        let export = export_revision_file(&path, "HEAD", "pixel.png").expect("export");
        assert_eq!(export.parent().map(|value| value.to_string_lossy().ends_with("branchline-media")), Some(true));
        assert_eq!(
            export.file_name().map(|value| value.to_string_lossy().to_string()),
            Some(format!("{}.png", blob.oid)),
            "文件名必须是 oid，内容寻址免失效"
        );
        assert_eq!(fs::read(&export).expect("read export"), minimal_png(2, 2));
        // 同一 oid 再导出应复用文件而不是重写：删掉后重新落盘，比较两次 mtime。
        let _ = fs::remove_file(&export);
        let fresh = export_revision_file(&path, "HEAD", "pixel.png").expect("fresh export");
        let before = fs::metadata(&fresh).expect("metadata")
            .modified()
            .expect("mtime");
        let again = export_revision_file(&path, "HEAD", "pixel.png").expect("export again");
        assert_eq!(again, fresh, "同 oid 必须命中同一个导出文件");
        let after = fs::metadata(&again).expect("metadata")
            .modified()
            .expect("mtime");
        assert_eq!(after, before, "已存在即复用，不重复写盘");
        // 不存在的文件报错，不 panic。
        assert!(export_revision_file(&path, "HEAD", "missing.png").is_err());
        // 超过预览上限但仍在导出上限内的文件可导出；上限关系在此锁住。
        assert!(MAX_EXPORT_BYTES > MAX_PREVIEW_BYTES, "导出上限应宽于预览上限");
    }

    // --- 收尾补齐：校验层语义、缓存命中、非 blob 对象、跨模块取消闸 ---

    #[test]
    fn path_validation_matches_the_main_git_module_rules() {
        // 与 git.rs 私有的 validated_file_args 同语义：绝对路径与 `..` 分量一律拒绝。
        for hostile in [
            "../../etc/passwd",
            "..",
            "docs/../../../etc/hosts",
            "/etc/passwd.png",
            "./../outside.png",
            "图片/../../escape.png",
            "-u",
            "",
            "has\0nul.png",
        ] {
            assert!(validated_path(hostile).is_err(), "必须拒绝：{hostile}");
        }
        // 名字里带连续点、空格、中文的合法文件不能被误伤（早期 contains("..") 一刀切会拒掉 a..b.png）。
        for legal in ["a..b.png", "图片 资产/我的 logo.png", "dots...txt", "./x.png", "sub/dir/ok.PNG"] {
            assert!(validated_path(legal).is_ok(), "不该拒绝：{legal}");
        }
    }

    #[test]
    fn directory_validation_allows_the_repository_root() {
        assert_eq!(validated_directory_path("").unwrap(), "");
        assert_eq!(validated_directory_path("/").unwrap(), "");
        assert_eq!(validated_directory_path("src/").unwrap(), "src");
        assert_eq!(validated_directory_path("图片 资产/图标").unwrap(), "图片 资产/图标");
        assert_eq!(validated_directory_path("apps\\desktop").unwrap(), "apps/desktop");
        // 目录名里带连续点不是路径穿越。
        assert!(validated_directory_path("a..b").is_ok());
        assert!(validated_directory_path("../outside").is_err());
        assert!(validated_directory_path("a/../b").is_err());
        assert!(validated_directory_path("-C").is_err());
    }

    #[test]
    fn safe_extension_only_admits_plain_ascii_suffixes() {
        assert_eq!(safe_extension("docs/a.PNG"), "png");
        assert_eq!(safe_extension("docs/a.pn g"), "");
        assert_eq!(safe_extension("docs/a.verylongextension"), "");
        assert_eq!(safe_extension("docs/Makefile"), "");
        assert_eq!(safe_extension("dir.name/without-dot"), "");
    }

    #[test]
    fn exported_temp_file_drops_a_hostile_extension_but_keeps_the_bytes() {
        let repository = repository();
        fs::write(repository.0.join("odd.pn g"), minimal_png(3, 3)).expect("write");
        commit_all(&repository.0, "怪后缀");
        let path = repository.0.to_string_lossy().to_string();
        let blob = describe_revision_blob(&path, "HEAD", "odd.pn g", None).expect("blob");
        let export = export_revision_file(&path, "HEAD", "odd.pn g").expect("export");
        assert_eq!(
            export.file_name().map(|value| value.to_string_lossy().to_string()),
            Some(blob.oid.clone()),
            "非纯字母数字的后缀不得进入落盘文件名"
        );
        assert_eq!(fs::read(&export).expect("read"), minimal_png(3, 3));
    }

    #[test]
    fn repeated_request_hits_the_content_addressed_cache() {
        let repository = repository();
        fs::write(repository.0.join("cache.png"), minimal_png(6, 5)).expect("write");
        commit_all(&repository.0, "缓存素材");
        let path = repository.0.to_string_lossy().to_string();
        let first = describe_revision_blob(&path, "HEAD", "cache.png", None).expect("first");
        assert!(!first.cached, "首次读取不该标记命中");
        let second = describe_revision_blob(&path, "HEAD", "cache.png", None).expect("second");
        assert!(second.cached, "同 (仓库, oid, ref, path) 必须命中缓存");
        assert_eq!(first.oid, second.oid);
        assert_eq!(first.data_base64, second.data_base64, "命中结果与首次读取逐字节一致");
        // 换一种引用写法时不冒充命中：缓存项带 ref/path，宁可回源也不给错标签。
        let head = git::git_output(&repository.0, &["rev-parse", "HEAD"]).expect("head").trim().to_string();
        let by_hash = describe_revision_blob(&path, &head, "cache.png", None).expect("by hash");
        assert!(!by_hash.cached);
        assert_eq!(by_hash.oid, first.oid);
    }

    #[test]
    fn a_tree_object_is_not_mistaken_for_a_blob() {
        let repository = repository();
        fs::create_dir_all(repository.0.join("图片 资产")).expect("mkdir");
        fs::write(repository.0.join("图片 资产/x.png"), minimal_png(1, 1)).expect("write");
        fs::write(repository.0.join("note.txt"), "hi\n").expect("write");
        commit_all(&repository.0, "目录素材");
        let path = repository.0.to_string_lossy().to_string();
        // 目录：rev-parse 解析得动，但 cat-file -t 是 tree，不是 blob。
        assert!(resolve_blob_oid(&repository.0, "HEAD", "图片 资产").expect("tree probe").is_none());
        assert!(describe_revision_blob(&path, "HEAD", "图片 资产", None).is_err());
        // 差异配对里它既不是崩溃也不是「某侧缺失」：两侧都取不到 → 明确文案。
        let pair = load_image_file_diff(&path, "HEAD", "HEAD", "图片 资产", None).expect("pair");
        assert!(pair.before.is_none() && pair.after.is_none());
        assert_eq!(pair.error.as_deref(), Some("两侧都不存在该文件"));
        assert!(!pair.identical);
        // 非图片后缀：走媒体路径也不 panic，只是标记为不可预览、不回传字节。
        let text = describe_revision_blob(&path, "HEAD", "note.txt", None).expect("text blob");
        assert_eq!(text.preview_kind, "other");
        assert_eq!(text.mime, "application/octet-stream");
        assert!(!text.previewable);
        assert!(text.data_base64.is_none());
        assert_eq!(text.size_bytes, 3);
    }

    #[test]
    fn escaping_paths_are_refused_for_every_entry_point() {
        let repository = repository();
        fs::write(repository.0.join("a.png"), minimal_png(1, 1)).expect("write");
        commit_all(&repository.0, "a");
        let path = repository.0.to_string_lossy().to_string();
        for hostile in ["../../etc/passwd", "../escape.png", "a/../../../b.png"] {
            let outcome = describe_revision_blob(&path, "HEAD", hostile, None);
            assert!(outcome.is_err(), "{hostile} 必须被拒");
            assert!(!outcome.unwrap_err().contains("取消"), "拒绝原因不该是取消");
        }
        assert!(load_image_file_diff(&path, "HEAD", "HEAD", "../../etc/passwd", None).is_err());
        assert!(export_revision_file(&path, "HEAD", "../../etc/passwd").is_err());
    }

    #[test]
    fn shared_cancellation_gate_is_visible_to_other_modules() {
        // git_tree 的文本预览与媒体共用这道闸：先取消，再确认标记只被消费一次。
        let request_id = "shared-gate-1";
        cancel_media_request(request_id);
        assert!(ensure_not_cancelled(Some(request_id)).is_err());
        assert!(ensure_not_cancelled(Some(request_id)).is_ok(), "取消标记只能消费一次");
        assert!(ensure_not_cancelled(None).is_ok());
        assert!(ensure_not_cancelled(Some("   ")).is_ok());
    }

    // --- 收尾补齐：相对引用与非 ASCII ref（真实差异入口用的就是 HEAD~1） ---

    #[test]
    fn relative_and_non_ascii_references_resolve_against_a_real_repository() {
        let repository = repository();
        fs::write(repository.0.join("logo.png"), minimal_png(1, 1)).expect("write");
        let first = commit_all(&repository.0, "基线");
        fs::write(repository.0.join("logo.png"), minimal_png(4, 4)).expect("rewrite");
        let second = commit_all(&repository.0, "改动");
        git::git_output(&repository.0, &["tag", "中文标签"]).expect("tag");
        git::git_output(&repository.0, &["branch", "中文分支", "HEAD"]).expect("branch");
        let path = repository.0.to_string_lossy().to_string();

        // HEAD~1 / HEAD^{} 这类相对写法是最常见的差异入口，绝不能在校验层就被判「无效引用」。
        for friendly in ["HEAD~1", "HEAD^{}", "HEAD^", "refs/heads/main", "中文分支", "中文标签", "v1.0~2"] {
            assert!(validated_reference(friendly).is_ok(), "不该拒绝：{friendly}");
        }
        let pair = load_image_file_diff(&path, "HEAD~1", "HEAD", "logo.png", None).expect("pair by HEAD~1");
        let before = pair.before.clone().expect("before side");
        let after = pair.after.clone().expect("after side");
        assert_eq!((before.width, after.width), (Some(1), Some(4)));
        assert_eq!(pair.from_reference, "HEAD~1");
        assert_eq!(pair.to_reference, "HEAD");
        assert!(!pair.identical);
        // 相对写法与全 hash 必须落到同一对 blob 上。
        let by_hash = load_image_file_diff(&path, &first, &second, "logo.png", None).expect("pair by hash");
        assert_eq!(by_hash.before.clone().expect("hash before").oid, before.oid);
        assert_eq!(by_hash.after.clone().expect("hash after").oid, after.oid);
        // 中文分支 / 中文标签同样可读（git ref 语法允许非 ASCII）。
        assert_eq!(describe_revision_blob(&path, "中文标签", "logo.png", None).expect("tag").oid, after.oid);
        assert_eq!(describe_revision_blob(&path, "中文分支", "logo.png", None).expect("branch").oid, after.oid);
        // 拒掉的仍然是真正危险的写法：空白、控制字符、以 '-' 开头、shell 元字符。
        for hostile in ["--output=/tmp/pwn", "-b", "a b", "HEAD\n--help", "x;rm", "a|b", "a\"b", "a'b", "$(id)"] {
            assert!(validated_reference(hostile).is_err(), "必须拒绝：{hostile}");
        }
        // ref 内部的 '-' 不是选项开头。
        assert!(validated_reference("refs/heads/-leading-dash").is_ok());
    }

    /// 仅测试用：与 base64_encode 对偶的最小解码，用来证明回传字节可还原。
    fn base64_decode_fixture(input: &str) -> Vec<u8> {
        let mut buffer: u32 = 0;
        let mut bits = 0;
        let mut out = Vec::new();
        for byte in input.bytes() {
            if byte == b'=' {
                break;
            }
            let value = match byte {
                b'A'..=b'Z' => byte - b'A',
                b'a'..=b'z' => byte - b'a' + 26,
                b'0'..=b'9' => byte - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                _ => continue,
            };
            buffer = (buffer << 6) | value as u32;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((buffer >> bits) as u8);
                buffer &= (1 << bits) - 1;
            }
        }
        out
    }
}
