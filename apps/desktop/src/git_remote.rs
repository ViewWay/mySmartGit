//! 远程仓库、分支上游跟踪与标签生命周期管理。
//!
//! 本模块刻意与 git.rs 分离：git.rs 体积已大，且并行轨道正在修改其
//! commit/pull/conflict 区域。这里只通过 `crate::git` 暴露的公共入口
//! （`repository_root` / `git_output` / `git_output_owned` / `read_repository`）
//! 复用统一的 Git 进程调用与命令日志基础设施。
//!
//! 安全约束（红线）：
//! - 所有 Git 调用都以参数数组发起，绝不拼接 shell 字符串，绝不使用 `sh -c`；
//! - 分支名 / 标签名 / 远程名先过本地规则，再交给 `git check-ref-format` 裁决；
//! - 以 `-` 开头的输入一律拒绝，避免被 Git 解析成命令选项（选项注入）；
//! - 远程 URL 中的凭据（userinfo、查询串）在返回前端之前脱敏；
//!   命令日志侧的脱敏由 git.rs 的 `sanitize_command` / `limit_log_output` 负责；
//! - Git 回显在 stderr 里的目标地址同样可能内嵌凭据，返回前端前统一过 `redact_error_text`；
//! - 远端写操作（推送标签、删除远端标签）的冲突预检必须对准 `pushurl`，
//!   而不是 `ls-remote <远程名>` 默认解析到的 fetch 地址，否则 fetch/push 分离时会查错仓库。
//!
//! 破坏性操作契约：删除远程、重命名远程 / 分支、改写 fetch 或 push 地址、
//! 删除本地或远端标签、覆盖推送远端标签，第一次调用只做「预览」——
//! 返回 `executed=false` + `requires_confirmation=true` + warnings / affected，
//! Rust 层不落任何改动；前端二次确认后带 `confirm=true` 再调用才真正执行。

use crate::git;
use crate::models::{RemoteOperationReport, RepositoryRemoteDetail, RepositoryTagDetail};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// 预览列表最多展示的条目数，超出部分折叠成一条提示，避免返回值过大。
const AFFECTED_LIMIT: usize = 40;

/// 哈希展示长度。
const SHORT_HASH: usize = 8;

// =============================================================================================
// Git 调用与校验helper
// =============================================================================================

/// 读取型调用：失败视为「没有配置」，返回空串。
fn optional(root: &Path, args: &[&str]) -> String {
    git::git_output(root, args).unwrap_or_default()
}

/// 按行切成去空白后的非空字符串列表。
fn lines_of(value: &str) -> Vec<String> {
    value
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect()
}

/// 只关心成功与否的调用（校验、存在性探测）。
fn succeeds(root: &Path, args: &[&str]) -> bool {
    git::git_output(root, args).is_ok()
}

/// 读取多值配置项（同一 key 可出现多次）；键名全部由本模块拼接，不接受用户直接输入键名。
fn config_list(root: &Path, key: &str) -> Vec<String> {
    lines_of(&optional(root, &["config", "--get-all", key]))
}

/// 带标签的 ref 名校验：本地规则 + `git check-ref-format` 双重把关。
fn check_ref_format(root: &Path, full_ref: &str, label: &str, value: &str) -> Result<(), String> {
    let checked = git::git_output_owned(root, &["check-ref-format".into(), full_ref.into()]);
    if checked.is_err() {
        return Err(format!("{label}名称不符合 Git 引用命名规则：{value}"));
    }
    Ok(())
}

/// 控制字符、空白与 Git 特殊字符黑名单。
fn has_forbidden_character(value: &str) -> bool {
    value
        .chars()
        .any(|character| character.is_control() || character.is_whitespace())
        || value.contains(['~', '^', ':', '?', '*', '[', '\\'])
}

/// 远程名既是 `refs/remotes/<name>/*` 的路径段，也是 git config 的段名，
/// 因此除 check-ref-format 外还要拒绝 `/`、前导 `-`、`..` 与 `.lock`。
fn validate_remote_name(root: &Path, raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("远程名称不能为空".to_string());
    }
    if name.chars().count() > 100 {
        return Err("远程名称过长（上限 100 字符）".to_string());
    }
    if name.starts_with('-') {
        return Err("远程名称不能以 - 开头，否则会被 Git 当成命令选项".to_string());
    }
    if name.contains('/') || name.contains("..") || name.starts_with('.') || name.ends_with('.')
        || name.ends_with(".lock")
    {
        return Err("远程名称不能包含 / 或 ..，也不能以 . 开头或结尾".to_string());
    }
    if has_forbidden_character(name) {
        return Err("远程名称不能包含空白、控制字符或 Git 特殊字符".to_string());
    }
    check_ref_format(root, &format!("refs/remotes/{name}/placeholder"), "远程", name)?;
    Ok(name.to_string())
}

/// 远程地址：只接受常见协议、scp 形式（`git@host:path`）或绝对路径；
/// 拒绝空白 / 控制字符（防 config 与换行注入）与前导 `-`（防选项注入）。
fn validate_remote_url(raw: &str) -> Result<String, String> {
    let url = raw.trim();
    if url.is_empty() {
        return Err("远程地址不能为空".to_string());
    }
    if url.chars().count() > 2_000 {
        return Err("远程地址过长（上限 2000 字符）".to_string());
    }
    if url.starts_with('-') {
        return Err("远程地址不能以 - 开头，否则会被 Git 当成命令选项".to_string());
    }
    if url
        .chars()
        .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err("远程地址不能包含空白或控制字符".to_string());
    }
    if ["https://", "http://", "ssh://", "git://", "file://"]
        .iter()
        .any(|prefix| url.starts_with(prefix))
    {
        return Ok(url.to_string());
    }
    if std::path::Path::new(url).is_absolute() {
        return Ok(url.to_string());
    }
    // scp 形式：[user@]host:path，host 段不含 '/'，冒号后为路径。
    if let Some((host, path)) = url.split_once(':') {
        if !host.is_empty() && !host.contains('/') && !path.is_empty() {
            return Ok(url.to_string());
        }
    }
    Err("远程地址需要是 https/http/ssh/git/file URL、git@host:path 形式或本地绝对路径".to_string())
}

fn validate_tag_name(root: &Path, raw: &str) -> Result<String, String> {
    let tag = raw.trim();
    if tag.is_empty() {
        return Err("标签名称不能为空".to_string());
    }
    if tag.starts_with('-') {
        return Err("标签名称不能以 - 开头，否则会被 Git 当成命令选项".to_string());
    }
    check_ref_format(root, &format!("refs/tags/{tag}"), "标签", tag)?;
    Ok(tag.to_string())
}

fn validate_branch_name(root: &Path, raw: &str) -> Result<String, String> {
    let branch = raw.trim();
    if branch.is_empty() {
        return Err("分支名称不能为空".to_string());
    }
    if branch.starts_with('-') {
        return Err("分支名称不能以 - 开头，否则会被 Git 当成命令选项".to_string());
    }
    check_ref_format(root, &format!("refs/heads/{branch}"), "分支", branch)?;
    Ok(branch.to_string())
}

/// 把 URL 里的凭据与查询串换成 `[redacted]`，返回（脱敏结果、是否改写）。
/// 规则与 git.rs 私有的 `redact_log_urls` 一致，但这里服务于返回值而非日志。
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
    // scp 形式 [user@]host:path —— '@' 之前一定是用户名。
    if let Some((host_part, path_part)) = scp_parts(raw) {
        if let Some(at) = host_part.rfind('@') {
            return (
                format!("[redacted]@{}:{}", &host_part[at + 1..], path_part),
                true,
            );
        }
    }
    (raw.to_string(), false)
}

fn scp_parts(raw: &str) -> Option<(&str, &str)> {
    let (head, tail) = raw.split_once(':')?;
    if head.is_empty() || head.contains('/') || tail.is_empty() {
        return None;
    }
    Some((head, tail))
}

fn redact_urls(values: Vec<String>) -> (Vec<String>, bool) {
    let mut redacted = false;
    let list = values
        .into_iter()
        .map(|value| {
            let (safe, changed) = redact_url(&value);
            redacted |= changed;
            safe
        })
        .collect();
    (list, redacted)
}

/// 把 Git 错误文本里内嵌的 URL 凭据抹掉后再返回给前端。
/// `git push` 失败时 stderr 常常原样回显目标地址；本模块承诺凭据不进返回值，所以在出口兜底。
/// 规则与 git.rs 私有的 `redact_log_urls` 一致，但那边是私有函数且 git.rs 正被并行轨道改动，
/// 这里做一份最小实现，不为复用去触碰 git.rs。
fn redact_error_text(raw: &str) -> String {
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

/// 网络类操作的错误出口：保留 Git 的原始原因，但剥掉可能内嵌的凭据。
fn network_error(label: &str, error: String) -> String {
    format!("{label}：{}", redact_error_text(&error))
}

fn shorten(hash: &str) -> String {
    hash.chars().take(SHORT_HASH).collect()
}

// =============================================================================================
// 读取
// =============================================================================================

/// `(本地分支, 上游简称)` 列表；没有上游的分支不出现。
/// 分隔符用真实控制字节：`for-each-ref --format` 不解释 `%x1f` 这类转义，
/// 参数以数组传入，不会经过 shell。
fn local_branch_upstreams(root: &Path) -> Vec<(String, String)> {
    optional(
        root,
        &[
            "for-each-ref",
            "--format=%(refname:short)\u{1f}%(upstream:short)\u{1e}",
            "refs/heads",
        ],
    )
    .split('\x1e')
    .filter_map(|record| {
        let mut fields = record.split('\x1f');
        let branch = fields.next()?.trim().to_string();
        let upstream = fields.next().unwrap_or_default().trim().to_string();
        if branch.is_empty() || upstream.is_empty() {
            return None;
        }
        Some((branch, upstream))
    })
    .collect()
}

fn remote_of_upstream(upstream: &str) -> Option<&str> {
    upstream.split_once('/').map(|(remote, _)| remote)
}

/// 该远程在本地已缓存的分支简称。`refs/remotes/<远程>/HEAD` 不算分支：
/// 它的 `%(refname:short)` 会退化成「<远程>」本身，所以必须按完整引用名排除。
fn remote_cached_branches(root: &Path, name: &str) -> Vec<String> {
    let prefix = format!("refs/remotes/{name}/");
    lines_of(&optional(
        root,
        &["for-each-ref", "--format=%(refname)", &format!("refs/remotes/{name}")],
    ))
    .into_iter()
    .filter_map(|reference| reference.strip_prefix(&prefix).map(ToString::to_string))
    .filter(|branch| branch != "HEAD")
    .collect()
}

/// 单个远程的完整视图（URL 已脱敏）。
/// push 地址读取 `remote.<name>.pushurl` 配置本身：为空表示「沿用 fetch 地址」，
/// 不能用 `git remote get-url --push`，因为它在未配置时会回落到 fetch 地址。
fn parse_one_remote(root: &Path, name: &str, upstreams: &[(String, String)]) -> RepositoryRemoteDetail {
    let (fetch_urls, fetch_redacted) = redact_urls(config_list(root, &format!("remote.{name}.url")));
    let (push_urls, push_redacted) = redact_urls(config_list(root, &format!("remote.{name}.pushurl")));
    let head_branch = optional(
        root,
        &["symbolic-ref", "--quiet", "--short", &format!("refs/remotes/{name}/HEAD")],
    )
    .trim()
    .to_string();
    let cached_branches = remote_cached_branches(root, name);
    RepositoryRemoteDetail {
        name: name.to_string(),
        fetch_urls,
        push_urls,
        fetch_refspecs: config_list(root, &format!("remote.{name}.fetch")),
        push_refspecs: config_list(root, &format!("remote.{name}.push")),
        head_branch: (!head_branch.is_empty()).then_some(head_branch),
        cached_branch_count: cached_branches.len(),
        tracking_branches: upstreams
            .iter()
            .filter(|(_, upstream)| remote_of_upstream(upstream) == Some(name))
            .map(|(branch, _)| branch.clone())
            .collect(),
        credentials_redacted: fetch_redacted || push_redacted,
    }
}

/// 读取全部远程（URL 已脱敏）。
pub(crate) fn parse_remotes(root: &Path) -> Vec<RepositoryRemoteDetail> {
    let upstreams = local_branch_upstreams(root);
    lines_of(&optional(root, &["remote"]))
        .into_iter()
        .map(|name| parse_one_remote(root, &name, &upstreams))
        .collect()
}

pub fn list_repository_remotes(
    repository_path: &str,
) -> Result<Vec<RepositoryRemoteDetail>, String> {
    let root = git::repository_root(repository_path)?;
    Ok(parse_remotes(&root))
}

/// 标签明细：类型、指向提交、打标签人、时间、说明、签名与是否被分支包含。
pub(crate) fn parse_tag_details(root: &Path) -> Vec<RepositoryTagDetail> {
    // 一次 rev-list 建立「被任一本地分支包含的提交」集合，避免每标签一次进程调用。
    let reachable: HashSet<String> = lines_of(&optional(root, &["rev-list", "--branches"]))
        .into_iter()
        .filter(|hash| hash.len() >= SHORT_HASH)
        .collect();
    // 字段顺序固定（见下方解析），说明首行可能含制表符，故放最后一列，只污染自身。
    let format = [
        "%(refname:short)",
        "%(objecttype)",
        "%(objectname)",
        "%(*objectname)",
        "%(objectname:short)",
        "%(*objectname:short)",
        "%(creatordate:iso8601)",
        "%(taggername)",
        "%(taggeremail)",
        "%(if)%(contents:signature)%(then)S%(else)P%(end)",
        "%(contents:subject)",
    ]
    .into_iter()
    .map(|atom| format!("{atom}\u{1f}"))
    .collect::<Vec<_>>()
    .join("")
        + "\u{1e}";
    optional(
        root,
        &[
            "for-each-ref",
            "--sort=-creatordate",
            &format!("--format={format}"),
            "refs/tags",
        ],
    )
    .split('\x1e')
    .filter_map(|record| {
        let fields: Vec<&str> = record.split('\x1f').collect();
        if fields.len() < 11 {
            return None;
        }
        let name = fields[0].trim();
        if name.is_empty() {
            return None;
        }
        let annotated = fields[1].trim() == "tag";
        let peeled_full = fields[3].trim();
        let target_full = if peeled_full.is_empty() {
            fields[2].trim()
        } else {
            peeled_full
        };
        let email = fields[8].trim();
        Some(RepositoryTagDetail {
            name: name.to_string(),
            kind: if annotated { "annotated" } else { "lightweight" }.to_string(),
            target: if annotated { fields[5].trim() } else { fields[4].trim() }.to_string(),
            tag_object: if annotated { fields[4].trim() } else { "" }.to_string(),
            tagger: fields[7].trim().to_string(),
            tagger_email: email.trim_start_matches('<').trim_end_matches('>').to_string(),
            date: fields[6].trim().to_string(),
            subject: fields[10].trim().to_string(),
            signed: fields[9].trim() == "S",
            on_branch: reachable.contains(target_full),
        })
    })
    .collect()
}

pub fn list_repository_tag_details(
    repository_path: &str,
) -> Result<Vec<RepositoryTagDetail>, String> {
    let root = git::repository_root(repository_path)?;
    Ok(parse_tag_details(&root))
}

// =============================================================================================
// 统一返回构造
// =============================================================================================

/// 截断过长列表并补一条提示。
fn cap(values: Vec<String>, warnings: &mut Vec<String>, note: &str) -> Vec<String> {
    if values.len() <= AFFECTED_LIMIT {
        return values;
    }
    let total = values.len();
    let mut kept = values;
    kept.truncate(AFFECTED_LIMIT);
    warnings.push(format!("{note}（共 {total} 项，仅列出前 {AFFECTED_LIMIT} 项）"));
    kept
}

/// 组装返回值；`executed` 为真时附带刷新后的仓库快照（快照读取失败不影响操作结果）。
fn build_report(
    root: &Path,
    action: &str,
    executed: bool,
    requires_confirmation: bool,
    summary: String,
    warnings: Vec<String>,
    affected: Vec<String>,
) -> RemoteOperationReport {
    let snapshot = if executed {
        git::read_repository(&root.to_string_lossy()).ok()
    } else {
        None
    };
    RemoteOperationReport {
        action: action.to_string(),
        executed,
        requires_confirmation,
        summary,
        warnings,
        affected,
        remotes: parse_remotes(root),
        tags: parse_tag_details(root),
        snapshot,
    }
}

fn remote_exists(root: &Path, name: &str) -> bool {
    // 只做存在性判断：一次 `git remote` 足够。
    // 早先这里是 parse_remotes(...).any(...)，那会为每个远程再起 5 个进程，
    // 而它常被夹在已经 parse 过一次的流程里，纯属重复开销。
    lines_of(&optional(root, &["remote"])).iter().any(|item| item == name)
}

fn local_branch_exists(root: &Path, branch: &str) -> bool {
    succeeds(root, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")])
}

fn tag_exists(root: &Path, tag: &str) -> bool {
    succeeds(root, &["show-ref", "--verify", "--quiet", &format!("refs/tags/{tag}")])
}

/// 解析提交引用为完整哈希；只接受 Git 能唯一解析的引用，避免歧义传播到后续命令。
fn resolve_commit(root: &Path, raw: &str) -> Result<String, String> {
    let reference = raw.trim();
    if reference.is_empty() {
        return Err("提交引用不能为空".to_string());
    }
    if reference.starts_with('-') {
        return Err("提交引用不能以 - 开头，否则会被 Git 当成命令选项".to_string());
    }
    let commit = optional(
        root,
        &["rev-parse", "--verify", "--quiet", &format!("{reference}^{{commit}}")],
    )
    .trim()
    .to_string();
    if commit.is_empty() {
        return Err(format!("无法解析提交引用：{reference}"));
    }
    Ok(commit)
}

/// 推送（含 `push --delete`）真正会落到哪个地址：`pushurl` 优先，其次 `url`，
/// 两者都读不到时才退回远程名本身（此时 Git 会自己按远程名解析 fetch 地址）。
fn push_target(root: &Path, remote: &str) -> String {
    config_list(root, &format!("remote.{remote}.pushurl"))
        .into_iter()
        .find(|url| !url.is_empty())
        .or_else(|| {
            config_list(root, &format!("remote.{remote}.url"))
                .into_iter()
                .find(|url| !url.is_empty())
        })
        .unwrap_or_else(|| remote.to_string())
}

/// 远端标签现状。探测对象必须是**推送真正会去的地址**：
/// `git ls-remote <远程名>` 走 fetch 地址，而 `push` / `push --delete` 走 pushurl，
/// 两者分离时用远程名探测会查错仓库 —— 要么把「推送目标其实没有这个标签」误报成冲突，
/// 要么漏报冲突让 Git 直接拒绝推送，两种结果都让预览不可信。
fn remote_tag_hash(root: &Path, target: &str, tag: &str) -> Result<Option<String>, String> {
    let output = git::git_output(root, &["ls-remote", "--tags", target, &format!("refs/tags/{tag}")])?;
    let wanted = format!("refs/tags/{tag}");
    for line in output.lines() {
        let Some((hash, reference)) = line.split_once('\t') else {
            continue;
        };
        // 跳过 `^{}` 剥皮行，只比对标签引用本身。
        if reference.trim() == wanted {
            return Ok(Some(hash.trim().to_string()));
        }
    }
    Ok(None)
}


/// 远端**全部**标签引用的哈希表，只需一次网络往返。
/// 逐标签 `ls-remote` 会让 N 个标签产生 N 次往返，一次推送一批发布标签时界面会明显卡住。
fn remote_tag_hashes(root: &Path, target: &str) -> Result<HashMap<String, String>, String> {
    let output = git::git_output(root, &["ls-remote", "--tags", target])?;
    let mut hashes = HashMap::new();
    for line in output.lines() {
        let Some((hash, reference)) = line.split_once('\t') else {
            continue;
        };
        let reference = reference.trim();
        let Some(name) = reference.strip_prefix("refs/tags/") else {
            continue;
        };
        // `refs/tags/x^{}` 是注释标签剥皮后的提交行；比对对象是标签引用自身，跳过剥皮行。
        if name.is_empty() || name.ends_with("^{}") {
            continue;
        }
        hashes.insert(name.to_string(), hash.trim().to_string());
    }
    Ok(hashes)
}

/// 一次 `for-each-ref` 取回这批标签的本地对象哈希，避免每个标签再起一个 git 进程。
fn local_tag_object_hashes(root: &Path, tags: &[String]) -> HashMap<String, String> {
    if tags.is_empty() {
        return HashMap::new();
    }
    let mut args: Vec<String> = vec![
        "for-each-ref".into(),
        "--format=%(refname)\t%(objectname)\u{1e}".into(),
    ];
    for tag in tags {
        args.push(format!("refs/tags/{tag}"));
    }
    let output = git::git_output_owned(root, &args).unwrap_or_default();
    let mut hashes = HashMap::new();
    for record in output.split('\x1e') {
        let Some((reference, hash)) = record.split_once('\t') else {
            continue;
        };
        let reference = reference.trim();
        if let Some(name) = reference.strip_prefix("refs/tags/") {
            if !name.is_empty() {
                hashes.insert(name.to_string(), hash.trim().to_string());
            }
        }
    }
    hashes
}

// =============================================================================================
// 远程管理
// =============================================================================================

/// 新增远程（非破坏性，直接执行）。`fetch` 为真时补做一次抓取，抓取失败只降级为警告，
/// 不回滚已添加的远程，避免「半成功」更难排查。
pub fn add_repository_remote(
    repository_path: &str,
    name: &str,
    url: &str,
    fetch: bool,
) -> Result<RemoteOperationReport, String> {
    let root = git::repository_root(repository_path)?;
    let name = validate_remote_name(&root, name)?;
    let url = validate_remote_url(url)?;
    if remote_exists(&root, &name) {
        return Err(format!("远程仓库已存在：{name}"));
    }
    let (redacted, _) = redact_url(&url);
    git::git_output(&root, &["remote", "add", &name, &url])
        .map_err(|error| network_error(&format!("添加远程仓库 {name} 失败"), error))?;
    let mut warnings = Vec::new();
    if fetch && !succeeds(&root, &["fetch", "--quiet", &name]) {
        warnings.push("远程已添加，但立即抓取未成功（可能是网络不可达或凭据缺失）".to_string());
    }
    Ok(build_report(
        &root,
        "add-remote",
        true,
        false,
        format!("已添加远程仓库：{name} → {redacted}"),
        warnings,
        vec![name],
    ))
}

/// 删除远程：`confirm=false` 只预览会连带失去的上游跟踪与缓存引用。
pub fn remove_repository_remote(
    repository_path: &str,
    name: &str,
    confirm: bool,
) -> Result<RemoteOperationReport, String> {
    let root = git::repository_root(repository_path)?;
    let name = validate_remote_name(&root, name)?;
    let detail = parse_remotes(&root)
        .into_iter()
        .find(|remote| remote.name == name)
        .ok_or_else(|| format!("远程仓库不存在：{name}"))?;
    let cached_refs = remote_cached_branches(&root, &name)
        .into_iter()
        .map(|branch| format!("{name}/{branch}"))
        .collect::<Vec<_>>();
    if !confirm {
        let mut warnings = vec![
            format!(
                "将删除远程仓库：{}（fetch：{}）",
                detail.name,
                detail.fetch_urls.join(", ")
            ),
            "本地缓存的远程分支引用（refs/remotes/<远程>/*）会被一并移除".to_string(),
            "与该远程绑定的 branch.<分支>.remote / branch.<分支>.merge 配置会被清除".to_string(),
        ];
        let mut affected = cap(detail.tracking_branches.clone(), &mut warnings, "将失去上游跟踪的本地分支");
        let cached = cap(cached_refs, &mut warnings, "将删除的缓存远程引用");
        affected.extend(cached);
        return Ok(build_report(
            &root,
            "remove-remote",
            false,
            true,
            format!("确认删除远程仓库：{name}"),
            warnings,
            affected,
        ));
    }
    git::git_output(&root, &["remote", "remove", &name])
        .map_err(|error| format!("删除远程仓库 {name} 失败：{error}"))?;
    let mut warnings = Vec::new();
    if !detail.tracking_branches.is_empty() {
        warnings.push(format!(
            "这些本地分支的上游跟踪已失效：{}",
            detail.tracking_branches.join(", ")
        ));
    }
    Ok(build_report(
        &root,
        "remove-remote",
        true,
        false,
        format!("已删除远程仓库：{name}"),
        warnings,
        vec![name],
    ))
}

/// 重命名远程：会重写 refs/remotes/* 与所有跟踪配置，因此默认先预览。
pub fn rename_repository_remote(
    repository_path: &str,
    old_name: &str,
    new_name: &str,
    confirm: bool,
) -> Result<RemoteOperationReport, String> {
    let root = git::repository_root(repository_path)?;
    let old_name = validate_remote_name(&root, old_name)?;
    let new_name = validate_remote_name(&root, new_name)?;
    if old_name == new_name {
        return Err("新旧远程名称相同".to_string());
    }
    let detail = parse_remotes(&root)
        .into_iter()
        .find(|remote| remote.name == old_name)
        .ok_or_else(|| format!("远程仓库不存在：{old_name}"))?;
    if remote_exists(&root, &new_name) {
        return Err(format!("远程名称已被占用：{new_name}"));
    }
    if !confirm {
        let mut warnings = vec![
            format!(
                "本地缓存的远程分支引用会整体改名（{} 个）",
                detail.cached_branch_count
            ),
            "跟踪该远程的本地分支上游会一起改为新名称".to_string(),
            "远端仓库本身的地址与命名不受影响，只改本地配置".to_string(),
        ];
        let affected = cap(detail.tracking_branches.clone(), &mut warnings, "受影响分支");
        return Ok(build_report(
            &root,
            "rename-remote",
            false,
            true,
            format!("将把远程「{old_name}」重命名为「{new_name}」"),
            warnings,
            affected,
        ));
    }
    git::git_output(&root, &["remote", "rename", &old_name, &new_name])
        .map_err(|error| format!("重命名远程仓库失败：{error}"))?;
    Ok(build_report(
        &root,
        "rename-remote",
        true,
        false,
        format!("已把远程「{old_name}」重命名为「{new_name}」"),
        Vec::new(),
        vec![old_name, new_name],
    ))
}

/// 设置远程地址：`push=true` 改 pushurl（推送去向），`push=false` 改 fetch 地址。
/// 两者都会改变后续所有网络操作的目标，一律要求二次确认。
pub fn set_repository_remote_url(
    repository_path: &str,
    name: &str,
    url: &str,
    push: bool,
    confirm: bool,
) -> Result<RemoteOperationReport, String> {
    let root = git::repository_root(repository_path)?;
    let name = validate_remote_name(&root, name)?;
    let url = validate_remote_url(url)?;
    let detail = parse_remotes(&root)
        .into_iter()
        .find(|remote| remote.name == name)
        .ok_or_else(|| format!("远程仓库不存在：{name}"))?;
    let (redacted_new, _) = redact_url(&url);
    let kind = if push { "push" } else { "fetch" };
    let action = if push { "set-push-url" } else { "set-fetch-url" };
    if !confirm {
        let mut warnings = vec![format!(
            "此后所有 {kind} 都会指向新地址；若是 push 地址，误填会把提交推到别的仓库"
        )];
        if push && detail.push_urls.is_empty() {
            warnings.push("当前 push 沿用 fetch 地址，设置后 push 与 fetch 将分离".to_string());
        }
        if !push && !detail.push_urls.is_empty() {
            warnings.push(format!(
                "该远程已单独配置 push 地址（{}），改动 fetch 地址不会影响推送目标",
                detail.push_urls.join(", ")
            ));
        }
        if !detail.tracking_branches.is_empty() {
            warnings.push(format!(
                "有 {} 个本地分支跟踪该远程：{}",
                detail.tracking_branches.len(),
                detail.tracking_branches.join(", ")
            ));
        }
        let current = if push { &detail.push_urls } else { &detail.fetch_urls };
        return Ok(build_report(
            &root,
            action,
            false,
            true,
            format!("将把远程「{name}」的 {kind} 地址改为：{redacted_new}"),
            warnings,
            current.clone(),
        ));
    }
    let mut args: Vec<&str> = vec!["remote", "set-url"];
    if push {
        args.push("--push");
    }
    args.extend_from_slice(&[&name, &url]);
    git::git_output(&root, &args).map_err(|error| network_error(&format!("设置远程 {kind} 地址失败"), error))?;
    Ok(build_report(
        &root,
        action,
        true,
        false,
        format!("已把远程「{name}」的 {kind} 地址设为：{redacted_new}"),
        Vec::new(),
        vec![name],
    ))
}

// =============================================================================================
// 分支：重命名与上游跟踪
// =============================================================================================

/// 重命名本地分支。远端同名分支不会被自动改名，预览中明确告知。
pub fn rename_repository_branch(
    repository_path: &str,
    old_name: &str,
    new_name: &str,
    confirm: bool,
) -> Result<RemoteOperationReport, String> {
    let root = git::repository_root(repository_path)?;
    let old_name = validate_branch_name(&root, old_name)?;
    let new_name = validate_branch_name(&root, new_name)?;
    if old_name == new_name {
        return Err("新旧分支名称相同".to_string());
    }
    if !local_branch_exists(&root, &old_name) {
        return Err(format!("本地分支不存在：{old_name}"));
    }
    if local_branch_exists(&root, &new_name) {
        return Err(format!("分支名称已被占用：{new_name}"));
    }
    let worktree_paths = optional(
        &root,
        &[
            "for-each-ref",
            "--format=%(worktreepath)\u{1e}",
            &format!("refs/heads/{old_name}"),
        ],
    )
    .split('\x1e')
    .map(str::trim)
    .filter(|path| !path.is_empty())
    .map(ToString::to_string)
    .collect::<Vec<_>>();
    if !worktree_paths.is_empty() {
        // 其他 Worktree 正在使用该分支，Git 也会拒绝，这里提前拦下并给出原因。
        return Err(format!(
            "分支 {} 已被其他 Worktree 检出，请先切换或移除：{}",
            old_name,
            worktree_paths.join(", ")
        ));
    }
    let upstream = local_branch_upstreams(&root)
        .into_iter()
        .find(|(branch, _)| branch == &old_name)
        .map(|(_, upstream)| upstream);
    let current = optional(&root, &["branch", "--show-current"]).trim().to_string();
    if !confirm {
        let mut warnings = vec![
            format!(
                "远端分支不会随之改名：需要自行推送「{new_name}」并删除远端的「{old_name}」"
            ),
            "本地 reflog 与提交历史保持不变".to_string(),
        ];
        if let Some(upstream) = &upstream {
            warnings.push(format!(
                "上游跟踪仍指向「{upstream}」（改名不会自动指向远端新分支）"
            ));
        }
        if current == old_name {
            warnings.push("这是当前分支，改名后 HEAD 会跟随到新名称".to_string());
        }
        return Ok(build_report(
            &root,
            "rename-branch",
            false,
            true,
            format!("将把本地分支「{old_name}」重命名为「{new_name}」"),
            warnings,
            vec![old_name.clone(), new_name.clone()],
        ));
    }
    git::git_output(&root, &["branch", "-m", "--", &old_name, &new_name])
        .map_err(|error| format!("重命名分支失败：{error}"))?;
    Ok(build_report(
        &root,
        "rename-branch",
        true,
        false,
        format!("已把本地分支「{old_name}」重命名为「{new_name}」"),
        upstream
            .map(|upstream| format!("上游跟踪保持不变：{upstream}"))
            .into_iter()
            .collect(),
        vec![old_name, new_name],
    ))
}

/// 设置或清除上游跟踪分支。`upstream` 形如 `origin/main`；`None` 表示清除。
/// 该操作可逆且不删数据，直接执行。
pub fn set_repository_branch_upstream(
    repository_path: &str,
    branch: &str,
    upstream: Option<&str>,
) -> Result<RemoteOperationReport, String> {
    let root = git::repository_root(repository_path)?;
    let branch = validate_branch_name(&root, branch)?;
    if !local_branch_exists(&root, &branch) {
        return Err(format!("本地分支不存在：{branch}"));
    }
    let summary = match upstream {
        None => {
            git::git_output(&root, &["branch", "--unset-upstream", "--", &branch])
                .map_err(|error| format!("清除上游跟踪失败：{error}"))?;
            format!("已清除分支 {branch} 的上游跟踪")
        }
        Some(raw) => {
            let upstream = raw.trim();
            let (remote, remote_branch) = upstream
                .split_once('/')
                .filter(|(remote, name)| !remote.is_empty() && !name.is_empty())
                .ok_or_else(|| format!("上游分支需要是「远程/分支」形式：{upstream}"))?;
            validate_remote_name(&root, remote)?;
            let reference = format!("refs/remotes/{remote}/{remote_branch}");
            check_ref_format(&root, &reference, "分支", remote_branch)?;
            if !remote_exists(&root, remote) {
                return Err(format!("远程仓库不存在：{remote}"));
            }
            if !succeeds(&root, &["show-ref", "--verify", "--quiet", &reference]) {
                return Err(format!(
                    "本地还没有缓存远端分支 {remote}/{remote_branch}，请先 Fetch 再设置上游"
                ));
            }
            git::git_output(
                &root,
                &[
                    "branch",
                    &format!("--set-upstream-to={upstream}"),
                    "--",
                    &branch,
                ],
            )
            .map_err(|error| format!("设置上游跟踪失败：{error}"))?;
            format!("已让分支 {branch} 跟踪 {upstream}")
        }
    };
    Ok(build_report(
        &root,
        "set-upstream",
        true,
        false,
        summary,
        Vec::new(),
        vec![branch],
    ))
}

// =============================================================================================
// 标签：注释 / 签名 / 删除 / 推送
// =============================================================================================

#[derive(Clone, Copy)]
enum CreateTagKind {
    Annotated,
    Signed,
}

impl CreateTagKind {
    fn flag(self) -> &'static str {
        match self {
            Self::Annotated => "-a",
            Self::Signed => "-s",
        }
    }

    fn action(self) -> &'static str {
        match self {
            Self::Annotated => "create-annotated-tag",
            Self::Signed => "create-signed-tag",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Annotated => "注释标签",
            Self::Signed => "签名标签",
        }
    }
}

/// 注释标签（`git tag -a -m`）：含打标签人、日期与说明。
/// `force=true` 才允许把已存在的标签移到别的提交，且仍需 `confirm=true`。
pub fn create_repository_annotated_tag(
    repository_path: &str,
    tag: &str,
    commit: &str,
    message: &str,
    force: bool,
    confirm: bool,
) -> Result<RemoteOperationReport, String> {
    let root = git::repository_root(repository_path)?;
    let tag = validate_tag_name(&root, tag)?;
    let message = require_message(message, "注释标签")?;
    let target = resolve_commit(&root, commit)?;
    create_tag(&root, CreateTagKind::Annotated, &tag, &target, &message, None, force, confirm)
}

/// 签名标签（`git tag -s`）。缺少可用私钥时 Git 会失败，原因原样上抛；
/// 绝不降级成轻量标签冒充「已签名」。
pub fn create_repository_signed_tag(
    repository_path: &str,
    tag: &str,
    commit: &str,
    message: &str,
    signing_key: Option<&str>,
    force: bool,
    confirm: bool,
) -> Result<RemoteOperationReport, String> {
    let root = git::repository_root(repository_path)?;
    let tag = validate_tag_name(&root, tag)?;
    let message = require_message(message, "签名标签")?;
    let target = resolve_commit(&root, commit)?;
    create_tag(
        &root,
        CreateTagKind::Signed,
        &tag,
        &target,
        &message,
        signing_key.map(str::trim).filter(|key| !key.is_empty()),
        force,
        confirm,
    )
}

fn require_message(raw: &str, label: &str) -> Result<String, String> {
    let message = raw.trim();
    if message.is_empty() {
        return Err(format!("{label}需要填写标签说明"));
    }
    if message.contains('\0') {
        return Err("标签说明不能包含空字符".to_string());
    }
    Ok(message.to_string())
}

#[allow(clippy::too_many_arguments)]
fn create_tag(
    root: &Path,
    kind: CreateTagKind,
    tag: &str,
    target: &str,
    message: &str,
    signing_key: Option<&str>,
    force: bool,
    confirm: bool,
) -> Result<RemoteOperationReport, String> {
    let existing = tag_exists(root, tag);
    if existing && !force {
        return Err(format!(
            "标签已存在：{tag}。如需移动它请开启覆盖模式（会要求二次确认）"
        ));
    }
    if existing && !confirm {
        // force=true 但还没二次确认：只给出「从哪挪到哪」的预览。
        let previous = optional(
            root,
            &["rev-parse", "--verify", "--quiet", &format!("refs/tags/{tag}^{{commit}}")],
        )
        .trim()
        .to_string();
        let mut warnings = vec![
            "覆盖标签只改本地引用，其他人需要手动更新；远端同名标签不会自动同步".to_string(),
        ];
        if !previous.is_empty() && previous != target {
            warnings.push(format!("标签将从 {} 移到 {}", shorten(&previous), shorten(target)));
        }
        return Ok(build_report(
            root,
            kind.action(),
            false,
            true,
            format!("将覆盖已有{}：{tag}", kind.label()),
            warnings,
            vec![tag.to_string()],
        ));
    }
    let mut args: Vec<String> = vec!["tag".into()];
    if existing && force {
        args.push("-f".into());
    }
    args.push(kind.flag().into());
    // `-m` 后的内容会被 git.rs 的 sanitize_command 从日志里抹掉，标签说明不入日志。
    args.extend_from_slice(&["-m".into(), message.to_string()]);
    if let Some(key) = signing_key {
        if key.starts_with('-') || has_forbidden_character(key) {
            return Err("签名密钥标识不能包含空白、控制字符或 Git 特殊字符".to_string());
        }
        args.extend_from_slice(&["-u".into(), key.to_string()]);
    }
    args.push(tag.to_string());
    args.push(target.to_string());
    git::git_output_owned(root, &args).map_err(|error| {
        let hint = if matches!(kind, CreateTagKind::Signed) {
            "（请确认已安装 GPG、已配置 user.signingkey，且私钥无需交互解锁）"
        } else {
            ""
        };
        format!("创建{}失败：{error}{hint}", kind.label())
    })?;
    if !tag_exists(root, tag) {
        // 兜底：Git 报成功但引用没落地时宁可报错，也不谎报成功。
        return Err(format!("创建{}失败：标签引用未落地", kind.label()));
    }
    Ok(build_report(
        root,
        kind.action(),
        true,
        false,
        format!("已创建{}：{tag} → {}", kind.label(), shorten(target)),
        Vec::new(),
        vec![tag.to_string()],
    ))
}

/// 删除本地标签：预览给出类型、是否签名、是否已被分支包含。
pub fn delete_repository_tag(
    repository_path: &str,
    tag: &str,
    confirm: bool,
) -> Result<RemoteOperationReport, String> {
    let root = git::repository_root(repository_path)?;
    let tag = validate_tag_name(&root, tag)?;
    let detail = parse_tag_details(&root)
        .into_iter()
        .find(|item| item.name == tag)
        .ok_or_else(|| format!("标签不存在：{tag}"))?;
    if !confirm {
        let mut warnings = vec![
            "删除本地标签不会移除远端同名标签，需要单独执行「删除远端标签」".to_string(),
            format!("目标提交：{}（{}）", detail.target, detail.kind),
        ];
        if detail.signed {
            warnings.push("这是签名标签，删除后本地无法再校验该签名".to_string());
        }
        if !detail.on_branch {
            warnings.push("该标签指向的提交不在任何本地分支上，删除后对象可能被 GC 回收".to_string());
        }
        return Ok(build_report(
            &root,
            "delete-tag",
            false,
            true,
            format!("将删除本地标签：{tag}"),
            warnings,
            vec![tag],
        ));
    }
    git::git_output(&root, &["tag", "-d", "--", &tag])
        .map_err(|error| format!("删除标签 {tag} 失败：{error}"))?;
    Ok(build_report(
        &root,
        "delete-tag",
        true,
        false,
        format!("已删除本地标签：{tag}"),
        Vec::new(),
        vec![tag],
    ))
}

/// 删除远端标签：先用 ls-remote 探测真实状态，再要求二次确认。
pub fn delete_repository_remote_tag(
    repository_path: &str,
    remote: &str,
    tag: &str,
    confirm: bool,
) -> Result<RemoteOperationReport, String> {
    let root = git::repository_root(repository_path)?;
    let remote = validate_remote_name(&root, remote)?;
    let tag = validate_tag_name(&root, tag)?;
    if !remote_exists(&root, &remote) {
        return Err(format!("远程仓库不存在：{remote}"));
    }
    let mut preview_warnings = vec![format!(
        "这是远端写操作：执行后所有协作者都会看到 {remote} 上的标签 {tag} 消失"
    )];
    let target = push_target(&root, &remote);
    let remote_hash = match remote_tag_hash(&root, &target, &tag) {
        Ok(hash) => hash,
        Err(_) => {
            // 探测失败（离线 / 凭据受限）不阻断预览，但必须写明无法核实。
            preview_warnings.push(format!("无法核实远端 {remote} 上的标签状态（网络或凭据受限）"));
            None
        }
    };
    if remote_hash.is_none() && preview_warnings.len() == 1 {
        preview_warnings.push(format!("远端 {remote} 上当前没有标签 {tag}，执行可能由 Git 报「无此引用」"));
    }
    if !confirm {
        return Ok(build_report(
            &root,
            "delete-remote-tag",
            false,
            true,
            format!("将从远端 {remote} 删除标签：{tag}"),
            preview_warnings,
            vec![format!("refs/tags/{tag}")],
        ));
    }
    git::git_output_owned(
        &root,
        &[
            "push".into(),
            "--delete".into(),
            remote.clone(),
            format!("refs/tags/{tag}"),
        ],
    )
    .map_err(|error| network_error("删除远端标签失败", error))?;
    let mut warnings = Vec::new();
    if tag_exists(&root, &tag) {
        warnings.push(format!("本地标签 {tag} 仍然保留，如需删除请再执行本地删除"));
    }
    Ok(build_report(
        &root,
        "delete-remote-tag",
        true,
        false,
        format!("已从远端 {remote} 删除标签：{tag}"),
        warnings,
        vec![format!("{remote}/refs/tags/{tag}")],
    ))
}

/// 推送标签到远端。远端同名标签指向不同提交属于强推，需要 `force` + `confirm` 双开关。
pub fn push_repository_tags(
    repository_path: &str,
    remote: &str,
    tags: &[String],
    force: bool,
    confirm: bool,
) -> Result<RemoteOperationReport, String> {
    let root = git::repository_root(repository_path)?;
    let remote = validate_remote_name(&root, remote)?;
    if !remote_exists(&root, &remote) {
        return Err(format!("远程仓库不存在：{remote}"));
    }
    let mut validated = Vec::new();
    let mut missing = Vec::new();
    for tag in tags {
        let tag = validate_tag_name(&root, tag)?;
        if tag_exists(&root, &tag) {
            validated.push(tag);
        } else {
            missing.push(tag);
        }
    }
    if validated.is_empty() {
        return Err(if missing.is_empty() {
            "请先选择要推送的标签".to_string()
        } else {
            format!("本地标签不存在：{}", missing.join(", "))
        });
    }
    // 远端现状：同名标签指向不同对象时，推送就是覆盖。探测对准真正的推送目标，
    // 且远端与本地各只查一次（不逐个标签往返 / 起进程）。
    let target = push_target(&root, &remote);
    let mut conflicts = Vec::new();
    let mut unverifiable = 0usize;
    match remote_tag_hashes(&root, &target) {
        Ok(remote_hashes) => {
            let local_hashes = local_tag_object_hashes(&root, &validated);
            for tag in &validated {
                let local = local_hashes.get(tag).map(String::as_str).unwrap_or_default();
                if let Some(remote_hash) = remote_hashes.get(tag) {
                    if !local.is_empty() && local != remote_hash {
                        conflicts.push(format!("refs/tags/{tag}"));
                    }
                }
            }
        }
        // 探测失败（离线 / 凭据受限）不阻断推送，但要如实说明无法核实。
        Err(_) => unverifiable = validated.len(),
    }
    if !conflicts.is_empty() && !(force && confirm) {
        let mut warnings = vec![
            "远端已存在同名标签且指向不同对象，直接推送会被 Git 拒绝".to_string(),
            "覆盖远端标签会影响所有协作者的本地标签，请确认后再执行强推".to_string(),
        ];
        let affected = cap(conflicts, &mut warnings, "冲突标签");
        return Ok(build_report(
            &root,
            "push-tags",
            false,
            true,
            format!("远端 {remote} 上存在同名标签指向不同提交，需要强推确认"),
            warnings,
            affected,
        ));
    }
    let mut args: Vec<String> = vec!["push".into()];
    if force && confirm && !conflicts.is_empty() {
        args.push("--force".into());
    }
    args.push(remote.clone());
    // `--` 之后全部按 refspec 处理，配合已校验的标签名杜绝选项注入。
    args.push("--".into());
    for tag in &validated {
        args.push(format!("refs/tags/{tag}"));
    }
    git::git_output_owned(&root, &args).map_err(|error| network_error("推送标签失败", error))?;
    let mut warnings = Vec::new();
    if !missing.is_empty() {
        warnings.push(format!("这些标签在本地不存在，已跳过：{}", missing.join(", ")));
    }
    if !conflicts.is_empty() {
        warnings.push(format!("已强制覆盖远端标签：{}", conflicts.join(", ")));
    }
    if unverifiable > 0 {
        warnings.push("推送前无法核实部分远端标签状态，结果以本次推送输出为准".to_string());
    }
    Ok(build_report(
        &root,
        "push-tags",
        true,
        false,
        format!("已推送 {} 个标签到 {remote}", validated.len()),
        warnings,
        validated,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::{SystemTime, UNIX_EPOCH};

    static SCRATCH_SEQ: AtomicUsize = AtomicUsize::new(0);
    /// 签名标签测试会改全局 GNUPGHOME，必须串行，避免与其他用例互相污染。
    static GPG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    /// 每个用例一套临时目录：<root>/work 是本地仓库，<root>/remote.git 是 bare 远端。
    /// 目录名带 pid + 纳秒 + 递增序号，规避并行 worktree 之间的临时目录撞名。
    struct Sandbox {
        root: PathBuf,
        repo: PathBuf,
        remote: PathBuf,
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn scratch_root(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let seq = SCRATCH_SEQ.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "branchline-remote-test-{label}-{}-{unique}-{seq}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).expect("create sandbox directory");
        root
    }

    fn git_at(dir: &Path, args: &[&str]) -> String {
        git::git_output(dir, args).expect("fixture git command")
    }

    fn configure_identity(dir: &Path) {
        git_at(dir, &["config", "user.name", "Branchline Test"]);
        git_at(dir, &["config", "user.email", "branchline@example.com"]);
        // 隔离开发机的全局签名配置，保证注释标签用例只测 -a 而不被 tag.gpgsign 影响。
        git_at(dir, &["config", "tag.gpgsign", "false"]);
        git_at(dir, &["config", "commit.gpgsign", "false"]);
    }

    fn sandbox(label: &str) -> Sandbox {
        let root = scratch_root(label);
        let repo = root.join("work");
        let remote = root.join("remote.git");
        std::fs::create_dir_all(&repo).expect("create work repository");
        git_at(&repo, &["init", "--quiet"]);
        configure_identity(&repo);
        std::fs::write(repo.join("README.md"), "first\n").expect("write readme");
        git_at(&repo, &["add", "README.md"]);
        git_at(&repo, &["commit", "--quiet", "-m", "初始提交"]);
        std::fs::create_dir_all(&remote).expect("create bare remote");
        git_at(&remote, &["init", "--bare", "--quiet"]);
        Sandbox { root, repo, remote }
    }

    fn path_of(dir: &Path) -> String {
        dir.to_string_lossy().to_string()
    }

    fn branch_of(root: &Path) -> String {
        git_at(root, &["branch", "--show-current"]).trim().to_string()
    }

    /// 追加一次提交，返回该提交的完整哈希（用于制造标签冲突）。
    fn extra_commit(root: &Path, message: &str) -> String {
        std::fs::write(root.join("EXTRA.md"), format!("{message}\n")).expect("write extra file");
        git_at(root, &["add", "EXTRA.md"]);
        git_at(root, &["commit", "--quiet", "-m", message]);
        git_at(root, &["rev-parse", "HEAD"]).trim().to_string()
    }

    /// 把当前分支推到 bare 远端并抓回本地引用，让远程分支进入「已缓存」状态。
    fn push_and_cache_branch(env: &Sandbox, remote_name: &str) -> String {
        let branch = branch_of(&env.repo);
        git_at(&env.repo, &["push", "--quiet", remote_name, &format!("{branch}:{branch}")]);
        git_at(&env.repo, &["fetch", "--quiet", remote_name]);
        branch
    }

    fn config_of(root: &Path, key: &str) -> String {
        git::git_output(root, &["config", "--get", key])
            .unwrap_or_default()
            .trim()
            .to_string()
    }

    /// 在沙箱里再建一个 bare 仓库，用于验证 fetch 与 push 分开指向的场景。
    fn extra_bare(env: &Sandbox, label: &str) -> PathBuf {
        let dir = env.root.join(label);
        std::fs::create_dir_all(&dir).expect("create extra bare remote");
        git_at(&dir.as_path(), &["init", "--bare", "--quiet"]);
        dir
    }

    /// 绕过「远程」概念，直接把当前分支推进指定 bare 仓库。
    fn push_branch_to_url(env: &Sandbox, url: &Path) -> String {
        let branch = branch_of(&env.repo);
        git_at(
            &env.repo,
            &["push", "--quiet", &path_of(url), &format!("{branch}:{branch}")],
        );
        branch
    }

    /// 从 bare 仓库**自身**读它拥有的标签引用，作为服务端事实的唯一凭据。
    /// 只看客户端 `ls-remote` 会受本地缓存与传输层缓存影响，不足以证明远端真的变了。
    fn tags_owned_by_bare(bare: &Path) -> Vec<String> {
        lines_of(&git_at(bare, &["for-each-ref", "--format=%(refname:short)", "refs/tags"]))
    }

    /// bare 仓库里某标签真正指向的提交（注释标签要剥一层）。
    fn peeled_tag_commit(bare: &Path, tag: &str) -> String {
        git_at(bare, &["rev-parse", "--verify", &format!("refs/tags/{tag}^{{commit}}")])
            .trim()
            .to_string()
    }

    /// RemoteOperationReport 内嵌快照因而没有 Debug，取错误文本时用 match 而非 expect_err。
    fn report_error(result: Result<RemoteOperationReport, String>, label: &str) -> String {
        match result {
            Ok(_) => panic!("{label}：预期返回错误，但操作却成功了"),
            Err(error) => error,
        }
    }

    // ---------------------------------------------------------------- 校验与脱敏（纯逻辑）

    #[test]
    fn rejects_option_like_and_control_characters_in_names_and_urls() {
        let env = sandbox("validate");
        let root = env.repo.as_path();

        // 以 - 开头会被 Git 当成选项，一律拒绝。
        for name in ["-x", " -x", "--mirror"] {
            assert!(validate_remote_name(root, name).is_err(), "远程名 {name} 应被拒绝");
            assert!(validate_tag_name(root, name).is_err(), "标签名 {name} 应被拒绝");
            assert!(validate_branch_name(root, name).is_err(), "分支名 {name} 应被拒绝");
        }
        assert!(validate_remote_name(root, "").is_err());
        assert!(validate_remote_name(root, "origin/inner").is_err());
        assert!(validate_remote_name(root, "has space").is_err());
        assert!(validate_remote_name(root, "a\nb").is_err());
        assert!(validate_tag_name(root, "tag^{}").is_err());
        // 合法名称
        assert_eq!(validate_remote_name(root, "origin").ok().as_deref(), Some("origin"));
        assert_eq!(validate_tag_name(root, "v1.2.3-rc1").ok().as_deref(), Some("v1.2.3-rc1"));
        assert_eq!(
            validate_branch_name(root, "feature/demo").ok().as_deref(),
            Some("feature/demo")
        );

        for url in ["-t", "https://ex.com/a b.git", "https://ex.com/a\nb", "", "relative/path.git"] {
            assert!(validate_remote_url(url).is_err(), "地址 {url:?} 应被拒绝");
        }
        assert!(validate_remote_url("https://example.com/a.git").is_ok());
        assert!(validate_remote_url("git@github.com:owner/repo.git").is_ok());
        assert!(validate_remote_url(&path_of(&env.remote)).is_ok());
    }

    #[test]
    fn redacts_credentials_and_query_strings_in_returned_urls() {
        let (https, changed) = redact_url("https://user:supersecret@example.com/team/repo.git");
        assert!(changed);
        assert!(!https.contains("supersecret"));
        assert_eq!(https, "https://[redacted]@example.com/team/repo.git");

        let (query, _) = redact_url("https://example.com/repo.git?token=privatetoken");
        assert!(!query.contains("privatetoken"));
        assert!(query.ends_with("?[redacted]"));

        let (scp, scp_changed) = redact_url("git@github.com:owner/repo.git");
        assert!(scp_changed);
        assert_eq!(scp, "[redacted]@github.com:owner/repo.git");

        // 裸本地路径与无凭据 URL 原样返回。
        let (plain, plain_changed) = redact_url("/tmp/repos/remote.git");
        assert!(!plain_changed);
        assert_eq!(plain, "/tmp/repos/remote.git");
    }

    #[test]
    fn scrubs_credentials_from_git_error_text_before_returning_it() {
        // git 在 push 失败时会把目标地址原样回显进 stderr，这类文本会直接返回前端。
        let raw = "remote: error: failed to push some refs to 'https://oauth2:TOKENVALUE@git.example.com/team/repo.git'";
        let safe = redact_error_text(raw);
        assert!(!safe.contains("TOKENVALUE"), "{safe}");
        assert!(safe.contains("git.example.com/team/repo.git"), "主机与路径要保留，否则无法排障：{safe}");
        assert!(safe.contains("[redacted]@"));

        // 查询串里的 token 同样不能外泄。
        let query = redact_error_text("fatal: could not read from https://host/repo.git?access_key=SECRETKEY");
        assert!(!query.contains("SECRETKEY"), "{query}");

        // 普通错误文本不被改写。
        let plain = "fatal: not a git repository";
        assert_eq!(redact_error_text(plain), plain);
        assert_eq!(network_error("推送标签失败", plain.to_string()), "推送标签失败：fatal: not a git repository");
    }

    #[test]
    fn probes_and_deletes_target_the_push_url_not_the_fetch_url() {
        let env = sandbox("push-target-resolution");
        let path = path_of(&env.repo);
        add_repository_remote(&path, "origin", &path_of(&env.remote), false).expect("add remote");
        // 未分离时推送去向就是 fetch 地址。
        assert_eq!(push_target(&env.repo, "origin"), path_of(&env.remote));

        let push_only = extra_bare(&env, "resolved-push.git");
        set_repository_remote_url(&path, "origin", &path_of(&push_only), true, true).expect("set push url");
        assert_eq!(push_target(&env.repo, "origin"), path_of(&push_only));
        // 远程名本身仍解析得到 fetch 地址，二者必须区分开，否则冲突预检会查错仓库。
        assert_ne!(push_target(&env.repo, "origin"), path_of(&env.remote));
    }

    // ---------------------------------------------------------------- 远程管理

    #[test]
    fn adds_and_lists_remote_with_fetch_and_push_urls() {
        let env = sandbox("add-list");
        let path = path_of(&env.repo);
        let url = path_of(&env.remote);

        let added = add_repository_remote(&path, "origin", &url, false).expect("add remote");
        assert!(added.executed);
        assert!(!added.requires_confirmation);
        assert!(added.snapshot.is_some(), "已执行的操作应回填快照供前端刷新");
        assert_eq!(added.remotes.len(), 1);
        assert_eq!(added.remotes[0].name, "origin");
        assert_eq!(added.remotes[0].fetch_urls, vec![url.clone()]);
        // 未单独配置 pushurl 时不应伪报成「已分离」。
        assert!(added.remotes[0].push_urls.is_empty());

        // 重复添加必须失败而不是静默覆盖。
        assert!(add_repository_remote(&path, "origin", &url, false).is_err());

        let listed = list_repository_remotes(&path).expect("list remotes");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].fetch_urls, vec![url]);
        assert!(!listed[0].credentials_redacted);
    }

    #[test]
    fn remove_remote_previews_before_destroying_tracking() {
        let env = sandbox("remove-remote");
        let path = path_of(&env.repo);
        add_repository_remote(&path_of(&env.repo), "origin", &path_of(&env.remote), false)
            .expect("add remote");
        let branch = push_and_cache_branch(&env, "origin");
        set_repository_branch_upstream(&path, &branch, Some(&format!("origin/{branch}")))
            .expect("set upstream");

        let preview = remove_repository_remote(&path, "origin", false).expect("preview removal");
        assert!(!preview.executed, "未确认时绝不能执行");
        assert!(preview.requires_confirmation);
        assert!(preview.snapshot.is_none());
        assert!(preview.affected.contains(&branch), "{:?}", preview.affected);
        assert!(preview
            .warnings
            .iter()
            .any(|warning| warning.contains("refs/remotes")));
        // 预览后远程与跟踪关系仍在。
        assert_eq!(
            config_of(&env.repo, &format!("branch.{branch}.remote")),
            "origin"
        );

        let removed = remove_repository_remote(&path, "origin", true).expect("confirmed removal");
        assert!(removed.executed);
        assert!(removed.remotes.is_empty());
        assert!(removed.warnings.iter().any(|warning| warning.contains(&branch)));
        assert!(config_of(&env.repo, &format!("branch.{branch}.remote")).is_empty());
        assert_eq!(list_repository_remotes(&path).expect("list").len(), 0);
    }

    #[test]
    fn rename_remote_rewrites_cached_refs_and_upstream() {
        let env = sandbox("rename-remote");
        let path = path_of(&env.repo);
        add_repository_remote(&path, "origin", &path_of(&env.remote), false).expect("add remote");
        let branch = push_and_cache_branch(&env, "origin");
        set_repository_branch_upstream(&path, &branch, Some(&format!("origin/{branch}")))
            .expect("set upstream");

        let preview = rename_repository_remote(&path, "origin", "upstream", false).expect("preview");
        assert!(!preview.executed);
        assert_eq!(config_of(&env.repo, &format!("branch.{branch}.remote")), "origin");

        let renamed = rename_repository_remote(&path, "origin", "upstream", true).expect("rename");
        assert!(renamed.executed);
        assert_eq!(renamed.remotes.len(), 1);
        assert_eq!(renamed.remotes[0].name, "upstream");
        assert_eq!(renamed.remotes[0].cached_branch_count, 1);
        assert_eq!(renamed.remotes[0].tracking_branches, vec![branch.clone()]);
        assert_eq!(config_of(&env.repo, &format!("branch.{branch}.remote")), "upstream");
        assert_eq!(
            local_branch_upstreams(&env.repo)
                .into_iter()
                .find(|(item, _)| item == &branch)
                .map(|(_, upstream)| upstream),
            Some(format!("upstream/{branch}"))
        );
        // 目标名称占用时报错，不做覆盖。
        assert!(rename_repository_remote(&path, "upstream", "upstream", true).is_err());
    }

    #[test]
    fn set_remote_url_requires_confirmation_and_keeps_credentials_out_of_results() {
        let env = sandbox("set-url");
        let path = path_of(&env.repo);
        add_repository_remote(&path, "origin", &path_of(&env.remote), false).expect("add remote");

        let secret = "supersecretvalue";
        let new_url = format!("https://oauth2:{secret}@git.example.com/team/repo.git");
        let preview = set_repository_remote_url(&path, "origin", &new_url, false, false).expect("preview");
        assert!(!preview.executed);
        assert!(preview.requires_confirmation);
        assert!(preview.summary.contains("[redacted]"));
        assert!(!preview.summary.contains(secret), "返回值不得含凭据：{}", preview.summary);
        assert_eq!(config_of(&env.repo, "remote.origin.url"), path_of(&env.remote));

        let applied = set_repository_remote_url(&path, "origin", &new_url, false, true).expect("apply");
        assert!(applied.executed);
        assert_eq!(
            config_of(&env.repo, "remote.origin.url"),
            new_url,
            "配置里保存原始地址，展示时再脱敏"
        );
        let shown = &applied.remotes[0];
        assert_eq!(shown.fetch_urls, vec![format!("https://[redacted]@git.example.com/team/repo.git")]);
        assert!(shown.credentials_redacted);
        assert!(!shown.fetch_urls.iter().any(|url| url.contains(secret)));

        // push 地址与 fetch 分离，同样要求二次确认。
        let push_url = format!("ssh://push@push.example.com/team/repo.git?jwt={secret}");
        let push_preview = set_repository_remote_url(&path, "origin", &push_url, true, false).expect("push preview");
        assert!(!push_preview.executed);
        assert!(push_preview
            .warnings
            .iter()
            .any(|warning| warning.contains("push 与 fetch 将分离")));
        assert!(config_of(&env.repo, "remote.origin.pushurl").is_empty());

        let push_applied = set_repository_remote_url(&path, "origin", &push_url, true, true).expect("push apply");
        assert!(push_applied.executed);
        assert_eq!(config_of(&env.repo, "remote.origin.pushurl"), push_url);
        assert_eq!(
            push_applied.remotes[0].push_urls,
            vec!["ssh://[redacted]@push.example.com/team/repo.git?[redacted]"]
        );
        assert!(!push_applied.remotes[0].push_urls.iter().any(|url| url.contains(secret)));
        // 已分离 push 地址后，改 fetch 的预览要提示这一点。
        let again = set_repository_remote_url(&path, "origin", &path_of(&env.remote), false, false).expect("preview again");
        assert!(again
            .warnings
            .iter()
            .any(|warning| warning.contains("不会影响推送目标")));
    }

    // ---------------------------------------------------------------- 抓取标记与地址分离

    #[test]
    fn add_remote_with_fetch_caches_refs_and_without_fetch_does_not() {
        let env = sandbox("add-fetch-flag");
        let path = path_of(&env.repo);
        // 先把内容推进两个 bare 远端，抓取与否的差别才可观测。
        push_branch_to_url(&env, &env.remote);
        let second = extra_bare(&env, "remote-no-fetch.git");
        git_at(&env.repo, &["push", "--quiet", &path_of(&second), "HEAD:refs/heads/seed"]);

        let added = add_repository_remote(&path, "origin", &path_of(&env.remote), true).expect("add with fetch");
        assert!(added.executed);
        assert_eq!(
            added.remotes[0].cached_branch_count, 1,
            "fetch=true 应当立即把远端分支缓存到本地"
        );
        assert!(added.warnings.is_empty(), "本地路径抓取不该失败：{:?}", added.warnings);

        let skipped = add_repository_remote(&path, "mirror", &path_of(&second), false).expect("add without fetch");
        // 远程列表按名称排序返回，这里显式按名字取，避免依赖下标。
        let mirror = skipped
            .remotes
            .iter()
            .find(|remote| remote.name == "mirror")
            .expect("mirror listed");
        assert_eq!(mirror.cached_branch_count, 0, "fetch=false 不该顺带抓取");
        let origin = skipped
            .remotes
            .iter()
            .find(|remote| remote.name == "origin")
            .expect("origin still listed");
        assert_eq!(origin.cached_branch_count, 1, "上一步抓来的引用不该因为新增别的远程而消失");

        // 校验失败时不得留下半截配置。
        assert!(add_repository_remote(&path, "-x", &path_of(&env.remote), false).is_err());
        assert_eq!(list_repository_remotes(&path).expect("list").len(), 2);
    }

    #[test]
    fn honours_separate_fetch_and_push_urls_against_real_remotes() {
        let env = sandbox("split-urls");
        let path = path_of(&env.repo);
        let fetch_only = env.remote.clone();
        let push_only = extra_bare(&env, "push-target.git");
        push_branch_to_url(&env, &fetch_only);

        add_repository_remote(&path, "origin", &path_of(&fetch_only), true).expect("add remote");
        let applied = set_repository_remote_url(&path, "origin", &path_of(&push_only), true, true).expect("set push url");
        assert!(applied.executed);
        assert_eq!(config_of(&env.repo, "remote.origin.url"), path_of(&fetch_only));
        assert_eq!(config_of(&env.repo, "remote.origin.pushurl"), path_of(&push_only));

        // 让 fetch 仓库先持有一个指向「旧提交」的 v.split（绕过模块直接推）。
        // 修复前的缺陷：推送前的冲突预检用 `ls-remote <远程名>`，走的是 fetch 地址，
        // 会把这个旧标签当成冲突，于是对「推送目标根本没有该标签」的正常推送误报成需要强推确认。
        create_repository_annotated_tag(&path, "v.split", "HEAD", "旧提交上的标签", false, false).expect("tag old");
        git_at(&env.repo, &["push", "--quiet", &path_of(&fetch_only), "refs/tags/v.split"]);
        let seeded = peeled_tag_commit(&fetch_only, "v.split");

        // 把标签移到新提交后经模块推送：必须直接执行（无误报冲突），且只写到 push 地址。
        let moved = extra_commit(&env.repo, "用于分离地址的第二个提交");
        create_repository_annotated_tag(&path, "v.split", "HEAD", "新提交上的标签", true, true).expect("move tag");
        let pushed = push_repository_tags(&path, "origin", &["v.split".to_string()], false, false)
            .expect("push tag through pushurl");
        assert!(
            pushed.executed,
            "推送目标上并没有同名标签，不该被误判成强推：{} / {:?}",
            pushed.summary,
            pushed.warnings
        );
        assert!(!pushed.requires_confirmation);
        assert_eq!(pushed.affected, vec!["v.split".to_string()], "成功推送的 affected 就是被推送的标签");
        assert!(
            !pushed.warnings.iter().any(|warning| warning.contains("强制覆盖")),
            "误报冲突才会走到强推分支：{:?}",
            pushed.warnings
        );

        assert_eq!(
            peeled_tag_commit(&push_only, "v.split"),
            moved,
            "push 地址仓库应真的收到指向新提交的标签"
        );
        assert_eq!(
            peeled_tag_commit(&fetch_only, "v.split"),
            seeded,
            "fetch 地址上的标签不该被推送改写"
        );
        assert!(tags_owned_by_bare(&push_only).contains(&"v.split".to_string()));

        // 删除远端标签同样只能作用于 push 地址：push 侧消失，fetch 侧仍在。
        let deleted = delete_repository_remote_tag(&path, "origin", "v.split", true).expect("delete via pushurl");
        assert!(deleted.executed);
        assert!(
            !tags_owned_by_bare(&push_only).contains(&"v.split".to_string()),
            "push 地址仓库的标签应被真的删除"
        );
        assert!(
            tags_owned_by_bare(&fetch_only).contains(&"v.split".to_string()),
            "删除绝不该波及 fetch 地址"
        );
    }


    // ---------------------------------------------------------------- 分支

    #[test]
    fn rename_branch_previews_then_renames_and_keeps_upstream_note() {
        let env = sandbox("rename-branch");
        let path = path_of(&env.repo);
        add_repository_remote(&path, "origin", &path_of(&env.remote), false).expect("add remote");
        let base = push_and_cache_branch(&env, "origin");
        let old = "feature/old-name";
        git_at(&env.repo, &["branch", old, "HEAD"]);
        set_repository_branch_upstream(&path, old, Some(&format!("origin/{base}"))).expect("set upstream");

        let preview = rename_repository_branch(&path, old, "feature/new-name", false).expect("preview");
        assert!(!preview.executed);
        assert!(preview
            .warnings
            .iter()
            .any(|warning| warning.contains("远端分支不会随之改名")));
        assert!(local_branch_exists(&env.repo, old));

        let renamed = rename_repository_branch(&path, old, "feature/new-name", true).expect("rename");
        assert!(renamed.executed);
        assert!(!local_branch_exists(&env.repo, old));
        assert!(local_branch_exists(&env.repo, "feature/new-name"));
        assert!(renamed
            .warnings
            .iter()
            .any(|warning| warning.contains(&format!("origin/{base}"))));

        // 名称占用与不存在的分支都要拒绝。
        assert!(rename_repository_branch(&path, "feature/new-name", &base, true).is_err());
        assert!(rename_repository_branch(&path, "feature/missing", "x", true).is_err());
    }

    #[test]
    fn rename_branch_refuses_when_checked_out_in_another_worktree() {
        let env = sandbox("rename-branch-worktree");
        let path = path_of(&env.repo);
        let branch = "feature/in-worktree";
        git_at(&env.repo, &["branch", branch, "HEAD"]);
        let worktree = env.root.join("wt-in-use");
        git_at(
            &env.repo,
            &["worktree", "add", "--quiet", &worktree.to_string_lossy(), branch],
        );

        let error = report_error(
            rename_repository_branch(&path, branch, "feature/moved", true),
            "被 Worktree 占用的分支不应直接改名",
        );
        assert!(error.contains("Worktree"), "{error}");
        assert!(local_branch_exists(&env.repo, branch));
        git_at(&env.repo, &["worktree", "remove", "--force", &worktree.to_string_lossy()]);
    }

    #[test]
    fn sets_and_clears_upstream_and_requires_cached_remote_ref() {
        let env = sandbox("upstream");
        let path = path_of(&env.repo);
        add_repository_remote(&path, "origin", &path_of(&env.remote), false).expect("add remote");
        let branch = push_and_cache_branch(&env, "origin");
        assert!(local_branch_upstreams(&env.repo)
            .into_iter()
            .all(|(item, _)| item != branch));

        // 远端不存在 / 未缓存的引用必须拒绝，避免写出无效跟踪配置。
        assert!(set_repository_branch_upstream(&path, &branch, Some("noremote/x")).is_err());
        let missing = report_error(
            set_repository_branch_upstream(&path, &branch, Some("origin/never-pushed")),
            "未缓存的远端分支应拒绝",
        );
        assert!(missing.contains("Fetch"), "{missing}");

        let set = set_repository_branch_upstream(&path, &branch, Some(&format!("origin/{branch}")))
            .expect("set upstream");
        assert!(set.executed);
        assert_eq!(config_of(&env.repo, &format!("branch.{branch}.remote")), "origin");
        assert_eq!(
            config_of(&env.repo, &format!("branch.{branch}.merge")),
            format!("refs/heads/{branch}")
        );

        let cleared = set_repository_branch_upstream(&path, &branch, None).expect("clear upstream");
        assert!(cleared.executed);
        assert!(cleared.summary.contains("已清除"));
        assert!(config_of(&env.repo, &format!("branch.{branch}.remote")).is_empty());
        assert!(local_branch_upstreams(&env.repo)
            .into_iter()
            .all(|(item, _)| item != branch));
    }

    // ---------------------------------------------------------------- 标签

    #[test]
    fn annotated_tag_records_tagger_date_and_message() {
        let env = sandbox("annotated-tag");
        let path = path_of(&env.repo);
        let created = create_repository_annotated_tag(&path, "v1.0.0", "HEAD", "首次正式发布", false, false)
            .expect("create annotated tag");
        assert!(created.executed);
        let tag = created
            .tags
            .iter()
            .find(|item| item.name == "v1.0.0")
            .expect("tag listed");
        assert_eq!(tag.kind, "annotated");
        assert!(!tag.signed, "只带说明的注释标签不该被报成已签名");
        assert!(!tag.tag_object.is_empty(), "注释标签必须有自己的标签对象");
        assert_eq!(tag.tagger, "Branchline Test");
        assert_eq!(tag.tagger_email, "branchline@example.com");
        assert!(tag.date.starts_with("20"), "日期应来自打标签时间：{}", tag.date);
        assert_eq!(tag.subject, "首次正式发布");
        assert!(tag.on_branch, "标签指向的提交在分支上");

        // 轻量标签对比：没有标签对象、没有打标签人。
        git_at(&env.repo, &["tag", "light-1", "HEAD"]);
        let details = list_repository_tag_details(&path).expect("list details");
        let light = details.iter().find(|item| item.name == "light-1").expect("light tag");
        assert_eq!(light.kind, "lightweight");
        assert!(light.tag_object.is_empty());
        assert!(light.tagger.is_empty());
        assert!(!light.signed);

        // 说明缺失、重名未开覆盖时必须报错。
        assert!(create_repository_annotated_tag(&path, "v1.1.0", "HEAD", "   ", false, false).is_err());
        let duplicate = report_error(
            create_repository_annotated_tag(&path, "v1.0.0", "HEAD", "重复", false, false),
            "重名应拒绝",
        );
        assert!(duplicate.contains("覆盖"), "{duplicate}");
    }

    #[test]
    fn force_moving_annotated_tag_needs_confirmation_and_reports_target_change() {
        let env = sandbox("tag-force");
        let path = path_of(&env.repo);
        create_repository_annotated_tag(&path, "v2.0.0", "HEAD", "旧位置", false, false).expect("first tag");
        let moved = extra_commit(&env.repo, "第二个提交");

        let preview =
            create_repository_annotated_tag(&path, "v2.0.0", "HEAD", "新位置", true, false).expect("preview force");
        assert!(!preview.executed, "未确认时不得移动标签");
        assert!(preview.requires_confirmation);
        assert!(preview
            .warnings
            .iter()
            .any(|warning| warning.contains("从") && warning.contains("移到")));

        let applied =
            create_repository_annotated_tag(&path, "v2.0.0", "HEAD", "新位置", true, true).expect("apply force");
        assert!(applied.executed);
        let tag = applied.tags.iter().find(|item| item.name == "v2.0.0").expect("tag");
        // %(…:short) 是 Git 自动长度的缩写，必须是完整哈希的前缀。
        assert!(moved.starts_with(&tag.target), "{moved} vs {:?}", tag.target);
        assert_eq!(tag.subject, "新位置");
    }

    #[test]
    fn delete_local_tag_previews_and_does_not_touch_remote() {
        let env = sandbox("delete-tag");
        let path = path_of(&env.repo);
        add_repository_remote(&path, "origin", &path_of(&env.remote), false).expect("add remote");
        create_repository_annotated_tag(&path, "v3.0.0", "HEAD", "待发版", false, false).expect("create tag");
        push_repository_tags(&path, "origin", &["v3.0.0".to_string()], false, false).expect("push tag");
        assert!(remote_tag_hash(&env.repo, "origin", "v3.0.0")
            .expect("ls-remote")
            .is_some());

        let preview = delete_repository_tag(&path, "v3.0.0", false).expect("preview delete");
        assert!(!preview.executed);
        assert!(preview.requires_confirmation);
        assert!(preview
            .warnings
            .iter()
            .any(|warning| warning.contains("远端同名标签")));
        assert!(tag_exists(&env.repo, "v3.0.0"), "预览不应删除本地标签");

        let deleted = delete_repository_tag(&path, "v3.0.0", true).expect("delete");
        assert!(deleted.executed);
        assert!(!tag_exists(&env.repo, "v3.0.0"));
        assert!(deleted.tags.iter().all(|item| item.name != "v3.0.0"));
        // 远端标签仍在 —— 删除远端是独立动作。
        assert!(remote_tag_hash(&env.repo, "origin", "v3.0.0")
            .expect("ls-remote after local delete")
            .is_some());
    }

    #[test]
    fn pushes_tags_and_deletes_remote_tag_with_confirmation_gate() {
        let env = sandbox("push-tag");
        let path = path_of(&env.repo);
        add_repository_remote(&path, "origin", &path_of(&env.remote), false).expect("add remote");
        create_repository_annotated_tag(&path, "v1.0.0", "HEAD", "第一个发布", false, false).expect("tag 1");
        create_repository_annotated_tag(&path, "v1.1.0", "HEAD", "第二个发布", false, false).expect("tag 2");

        let pushed = push_repository_tags(
            &path,
            "origin",
            &["v1.0.0".to_string(), "v1.1.0".to_string()],
            false,
            false,
        )
        .expect("push tags");
        assert!(pushed.executed);
        assert_eq!(pushed.summary, "已推送 2 个标签到 origin");
        for tag in ["v1.0.0", "v1.1.0"] {
            assert!(remote_tag_hash(&env.repo, "origin", tag)
                .expect("ls-remote")
                .is_some(), "{tag} 应在远端存在");
        }

        // 远端已有同名标签且对象不同：不加 force 只给预览，且远端保持不变。
        extra_commit(&env.repo, "第三个提交");
        create_repository_annotated_tag(&path, "v1.0.0", "HEAD", "改到别处", true, true).expect("move tag");
        let blocked = push_repository_tags(&path, "origin", &["v1.0.0".to_string()], false, false)
            .expect("conflict preview");
        assert!(!blocked.executed);
        assert!(blocked.requires_confirmation);
        assert_eq!(blocked.affected, vec!["refs/tags/v1.0.0".to_string()]);
        assert!(blocked
            .warnings
            .iter()
            .any(|warning| warning.contains("会被 Git 拒绝")));
        let before = remote_tag_hash(&env.repo, "origin", "v1.0.0").expect("hash before").unwrap();

        let forced = push_repository_tags(&path, "origin", &["v1.0.0".to_string()], true, true)
            .expect("force push");
        assert!(forced.executed);
        assert!(forced
            .warnings
            .iter()
            .any(|warning| warning.contains("已强制覆盖")));
        let after = remote_tag_hash(&env.repo, "origin", "v1.0.0").expect("hash after").unwrap();
        assert_ne!(before, after, "强推应改变远端标签对象");

        // 不存在的标签报错，不静默成功。
        assert!(push_repository_tags(&path, "origin", &["v9.9.9".to_string()], false, false).is_err());

        // 删除远端标签：先预览再执行。
        let preview = delete_repository_remote_tag(&path, "origin", "v1.1.0", false).expect("preview");
        assert!(!preview.executed);
        assert!(preview
            .warnings
            .iter()
            .any(|warning| warning.contains("所有协作者")));
        assert!(remote_tag_hash(&env.repo, "origin", "v1.1.0")
            .expect("still there")
            .is_some());

        let deleted = delete_repository_remote_tag(&path, "origin", "v1.1.0", true).expect("delete remote");
        assert!(deleted.executed);
        assert!(remote_tag_hash(&env.repo, "origin", "v1.1.0")
            .expect("gone")
            .is_none());
        // 本地标签保留，并在返回值里提醒。
        assert!(tag_exists(&env.repo, "v1.1.0"));
        assert!(deleted
            .warnings
            .iter()
            .any(|warning| warning.contains("本地标签 v1.1.0 仍然保留")));
    }

    /// 批量探测远端后，只应把「真正分歧的那个标签」报成冲突，且强推后全部落地。
    /// 这条用例同时守住性能改动：远端与本地各只查一次，比对必须仍然逐标签精确。
    #[test]
    fn batched_remote_lookup_flags_only_the_conflicting_tag_when_pushing_many() {
        let env = sandbox("push-many-batched");
        let path = path_of(&env.repo);
        add_repository_remote(&path, "origin", &path_of(&env.remote), false).expect("add remote");
        let names = ["v.1.0.0", "v.2.0.0", "v.3.0.0"];
        for name in names {
            create_repository_annotated_tag(&path, name, "HEAD", "首发", false, false)
                .unwrap_or_else(|error| panic!("{name}: {error}"));
        }
        let batch: Vec<String> = names.iter().map(|name| (*name).to_string()).collect();
        push_repository_tags(&path, "origin", &batch, false, false).expect("first batch push");
        assert_eq!(tags_owned_by_bare(&env.remote).len(), names.len());

        // 只把 v.2.0.0 移到新提交，制造唯一一个远端分歧。
        extra_commit(&env.repo, "只让一个标签分歧");
        create_repository_annotated_tag(&path, "v.2.0.0", "HEAD", "改到别处", true, true).expect("move one");

        let preview = push_repository_tags(&path, "origin", &batch, false, false).expect("conflict preview");
        assert!(!preview.executed);
        assert_eq!(
            preview.affected,
            vec!["refs/tags/v.2.0.0".to_string()],
            "批量比对不该把没分歧的标签一起报成冲突"
        );

        let forced = push_repository_tags(&path, "origin", &batch, true, true).expect("force push all");
        assert!(forced.executed);
        let owned = tags_owned_by_bare(&env.remote);
        for name in names {
            assert!(owned.contains(&name.to_string()), "{name} 应已落到远端：{owned:?}");
        }
        assert_eq!(
            peeled_tag_commit(&env.remote, "v.2.0.0"),
            git_at(&env.repo, &["rev-parse", "HEAD"]).trim(),
            "远端的 v.2.0.0 应被更新到新提交"
        );
    }

    #[test]
    fn delete_remote_tag_is_gone_from_the_bare_repository_itself() {
        let env = sandbox("remote-tag-server-side");
        let path = path_of(&env.repo);
        add_repository_remote(&path, "origin", &path_of(&env.remote), false).expect("add remote");

        create_repository_annotated_tag(&path, "v.serve", "HEAD", "服务端可见", false, false).expect("tag");
        push_repository_tags(&path, "origin", &["v.serve".to_string()], false, false).expect("push");
        // bare 仓库自己承认收到了标签，而且是带说明的注释标签对象。
        assert_eq!(tags_owned_by_bare(&env.remote), vec!["v.serve".to_string()]);
        assert_eq!(
            git_at(&env.remote, &["cat-file", "-t", "refs/tags/v.serve"]).trim(),
            "tag",
            "注释标签应在远端保存为 tag 对象而非轻量引用"
        );

        let preview = delete_repository_remote_tag(&path, "origin", "v.serve", false).expect("preview");
        assert!(!preview.executed);
        assert!(
            tags_owned_by_bare(&env.remote).contains(&"v.serve".to_string()),
            "未确认时远端标签必须原样保留"
        );

        let deleted = delete_repository_remote_tag(&path, "origin", "v.serve", true).expect("delete");
        assert!(deleted.executed);
        assert!(
            tags_owned_by_bare(&env.remote).is_empty(),
            "删除后 bare 仓库不应再持有该标签：{:?}",
            tags_owned_by_bare(&env.remote)
        );
        // 删除远端不牵连本地标签，且本地标签信息仍完整可读。
        assert!(tag_exists(&env.repo, "v.serve"));
        assert!(deleted
            .tags
            .iter()
            .any(|item| item.name == "v.serve" && item.subject == "服务端可见"));
    }

    #[test]
    fn signed_tag_reports_gpg_failure_without_faking_a_lightweight_tag() {
        let env = sandbox("signed-tag-failure");
        let path = path_of(&env.repo);
        // 指向一个不存在的密钥：Git 会失败，并且不会留下半截标签。
        git_at(&env.repo, &["config", "user.signingkey", "DEADBEEFDEADBEEF"]);
        git_at(&env.repo, &["config", "gpg.format", "openpgp"]);
        let error = report_error(
            create_repository_signed_tag(&path, "v-bad", "HEAD", "签名说明", None, false, false),
            "无可用私钥时签名必须失败",
        );
        assert!(error.contains("签名标签"), "{error}");
        assert!(error.contains("GPG") || error.contains("gpg"), "错误应说明签名原因：{error}");
        assert!(!tag_exists(&env.repo, "v-bad"), "签名失败不得创建标签");
    }

    #[test]
    fn signed_tag_is_created_and_verifiable_when_a_key_is_available() {
        let guard = GPG_LOCK.get_or_init(|| Mutex::new(())).lock();
        let sandbox_gpg = match gpg_signing_context() {
            Ok(context) => context,
            Err(reason) => {
                // 环境不具备签名条件时明确跳过并说明原因，绝不伪造「已签名」通过。
                eprintln!("SKIP signed_tag_is_created_and_verifiable_when_a_key_is_available：{reason}");
                drop(guard);
                return;
            }
        };
        let previous = std::env::var("GNUPGHOME").ok();
        std::env::set_var("GNUPGHOME", &sandbox_gpg.home);
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let env = sandbox("signed-tag-ok");
            let path = path_of(&env.repo);
            git_at(&env.repo, &["config", "user.signingkey", &sandbox_gpg.key_id]);
            git_at(&env.repo, &["config", "gpg.format", "openpgp"]);
            let created =
                create_repository_signed_tag(&path, "v-signed", "HEAD", "已签名发布", None, false, false)
                    .expect("create signed tag");
            assert!(created.executed);
            let tag = created.tags.iter().find(|item| item.name == "v-signed").expect("tag listed");
            assert_eq!(tag.kind, "annotated", "签名标签必然是注释标签");
            assert!(tag.signed, "签名标签应被识别为已签名");
            assert!(!tag.tag_object.is_empty());
            assert_eq!(tag.subject, "已签名发布");
            // 用 git 自己复核签名，确保不是「自称已签名」。
            git_at(&env.repo, &["verify-tag", "v-signed"]);
        }));
        match previous {
            Some(value) => std::env::set_var("GNUPGHOME", value),
            None => std::env::remove_var("GNUPGHOME"),
        }
        drop(guard);
        kill_gpg_agent(&sandbox_gpg.home);
        let _ = std::fs::remove_dir_all(&sandbox_gpg.home);
        outcome.expect("signed tag assertions");
    }

    struct GpgContext {
        home: PathBuf,
        key_id: String,
    }

    /// gpg-agent 的 socket 位于 `<GNUPGHOME>/S.gpg-agent`，而 Unix socket 路径上限只有
    /// 104 字节；macOS 的 `temp_dir()` 是百余字符的深层路径，直接拿来当 GNUPGHOME 会让
    /// 密钥生成以「File name too long」失败。因此固定用 `/tmp` 下的短目录。
    fn gpg_home_root() -> PathBuf {
        let short = Path::new("/tmp");
        if short.is_dir() {
            short.to_path_buf()
        } else {
            std::env::temp_dir()
        }
    }

    fn kill_gpg_agent(home: &Path) {
        let _ = Command::new("gpgconf")
            .args(["--homedir", &home.to_string_lossy(), "--kill", "gpg-agent"])
            .output();
    }

    /// 在隔离的 GNUPGHOME 里生成一枚一次性密钥；不可用时返回原因，由用例打印后跳过。
    fn gpg_signing_context() -> Result<GpgContext, String> {
        let home = gpg_home_root().join(format!(
            "bl-gpg-{}-{}",
            std::process::id(),
            SCRATCH_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).map_err(|error| format!("创建 GNUPGHOME 失败：{error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // gpg 会对权限开放的钥匙箱目录告警，某些配置下直接拒绝起 agent。
            let _ = std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700));
        }
        let run = |args: &[&str]| {
            Command::new("gpg")
                .arg("--homedir")
                .arg(&home)
                .args(args)
                .output()
                .map_err(|error| format!("本机没有可用的 gpg：{error}"))
        };
        let cleanup = || {
            kill_gpg_agent(&home);
            let _ = std::fs::remove_dir_all(&home);
        };
        let version = run(&["--version"])?;
        if !version.status.success() {
            cleanup();
            return Err("本机 gpg 不可用".to_string());
        }
        let generated = run(&[
            "--batch",
            "--no-tty",
            "--pinentry-mode",
            "loopback",
            "--passphrase",
            "",
            "--quick-gen-key",
            "Branchline Test <branchline@example.com>",
            "rsa2048",
            "sign",
            "never",
        ])?;
        if !generated.status.success() {
            let reason = String::from_utf8_lossy(&generated.stderr).trim().to_string();
            cleanup();
            return Err(format!("gpg 无法在隔离目录里生成签名密钥：{reason}"));
        }
        let listed = run(&["--batch", "--list-secret-keys", "--with-colons"])?;
        if !listed.status.success() {
            cleanup();
            return Err("gpg 生成密钥后无法列出钥匙箱".to_string());
        }
        let text = String::from_utf8_lossy(&listed.stdout);
        // fpr 记录的第 10 字段是密钥指纹，取私钥段里的第一个。
        let mut after_secret = false;
        let mut key_id = String::new();
        for record in text.lines() {
            let fields: Vec<&str> = record.split(':').collect();
            match fields.first().copied() {
                Some("sec") => after_secret = true,
                Some("fpr") if after_secret && fields.len() > 9 => {
                    key_id = fields[9].to_string();
                    break;
                }
                _ => {}
            }
        }
        if key_id.is_empty() {
            cleanup();
            return Err("隔离钥匙箱里没有拿到私钥指纹".to_string());
        }
        Ok(GpgContext { home, key_id })
    }
}
