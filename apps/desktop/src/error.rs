//! 结构化命令错误：给前端稳定的 code + 参数 + 原始诊断详情。
//!
//! 策略（与规格 4.3 一致）：
//! - `CommandError` 可直接作为 Tauri 命令的错误返回值（实现 Serialize）。
//! - `classify()` 把常见 git stderr 归类为稳定 code；未匹配时回退 `git.unknown`。
//! - 命令可继续返回 `Err(String)`；前端 `BranchlineCommandError` 会把纯字符串
//!   归一化为 `errors.unknown` 并把原文放进 detail，因此迁移可以逐步进行。

use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub params: BTreeMap<String, String>,
    pub detail: Option<String>,
}

impl CommandError {
    pub fn new(code: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            params: BTreeMap::new(),
            detail: None,
        }
    }

    pub fn param(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.params.insert(key.into(), value.into());
        self
    }

    pub fn detail(mut self, value: impl Into<String>) -> Self {
        self.detail = Some(value.into());
        self
    }
}

impl From<String> for CommandError {
    fn from(message: String) -> Self {
        let code = classify(&message);
        Self {
            code: code.to_string(),
            params: BTreeMap::new(),
            detail: Some(message),
        }
    }
}

/// 供日志与宿主错误串接使用：`[code] detail`。
impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}]", self.code)?;
        if let Some(detail) = &self.detail {
            write!(f, " {detail}")?;
        }
        Ok(())
    }
}

/// 把常见 git 失败归类为稳定错误码；未匹配回退 `git.unknown`。
/// 规则刻意保守：只匹配确证性强的短语，避免把无关错误误标。
pub fn classify(message: &str) -> &'static str {
    let lower = message.to_lowercase();
    if lower.contains("not a git repository") {
        return "repository.notGit";
    }
    if lower.contains("non-fast-forward") || lower.contains("fetch first") {
        return "git.push.nonFastForward";
    }
    if lower.contains("conflict") || lower.contains("merge cannot be done") {
        return "git.conflict";
    }
    if lower.contains("authentication failed")
        || lower.contains("permission denied (publickey)")
        || lower.contains("could not read from remote repository")
    {
        return "git.auth.failed";
    }
    if lower.contains("could not resolve host")
        || lower.contains("network is unreachable")
        || lower.contains("connection timed out")
    {
        return "git.network";
    }
    if lower.contains("already exists") {
        return "git.branch.exists";
    }
    if lower.contains("local changes") || lower.contains("would be overwritten") {
        return "git.worktree.dirty";
    }
    if lower.contains("git-lfs")
        && (lower.contains("not installed") || lower.contains("command not found"))
    {
        return "git.lfs.missing";
    }
    "git.unknown"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_structured_errors() {
        let error = CommandError::new("git.fetch.failed")
            .param("remote", "origin")
            .detail("fatal: something");
        let value = serde_json::to_value(&error).unwrap();
        assert_eq!(value["code"], "git.fetch.failed");
        assert_eq!(value["params"]["remote"], "origin");
        assert_eq!(value["detail"], "fatal: something");
        assert!(value["params"].as_object().unwrap().len() == 1);
    }

    #[test]
    fn classifies_common_git_failures() {
        assert_eq!(classify("fatal: not a git repository"), "repository.notGit");
        assert_eq!(
            classify("! [rejected] main -> main (non-fast-forward)"),
            "git.push.nonFastForward"
        );
        assert_eq!(
            classify("CONFLICT (content): Merge conflict in a.ts"),
            "git.conflict"
        );
        assert_eq!(
            classify("fatal: Authentication failed for 'https://...'"),
            "git.auth.failed"
        );
        assert_eq!(
            classify("ssh: Could not resolve host github.com"),
            "git.network"
        );
        assert_eq!(
            classify("fatal: branch 'x' already exists"),
            "git.branch.exists"
        );
        assert_eq!(
            classify("error: Your local changes to the following files would be overwritten"),
            "git.worktree.dirty"
        );
        assert_eq!(classify("git-lfs: command not found"), "git.lfs.missing");
        assert_eq!(classify("something inexplicable"), "git.unknown");
    }

    #[test]
    fn from_string_classifies_and_keeps_detail() {
        let error = CommandError::from(String::from("fatal: not a git repository"));
        assert_eq!(error.code, "repository.notGit");
        assert_eq!(error.detail.as_deref(), Some("fatal: not a git repository"));
    }
}
