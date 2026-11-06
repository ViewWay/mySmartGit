//! Gitflow 工作流（W3-4）：配置读写、分支分组、start / finish。
//!
//! 本模块刻意与 git.rs 分离：git.rs 体积已大，且并行轨道正在改动 checkout /
//! merge / conflict 区域。这里只通过 `crate::git` 暴露的公共入口
//! （`repository_root` / `git_output` / `git_output_owned`）复用统一的 Git 进程
//! 调用与命令日志基础设施。
//!
//! 安全约束（红线）：
//! - 所有 Git 调用都以参数数组发起，绝不拼接 shell 字符串，绝不使用 `sh -c`；
//! - 分支名 / 前缀 / 标签名先过本地规则，再交给 `git check-ref-format` 裁决；
//!   以 `-` 开头的输入、换行 / NUL / 控制字符一律拒绝（选项注入与配置注入）；
//! - `finish_gitflow_branch` 只做本地 `--no-ff` 合并、可选打标签、删除本地分支，
//!   **绝不 push**；
//! - 合并冲突时**不自动 abort**：保留 Git 的 MERGE_HEAD 状态，返回 conflicts=true
//!   与 guidance，让用户在现有「操作」页继续解决或明确中止；
//! - `support/*` 是长期维护分支，不参与 finish（只允许 start）。

// 命令包装由 commands.rs 注册、lib.rs 挂载，那两处由主仓串行合并；
// 注册落地前这些入口在 crate 内没有调用点，故在此放行 dead_code。
#![allow(dead_code)]

use crate::git;
use serde::{Deserialize, Serialize};
use std::path::Path;

const DEFAULT_DEVELOP: &str = "develop";
const DEFAULT_FEATURE_PREFIX: &str = "feature/";
const DEFAULT_RELEASE_PREFIX: &str = "release/";
const DEFAULT_HOTFIX_PREFIX: &str = "hotfix/";
const DEFAULT_SUPPORT_PREFIX: &str = "support/";
const DEFAULT_TAG_PREFIX: &str = "";
const MAX_NAME_LEN: usize = 200;
const MAX_PREFIX_LEN: usize = 100;
const MAX_TAG_MESSAGE_LEN: usize = 5_000;

/// 本地 git config 的键名（与 git-flow 传统键保持一致，便于与命令行工作流互换）。
const KEY_MAIN: &str = "gitflow.branch.master";
const KEY_DEVELOP: &str = "gitflow.branch.develop";
const KEY_FEATURE: &str = "gitflow.prefix.feature";
const KEY_RELEASE: &str = "gitflow.prefix.release";
const KEY_HOTFIX: &str = "gitflow.prefix.hotfix";
const KEY_SUPPORT: &str = "gitflow.prefix.support";
const KEY_TAG: &str = "gitflow.prefix.versiontag";

// =============================================================================================
// 数据契约（与 packages/git-models 尾部同名类型对齐）
// =============================================================================================

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitflowConfig {
    /// 主干分支：默认 main，不存在而 master 存在时用 master。
    pub main_branch: String,
    pub develop_branch: String,
    pub feature_prefix: String,
    pub release_prefix: String,
    pub hotfix_prefix: String,
    pub support_prefix: String,
    /// 发布标签前缀，默认空（即 release/1.0.0 打成 1.0.0）。
    pub tag_prefix: String,
}

impl Default for GitflowConfig {
    fn default() -> Self {
        Self {
            main_branch: "main".to_string(),
            develop_branch: DEFAULT_DEVELOP.to_string(),
            feature_prefix: DEFAULT_FEATURE_PREFIX.to_string(),
            release_prefix: DEFAULT_RELEASE_PREFIX.to_string(),
            hotfix_prefix: DEFAULT_HOTFIX_PREFIX.to_string(),
            support_prefix: DEFAULT_SUPPORT_PREFIX.to_string(),
            tag_prefix: DEFAULT_TAG_PREFIX.to_string(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitflowBranches {
    pub main_branch: String,
    pub develop_branch: String,
    /// 各组只返回去掉前缀后的短名，start / finish 直接接收短名。
    pub feature: Vec<String>,
    pub release: Vec<String>,
    pub hotfix: Vec<String>,
    pub support: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitflowStartReport {
    pub kind: String,
    pub branch: String,
    pub base: String,
    pub head: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GitflowFinishOptions {
    pub tag: bool,
    pub tag_message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitflowStepReport {
    pub action: String,
    /// completed / skipped / failed / conflict。
    pub status: String,
    pub detail: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitflowFinishReport {
    pub kind: String,
    pub branch: String,
    pub completed: bool,
    /// 为 true 时 Git 合并状态仍保留（MERGE_HEAD 存在），未自动 abort。
    pub conflicts: bool,
    pub steps: Vec<GitflowStepReport>,
    /// 冲突或失败时的可操作指引；成功为 None。
    pub guidance: Option<String>,
    pub head_before: String,
    pub head_after: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Feature,
    Release,
    Hotfix,
    Support,
}

impl Kind {
    fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim() {
            "feature" => Ok(Self::Feature),
            "release" => Ok(Self::Release),
            "hotfix" => Ok(Self::Hotfix),
            "support" => Ok(Self::Support),
            other => Err(format!(
                "未知的 Gitflow 分支类型：{other}（可选 feature/release/hotfix/support）"
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Feature => "feature",
            Self::Release => "release",
            Self::Hotfix => "hotfix",
            Self::Support => "support",
        }
    }

    fn prefix(self, config: &GitflowConfig) -> &str {
        match self {
            Self::Feature => &config.feature_prefix,
            Self::Release => &config.release_prefix,
            Self::Hotfix => &config.hotfix_prefix,
            Self::Support => &config.support_prefix,
        }
    }

    /// feature 从 develop 起；release / hotfix / support 从 main 起。
    fn default_base(self, config: &GitflowConfig) -> &str {
        match self {
            Self::Feature => &config.develop_branch,
            Self::Release | Self::Hotfix | Self::Support => &config.main_branch,
        }
    }
}

// =============================================================================================
// Git 调用与校验 helper
// =============================================================================================

fn optional(root: &Path, args: &[&str]) -> String {
    git::git_output(root, args).unwrap_or_default()
}

fn lines_of(value: &str) -> Vec<String> {
    value
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn branch_exists(root: &Path, name: &str) -> bool {
    git::git_output_owned(
        root,
        &[
            "rev-parse".to_string(),
            "--verify".to_string(),
            "--quiet".to_string(),
            format!("refs/heads/{name}"),
        ],
    )
    .is_ok()
}

fn tag_exists(root: &Path, tag: &str) -> bool {
    git::git_output_owned(
        root,
        &[
            "rev-parse".to_string(),
            "--verify".to_string(),
            "--quiet".to_string(),
            format!("refs/tags/{tag}"),
        ],
    )
    .is_ok()
}

fn head_of(root: &Path) -> String {
    optional(root, &["rev-parse", "HEAD"]).trim().to_string()
}

/// Git 合并进行中（冲突未解决）时 MERGE_HEAD 存在；这是「不能自动 abort」的判据。
fn merge_in_progress(root: &Path) -> bool {
    git::git_output(root, &["rev-parse", "--quiet", "--verify", "MERGE_HEAD"]).is_ok()
}

fn config_value(root: &Path, key: &str) -> Option<String> {
    git::git_output(root, &["config", "--local", "--get", key])
        .ok()
        .map(|value| value.trim().to_string())
}

fn write_config(root: &Path, key: &str, value: &str) -> Result<(), String> {
    git::git_output(root, &["config", "--local", "--replace-all", key, value])
        .map(|_| ())
        .map_err(|error| format!("写入 Gitflow 配置 {key} 失败：{error}"))
}

/// 通用单行输入校验：拒绝空串、超长、前导 `-`、空白与控制字符。
fn ensure_single_line(value: &str, label: &str, max_len: usize) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{label}不能为空"));
    }
    if value.chars().count() > max_len {
        return Err(format!("{label}过长（上限 {max_len} 字符）"));
    }
    if value.starts_with('-') {
        return Err(format!("{label}不能以 - 开头，否则会被 Git 当成命令选项"));
    }
    if value.chars().any(|character| {
        character == '\n' || character == '\r' || character == '\0' || character.is_control()
    }) {
        return Err(format!("{label}不能包含换行、NUL 或其他控制字符"));
    }
    if value.chars().any(char::is_whitespace) {
        return Err(format!("{label}不能包含空白字符"));
    }
    Ok(())
}

/// 分支名：本地规则 + `git check-ref-format --branch` 双重把关。
fn validate_branch_name(root: &Path, raw: &str, label: &str) -> Result<String, String> {
    let name = raw.trim();
    ensure_single_line(name, label, MAX_NAME_LEN)?;
    if name == "HEAD" {
        return Err(format!("{label}不能是 HEAD"));
    }
    git::git_output_owned(
        root,
        &[
            "check-ref-format".to_string(),
            "--branch".to_string(),
            name.to_string(),
        ],
    )
    .map_err(|_| format!("{label}不符合 Git 分支命名规则：{name}"))?;
    Ok(name.to_string())
}

/// 标签名：拒绝前导 `-` / 空白 / 控制字符后交给 `git check-ref-format refs/tags/<name>`。
fn validate_tag_name(root: &Path, raw: &str) -> Result<String, String> {
    let tag = raw.trim();
    ensure_single_line(tag, "标签名", MAX_NAME_LEN)?;
    git::git_output_owned(
        root,
        &["check-ref-format".to_string(), format!("refs/tags/{tag}")],
    )
    .map_err(|_| format!("标签名不符合 Git 引用命名规则：{tag}"))?;
    Ok(tag.to_string())
}

/// 前缀校验：构造一个探针分支 / 标签，让 Git 判断前缀拼出来的引用是否合法。
fn validate_prefix(
    root: &Path,
    raw: &str,
    label: &str,
    allow_empty: bool,
) -> Result<String, String> {
    let prefix = raw.trim();
    if prefix.is_empty() {
        return if allow_empty {
            Ok(String::new())
        } else {
            Err(format!("{label}不能为空"))
        };
    }
    ensure_single_line(prefix, label, MAX_PREFIX_LEN)?;
    let probe = format!("{prefix}probe");
    git::git_output_owned(
        root,
        &[
            "check-ref-format".to_string(),
            "--branch".to_string(),
            probe,
        ],
    )
    .map_err(|_| format!("{label}不能组成合法的分支名前缀：{prefix}"))?;
    Ok(prefix.to_string())
}

fn validate_tag_prefix(root: &Path, raw: &str) -> Result<String, String> {
    let prefix = raw.trim();
    if prefix.is_empty() {
        return Ok(String::new());
    }
    ensure_single_line(prefix, "标签前缀", MAX_PREFIX_LEN)?;
    let probe = format!("{prefix}1.0.0");
    git::git_output_owned(
        root,
        &["check-ref-format".to_string(), format!("refs/tags/{probe}")],
    )
    .map_err(|_| format!("标签前缀不能组成合法的标签名：{prefix}"))?;
    Ok(prefix.to_string())
}

/// 配置缺失时的主干默认值：main 优先；main 不存在而 master 存在则用 master。
fn detect_default_main(root: &Path) -> String {
    if branch_exists(root, "main") {
        "main".to_string()
    } else if branch_exists(root, "master") {
        "master".to_string()
    } else {
        "main".to_string()
    }
}

fn grouped(branches: &[String], prefix: &str) -> Vec<String> {
    if prefix.is_empty() {
        return Vec::new();
    }
    let mut names: Vec<String> = branches
        .iter()
        .filter_map(|branch| branch.strip_prefix(prefix))
        .filter(|leaf| !leaf.is_empty())
        .map(ToString::to_string)
        .collect();
    names.sort();
    names
}

/// 用户输入短名时去掉自己那层前缀；`feature/foo` 与 `foo` 等价。
fn leaf_name(prefix: &str, raw: &str) -> String {
    let trimmed = raw.trim();
    if prefix.is_empty() {
        return trimmed.to_string();
    }
    trimmed.strip_prefix(prefix).unwrap_or(trimmed).to_string()
}

fn resolve_flow_branch(
    root: &Path,
    kind: Kind,
    config: &GitflowConfig,
    raw_name: &str,
) -> Result<(String, String), String> {
    let leaf = leaf_name(kind.prefix(config), raw_name);
    // 先按用户输入本身把关：`feature/-x` 虽然是合法引用，但输入以 - 开头仍属选项注入。
    ensure_single_line(&leaf, "分支名", MAX_NAME_LEN)?;
    let full = format!("{}{}", kind.prefix(config), leaf);
    let validated = validate_branch_name(root, &full, "分支名")?;
    if validated == config.main_branch || validated == config.develop_branch {
        return Err(format!("不能对 {validated} 执行 Gitflow 分支操作"));
    }
    Ok((leaf, validated))
}

fn step(
    report: &mut GitflowFinishReport,
    action: impl Into<String>,
    status: &str,
    detail: Option<String>,
) {
    report.steps.push(GitflowStepReport {
        action: action.into(),
        status: status.to_string(),
        detail,
    });
}

/// 失败收尾：保留当前 Git 状态，绝不 abort；head_after 取当前 HEAD。
fn fail_report(
    root: &Path,
    mut report: GitflowFinishReport,
    action: String,
    status: &str,
    error: String,
    guidance: String,
    conflicts: bool,
) -> GitflowFinishReport {
    step(&mut report, action, status, Some(error));
    report.completed = false;
    report.conflicts = conflicts;
    report.guidance = Some(guidance);
    report.head_after = head_of(root);
    report
}

fn checkout(root: &Path, branch: &str) -> Result<(), String> {
    git::git_output(root, &["checkout", branch])
        .map(|_| ())
        .map_err(|error| format!("切换到 {branch} 失败：{error}"))
}

/// `--no-ff --no-edit`：始终生成合并提交，且不启动编辑器（GUI 进程没有终端）。
fn merge_no_ff(root: &Path, branch: &str) -> Result<(), String> {
    git::git_output_owned(
        root,
        &[
            "merge".to_string(),
            "--no-ff".to_string(),
            "--no-edit".to_string(),
            branch.to_string(),
        ],
    )
    .map(|_| ())
    .map_err(|error| format!("合并 {branch} 失败：{error}"))
}

fn create_tag(root: &Path, tag: &str, message: Option<&str>) -> Result<(), String> {
    let mut args = vec!["tag".to_string()];
    if let Some(message) = message {
        args.push("-a".to_string());
        args.push(tag.to_string());
        args.push("-m".to_string());
        args.push(message.to_string());
    } else {
        args.push(tag.to_string());
    }
    git::git_output_owned(root, &args)
        .map(|_| ())
        .map_err(|error| format!("创建标签 {tag} 失败：{error}"))
}

fn delete_branch(root: &Path, branch: &str) -> Result<(), String> {
    git::git_output(root, &["branch", "-d", branch])
        .map(|_| ())
        .map_err(|error| format!("删除分支 {branch} 失败：{error}"))
}

// =============================================================================================
// 公共入口
// =============================================================================================

/// 读取本地 Gitflow 配置；缺失键按默认值补齐（main 会探测 main/master）。
pub fn read_gitflow_config(repository_path: &str) -> Result<GitflowConfig, String> {
    let root = git::repository_root(repository_path)?;
    let main_branch = config_value(&root, KEY_MAIN)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| detect_default_main(&root));
    let develop_branch = config_value(&root, KEY_DEVELOP)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_DEVELOP.to_string());
    let prefix_or = |key: &str, default: &str| {
        config_value(&root, key)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| default.to_string())
    };
    Ok(GitflowConfig {
        main_branch,
        develop_branch,
        feature_prefix: prefix_or(KEY_FEATURE, DEFAULT_FEATURE_PREFIX),
        release_prefix: prefix_or(KEY_RELEASE, DEFAULT_RELEASE_PREFIX),
        hotfix_prefix: prefix_or(KEY_HOTFIX, DEFAULT_HOTFIX_PREFIX),
        support_prefix: prefix_or(KEY_SUPPORT, DEFAULT_SUPPORT_PREFIX),
        tag_prefix: config_value(&root, KEY_TAG).unwrap_or_else(|| DEFAULT_TAG_PREFIX.to_string()),
    })
}

/// 写入本地 git config（gitflow.* 键），返回规范化后的配置。
pub fn write_gitflow_config(
    repository_path: &str,
    config: &GitflowConfig,
) -> Result<GitflowConfig, String> {
    let root = git::repository_root(repository_path)?;
    let main_branch = validate_branch_name(&root, &config.main_branch, "主干分支")?;
    let develop_branch = validate_branch_name(&root, &config.develop_branch, "develop 分支")?;
    if main_branch == develop_branch {
        return Err("主干分支与 develop 分支不能相同".to_string());
    }
    let feature_prefix = validate_prefix(&root, &config.feature_prefix, "feature 前缀", false)?;
    let release_prefix = validate_prefix(&root, &config.release_prefix, "release 前缀", false)?;
    let hotfix_prefix = validate_prefix(&root, &config.hotfix_prefix, "hotfix 前缀", false)?;
    let support_prefix = validate_prefix(&root, &config.support_prefix, "support 前缀", false)?;
    let tag_prefix = validate_tag_prefix(&root, &config.tag_prefix)?;

    write_config(&root, KEY_MAIN, &main_branch)?;
    write_config(&root, KEY_DEVELOP, &develop_branch)?;
    write_config(&root, KEY_FEATURE, &feature_prefix)?;
    write_config(&root, KEY_RELEASE, &release_prefix)?;
    write_config(&root, KEY_HOTFIX, &hotfix_prefix)?;
    write_config(&root, KEY_SUPPORT, &support_prefix)?;
    write_config(&root, KEY_TAG, &tag_prefix)?;

    read_gitflow_config(repository_path)
}

/// 读取本地分支并按 feature/release/hotfix/support 前缀分组（短名）。
pub fn read_gitflow_branches(repository_path: &str) -> Result<GitflowBranches, String> {
    let root = git::repository_root(repository_path)?;
    let config = read_gitflow_config(repository_path)?;
    let branches = lines_of(&optional(
        &root,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    ));
    Ok(GitflowBranches {
        main_branch: config.main_branch.clone(),
        develop_branch: config.develop_branch.clone(),
        feature: grouped(&branches, &config.feature_prefix),
        release: grouped(&branches, &config.release_prefix),
        hotfix: grouped(&branches, &config.hotfix_prefix),
        support: grouped(&branches, &config.support_prefix),
    })
}

/// 创建并切换到 Gitflow 分支：feature 默认从 develop，其余默认从 main。
pub fn create_gitflow_branch(
    repository_path: &str,
    kind: &str,
    name: &str,
    base: Option<&str>,
) -> Result<GitflowStartReport, String> {
    let root = git::repository_root(repository_path)?;
    let kind = Kind::parse(kind)?;
    let config = read_gitflow_config(repository_path)?;
    let (_leaf, full) = resolve_flow_branch(&root, kind, &config, name)?;
    if branch_exists(&root, &full) {
        return Err(format!("分支 {full} 已存在"));
    }
    let base_raw = base
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| kind.default_base(&config));
    let base = validate_branch_name(&root, base_raw, "基础分支")?;
    if !branch_exists(&root, &base) {
        return Err(format!(
            "基础分支 {base} 不存在；请先创建它，或改用已有的基础分支"
        ));
    }

    git::git_output(&root, &["checkout", "-b", &full, &base]).map_err(|error| {
        format!("创建并切换到 {full} 失败：{error}（请先提交或暂存工作区改动）")
    })?;
    Ok(GitflowStartReport {
        kind: kind.as_str().to_string(),
        branch: full,
        base,
        head: head_of(&root),
    })
}

/// 完成 Gitflow 分支：feature 合到 develop；release/hotfix 合到 main 与 develop，
/// 可选打标签，最后删除分支。冲突时保留合并状态并返回 guidance，绝不 push。
pub fn complete_gitflow_branch(
    repository_path: &str,
    kind: &str,
    name: &str,
    options: &GitflowFinishOptions,
) -> Result<GitflowFinishReport, String> {
    let root = git::repository_root(repository_path)?;
    let kind = Kind::parse(kind)?;
    if kind == Kind::Support {
        return Err("support 分支用于长期维护，不执行完成操作；如需结束维护请手动删除".to_string());
    }
    let config = read_gitflow_config(repository_path)?;
    let main = config.main_branch.clone();
    let develop = config.develop_branch.clone();
    if main == develop {
        return Err("Gitflow 配置错误：主干分支与 develop 分支相同，请先修正配置".to_string());
    }
    let (leaf, full) = resolve_flow_branch(&root, kind, &config, name)?;
    if !branch_exists(&root, &full) {
        return Err(format!("分支 {full} 不存在"));
    }
    // 目标分支必须在动任何合并之前就存在，避免「合了一半才发现 develop 没建」。
    let targets: &[&str] = if kind == Kind::Feature {
        &[&develop]
    } else {
        &[&main, &develop]
    };
    for target in targets {
        if !branch_exists(&root, target) {
            return Err(format!(
                "目标分支 {target} 不存在；请先创建 {target} 或修正 Gitflow 配置后再完成分支"
            ));
        }
    }
    if options.tag && kind == Kind::Feature {
        return Err("只有 release/hotfix 分支完成时才能打标签".to_string());
    }

    let tag_message = options
        .tag_message
        .as_deref()
        .map(str::trim)
        .filter(|message| !message.is_empty());
    if let Some(message) = tag_message {
        if message.chars().count() > MAX_TAG_MESSAGE_LEN {
            return Err(format!("标签说明过长（上限 {MAX_TAG_MESSAGE_LEN} 字符）"));
        }
        if message.chars().any(|character| {
            character == '\0' || (character.is_control() && character != '\n' && character != '\t')
        }) {
            return Err("标签说明不能包含 NUL 或其他控制字符".to_string());
        }
    }

    let tag = if options.tag {
        let tag_name = validate_tag_name(&root, &format!("{}{}", config.tag_prefix, leaf))?;
        if tag_exists(&root, &tag_name) {
            return Err(format!("标签 {tag_name} 已存在；请改名或取消打标签"));
        }
        Some(tag_name)
    } else {
        None
    };

    let head_before = head_of(&root);
    let mut report = GitflowFinishReport {
        kind: kind.as_str().to_string(),
        branch: full.clone(),
        completed: false,
        conflicts: false,
        steps: Vec::new(),
        guidance: None,
        head_before,
        head_after: head_of(&root),
    };

    if kind == Kind::Feature {
        if let Err(error) = checkout(&root, &develop) {
            return Ok(fail_report(
                &root,
                report,
                format!("checkout {develop}"),
                "failed",
                error,
                format!("未执行任何合并，分支 {full} 保持不变；请先处理工作区改动后重试"),
                false,
            ));
        }
        step(
            &mut report,
            format!("checkout {develop}"),
            "completed",
            None,
        );

        if let Err(error) = merge_no_ff(&root, &full) {
            let conflicts = merge_in_progress(&root);
            let status = if conflicts { "conflict" } else { "failed" };
            let guidance = if conflicts {
                format!(
                    "合并 {full} 到 {develop} 时产生冲突；Git 合并状态已保留（MERGE_HEAD 存在）。\
                     请到现有「操作」页解决冲突后继续提交，或明确中止合并。本操作没有自动 abort，也未删除分支。"
                )
            } else {
                format!("合并 {full} 到 {develop} 失败；未自动清理任何状态，请检查后重试或手动处理")
            };
            return Ok(fail_report(
                &root,
                report,
                format!("merge --no-ff {full} -> {develop}"),
                status,
                error,
                guidance,
                conflicts,
            ));
        }
        step(
            &mut report,
            format!("merge --no-ff {full} -> {develop}"),
            "completed",
            None,
        );

        if let Err(error) = delete_branch(&root, &full) {
            return Ok(fail_report(
                &root,
                report,
                format!("delete {full}"),
                "failed",
                error,
                format!("已合并到 {develop}，但删除分支 {full} 失败；请手动删除后重试"),
                false,
            ));
        }
        step(&mut report, format!("delete {full}"), "completed", None);
    } else {
        // release / hotfix：先合入 main（可在 main 上打标签），再合回 develop。
        if let Err(error) = checkout(&root, &main) {
            return Ok(fail_report(
                &root,
                report,
                format!("checkout {main}"),
                "failed",
                error,
                format!("未执行任何合并，分支 {full} 保持不变；请先处理工作区改动后重试"),
                false,
            ));
        }
        step(&mut report, format!("checkout {main}"), "completed", None);

        if let Err(error) = merge_no_ff(&root, &full) {
            let conflicts = merge_in_progress(&root);
            let status = if conflicts { "conflict" } else { "failed" };
            let guidance = if conflicts {
                format!(
                    "合并 {full} 到 {main} 时产生冲突；Git 合并状态已保留（MERGE_HEAD 存在）。\
                     请到现有「操作」页解决冲突后继续提交，或明确中止合并。本操作没有自动 abort，也未删除分支。"
                )
            } else {
                format!("合并 {full} 到 {main} 失败；未自动清理任何状态，请检查后重试或手动处理")
            };
            return Ok(fail_report(
                &root,
                report,
                format!("merge --no-ff {full} -> {main}"),
                status,
                error,
                guidance,
                conflicts,
            ));
        }
        step(
            &mut report,
            format!("merge --no-ff {full} -> {main}"),
            "completed",
            None,
        );

        if let Some(tag_name) = tag.as_deref() {
            if let Err(error) = create_tag(&root, tag_name, tag_message) {
                return Ok(fail_report(
                    &root,
                    report,
                    format!("tag {tag_name}"),
                    "failed",
                    error,
                    format!(
                        "{full} 已合并到 {main}，但标签 {tag_name} 创建失败；分支未删除。\
                         请修正标签后重试，或手动打标签并合并回 {develop}"
                    ),
                    false,
                ));
            }
            step(
                &mut report,
                format!("tag {tag_name}"),
                "completed",
                tag_message.map(ToString::to_string),
            );
        } else {
            step(
                &mut report,
                "tag".to_string(),
                "skipped",
                Some("未选择打标签".to_string()),
            );
        }

        if let Err(error) = checkout(&root, &develop) {
            return Ok(fail_report(
                &root,
                report,
                format!("checkout {develop}"),
                "failed",
                error,
                format!(
                    "已合并到 {main}，但切换到 {develop} 失败；合并回 develop 与删除分支尚未执行，请手动继续"
                ),
                false,
            ));
        }
        step(
            &mut report,
            format!("checkout {develop}"),
            "completed",
            None,
        );

        if let Err(error) = merge_no_ff(&root, &full) {
            let conflicts = merge_in_progress(&root);
            let status = if conflicts { "conflict" } else { "failed" };
            let guidance = if conflicts {
                format!(
                    "合并 {full} 到 {develop} 时产生冲突；Git 合并状态已保留（MERGE_HEAD 存在）。\
                     {main} 的合并已完成，请到现有「操作」页解决冲突后继续提交，或明确中止；本操作未删除分支。"
                )
            } else {
                format!("合并 {full} 到 {develop} 失败；未自动清理任何状态，请检查后重试或手动处理")
            };
            return Ok(fail_report(
                &root,
                report,
                format!("merge --no-ff {full} -> {develop}"),
                status,
                error,
                guidance,
                conflicts,
            ));
        }
        step(
            &mut report,
            format!("merge --no-ff {full} -> {develop}"),
            "completed",
            None,
        );

        if let Err(error) = delete_branch(&root, &full) {
            return Ok(fail_report(
                &root,
                report,
                format!("delete {full}"),
                "failed",
                error,
                format!("已合并到 {main} 与 {develop}，但删除分支 {full} 失败；请手动删除"),
                false,
            ));
        }
        step(&mut report, format!("delete {full}"), "completed", None);
    }

    report.completed = true;
    report.head_after = head_of(&root);
    Ok(report)
}

// =============================================================================================
// Tauri 命令包装（主代理在 commands.rs / lib.rs 注册时可直接引用本模块函数）
// =============================================================================================

#[tauri::command]
pub async fn load_gitflow_config(repository_path: String) -> Result<GitflowConfig, String> {
    tauri::async_runtime::spawn_blocking(move || read_gitflow_config(&repository_path))
        .await
        .map_err(|error| format!("读取 Gitflow 配置失败：{error}"))?
}

#[tauri::command]
pub async fn save_gitflow_config(
    repository_path: String,
    config: GitflowConfig,
) -> Result<GitflowConfig, String> {
    tauri::async_runtime::spawn_blocking(move || write_gitflow_config(&repository_path, &config))
        .await
        .map_err(|error| format!("保存 Gitflow 配置失败：{error}"))?
}

#[tauri::command]
pub async fn list_gitflow_branches(repository_path: String) -> Result<GitflowBranches, String> {
    tauri::async_runtime::spawn_blocking(move || read_gitflow_branches(&repository_path))
        .await
        .map_err(|error| format!("读取 Gitflow 分支失败：{error}"))?
}

#[tauri::command]
pub async fn start_gitflow_branch(
    repository_path: String,
    kind: String,
    name: String,
    base: Option<String>,
) -> Result<GitflowStartReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_gitflow_branch(&repository_path, &kind, &name, base.as_deref())
    })
    .await
    .map_err(|error| format!("创建 Gitflow 分支失败：{error}"))?
}

#[tauri::command]
pub async fn finish_gitflow_branch(
    repository_path: String,
    kind: String,
    name: String,
    options: GitflowFinishOptions,
) -> Result<GitflowFinishReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        complete_gitflow_branch(&repository_path, &kind, &name, &options)
    })
    .await
    .map_err(|error| format!("完成 Gitflow 分支失败：{error}"))?
}

// =============================================================================================
// 测试
// =============================================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static SCRATCH_SEQ: AtomicUsize = AtomicUsize::new(0);

    struct Sandbox {
        root: PathBuf,
        repo: PathBuf,
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn sandbox(label: &str) -> Sandbox {
        git::isolate_test_git_environment();
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let seq = SCRATCH_SEQ.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "branchline-flow-test-{label}-{}-{unique}-{seq}",
            std::process::id()
        ));
        let repo = root.join("work");
        std::fs::create_dir_all(&repo).expect("create sandbox repository");
        git_at(&repo, &["init", "--quiet"]);
        git_at(&repo, &["config", "user.name", "Branchline Test"]);
        git_at(&repo, &["config", "user.email", "branchline@example.com"]);
        git_at(&repo, &["config", "commit.gpgsign", "false"]);
        git_at(&repo, &["config", "tag.gpgsign", "false"]);
        std::fs::write(repo.join("README.md"), "base\n").expect("write readme");
        git_at(&repo, &["add", "README.md"]);
        git_at(&repo, &["commit", "--quiet", "-m", "初始提交"]);
        Sandbox { root, repo }
    }

    fn git_at(dir: &Path, args: &[&str]) -> String {
        git::git_output(dir, args).expect("fixture git command")
    }

    fn path_of(dir: &Path) -> String {
        dir.to_string_lossy().to_string()
    }

    fn current_branch(dir: &Path) -> String {
        git_at(dir, &["branch", "--show-current"])
            .trim()
            .to_string()
    }

    fn config_of(dir: &Path, key: &str) -> String {
        git::git_output(dir, &["config", "--local", "--get", key])
            .unwrap_or_default()
            .trim()
            .to_string()
    }

    fn commit_file(dir: &Path, name: &str, content: &str, message: &str) {
        std::fs::write(dir.join(name), content).expect("write file");
        git_at(dir, &["add", name]);
        git_at(dir, &["commit", "--quiet", "-m", message]);
    }

    fn create_develop(env: &Sandbox) {
        git_at(&env.repo, &["checkout", "-b", "develop"]);
    }

    // ---------------------------------------------------------------- 配置

    #[test]
    fn reads_default_config_and_grouped_branches() {
        let env = sandbox("config-default");
        let path = path_of(&env.repo);
        create_develop(&env);
        for branch in [
            "feature/a",
            "feature/b",
            "release/1.0.0",
            "hotfix/urgent",
            "support/lts",
            "plain",
        ] {
            git_at(&env.repo, &["branch", branch, "main"]);
        }
        let config = read_gitflow_config(&path).expect("default config");
        assert_eq!(config.main_branch, "main");
        assert_eq!(config.develop_branch, "develop");
        assert_eq!(config.feature_prefix, "feature/");
        assert_eq!(config.release_prefix, "release/");
        assert_eq!(config.hotfix_prefix, "hotfix/");
        assert_eq!(config.support_prefix, "support/");
        assert_eq!(config.tag_prefix, "");

        let branches = read_gitflow_branches(&path).expect("grouped branches");
        assert_eq!(branches.feature, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(branches.release, vec!["1.0.0".to_string()]);
        assert_eq!(branches.hotfix, vec!["urgent".to_string()]);
        assert_eq!(branches.support, vec!["lts".to_string()]);
        assert_eq!(branches.main_branch, "main");
        assert_eq!(branches.develop_branch, "develop");
    }

    #[test]
    fn defaults_to_master_when_main_is_absent() {
        let env = sandbox("master-fallback");
        git_at(&env.repo, &["branch", "-m", "main", "master"]);
        let config = read_gitflow_config(&path_of(&env.repo)).expect("config");
        assert_eq!(config.main_branch, "master");
    }

    #[test]
    fn saves_config_to_local_git_config_and_reads_it_back() {
        let env = sandbox("config-save");
        let path = path_of(&env.repo);
        create_develop(&env);
        let custom = GitflowConfig {
            main_branch: "main".to_string(),
            develop_branch: "develop".to_string(),
            feature_prefix: "feat/".to_string(),
            release_prefix: "rel/".to_string(),
            hotfix_prefix: "fix/".to_string(),
            support_prefix: "lts/".to_string(),
            tag_prefix: "v".to_string(),
        };
        let saved = write_gitflow_config(&path, &custom).expect("save config");
        assert_eq!(saved, custom);
        assert_eq!(config_of(&env.repo, KEY_FEATURE), "feat/");
        assert_eq!(config_of(&env.repo, KEY_TAG), "v");
        assert_eq!(read_gitflow_config(&path).expect("read back"), custom);
    }

    #[test]
    fn rejects_invalid_config_names_prefixes_and_duplicate_branches() {
        let env = sandbox("config-invalid");
        let path = path_of(&env.repo);
        let base = read_gitflow_config(&path).expect("config");

        let mut invalid = base.clone();
        invalid.feature_prefix = "-feat/".to_string();
        assert!(write_gitflow_config(&path, &invalid).is_err());

        let mut invalid = base.clone();
        invalid.release_prefix = "rel ease/".to_string();
        assert!(write_gitflow_config(&path, &invalid).is_err());

        let mut invalid = base.clone();
        invalid.hotfix_prefix = "fix\n/".to_string();
        assert!(write_gitflow_config(&path, &invalid).is_err());

        let mut invalid = base.clone();
        invalid.main_branch = "bad name".to_string();
        assert!(write_gitflow_config(&path, &invalid).is_err());

        let mut invalid = base.clone();
        invalid.main_branch = "-main".to_string();
        assert!(write_gitflow_config(&path, &invalid).is_err());

        let mut invalid = base.clone();
        invalid.develop_branch = invalid.main_branch.clone();
        assert!(
            write_gitflow_config(&path, &invalid).is_err(),
            "main 与 develop 不能相同"
        );

        let mut invalid = base;
        invalid.tag_prefix = "v 1".to_string();
        assert!(write_gitflow_config(&path, &invalid).is_err());
    }

    #[test]
    fn rejects_invalid_kind_and_branch_names() {
        let env = sandbox("names");
        let path = path_of(&env.repo);
        create_develop(&env);
        assert!(create_gitflow_branch(&path, "bogus", "x", None).is_err());
        for name in ["-x", "bad name", "bad\nname", "a\0b", ""] {
            assert!(
                create_gitflow_branch(&path, "feature", name, None).is_err(),
                "名称 {name:?} 应被拒绝"
            );
        }
        assert!(create_gitflow_branch(&path, "feature", "ok", Some("missing-base")).is_err());
        assert!(complete_gitflow_branch(
            &path,
            "feature",
            "ghost",
            &GitflowFinishOptions::default()
        )
        .is_err());
        assert!(complete_gitflow_branch(
            &path,
            "feature",
            "x",
            &GitflowFinishOptions {
                tag: true,
                tag_message: None
            }
        )
        .is_err());
        assert!(
            complete_gitflow_branch(&path, "support", "lts", &GitflowFinishOptions::default())
                .is_err()
        );
    }

    // ---------------------------------------------------------------- start / finish

    #[test]
    fn feature_start_and_finish_merges_no_ff_into_develop() {
        let env = sandbox("feature");
        let path = path_of(&env.repo);
        create_develop(&env);
        let develop_head = git_at(&env.repo, &["rev-parse", "HEAD"]).trim().to_string();

        let start = create_gitflow_branch(&path, "feature", "login", None).expect("start feature");
        assert_eq!(start.kind, "feature");
        assert_eq!(start.branch, "feature/login");
        assert_eq!(start.base, "develop");
        assert_eq!(current_branch(&env.repo), "feature/login");

        commit_file(&env.repo, "login.txt", "login\n", "实现登录");
        let finish =
            complete_gitflow_branch(&path, "feature", "login", &GitflowFinishOptions::default())
                .expect("finish feature");
        assert!(finish.completed, "{finish:?}");
        assert!(!finish.conflicts);
        assert!(finish.guidance.is_none());
        assert_eq!(current_branch(&env.repo), "develop");
        assert!(!branch_exists(&env.repo, "feature/login"));
        assert!(env.repo.join("login.txt").exists());
        assert_ne!(finish.head_before, finish.head_after);
        assert!(finish
            .steps
            .iter()
            .any(|step| step.action == "delete feature/login"));

        // --no-ff 必须留下真正的合并提交（两个父提交）。
        let parents = git_at(&env.repo, &["rev-list", "--parents", "-n", "1", "develop"]);
        assert_eq!(
            parents.split_whitespace().count(),
            3,
            "应为合并提交：{parents}"
        );
        assert_ne!(
            git_at(&env.repo, &["rev-parse", "HEAD"]).trim(),
            develop_head
        );
    }

    #[test]
    fn release_finish_merges_main_and_develop_and_creates_tag() {
        let env = sandbox("release");
        let path = path_of(&env.repo);
        create_develop(&env);
        let mut config = read_gitflow_config(&path).expect("config");
        config.tag_prefix = "v".to_string();
        write_gitflow_config(&path, &config).expect("save tag prefix");

        let start = create_gitflow_branch(&path, "release", "1.0.0", None).expect("start release");
        assert_eq!(start.branch, "release/1.0.0");
        assert_eq!(start.base, "main");
        commit_file(&env.repo, "release.txt", "release\n", "准备 1.0.0");

        let finish = complete_gitflow_branch(
            &path,
            "release",
            "1.0.0",
            &GitflowFinishOptions {
                tag: true,
                tag_message: Some("首个正式版本".to_string()),
            },
        )
        .expect("finish release");
        assert!(finish.completed, "{finish:?}");
        assert!(!finish.conflicts);
        assert_eq!(current_branch(&env.repo), "develop");
        assert!(!branch_exists(&env.repo, "release/1.0.0"));
        assert!(tag_exists(&env.repo, "v1.0.0"));
        assert_eq!(
            git_at(&env.repo, &["tag", "-l", "--format=%(contents)", "v1.0.0"]).trim(),
            "首个正式版本"
        );
        assert_eq!(
            git_at(&env.repo, &["rev-parse", "main:release.txt"]).trim(),
            git_at(&env.repo, &["rev-parse", "develop:release.txt"]).trim()
        );
        assert!(finish
            .steps
            .iter()
            .any(|step| step.action == "tag v1.0.0" && step.status == "completed"));
        assert!(finish
            .steps
            .iter()
            .any(|step| step.action == "merge --no-ff release/1.0.0 -> main"));
    }

    #[test]
    fn release_finish_conflict_keeps_merge_state_without_abort() {
        let env = sandbox("conflict");
        let path = path_of(&env.repo);
        create_develop(&env);

        let start = create_gitflow_branch(&path, "release", "2.0.0", None).expect("start release");
        assert_eq!(start.base, "main");
        commit_file(&env.repo, "README.md", "release\n", "release 改动");

        git_at(&env.repo, &["checkout", "main"]);
        commit_file(&env.repo, "README.md", "main\n", "main 改动");

        let finish =
            complete_gitflow_branch(&path, "release", "2.0.0", &GitflowFinishOptions::default())
                .expect("finish report");
        assert!(!finish.completed);
        assert!(finish.conflicts, "{finish:?}");
        let guidance = finish.guidance.as_deref().expect("guidance");
        assert!(guidance.contains("MERGE_HEAD"), "{guidance}");
        assert!(guidance.contains("中止"), "{guidance}");
        assert!(merge_in_progress(&env.repo), "冲突后必须保留 MERGE_HEAD");
        assert!(
            branch_exists(&env.repo, "release/2.0.0"),
            "冲突时不能删除分支"
        );
        let status = git_at(&env.repo, &["status", "--porcelain"]);
        assert!(status.contains("UU README.md"), "{status}");
        assert!(finish.steps.iter().any(|step| step.status == "conflict"));
    }

    #[test]
    fn starts_each_kind_from_the_expected_base_branch() {
        let env = sandbox("bases");
        let path = path_of(&env.repo);
        create_develop(&env);

        for (kind, name, expected) in [
            ("feature", "f", "develop"),
            ("release", "r", "main"),
            ("hotfix", "h", "main"),
            ("support", "s", "main"),
        ] {
            git_at(&env.repo, &["checkout", "main"]);
            let report = create_gitflow_branch(&path, kind, name, None).expect(kind);
            assert_eq!(report.base, expected, "{kind} 的基础分支");
        }
        // 切回 main 后四个分支都已存在。
        for branch in ["feature/f", "release/r", "hotfix/h", "support/s"] {
            assert!(branch_exists(&env.repo, branch), "{branch} 应已创建");
        }
    }
}
