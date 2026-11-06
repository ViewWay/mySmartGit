//! 子模块接入：添加 Submodule、递归克隆与子模块指针差异（W2-10，对标 EnjoyGit）。
//!
//! 本模块刻意与 git.rs 分离：git.rs 体积已 6.5k 行，且并行轨道正在改动其
//! submodule / gitlink 区域。这里只复用 `crate::git` 暴露的公共入口
//! （`repository_root` / `git_output` / `git_output_owned` / `parse_submodules` /
//! `read_repository` / `display_path`），Git 进程调用与命令日志仍走同一套基础设施。
//!
//! 既有能力分工（避免重复实现，详见模块末尾「收敛说明」）：
//! - init / update / sync / deinit / gitlink 冲突解决 仍在 git.rs，本模块不重写；
//! - 本模块只补三件 EnjoyGit 有而本项目缺的事：`submodule add`、递归（浅）克隆、
//!   子模块**指针差异语义**（旧提交 → 新提交 + 子模块内新增提交列表）。
//!
//! 安全约束（红线）：
//! - 所有 Git 调用都以参数数组发起，绝不拼接 shell 字符串，绝不使用 `sh -c`；
//!   因此**不使用** `git submodule foreach`：它把参数交给 `sh -c` 执行，
//!   与上面的红线冲突。批量能力一律用「枚举 + 逐个子模块参数数组调用」实现；
//! - 地址先过协议白名单（https/http/ssh/git/file + scp 形式 + 本地绝对路径），
//!   拒绝 `ext::` / `fd::` 这类可执行传输、拒绝前导 `-`（选项注入）、
//!   拒绝空白与控制字符（config 与换行注入）；
//! - 路径必须是父仓库内的相对路径：拒绝绝对路径、`..`、前导 `-`、`.git` 段、
//!   Windows 保留字符，并在调用 Git 之前完成「是否已被 Submodule / 普通文件占用」的冲突判定；
//! - `submodule add` 的**所有**错误出口都过 `redact_error_text`：
//!   `git submodule add` 失败时 stderr 会原样回显 `https://user:token@host/...`，
//!   凭据绝不返回前端。命令日志侧的脱敏由 git.rs 的 `sanitize_command` /
//!   `limit_log_output` 负责，本模块不重复记录；
//! - `.gitmodules` 里的 URL 在序列化前一律脱敏，并用 `credentials_redacted` 如实告知；
//! - 只有当**用户自己给出的本地路径 / file:// 地址**参与子模块传输时，才对那一条命令
//!   临时附加 `-c protocol.file.allow=always`（Git 自 CVE-2022-39253 起默认拒绝
//!   file 协议的子模块传输）。该开关不写入任何配置文件、不影响 http/ssh 地址。

// 本模块的公开入口（add / details / pointer diff）由 commands.rs 注册、lib.rs 挂载，
// 那两处由主仓串行合并；注册落地前它们在 crate 内没有调用点，故在此放行 dead_code，
// 合并后这一行可以移除。
#![allow(dead_code)]

use crate::git;
use crate::models::{
    RepositorySubmoduleDetail, SubmoduleCommitEntry, SubmoduleOperationReport, SubmodulePointerDiff,
};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// 子模块内新增提交列表的上限，超出部分折叠成一条警告，避免返回值过大。
const COMMIT_LIMIT: usize = 200;
/// 报告列表最多展示的条目数。
const AFFECTED_LIMIT: usize = 40;
/// 明细探测的子模块数量上限：超过则不再逐个起进程读工作区状态。
const DETAIL_PROBE_LIMIT: usize = 60;
const SHORT_HASH: usize = 8;
const MAX_URL_LEN: usize = 2_000;
const MAX_PATH_LEN: usize = 500;
const MAX_NAME_LEN: usize = 100;

/// 允许的传输协议白名单。刻意不含 `ext::` / `fd::`：它们能在本机执行程序。
const ALLOWED_SCHEMES: [&str; 5] = ["https://", "http://", "ssh://", "git://", "file://"];

/// 本地路径 / file:// 传输需要的临时配置开关（只作用于单条命令）。
pub const FILE_TRANSPORT_CONFIG: &str = "protocol.file.allow=always";

// =============================================================================================
// Git 调用 helper
// =============================================================================================

/// 读取型调用：失败视为「没有内容」，返回空串。
fn optional(root: &Path, args: &[&str]) -> String {
    git::git_output(root, args).unwrap_or_default()
}

/// 只关心成功与否的调用（校验、存在性探测）。
fn succeeds(root: &Path, args: &[&str]) -> bool {
    git::git_output(root, args).is_ok()
}

/// 参数数组版的读取（用于数组元素需要现场拼接的用例）。
fn optional_owned(root: &Path, args: &[String]) -> String {
    git::git_output_owned(root, args).unwrap_or_default()
}

fn lines_of(value: &str) -> Vec<String> {
    value
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.trim().is_empty())
        .map(ToString::to_string)
        .collect()
}

fn shorten(hash: &str) -> String {
    hash.chars().take(SHORT_HASH).collect()
}

/// 该目录是否是「自己的」仓库。
/// `git -C <dir> rev-parse ...` 会沿目录树上溯，子模块未初始化时留下的空目录
/// 会被解析成**父仓库**的 HEAD —— 这是一个真实的误判来源（曾让 deinit 后的子模块
/// 被报告成「已检出父仓库提交」），所以必须核对 --show-toplevel 的归属。
pub fn resolves_own_repository(dir: &Path) -> bool {
    let top = optional(dir, &["rev-parse", "--show-toplevel"]).trim().to_string();
    if top.is_empty() {
        return false;
    }
    match (Path::new(&top).canonicalize(), dir.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

/// 只在目录自身是仓库时读它的 HEAD，否则返回空串（= 未初始化）。
fn own_head(dir: &Path) -> String {
    if !resolves_own_repository(dir) {
        return String::new();
    }
    optional(dir, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .trim()
        .to_string()
}

/// 子模块工作区的未提交改动文件数；目录不是独立仓库时返回 0。
fn own_dirty_count(dir: &Path) -> usize {
    if !resolves_own_repository(dir) {
        return 0;
    }
    lines_of(&optional(dir, &["status", "--porcelain"])).len()
}

// =============================================================================================
// 脱敏
// =============================================================================================

/// scp 形式 `[user@]host:path` 的两段；主机段含 `/` 或缺一即不算 scp。
fn scp_parts(raw: &str) -> Option<(&str, &str)> {
    let (head, tail) = raw.split_once(':')?;
    if head.is_empty() || head.contains('/') || tail.is_empty() {
        return None;
    }
    Some((head, tail))
}

/// 把 URL 里的凭据与查询串换成 `[redacted]`，返回（脱敏结果、是否改写）。
/// 规则与 git.rs 私有的 `redact_log_urls`、git_remote.rs 私有的 `redact_url` 一致；
/// 那两处都是私有函数且所在文件正被并行轨道改动，这里不跨文件复用，避免制造冲突面。
fn redact_url(raw: &str) -> (String, bool) {
    let mut redacted = false;
    if let Some(scheme_end) = raw.find("://") {
        let rest = &raw[scheme_end + 3..];
        let boundary = rest
            .find(|character: char| {
                character.is_whitespace() || matches!(character, '\'' | '"' | '<' | '>')
            })
            .unwrap_or(rest.len());
        let (head, tail) = rest.split_at(boundary);
        let path_start = head.find('/').unwrap_or(head.len());
        let (authority, path) = head.split_at(path_start);
        let query_at = path.find(['?', '#']);
        let (path_only, query) = match query_at {
            Some(index) => path.split_at(index),
            None => (path, ""),
        };
        let mut result = String::from(&raw[..scheme_end + 3]);
        match authority.rfind('@') {
            Some(at) => {
                redacted = true;
                result.push_str("[redacted]@");
                result.push_str(&authority[at + 1..]);
            }
            None => result.push_str(authority),
        }
        result.push_str(path_only);
        if !query.is_empty() {
            // 查询串里常见 token / 签名参数，整段丢弃。
            redacted = true;
            result.push_str("?[redacted]");
        }
        result.push_str(tail);
        return (result, redacted);
    }
    // scp 形式：只有 `user:pass@host:path` 才是凭据。
    // 裸 `git@host:path` 是 SSH 的常规写法，用户名本身不是秘密，不能改写 —— 否则
    // 每个 SSH 子模块的地址都会被显示成 [redacted]@host，用户会误以为配置坏了。
    // 这是本模块与 git_remote.rs::redact_url 的有意差异（那边不区分裸用户名）。
    if let Some((host_part, path_part)) = scp_parts(raw) {
        let userinfo = host_part.rsplit_once('@').map(|(user, _)| user).unwrap_or_default();
        if userinfo.contains(':') {
            return (
                format!(
                    "[redacted]@{}:{}",
                    &host_part[host_part.rfind('@').unwrap() + 1..],
                    path_part
                ),
                true,
            );
        }
    }
    (raw.to_string(), false)
}

/// 判断地址是否内嵌凭据（用于给用户「会被明文写进 .gitmodules」的风险提示）。
/// scheme 形式只要出现 userinfo 就算（`https://TOKEN@host` 是真实的 token 用法）；
/// scp 形式只在 userinfo 含 `:` 时才算（裸 `git@host` 是 SSH 常规写法）。
pub fn has_embedded_credentials(raw: &str) -> bool {
    if let Some(scheme_end) = raw.find("://") {
        let rest = &raw[scheme_end + 3..];
        let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        return rest[..authority_end].contains('@');
    }
    if let Some((host_part, _)) = scp_parts(raw) {
        let userinfo = host_part.rsplit_once('@').map(|(user, _)| user).unwrap_or_default();
        return userinfo.contains(':');
    }
    false
}

/// 把 Git 错误文本里内嵌的 URL 凭据抹掉后再返回给前端。
/// `git submodule add` 失败时 stderr 会回显 `致命错误：无法克隆 '<带凭据的 URL>' ...`，
/// 这是本模块必须堵住的出口。
pub(crate) fn redact_error_text(raw: &str) -> String {
    let mut result = String::new();
    let mut remaining = raw;
    while let Some(scheme_end) = remaining.find("://") {
        let authority_start = scheme_end + 3;
        let url_end = remaining[authority_start..]
            .find(|character: char| {
                character.is_whitespace() || matches!(character, '\'' | '"' | '<' | '>')
            })
            .map(|index| authority_start + index)
            .unwrap_or(remaining.len());
        let authority_end = remaining[authority_start..url_end]
            .find(['/', '?', '#'])
            .map(|index| authority_start + index)
            .unwrap_or(url_end);
        result.push_str(&remaining[..authority_start]);
        let authority = &remaining[authority_start..authority_end];
        match authority.rfind('@') {
            Some(at) => {
                result.push_str("[redacted]@");
                result.push_str(&authority[at + 1..]);
            }
            None => result.push_str(authority),
        }
        let suffix = &remaining[authority_end..url_end];
        match suffix.find('?') {
            Some(query) => {
                result.push_str(&suffix[..query]);
                result.push_str("?[redacted]");
            }
            None => result.push_str(suffix),
        }
        remaining = &remaining[url_end..];
    }
    result.push_str(remaining);
    result
}

/// 失败出口：保留 Git 的原始原因，但剥掉内嵌凭据。
fn network_error(label: &str, error: String) -> String {
    format!("{label}：{}", redact_error_text(&error))
}

// =============================================================================================
// 校验
// =============================================================================================

/// 子模块地址：只接受协议白名单、scp 形式（`git@host:path`）或本地绝对路径。
/// 递归克隆的源地址也走这一套规则（repository_management.rs 复用）。
pub fn validate_submodule_url(raw: &str) -> Result<String, String> {
    let url = raw.trim();
    if url.is_empty() {
        return Err("Submodule 地址不能为空".to_string());
    }
    if url.chars().count() > MAX_URL_LEN {
        return Err(format!("Submodule 地址过长（上限 {MAX_URL_LEN} 字符）"));
    }
    if url.starts_with('-') {
        return Err("Submodule 地址不能以 - 开头，否则会被 Git 当成命令选项".to_string());
    }
    if url
        .chars()
        .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err("Submodule 地址不能包含空白或控制字符".to_string());
    }
    for scheme in ALLOWED_SCHEMES {
        if url.starts_with(scheme) {
            let rest = &url[scheme.len()..];
            if rest.trim_start_matches('/').is_empty() {
                return Err("Submodule 地址缺少主机与路径".to_string());
            }
            return Ok(url.to_string());
        }
    }
    if matches!(
        url.split_once("://"),
        Some((other, _)) if !other.is_empty()
    ) {
        // 形如 `<scheme>://...` 但不在白名单里：ext::/fd::/pass:: 能在本机执行程序，一律拒绝。
        return Err("Submodule 地址协议不受支持，仅允许 https/http/ssh/git/file".to_string());
    }
    if Path::new(url).is_absolute() {
        return Ok(url.to_string());
    }
    if let Some((host, _)) = scp_parts(url) {
        // scp 形式有歧义：`fd::11/x`、`pass::arg` 这些传输助手写法也是「冒号前无斜杠」。
        // 因此要求主机段带点（或是 localhost / 显式 user@host），否则一律拒绝。
        let userinfo = host.rsplit_once('@').map(|(user, _)| user).unwrap_or_default();
        let hostname = host.rsplit('@').next().unwrap_or(host);
        if userinfo.contains(':') {
            return Err(
                "scp 形式地址不允许在用户名中携带口令，请改用 https://user:token@host 或凭据管理器"
                    .to_string(),
            );
        }
        // 注意：`deploy@buildbox:/srv/repo.git` 是合法的 scp 写法（远端绝对路径），
        // 不能按「本地绝对路径」误伤；真正的歧义由下面的主机名完整性规则挡住。
        if hostname.contains('.') || hostname == "localhost" || host.contains('@') {
            return Ok(url.to_string());
        }
        return Err(
            "看起来像 git@host:path，但主机名不完整（需要带点的主机名或显式 user@host）".to_string(),
        );
    }
    Err("Submodule 地址需要是 https/http/ssh/git/file URL、git@host:path 形式或本地绝对路径"
        .to_string())
}

/// 递归克隆源地址复用同一校验，错误文案按「地址」表述。
pub fn validate_clone_source(raw: &str) -> Result<String, String> {
    validate_submodule_url(raw).map_err(|error| error.replace("Submodule 地址", "仓库地址"))
}

/// 只有用户自己给出的本地路径 / file:// 地址才需要放开 file 协议。
pub fn uses_file_transport(url: &str) -> bool {
    url.starts_with("file://") || Path::new(url).is_absolute()
}

/// Submodule 段名：既是 `.gitmodules` 的 config 段名，也参与 `.git/modules/<name>` 目录命名。
pub fn validate_submodule_name(root: &Path, raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("Submodule 名称不能为空".to_string());
    }
    if name.chars().count() > MAX_NAME_LEN {
        return Err(format!("Submodule 名称过长（上限 {MAX_NAME_LEN} 字符）"));
    }
    if name.starts_with('-') {
        return Err("Submodule 名称不能以 - 开头，否则会被 Git 当成命令选项".to_string());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") || name.contains(' ') {
        return Err("Submodule 名称不能包含路径分隔符、.. 或空白".to_string());
    }
    if name.contains(['[', ']', '"', '\'', '~', '^', ':', '?', '*', '{']) || name.starts_with('.')
        || name.ends_with('.')
        || name.ends_with(".lock")
    {
        return Err("Submodule 名称不能包含 config 特殊字符".to_string());
    }
    if !succeeds(
        root,
        &["check-ref-format", "--allow-onelevel", name],
    ) {
        return Err(format!("Submodule 名称不符合 Git 命名规则：{name}"));
    }
    Ok(name.to_string())
}

/// 跟踪分支：只做语法裁决（远端是否存在该分支由 Git 自己判定）。
fn validate_branch_name(root: &Path, raw: &str) -> Result<String, String> {
    let branch = raw.trim();
    if branch.is_empty() {
        return Err("跟踪分支不能为空".to_string());
    }
    if branch.starts_with('-') {
        return Err("跟踪分支不能以 - 开头，否则会被 Git 当成命令选项".to_string());
    }
    if branch
        .chars()
        .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err("跟踪分支不能包含空白或控制字符".to_string());
    }
    if !succeeds(root, &["check-ref-format", "--branch", branch]) {
        return Err(format!("跟踪分支名称不符合 Git 规则：{branch}"));
    }
    Ok(branch.to_string())
}

/// 子模块相对路径归一化 + 静态规则校验。
/// 返回（归一化路径，绝对路径）；所有冲突判定都以它为准。
fn validate_submodule_relative_path(root: &Path, raw: &str) -> Result<(String, PathBuf), String> {
    let trimmed = raw.trim().replace('\\', "/");
    // 先按原样判形状，再剥首尾斜杠 —— 否则 "vendor/mod/" 这种「看起来是目录」的输入
    // 会在裁剪后静默变成合法路径，用户以为路径带斜杠也能用。
    if trimmed.starts_with('/') {
        return Err("Submodule 路径必须是父仓库内的相对路径".to_string());
    }
    if trimmed.ends_with('/') {
        return Err("Submodule 路径不能以 / 结尾，请直接写目录名".to_string());
    }
    if trimmed.contains("//") {
        return Err("Submodule 路径不能包含连续斜杠".to_string());
    }
    let path = trimmed.clone();
    if path.is_empty() || path == "." || path == ".." {
        return Err("Submodule 路径不能为空".to_string());
    }
    if path.chars().count() > MAX_PATH_LEN {
        return Err(format!("Submodule 路径过长（上限 {MAX_PATH_LEN} 字符）"));
    }
    if path.starts_with('-') {
        return Err("Submodule 路径不能以 - 开头，否则会被 Git 当成命令选项".to_string());
    }
    let segments: Vec<&str> = path.split('/').filter(|segment| !segment.is_empty()).collect();
    if segments.is_empty() {
        return Err("Submodule 路径无效".to_string());
    }
    if segments.iter().any(|segment| *segment == "..") {
        return Err("Submodule 路径不能包含 ..，否则会把内容写到仓库外".to_string());
    }
    if segments.iter().any(|segment| segment.eq_ignore_ascii_case(".git")) {
        return Err("Submodule 路径不能占用 .git 目录".to_string());
    }
    if segments
        .iter()
        .any(|segment| segment.eq_ignore_ascii_case(".gitmodules"))
    {
        return Err("Submodule 路径不能占用 .gitmodules 配置文件".to_string());
    }
    if segments.iter().any(|segment| {
        segment.chars().any(|character| {
            character.is_control() || matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*')
        }) || segment.ends_with('.')
            || segment.ends_with(' ')
    }) {
        return Err("Submodule 路径包含非法字符（Windows 保留字符或控制字符）".to_string());
    }
    let absolute = root.join(&path);
    // 词法上再兜一次：join 一个不含 .. 的相对路径必然还在 root 内。
    if !absolute.starts_with(root) {
        return Err("Submodule 路径必须位于父仓库目录内".to_string());
    }
    Ok((path, absolute))
}

/// 从地址推断默认子模块路径 / 段名，与 `git submodule add <url>` 的默认行为一致，
/// 但让我们能在调用 Git 之前就做冲突判定与结果播报。
fn derived_path_from_url(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches('/');
    // scheme 形式必须真的带「authority 之后的路径段」：`https://host.example`
    // 推断出 host.example 当目录名是纯粹的胡闹，宁可让用户显式指定。
    let relevant = match trimmed.find("://") {
        Some(at) => {
            let rest = &trimmed[at + 3..];
            let slash = rest.find('/')?;
            &rest[slash + 1..]
        }
        None => trimmed,
    };
    let tail = relevant
        .rsplit(|character| character == '/' || character == ':')
        .next()?;
    let stem = tail.strip_suffix(".git").unwrap_or(tail);
    if stem.is_empty() || stem == "." || stem == ".." {
        return None;
    }
    let segment = stem.rsplit('/').next().unwrap_or(stem);
    (!segment.is_empty() && segment != "." && segment != "..").then(|| segment.to_string())
}

// =============================================================================================
// 读取：.gitmodules 解析与明细
// =============================================================================================

/// `.gitmodules` 里的一条配置。名字来自文件本身，不视为可信输入：
/// 只用于回显与判重，绝不拿它拼 config 键去执行写操作。
#[derive(Clone)]
pub struct ConfiguredSubmodule {
    pub name: String,
    pub path: String,
    pub url: String,
    pub branch: Option<String>,
}

fn submodule_field(key: &str) -> Option<(&str, &str)> {
    let rest = key.strip_prefix("submodule.")?;
    for field in ["path", "url", "branch", "name"] {
        if let Some(name) = rest.strip_suffix(&format!(".{field}")) {
            if !name.is_empty() {
                return Some((name, field));
            }
        }
    }
    None
}

/// 一次进程读全部 `.gitmodules` 条目：值为第一个空格之后的整段（URL/路径可含空格）。
fn configured_submodules(root: &Path) -> Vec<ConfiguredSubmodule> {
    if !root.join(".gitmodules").is_file() {
        return Vec::new();
    }
    let raw = optional(root, &["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\."]);
    let mut by_name: HashMap<String, ConfiguredSubmodule> = HashMap::new();
    for line in raw.lines() {
        let Some(space) = line.find(' ') else { continue };
        let (key, value) = (&line[..space], line[space + 1..].trim_start_matches(' '));
        let Some((name, field)) = submodule_field(key.trim()) else {
            continue;
        };
        let entry = by_name
            .entry(name.to_string())
            .or_insert_with(|| ConfiguredSubmodule {
                name: name.to_string(),
                path: name.to_string(),
                url: String::new(),
                branch: None,
            });
        match field {
            "path" => entry.path = value.to_string(),
            "url" => entry.url = value.to_string(),
            "branch" => entry.branch = (!value.is_empty()).then(|| value.to_string()),
            _ => {}
        }
    }
    let mut list: Vec<ConfiguredSubmodule> = by_name.into_values().collect();
    list.sort_by(|left, right| left.path.cmp(&right.path));
    list
}

/// 已 `submodule init` 过的段名集合（本地 .git/config 里存在 `submodule.<name>.url`）。
fn initialized_names(root: &Path) -> HashSet<String> {
    optional(root, &["config", "--local", "--get-regexp", "^submodule\\..*\\.url$"])
        .lines()
        .filter_map(|line| {
            let key = line.split(' ').next()?.trim();
            submodule_field(key).map(|(name, _)| name.to_string())
        })
        .collect()
}

/// `git ls-tree <ref> -- <path>` 里的 gitlink 提交（mode 160000）。
fn ls_tree_gitlink(root: &Path, reference: &str, path: &str) -> String {
    let output = optional(root, &["ls-tree", reference, "--", path]);
    for line in output.lines() {
        let (meta, name) = match line.split_once('\t') {
            Some(pair) => pair,
            None => continue,
        };
        let fields: Vec<&str> = meta.split_whitespace().collect();
        if fields.len() >= 3 && fields[0] == "160000" && name.trim() == path {
            return fields[2].to_string();
        }
    }
    String::new()
}

/// `git ls-files -s -- <path>` 里索引记录的 gitlink 提交。
fn index_gitlink(root: &Path, path: &str) -> String {
    let output = optional(root, &["ls-files", "--stage", "--", path]);
    for line in output.lines() {
        let (meta, name) = match line.split_once('\t') {
            Some(pair) => pair,
            None => continue,
        };
        let fields: Vec<&str> = meta.split_whitespace().collect();
        if fields.len() >= 2 && fields[0] == "160000" && name.trim() == path {
            return fields[1].to_string();
        }
    }
    String::new()
}

/// 索引中该路径的全部记录（用于判断「被普通文件占用」）。
fn index_entries_at(root: &Path, path: &str) -> Vec<(String, String)> {
    let prefix = format!("{path}/");
    optional(root, &["ls-files", "--stage", "--", path, &prefix])
        .lines()
        .filter_map(|line| {
            let (meta, name) = line.split_once('\t')?;
            let fields: Vec<&str> = meta.split_whitespace().collect();
            (fields.len() >= 2)
                .then(|| (fields[0].to_string(), name.trim().to_string()))
        })
        .collect()
}

fn normalize_relative(path: &str) -> String {
    path.replace('\\', "/").trim_matches('/').to_string()
}

/// 子模块明细：`.gitmodules`、`submodule status --recursive`、gitlink 记录与工作区状态合并。
pub(crate) fn parse_submodule_details(root: &Path) -> Vec<RepositorySubmoduleDetail> {
    let configured = configured_submodules(root);
    let initialized = initialized_names(root);
    let statuses = git::parse_submodules(root);
    // statuses 与 configured 的并集：deinit 后 status 仍会列出；手工编辑 .gitmodules 时只有配置。
    let mut paths: Vec<String> = statuses
        .iter()
        .map(|status| normalize_relative(&status.path))
        .collect();
    for entry in &configured {
        let path = normalize_relative(&entry.path);
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    paths.sort();
    paths.dedup();

    let probing = paths.len() <= DETAIL_PROBE_LIMIT;
    paths
        .into_iter()
        .map(|path| {
            let status = statuses
                .iter()
                .find(|status| normalize_relative(&status.path) == path);
            let entry = configured
                .iter()
                .find(|entry| normalize_relative(&entry.path) == path);
            let (safe_url, redacted) = entry
                .map(|entry| redact_url(&entry.url))
                .unwrap_or_else(|| ("".to_string(), false));
            let absolute = root.join(&path);
            // 明细探测有进程上限：超大仓库只保留 status 已经给出的信息，
            // 精确的指针三元组交给 load_submodule_pointer_diff 按需读取。
            let recorded = if probing {
                (
                    ls_tree_gitlink(root, "HEAD", &path),
                    index_gitlink(root, &path),
                    own_head(&absolute),
                )
            } else {
                (String::new(), String::new(), String::new())
            };
            let dirty = probing.then(|| own_dirty_count(&absolute));
            let nested_count = statuses
                .iter()
                .filter(|inner| {
                    let inner = normalize_relative(&inner.path);
                    inner != path && inner.starts_with(&format!("{path}/"))
                })
                .count();
            let name = entry.map(|entry| entry.name.clone()).unwrap_or_else(|| path.clone());
            RepositorySubmoduleDetail {
                path: path.clone(),
                name: name.clone(),
                credentials_redacted: redacted,
                url: safe_url,
                configured_branch: entry.and_then(|entry| entry.branch.clone()),
                status: status
                    .map(|status| status.status.clone())
                    .unwrap_or_else(|| "unknown".to_string()),
                initialized: initialized.contains(&name) || status.map(|s| s.status != "uninitialized").unwrap_or(false),
                head_commit: recorded.0,
                staged_commit: recorded.1,
                checked_out_commit: recorded.2,
                dirty_files: dirty,
                nested_count,
                absolute_path: git::display_path(&absolute),
            }
        })
        .collect()
}

pub fn list_repository_submodule_details(
    repository_path: &str,
) -> Result<Vec<RepositorySubmoduleDetail>, String> {
    let root = git::repository_root(repository_path)?;
    Ok(parse_submodule_details(&root))
}

// =============================================================================================
// 读取：子模块指针差异（EnjoyGit 的「Submodule 差异」语义）
// =============================================================================================

fn parse_commit_records(raw: &str) -> Vec<SubmoduleCommitEntry> {
    raw.split('\u{1e}')
        .filter_map(|record| {
            let fields: Vec<&str> = record.split('\u{1f}').collect();
            if fields.len() < 6 || fields[0].trim().is_empty() {
                return None;
            }
            Some(SubmoduleCommitEntry {
                hash: fields[0].trim().to_string(),
                short_hash: fields[1].trim().to_string(),
                title: fields[5].trim().to_string(),
                author: fields[2].trim().to_string(),
                email: fields[3].trim().to_string(),
                commit_time: fields[4].trim().to_string(),
            })
        })
        .collect()
}

/// 子模块指针差异：父仓库记录的旧提交 → 子模块当前的新提交，以及为此新增的提交列表。
pub fn load_submodule_pointer_diff(
    repository_path: &str,
    submodule_path: &str,
) -> Result<SubmodulePointerDiff, String> {
    let root = git::repository_root(repository_path)?;
    let (relative, absolute) = validate_submodule_relative_path(&root, submodule_path)?;
    let configured = configured_submodules(&root);
    let entry = configured
        .iter()
        .find(|entry| normalize_relative(&entry.path) == relative);
    let status = git::parse_submodules(&root)
        .into_iter()
        .find(|status| normalize_relative(&status.path) == relative);
    if entry.is_none() && status.is_none() {
        return Err(format!("Submodule 不存在：{relative}"));
    }
    let (url, credentials_redacted) = entry
        .map(|entry| redact_url(&entry.url))
        .unwrap_or_else(|| ("".to_string(), false));
    let name = entry.map(|e| e.name.clone()).unwrap_or_else(|| relative.clone());

    let head_commit = ls_tree_gitlink(&root, "HEAD", &relative);
    let staged_commit = index_gitlink(&root, &relative);
    // 未初始化 / 已 deinit 的目录里 rev-parse 会上溯到父仓库，own_head 负责排除这种假阳性。
    let current_commit = own_head(&absolute);
    let uninitialized = current_commit.is_empty();
    let detached = !uninitialized
        && !succeeds(&absolute, &["symbolic-ref", "--quiet", "--short", "HEAD"]);
    let dirty_files = own_dirty_count(&absolute);

    let previous_commit = if head_commit.is_empty() { staged_commit.clone() } else { head_commit.clone() };
    let target_commit = current_commit.clone();
    let pointer_staged = !staged_commit.is_empty() && staged_commit != head_commit;
    let pointer_unstaged = !current_commit.is_empty() && staged_commit != current_commit;
    let changed = pointer_staged || pointer_unstaged || (!head_commit.is_empty() && head_commit != current_commit);

    let mut warnings: Vec<String> = Vec::new();
    let mut added_commits: Vec<SubmoduleCommitEntry> = Vec::new();
    let mut added_count = 0usize;
    let mut removed_count = 0usize;
    let mut files_changed = 0usize;
    let mut additions = 0usize;
    let mut deletions = 0usize;
    let mut fast_forward = false;

    if credentials_redacted {
        warnings.push("该 Submodule 地址内嵌凭据，展示时已替换为 [redacted]；.gitmodules 里仍是明文，建议改用凭据管理器或 SSH".to_string());
    }

    if uninitialized {
        warnings.push("子模块尚未初始化：先执行初始化，或递归克隆后再看差异".to_string());
    } else if previous_commit.is_empty() {
        warnings.push("父仓库还没有该 Submodule 的记录提交，无法比较指针".to_string());
    } else if previous_commit == target_commit {
        fast_forward = true;
    } else {
        let range = format!("{previous_commit}..{target_commit}");
        let behind = format!("{target_commit}..{previous_commit}");
        if !succeeds(&absolute, &["merge-base", "--is-ancestor", &previous_commit, &target_commit]) {
            warnings.push("指针不是简单前移：旧提交不是新提交的祖先（子模块历史被改写、回退或分叉）".to_string());
        } else {
            fast_forward = true;
        }
        // 旧提交可能根本不在本地对象库里（例如从未 fetch 过），这时逐条列出没有意义，
        // 只如实告知，不伪造计数。
        let countable = succeeds(
            &absolute,
            &["rev-list", "--count", &format!("{previous_commit}..{target_commit}")],
        ) && succeeds(
            &absolute,
            &["cat-file", "-e", &format!("{previous_commit}^{{commit}}")],
        );
        if countable {
            added_count = optional(&absolute, &["rev-list", "--count", &range])
                .trim()
                .parse()
                .unwrap_or_default();
            removed_count = optional(&absolute, &["rev-list", "--count", &behind])
                .trim()
                .parse()
                .unwrap_or_default();
            let format = "%H\u{1f}%h\u{1f}%an\u{1f}%ae\u{1f}%aI\u{1f}%s\u{1e}";
            added_commits = parse_commit_records(&optional_owned(
                &absolute,
                &[
                    "log".to_string(),
                    "--reverse".into(),
                    "--no-merges".into(),
                    format!("--format={format}"),
                    format!("-n{}", COMMIT_LIMIT + 1),
                    range.clone(),
                ],
            ));
            if added_commits.len() > COMMIT_LIMIT {
                added_commits.truncate(COMMIT_LIMIT);
                warnings.push(format!(
                    "新增提交过多（共 {added_count} 个），仅列出前 {COMMIT_LIMIT} 个"
                ));
            }
            // numstat 走「完整 diff」；只看计数，路径本身由 diff 视图负责。
            for line in optional(&absolute, &["diff", "--numstat", &previous_commit, &target_commit]).lines() {
                let fields: Vec<&str> = line.split('\t').collect();
                if fields.len() < 3 {
                    continue;
                }
                additions += fields[0].parse::<usize>().unwrap_or_default();
                deletions += fields[1].parse::<usize>().unwrap_or_default();
                files_changed += 1;
            }
            if removed_count > 0 {
                warnings.push(format!("指针同时丢掉了 {removed_count} 个提交（新指针不包含旧指针的历史）"));
            }
        } else {
            warnings.push("旧提交不在子模块本地对象库中，无法列出新增提交；请先在子模块内 fetch".to_string());
        }
    }

    let summary = if uninitialized {
        format!("{relative}：未初始化，没有可比对的提交")
    } else if !changed || previous_commit == target_commit {
        format!(
            "{}：指针未变化（{}）",
            relative,
            shorten(&target_commit)
        )
    } else {
        format!(
            "{}：指针从 {} 移到 {}，新增 {added_count} 个提交，改动 {files_changed} 个文件 +{additions}/-{deletions}",
            relative,
            shorten(&previous_commit),
            shorten(&target_commit)
        )
    };

    Ok(SubmodulePointerDiff {
        path: relative,
        name,
        url,
        absolute_path: git::display_path(&absolute),
        head_commit,
        staged_commit,
        current_commit,
        previous_commit,
        target_commit,
        changed,
        pointer_staged,
        pointer_unstaged,
        uninitialized,
        detached,
        added_commits,
        added_count,
        removed_count,
        fast_forward,
        files_changed,
        additions,
        deletions,
        dirty_files,
        summary,
        warnings,
    })
}

// =============================================================================================
// 写入：添加 Submodule
// =============================================================================================

fn build_report(
    root: &Path,
    action: &str,
    executed: bool,
    requires_confirmation: bool,
    summary: String,
    warnings: Vec<String>,
    affected: Vec<String>,
) -> SubmoduleOperationReport {
    let snapshot = if executed {
        git::read_repository(&root.to_string_lossy()).ok()
    } else {
        None
    };
    let mut affected = affected;
    let mut warnings = warnings;
    if affected.len() > AFFECTED_LIMIT {
        let total = affected.len();
        affected.truncate(AFFECTED_LIMIT);
        warnings.push(format!("受影响项共 {total} 个，仅列出前 {AFFECTED_LIMIT} 个"));
    }
    SubmoduleOperationReport {
        action: action.to_string(),
        executed,
        requires_confirmation,
        summary,
        warnings,
        affected,
        submodules: parse_submodule_details(root),
        snapshot,
    }
}

/// `git submodule add <url> [<path>]`，带 URL / 路径 / 名称 / 分支校验与凭据脱敏。
///
/// 幂等性：重复添加同一路径会在预检阶段被拒（`已存在 Submodule 记录`），
/// 不会把仓库改到半截；「收养」已存在的非空目录需要显式 confirm，
/// confirm=false 时只返回预览且不落任何改动。
pub fn add_repository_submodule(
    repository_path: &str,
    url: &str,
    submodule_path: Option<&str>,
    name: Option<&str>,
    branch: Option<&str>,
    confirm: bool,
) -> Result<SubmoduleOperationReport, String> {
    let root = git::repository_root(repository_path)?;
    let url = validate_submodule_url(url)?;
    let relative = match submodule_path {
        Some(raw) => validate_submodule_relative_path(&root, raw)?.0,
        None => derived_path_from_url(&url)
            .and_then(|candidate| validate_submodule_relative_path(&root, &candidate).ok())
            .map(|(candidate, _)| candidate)
            .ok_or_else(|| "无法从地址推断 Submodule 路径，请手动指定".to_string())?
    };
    let absolute = root.join(&relative);
    let name = match name {
        Some(raw) => validate_submodule_name(&root, raw)?,
        None => relative.clone(),
    };
    let branch = branch
        .map(|raw| validate_branch_name(&root, raw))
        .transpose()?;

    let configured = configured_submodules(&root);
    let existing_by_path = configured
        .iter()
        .find(|entry| normalize_relative(&entry.path) == relative);
    let existing_by_name = configured.iter().find(|entry| entry.name == name);
    if let Some(entry) = existing_by_path {
        return Err(format!(
            "该路径已登记为 Submodule：{}（地址 {}），请换个路径或先取消登记",
            entry.path,
            redact_url(&entry.url).0
        ));
    }
    if let Some(entry) = existing_by_name {
        // 走到这里说明 path 预检已经放行，即同名的段指向的是另一个路径：
        // 再写一次会覆盖那条 .gitmodules 记录，必须拒绝。
        return Err(format!(
            "Submodule 名称已用于其他路径 {}：{name}，请换个名称",
            entry.path
        ));
    }
    if git::parse_submodules(&root)
        .iter()
        .any(|status| normalize_relative(&status.path) == relative)
    {
        return Err(format!("该路径已是 Submodule：{relative}"));
    }

    // 路径占用判定：普通文件/目录占用一律拒绝；只有「已存在的仓库目录」允许在确认后收养。
    let index_entries = index_entries_at(&root, &relative);
    let gitlink_taken = index_entries
        .iter()
        .any(|(mode, _)| mode == "160000");
    let ordinary_taken = index_entries
        .iter()
        .any(|(mode, _)| mode != "160000");
    if gitlink_taken {
        return Err(format!(
            "该路径已被 Submodule 指针占用：{relative}（可能已从 .gitmodules 取消登记，请先处理再添加）"
        ));
    }
    if ordinary_taken {
        return Err(format!(
            "该路径已被普通文件占用：{relative}，请先移除这些文件并提交后再添加 Submodule"
        ));
    }
    let adopt_existing = detect_adoptable_directory(&absolute)?;

    let mut warnings: Vec<String> = Vec::new();
    if has_embedded_credentials(&url) {
        warnings.push(
            "地址内嵌凭据：Git 会把它明文写进 .gitmodules 并随提交公开，请改用凭据管理器、SSH 或 token 助手"
                .to_string(),
        );
    }
    if url.starts_with("http://") {
        warnings.push("使用 http:// 明文传输，建议改用 https://".to_string());
    }
    if git::parse_submodules(&root)
        .iter()
        .any(|status| status.status == "uninitialized")
    {
        warnings.push("仓库里存在未初始化的 Submodule，添加后建议一并执行初始化".to_string());
    }

    if adopt_existing && !confirm {
        let mut preview_warnings = warnings;
        preview_warnings.push(
            "收养不会删除目录内容，但会把该目录的提交记录改写成父仓库的指针".to_string(),
        );
        return Ok(build_report(
            &root,
            "submodule-add",
            false,
            true,
            format!(
                "将收养目录里已有的仓库作为 Submodule：{}（会改用 --force 写入 .gitmodules 与 gitlink）",
                relative
            ),
            preview_warnings,
            vec![relative.clone(), name.clone()],
        ));
    }

    let head_exists = succeeds(&root, &["rev-parse", "--verify", "--quiet", "HEAD"]);
    if !head_exists {
        warnings.push("父仓库还没有任何提交：指针会随首次提交一起记录".to_string());
    }

    let mut args: Vec<String> = Vec::new();
    if uses_file_transport(&url) {
        args.extend(["-c".into(), FILE_TRANSPORT_CONFIG.into()]);
    }
    args.extend(["submodule".into(), "add".into()]);
    if adopt_existing {
        args.push("--force".into());
    }
    if let Some(branch) = &branch {
        args.extend(["--branch".into(), branch.clone()]);
    }
    if name != relative {
        args.extend(["--name".into(), name.clone()]);
    }
    args.extend(["--".into(), url.clone(), relative.clone()]);

    if let Err(error) = git::git_output_owned(&root, &args) {
        // 出口脱敏：Git 会把带凭据的地址原样回显在 stderr。
        return Err(network_error("添加 Submodule 失败", error));
    }

    let (safe_url, _) = redact_url(&url);
    warnings.push(".gitmodules 与指针已进入索引，仍需提交才会写进历史".to_string());
    Ok(build_report(
        &root,
        "submodule-add",
        true,
        false,
        format!("已添加 Submodule {relative}（{safe_url}）"),
        warnings,
        vec![relative, name],
    ))
}

/// 目录已存在且非空时：能收养 → true；确定不能 → Err；空目录/不存在 → false。
fn detect_adoptable_directory(absolute: &Path) -> Result<bool, String> {
    if !absolute.exists() {
        return Ok(false);
    }
    if !absolute.is_dir() {
        return Err(format!("目标位置已存在同名文件：{}", absolute.display()));
    }
    let empty = std::fs::read_dir(absolute)
        .map(|mut entries| entries.next().is_none())
        .map_err(|error| format!("无法检查 Submodule 目录：{error}"))?;
    if empty {
        return Ok(false);
    }
    // 关键：必须是「这个目录自己的」仓库。子模块目录嵌在父仓库里，
    // 直接 rev-parse 会向上找到父仓库，从而把一个普通目录误判成可收养的仓库。
    let is_own_worktree = resolves_own_repository(absolute)
        && !optional(absolute, &["rev-parse", "--verify", "--quiet", "HEAD"])
            .trim()
            .is_empty();
    if is_own_worktree {
        return Ok(true);
    }
    Err(format!(
        "目标目录非空且不是一个可用的 Git 仓库：{}，请清空或改用其他路径",
        absolute.display()
    ))
}

/// 供 repository_management.rs 复用：本地源需要临时放开 file 协议。
pub fn file_transport_args(url: &str) -> Vec<String> {
    if uses_file_transport(url) {
        vec!["-c".to_string(), FILE_TRANSPORT_CONFIG.to_string()]
    } else {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static SEQ: AtomicUsize = AtomicUsize::new(0);
    const LEAKED_TOKEN: &str = "SECRETTOK";

    struct Sandbox {
        root: PathBuf,
        parent: PathBuf,
        source: PathBuf,
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        git::git_output(dir, args).expect("fixture git command")
    }

    fn configure(dir: &Path) {
        git(dir, &["config", "user.name", "Branchline Test"]);
        git(dir, &["config", "user.email", "branchline@example.com"]);
        git(dir, &["config", "commit.gpgsign", "false"]);
        // 刻意不设 protocol.allow：让 file 协议的放行完全依赖被测代码自己附加的
        // `-c protocol.file.allow=always`，否则用例会把「忘记加开关」也测成通过。
    }

    fn init_repository(dir: &Path, file: &str, message: &str) -> String {
        std::fs::create_dir_all(dir).expect("create repository directory");
        git(dir, &["init", "--quiet"]);
        configure(dir);
        std::fs::write(dir.join(file), "内容\n").expect("write seed file");
        git(dir, &["add", "--", file]);
        git(dir, &["commit", "--quiet", "-m", message]);
        git(dir, &["rev-parse", "HEAD"]).trim().to_string()
    }

    /// 追加一次提交，返回新提交完整哈希。
    fn advance(dir: &Path, file: &str, message: &str) -> String {
        std::fs::write(dir.join(file), format!("{message}\n")).expect("write extra file");
        git(dir, &["add", "--", file]);
        git(dir, &["commit", "--quiet", "-m", message]);
        git(dir, &["rev-parse", "HEAD"]).trim().to_string()
    }

    fn sandbox(label: &str) -> Sandbox {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "branchline-submodule-{label}-{}-{unique}-{seq}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).expect("create sandbox");
        let parent = root.join("parent");
        let source = root.join("source");
        init_repository(&parent, "README.md", "父仓库初始提交");
        init_repository(&source, "lib.md", "子模块初始提交");
        Sandbox { root, parent, source }
    }

    fn path_of(dir: &Path) -> String {
        dir.to_string_lossy().to_string()
    }

    fn head(dir: &Path) -> String {
        git(dir, &["rev-parse", "HEAD"]).trim().to_string()
    }

    /// 报告结构体没有 Debug（内含 RepositorySnapshot），
    /// 所以「预期被拒」用这个辅助而不是 expect_err。
    trait UnwrapRejected {
        fn rejected(self, label: &str) -> String;
    }
    impl UnwrapRejected for Result<SubmoduleOperationReport, String> {
        fn rejected(self, label: &str) -> String {
            match self {
                Err(error) => error,
                Ok(report) => panic!("{label}：预期被拒绝，实际执行了 {}", report.summary),
            }
        }
    }

    // ---------------------------------------------------------------------------------------
    // 纯校验与脱敏
    // ---------------------------------------------------------------------------------------

    #[test]
    fn url_rules_reject_executable_transports_and_option_injection() {
        for raw in [
            "ext::sh -c touch% /tmp/branchline-pwned",
            "fd::11/foo",
            "pass::arg",
            "--upload-pack=evil",
            "not-a-url-at-all",
            "https://",
            "  ",
            "https://host/a b",
            "user:pw@host.example:team/repo.git",
        ] {
            assert!(
                validate_submodule_url(raw).is_err(),
                "应拒绝地址：{raw}"
            );
        }
        for raw in [
            "https://host.example/team/repo.git",
            "http://host.example/team/repo.git",
            "ssh://git@host.example/team/repo.git",
            "git://host.example/repo.git",
            "file:///srv/repo.git",
            "git@host.example:team/repo.git",
            // scp 形式的远端绝对路径是合法写法，不能按本地路径误伤。
            "deploy@buildbox:/srv/repo.git",
            "/srv/local/repo.git",
            &format!("https://user:{LEAKED_TOKEN}@host.example/team/repo.git"),
        ] {
            assert!(
                validate_submodule_url(raw).is_ok(),
                "应放行地址：{raw}"
            );
        }
        // file 协议开关只针对本地路径 / file://，http 地址绝不携带。
        assert!(uses_file_transport("/srv/local/repo.git"));
        assert!(uses_file_transport("file:///srv/repo.git"));
        assert!(!uses_file_transport("https://host.example/team/repo.git"));
        assert_eq!(
            file_transport_args("https://host.example/team/repo.git"),
            Vec::<String>::new()
        );
        assert_eq!(
            file_transport_args("/srv/local/repo.git"),
            vec!["-c".to_string(), FILE_TRANSPORT_CONFIG.to_string()]
        );
    }

    #[test]
    fn redaction_scrubs_credentials_but_keeps_plain_ssh_usernames() {
        let leaked = format!("https://user:{LEAKED_TOKEN}@host.example/team/repo.git?token=private");
        let (safe, changed) = redact_url(&leaked);
        assert!(changed);
        assert!(!safe.contains(LEAKED_TOKEN));
        assert!(!safe.contains("private"));
        assert!(safe.contains("host.example/team/repo.git"));
        assert!(has_embedded_credentials(&leaked));

        // scp 形式的裸用户名是 SSH 常规写法，不能被当成凭据改写。
        let ssh = "git@host.example:team/repo.git";
        let (safe_ssh, changed_ssh) = redact_url(ssh);
        assert_eq!(safe_ssh, ssh);
        assert!(!changed_ssh);
        assert!(!has_embedded_credentials(ssh));

        // Git 失败时会把地址原样回显在 stderr —— 出口必须擦干净。
        let error = format!(
            "致命错误：无法克隆 '{leaked}' 到子模组路径 '/w/vendor/lib'\n正克隆到 '/w/vendor/lib'..."
        );
        let safe_error = redact_error_text(&error);
        assert!(!safe_error.contains(LEAKED_TOKEN));
        assert!(!safe_error.contains("private"));
        assert!(safe_error.contains("host.example/team/repo.git"));
        assert!(safe_error.contains("子模组路径"));
    }

    #[test]
    fn path_and_name_rules_reject_traversal_and_reserved_targets() {
        let sandbox = sandbox("paths");
        let root = &sandbox.parent;
        for raw in [
            "/etc/passwd",
            "../escape",
            "vendor/../../escape",
            "-b",
            ".git/hooks",
            "vendor/.git/mod",
            ".gitmodules",
            "vendor//mod",
            "vendor/mod/",
            "vendor/mod<>",
            "vendor/",
            "",
            "   ",
        ] {
            assert!(
                validate_submodule_relative_path(root, raw).is_err(),
                "应拒绝路径：{raw}"
            );
        }
        // 合法路径必须落在父仓库内。
        let (relative, absolute) = validate_submodule_relative_path(root, "vendor\\deep\\mod")
            .expect("合法路径");
        assert_eq!(relative, "vendor/deep/mod");
        assert!(absolute.starts_with(root));
        // 段名既是 config 段名也参与 .git/modules 目录命名。
        for raw in ["", "-x", "a/b", "a b", "a[b]", ".hidden", "x.lock"] {
            assert!(
                validate_submodule_name(root, raw).is_err(),
                "应拒绝名称：{raw}"
            );
        }
        assert_eq!(validate_submodule_name(root, "shared-lib").unwrap(), "shared-lib");
    }

    #[test]
    fn url_path_segment_is_used_when_no_explicit_path_given() {
        assert_eq!(
            derived_path_from_url("git@host.example:team/repo.git").as_deref(),
            Some("repo")
        );
        assert_eq!(
            derived_path_from_url("https://host.example/team/repo.git/").as_deref(),
            Some("repo")
        );
        assert_eq!(derived_path_from_url("https://host.example/"), None);
    }

    // ---------------------------------------------------------------------------------------
    // 添加子模块（真实仓库）
    // ---------------------------------------------------------------------------------------

    #[test]
    fn add_records_gitmodules_and_parent_pointer_without_committing() {
        let sandbox = sandbox("add");
        let source_head = head(&sandbox.source);
        let report = add_repository_submodule(
            &path_of(&sandbox.parent),
            &path_of(&sandbox.source),
            Some("vendor/lib"),
            None,
            None,
            false,
        )
        .expect("添加本地子模块");

        assert!(report.executed);
        assert!(!report.requires_confirmation);
        assert_eq!(report.action, "submodule-add");
        assert!(report.summary.contains("vendor/lib"));
        // 指针只进索引，不自动提交 —— 与 EnjoyGit 的「添加后仍需提交」一致。
        let committed = git(&sandbox.parent, &["status", "--porcelain"]);
        assert!(committed.contains(".gitmodules"), "{committed}");
        assert!(committed.contains("vendor/lib"), "{committed}");
        assert_eq!(
            git(&sandbox.parent, &["rev-list", "--count", "HEAD"]).trim(),
            "1"
        );

        let gitmodules =
            std::fs::read_to_string(sandbox.parent.join(".gitmodules")).expect("读 .gitmodules");
        assert!(gitmodules.contains("[submodule \"vendor/lib\"]"), "{gitmodules}");
        assert!(gitmodules.contains("path = vendor/lib"), "{gitmodules}");
        assert!(
            gitmodules.contains(&format!("url = {}", path_of(&sandbox.source))),
            "{gitmodules}"
        );

        // 父仓库记录的 gitlink 必须等于子模块源仓库的 HEAD。
        assert_eq!(index_gitlink(&sandbox.parent, "vendor/lib"), source_head);
        // 内容真的落地了。
        assert!(sandbox.parent.join("vendor/lib/lib.md").is_file());

        let details = parse_submodule_details(&sandbox.parent);
        assert_eq!(details.len(), 1);
        assert_eq!(details[0].path, "vendor/lib");
        assert_eq!(details[0].name, "vendor/lib");
        assert_eq!(details[0].staged_commit, source_head);
        assert_eq!(details[0].checked_out_commit, source_head);
        assert_eq!(details[0].status, "ok");
        assert!(details[0].initialized);
        assert_eq!(details[0].url, path_of(&sandbox.source));
        assert!(!details[0].credentials_redacted);
        assert!(details[0].absolute_path.ends_with("vendor/lib"));

        // 重复添加同一路径必须被拒（幂等：仓库状态不变）。
        let again = add_repository_submodule(
            &path_of(&sandbox.parent),
            &path_of(&sandbox.source),
            Some("vendor/lib"),
            None,
            None,
            false,
        );
        assert!(again.is_err(), "重复添加应被拒：{:?}", again.err());
        assert_eq!(parse_submodule_details(&sandbox.parent).len(), 1);
    }

    #[test]
    fn add_rejects_illegal_urls_and_leaves_repository_untouched() {
        let sandbox = sandbox("bad-url");
        for raw in [
            "ext::sh -c touch% /tmp/branchline-pwned",
            "--upload-pack=evil",
            "https://",
        ] {
            let error = add_repository_submodule(
                &path_of(&sandbox.parent),
                raw,
                Some("vendor/evil"),
                None,
                None,
                false,
            )
            .rejected("非法地址必须被拒");
            assert!(!error.is_empty());
        }
        assert!(!sandbox.parent.join(".gitmodules").exists());
        assert!(!std::path::Path::new("/tmp/branchline-pwned").exists());
        assert!(git(&sandbox.parent, &["status", "--porcelain"]).trim().is_empty());
    }

    #[test]
    fn add_rejects_occupied_paths_and_nested_traversal_targets() {
        let sandbox = sandbox("conflict");
        // 普通文件占用：先提交一个 tracked 文件，再把它当子模块路径。
        advance(&sandbox.parent, "taken.txt", "占用文件");
        let occupied = add_repository_submodule(
            &path_of(&sandbox.parent),
            &path_of(&sandbox.source),
            Some("taken.txt"),
            None,
            None,
            false,
        )
        .rejected("被普通文件占用的路径必须被拒");
        assert!(occupied.contains("普通文件"), "{occupied}");

        // 目录非空且不是仓库：同样提前拒绝，而不是让 Git 报半句话。
        std::fs::create_dir_all(sandbox.parent.join("busy")).expect("create busy dir");
        std::fs::write(sandbox.parent.join("busy/keep.txt"), "x").expect("write keep");
        let busy = add_repository_submodule(
            &path_of(&sandbox.parent),
            &path_of(&sandbox.source),
            Some("busy"),
            None,
            None,
            false,
        )
        .rejected("非空非仓库目录必须被拒");
        assert!(busy.contains("不是一个可用的 Git 仓库"), "{busy}");

        // .. 越界路径在校验阶段就被拒，仓库没动。
        let escape = add_repository_submodule(
            &path_of(&sandbox.parent),
            &path_of(&sandbox.source),
            Some("../outside"),
            None,
            None,
            false,
        )
        .rejected("越界路径必须被拒");
        assert!(escape.contains(".."), "{escape}");
        assert!(!sandbox.root.join("outside").exists());
        assert!(!sandbox.parent.join(".gitmodules").exists());
    }

    #[test]
    fn add_failure_redacts_credentials_from_errors_and_command_logs() {
        let sandbox = sandbox("redact");
        let url = format!("https://user:{LEAKED_TOKEN}@127.0.0.1:1/team/missing.git");
        let error = add_repository_submodule(
            &path_of(&sandbox.parent),
            &url,
            Some("vendor/remote"),
            None,
            None,
            false,
        )
        .rejected("不可达地址必须失败");
        assert!(
            !error.contains(LEAKED_TOKEN),
            "错误信息泄漏凭据：{error}"
        );
        assert!(!error.contains("user:"), "错误信息泄漏凭据：{error}");
        assert!(error.contains("127.0.0.1:1"), "失败原因要可读：{error}");
        // 带凭据的地址本身也要给用户风险提示。
        let report = add_repository_submodule(
            &path_of(&sandbox.parent),
            &url,
            Some("vendor/remote"),
            None,
            None,
            false,
        );
        assert!(report.is_err());

        // 命令日志侧：git.rs 的 sanitize 负责，这里只做兜底断言。
        let logs = git::load_command_logs();
        let leaked: Vec<_> = logs
            .iter()
            .filter(|entry| {
                entry.command.contains(LEAKED_TOKEN)
                    || entry.stdout.contains(LEAKED_TOKEN)
                    || entry.stderr.contains(LEAKED_TOKEN)
            })
            .collect();
        assert!(leaked.is_empty(), "命令日志泄漏凭据：{:?}", leaked.iter().map(|e| &e.command).collect::<Vec<_>>());
    }

    #[test]
    fn credential_bearing_urls_are_warned_and_redacted_in_details() {
        let sandbox = sandbox("cred-detail");
        // 直接改 .gitmodules 模拟「仓库里已经带凭据地址」的历史情况。
        git(
            &sandbox.parent,
            &["config", "-f", ".gitmodules", "submodule.legacy.path", "vendor/legacy"],
        );
        git(
            &sandbox.parent,
            &[
                "config",
                "-f",
                ".gitmodules",
                "submodule.legacy.url",
                &format!("https://user:{LEAKED_TOKEN}@host.example/team/repo.git"),
            ],
        );
        let details = parse_submodule_details(&sandbox.parent);
        assert_eq!(details.len(), 1, "{:?}", details.iter().map(|d| &d.path).collect::<Vec<_>>());
        let legacy = &details[0];
        assert_eq!(legacy.path, "vendor/legacy");
        assert_eq!(legacy.name, "legacy");
        assert!(legacy.credentials_redacted);
        assert!(!legacy.url.contains(LEAKED_TOKEN));
        assert!(legacy.url.contains("[redacted]@host.example"), "{}", legacy.url);
        assert_eq!(legacy.status, "unknown"); // 只有配置、没有工作区
    }

    #[test]
    fn add_adopts_existing_repository_only_after_confirmation() {
        let sandbox = sandbox("adopt");
        let target = sandbox.parent.join("vendor/adopted");
        std::fs::create_dir_all(target.parent().unwrap()).expect("create vendor dir");
        // 先把它克隆进工作区：这是一个「已经是仓库但父仓库没登记」的目录。
        git(
            &sandbox.parent,
            &[
                "clone",
                "--quiet",
                &path_of(&sandbox.source),
                &target.to_string_lossy(),
            ],
        );

        let preview = add_repository_submodule(
            &path_of(&sandbox.parent),
            &path_of(&sandbox.source),
            Some("vendor/adopted"),
            None,
            None,
            false,
        )
        .expect("预览收养");
        assert!(!preview.executed);
        assert!(preview.requires_confirmation);
        assert!(preview.summary.contains("收养"), "{}", preview.summary);
        assert!(preview
            .warnings
            .iter()
            .any(|warning| warning.contains("--force") || warning.contains("指针")));
        // 预览阶段仓库没有被动过。
        assert!(!sandbox.parent.join(".gitmodules").exists());
        assert!(!git(&sandbox.parent, &["status", "--porcelain"])
            .contains("vendor/adopted"));

        let executed = add_repository_submodule(
            &path_of(&sandbox.parent),
            &path_of(&sandbox.source),
            Some("vendor/adopted"),
            None,
            None,
            true,
        )
        .expect("确认后收养");
        assert!(executed.executed);
        let gitmodules =
            std::fs::read_to_string(sandbox.parent.join(".gitmodules")).expect("读 .gitmodules");
        assert!(gitmodules.contains("path = vendor/adopted"), "{gitmodules}");
        assert!(!index_gitlink(&sandbox.parent, "vendor/adopted").is_empty());
        // 收养不动目录内容。
        assert!(target.join("lib.md").is_file());
    }

    #[test]
    fn add_records_branch_and_custom_name() {
        let sandbox = sandbox("branch");
        git(&sandbox.source, &["branch", "feat/tracking"]);
        let report = add_repository_submodule(
            &path_of(&sandbox.parent),
            &path_of(&sandbox.source),
            Some("vendor/pinned"),
            Some("shared"),
            Some("feat/tracking"),
            false,
        )
        .expect("带分支与自定义名添加");
        assert!(report.executed);
        let gitmodules =
            std::fs::read_to_string(sandbox.parent.join(".gitmodules")).expect("读 .gitmodules");
        assert!(gitmodules.contains("[submodule \"shared\"]"), "{gitmodules}");
        assert!(gitmodules.contains("path = vendor/pinned"), "{gitmodules}");
        assert!(gitmodules.contains("branch = feat/tracking"), "{gitmodules}");
        let details = parse_submodule_details(&sandbox.parent);
        assert_eq!(details.len(), 1);
        assert_eq!(details[0].name, "shared");
        assert_eq!(details[0].configured_branch.as_deref(), Some("feat/tracking"));

        // 同名段名给别的路径必须被拒，避免覆盖已有登记。
        let clash = add_repository_submodule(
            &path_of(&sandbox.parent),
            &path_of(&sandbox.source),
            Some("vendor/other"),
            Some("shared"),
            None,
            false,
        )
        .rejected("段名冲突必须被拒");
        assert!(clash.contains("shared"), "{clash}");
    }

    // ---------------------------------------------------------------------------------------
    // 递归状态与指针差异
    // ---------------------------------------------------------------------------------------

    #[test]
    fn details_walk_nested_submodules_recursively() {
        let sandbox = sandbox("nested");
        // 源仓库自己再带一个子模块。
        let leaf = sandbox.root.join("leaf");
        init_repository(&leaf, "leaf.md", "叶子提交");
        git(
            &sandbox.source,
            &["-c", FILE_TRANSPORT_CONFIG, "submodule", "add", "--", &path_of(&leaf), "deps/leaf"],
        );
        git(&sandbox.source, &["add", ".gitmodules", "deps/leaf"]);
        git(&sandbox.source, &["commit", "--quiet", "-m", "源仓库登记子模块"]);

        add_repository_submodule(
            &path_of(&sandbox.parent),
            &path_of(&sandbox.source),
            Some("vendor/lib"),
            None,
            None,
            false,
        )
        .expect("添加外层子模块");
        git(
            &sandbox.parent,
            &["-c", FILE_TRANSPORT_CONFIG, "submodule", "update", "--init", "--recursive"],
        );

        let details = parse_submodule_details(&sandbox.parent);
        let paths: Vec<&str> = details.iter().map(|detail| detail.path.as_str()).collect();
        assert!(paths.contains(&"vendor/lib"), "{paths:?}");
        assert!(
            paths.contains(&"vendor/lib/deps/leaf"),
            "递归状态应列出嵌套子模块：{paths:?}"
        );
        let outer = details
            .iter()
            .find(|detail| detail.path == "vendor/lib")
            .expect("外层明细");
        assert_eq!(outer.nested_count, 1);
        assert!(outer.initialized);
        assert!(sandbox
            .parent
            .join("vendor/lib/deps/leaf/leaf.md")
            .is_file());
    }

    #[test]
    fn pointer_diff_lists_added_commits_between_recorded_and_current() {
        let sandbox = sandbox("diff");
        let recorded = add_repository_submodule(
            &path_of(&sandbox.parent),
            &path_of(&sandbox.source),
            Some("vendor/lib"),
            None,
            None,
            false,
        )
        .expect("添加子模块")
        .submodules;
        assert_eq!(recorded.len(), 1);
        git(&sandbox.parent, &["add", ".gitmodules", "vendor/lib"]);
        git(&sandbox.parent, &["commit", "--quiet", "-m", "登记子模块"]);

        // 源仓库往前走两个提交，父仓库的子模块工作区跟随更新。
        advance(&sandbox.source, "lib.md", "子模块改动一");
        let newest = advance(&sandbox.source, "extra.md", "子模块改动二");
        git(
            &sandbox.parent,
            &[
                "-c",
                FILE_TRANSPORT_CONFIG,
                "submodule",
                "update",
                "--init",
                "--remote",
                "--",
                "vendor/lib",
            ],
        );

        let diff = load_submodule_pointer_diff(&path_of(&sandbox.parent), "vendor/lib")
            .expect("指针差异");
        assert!(diff.changed);
        assert!(!diff.uninitialized);
        assert!(diff.fast_forward);
        assert_eq!(diff.target_commit, newest);
        assert!(!diff.head_commit.is_empty());
        assert_ne!(diff.previous_commit, diff.target_commit);
        // 工作区移动了、索引没动 —— 未暂存的指针变化。
        assert!(diff.pointer_unstaged);
        assert_eq!(diff.added_count, 2);
        assert_eq!(diff.removed_count, 0);
        let titles: Vec<&str> = diff
            .added_commits
            .iter()
            .map(|commit| commit.title.as_str())
            .collect();
        assert_eq!(
            titles,
            vec!["子模块改动一", "子模块改动二"],
            "{titles:?}"
        );
        assert!(diff.files_changed >= 2, "{:?}", diff.files_changed);
        assert!(diff.additions >= 2);
        assert!(diff.summary.contains("指针从"), "{}", diff.summary);
        assert!(diff.summary.contains("新增 2 个提交"), "{}", diff.summary);
        assert!(!diff.absolute_path.is_empty());
    }

    #[test]
    fn pointer_diff_flags_non_fast_forward_and_removed_commits() {
        let sandbox = sandbox("diverge");
        add_repository_submodule(
            &path_of(&sandbox.parent),
            &path_of(&sandbox.source),
            Some("vendor/lib"),
            None,
            None,
            false,
        )
        .expect("添加子模块");
        git(&sandbox.parent, &["add", ".gitmodules", "vendor/lib"]);
        git(&sandbox.parent, &["commit", "--quiet", "-m", "登记子模块"]);
        let checkout = sandbox.parent.join("vendor/lib");
        let first = head(&checkout);
        advance(&checkout, "one.md", "被丢弃的提交");
        git(&sandbox.parent, &["add", "vendor/lib"]);
        git(&sandbox.parent, &["commit", "--quiet", "-m", "指针移到被丢弃的提交"]);

        // 在子模块里回退到 first 再分叉出一条新历史。
        git(&checkout, &["checkout", "--quiet", &first]);
        advance(&checkout, "two.md", "分叉后的提交");

        let diff = load_submodule_pointer_diff(&path_of(&sandbox.parent), "vendor/lib")
            .expect("指针差异");
        assert!(diff.changed);
        assert!(!diff.fast_forward, "非快进必须被识别");
        assert_eq!(diff.added_count, 1);
        assert_eq!(diff.removed_count, 1);
        assert!(diff
            .warnings
            .iter()
            .any(|warning| warning.contains("非快进") || warning.contains("丢掉了")));
        assert_eq!(diff.added_commits.len(), 1);
        assert_eq!(diff.added_commits[0].title, "分叉后的提交");
    }

    #[test]
    fn pointer_diff_reports_uninitialized_and_unknown_paths() {
        let sandbox = sandbox("uninit");
        add_repository_submodule(
            &path_of(&sandbox.parent),
            &path_of(&sandbox.source),
            Some("vendor/lib"),
            None,
            None,
            false,
        )
        .expect("添加子模块");
        git(&sandbox.parent, &["add", ".gitmodules", "vendor/lib"]);
        git(&sandbox.parent, &["commit", "--quiet", "-m", "登记子模块"]);
        git(&sandbox.parent, &["submodule", "deinit", "--force", "--", "vendor/lib"]);

        let diff = load_submodule_pointer_diff(&path_of(&sandbox.parent), "vendor/lib")
            .expect("未初始化的指针差异");
        assert!(diff.uninitialized);
        assert!(diff.target_commit.is_empty());
        assert_eq!(diff.added_count, 0);
        assert!(diff.added_commits.is_empty());
        assert!(diff.summary.contains("未初始化"), "{}", diff.summary);
        assert!(diff
            .warnings
            .iter()
            .any(|warning| warning.contains("尚未初始化")));

        let missing = load_submodule_pointer_diff(&path_of(&sandbox.parent), "vendor/nope");
        assert!(missing.is_err(), "未登记的路径必须被拒");
        assert!(missing.err().unwrap().contains("vendor/nope"));
    }

    #[test]
    fn pointer_diff_counts_every_added_commit() {
        let sandbox = sandbox("count");
        add_repository_submodule(
            &path_of(&sandbox.parent),
            &path_of(&sandbox.source),
            Some("vendor/lib"),
            None,
            None,
            false,
        )
        .expect("添加子模块");
        git(&sandbox.parent, &["add", ".gitmodules", "vendor/lib"]);
        git(&sandbox.parent, &["commit", "--quiet", "-m", "登记子模块"]);
        let checkout = sandbox.parent.join("vendor/lib");
        let start = head(&checkout);
        for index in 0..3 {
            advance(&checkout, &format!("f{index}.md"), &format!("子模块提交 {index}"));
        }
        let diff = load_submodule_pointer_diff(&path_of(&sandbox.parent), "vendor/lib")
            .expect("指针差异");
        assert_eq!(diff.previous_commit, start);
        assert_eq!(diff.added_count, 3);
        assert_eq!(diff.added_commits.len(), 3);
        assert_eq!(diff.added_commits[0].title, "子模块提交 0");
        assert!(diff
            .added_commits
            .iter()
            .all(|commit| commit.hash.len() == 40 && !commit.short_hash.is_empty()));
        assert!(diff.additions >= 3);
        assert_eq!(diff.files_changed, 3);
    }

    #[test]
    fn pointer_diff_warns_when_recorded_commit_is_missing_locally() {
        let sandbox = sandbox("missing-object");
        add_repository_submodule(
            &path_of(&sandbox.parent),
            &path_of(&sandbox.source),
            Some("vendor/lib"),
            None,
            None,
            false,
        )
        .expect("添加子模块");
        git(&sandbox.parent, &["add", ".gitmodules", "vendor/lib"]);
        git(&sandbox.parent, &["commit", "--quiet", "-m", "登记子模块"]);
        // 把父仓库记录的指针改成子模块本地根本没有的提交（现实里对应「从没 fetch 过」）。
        let fake = "0123456789012345678901234567890123456789";
        git(
            &sandbox.parent,
            &["update-index", "--cacheinfo", &format!("160000,{fake},vendor/lib")],
        );
        git(&sandbox.parent, &["commit", "--quiet", "-m", "指针指向缺失对象"]);

        let diff = load_submodule_pointer_diff(&path_of(&sandbox.parent), "vendor/lib")
            .expect("指针差异");
        assert_eq!(diff.head_commit, fake);
        assert_eq!(diff.previous_commit, fake);
        assert!(diff.changed);
        // 旧对象读不出来时只能如实告知，不能伪造计数。
        assert_eq!(diff.added_count, 0);
        assert!(diff.added_commits.is_empty());
        assert!(diff
            .warnings
            .iter()
            .any(|warning| warning.contains("不在子模块本地对象库")), "{:?}", diff.warnings);
    }
}
