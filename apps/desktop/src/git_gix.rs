//! gix 只读快路径（Phase 2 迁移第一刀：状态 token）。
//!
//! 只迁高频只读操作，写与特殊操作继续 Git CLI（README 后续实现路线）。
//! token 是自洽哈希：不需要与 CLI 版逐字节对拍，但**灵敏度必须对齐**——
//! CLI 版（`git::repository_state_token`）哈希 `status --porcelain -z`、
//! 四个 refs 命名空间、`worktree list --porcelain` 与变更文件的 size/mtime，
//! 因此这里必须覆盖同样的变化面：
//! - staged（HEAD↔index）与 unstaged（index↔工作区）两段 status；
//! - untracked 逐文件（`-uall` 口径）；**ignored 显式跳过**（CLI 不受 ignored
//!   文件变化影响，构建产物 churn 不应触发刷新）；
//! - refs 只取 heads/remotes/tags/stash（其余命名空间如 refs/notes 变化
//!   不触发刷新，与 CLI 一致）；
//! - worktree 列表含 locked/prunable 状态。
//!
//! 确定性：目录遍历顺序不定，所有条目先收集、按路径排序后再哈希。
//! 任何 gix 错误直接返回 Err，由命令侧回退 Git CLI 实现。

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

use gix::status::UntrackedFiles;
use gix::status::{index_worktree, Item};

/// gix 实现的状态 token：与 CLI 版灵敏度对齐的自洽哈希。
pub fn repository_state_token(path: &str) -> Result<String, String> {
    let repo = gix::discover(path).map_err(|error| format!("gix open: {error}"))?;
    let workdir = repo
        .workdir()
        .map(PathBuf::from)
        .ok_or_else(|| "bare 仓库没有工作区".to_string())?;

    let mut hasher = DefaultHasher::new();

    // 条目收集后排序再哈希：status 的目录遍历顺序不定，直接边遍历边哈希
    // 会让同一状态在不同进程算出不同 token，触发无意义的刷新。
    let mut entries: Vec<(String, String, Option<(u64, i128)>)> = Vec::new();

    // CLI `status --porcelain -z --untracked-files=all` 的等价口径：
    // 无重命名跟踪（--porcelain 默认不开 -M）、untracked 逐文件、双段（staged + unstaged）。
    let status_iter = repo
        .status(gix::progress::Discard)
        .map_err(|error| format!("gix status: {error}"))?
        .index_worktree_rewrites(None)
        .untracked_files(UntrackedFiles::Files)
        .into_iter(Vec::new())
        .map_err(|error| format!("gix status iter: {error}"))?;
    for item in status_iter {
        let item = item.map_err(|error| format!("gix status item: {error}"))?;
        match item {
            Item::IndexWorktree(index_worktree::Item::Modification {
                rela_path, status, ..
            }) => {
                let path = path_string(&rela_path);
                entries.push((
                    path.clone(),
                    format!("{status:?}"),
                    worktree_stat(&workdir, &path),
                ));
            }
            Item::IndexWorktree(index_worktree::Item::DirectoryContents { entry, .. }) => {
                // 只吃 untracked；ignored 条目若被发出则显式跳过，保持与 CLI
                // 「ignored 文件变化不影响 token」的灵敏度对齐。
                if matches!(entry.status, gix::dir::entry::Status::Untracked) {
                    let path = path_string(&entry.rela_path);
                    entries.push((
                        path.clone(),
                        "untracked".to_string(),
                        worktree_stat(&workdir, &path),
                    ));
                }
            }
            Item::IndexWorktree(index_worktree::Item::Rewrite {
                source,
                dirwalk_entry,
                ..
            }) => {
                // 已关闭重命名跟踪，正常不会出现；保守哈希两侧路径与身份。
                let source_path = match &source {
                    index_worktree::RewriteSource::RewriteFromIndex {
                        source_rela_path, ..
                    } => path_string(source_rela_path),
                    index_worktree::RewriteSource::CopyFromDirectoryEntry {
                        source_dirwalk_entry,
                        ..
                    } => path_string(&source_dirwalk_entry.rela_path),
                };
                entries.push((
                    path_string(&dirwalk_entry.rela_path),
                    format!("rewrite {source:?}"),
                    None,
                ));
                entries.push((source_path, "rewrite-source".to_string(), None));
            }
            Item::TreeIndex(change) => {
                // staged 段（HEAD↔index）：Debug 含新旧 oid，内容变化必然换 token。
                entries.push((format!("{change:?}"), "staged".to_string(), None));
            }
        }
    }

    entries.sort();
    for entry in &entries {
        entry.hash(&mut hasher);
    }

    // refs：与 CLI for-each-ref 同一命名空间集合（heads/remotes/tags/stash）。
    let mut refs: Vec<(String, String)> = Vec::new();
    // Platform 借用 repo，必须先绑定生命周期再取迭代器。
    let references_platform = repo
        .references()
        .map_err(|error| format!("gix refs: {error}"))?;
    let references = references_platform
        .all()
        .map_err(|error| format!("gix refs iter: {error}"))?;
    for reference in references {
        let reference = reference.map_err(|error| format!("gix ref: {error}"))?;
        let name = reference.name().as_bstr().to_string();
        let in_scope = ["refs/heads/", "refs/remotes/", "refs/tags/", "refs/stash"]
            .iter()
            .any(|prefix| name.starts_with(prefix));
        if !in_scope {
            continue;
        }
        // Debug 形式包含 oid/符号目标名，足够作为哈希输入且无需导入 gix_ref。
        refs.push((name, format!("{:?}", reference.target())));
    }
    refs.sort();
    for reference in &refs {
        reference.hash(&mut hasher);
    }

    // worktree 列表：gix 已按 git_dir 排序返回；locked/prunable 对齐 CLI 的
    // porcelain 注记，锁状态变化也会换 token。
    let worktrees = repo
        .worktrees()
        .map_err(|error| format!("gix worktrees: {error}"))?;
    for proxy in &worktrees {
        let locked = if proxy.is_locked() {
            proxy.lock_reason().map(|reason| reason.to_string())
        } else {
            None
        };
        (
            proxy.git_dir().to_string_lossy(),
            locked,
            proxy.is_prunable(),
        )
            .hash(&mut hasher);
    }

    Ok(format!("{:016x}", hasher.finish()))
}

/// 变更文件的 size/mtime 现查（与 CLI 版的 fs::metadata 语义一致）；
/// 文件已被删除时返回 None——路径与状态本身仍参与哈希。
fn worktree_stat(workdir: &std::path::Path, relative: &str) -> Option<(u64, i128)> {
    let metadata = std::fs::metadata(workdir.join(relative)).ok()?;
    let modified = metadata.modified().ok()?;
    let elapsed = modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos() as i128;
    Some((metadata.len(), elapsed))
}

fn path_string(path: &[u8]) -> String {
    String::from_utf8_lossy(path).to_string()
}

/// 快照 refs 线程的 gix 读结果：与 CLI 版同语义的分支/标签名枚举。
/// ahead/behind（`parse_branch_tracking`）仍走 CLI rev-list，本轮不含。
#[derive(Debug, Clone)]
pub struct RefSnapshot {
    /// heads+remotes 合并短名：排序、去重、滤 `/HEAD` 结尾（parse_branches 语义）。
    pub branches: Vec<String>,
    /// remotes 短名：滤 `/HEAD`、按名排序（parse_remote_branches 语义，
    /// CLI for-each-ref 默认按全名排序，同前缀下与短名排序一致）。
    pub remote_branches: Vec<String>,
    /// heads 短名：按名排序（parse_local_branches 语义）。
    pub local_branches: Vec<String>,
    /// 标签名：creatordate 降序、并列按名升序（`tag --list --sort=-creatordate`：
    /// 稳定排序，初始序为引用名字典序）。
    pub tags: Vec<String>,
}

/// gix 版分支/标签枚举：进程内直读，替代 refs 线程的 3 个 for-each-ref/tag 子进程。
/// 错误由调用方回退 CLI 实现。
pub fn read_refs(path: &std::path::Path) -> Result<RefSnapshot, String> {
    let repo = gix::discover(path).map_err(|error| format!("gix open: {error}"))?;
    let mut heads: Vec<String> = Vec::new();
    let mut remotes: Vec<String> = Vec::new();
    let mut tags: Vec<(i64, String)> = Vec::new();

    let references_platform = repo
        .references()
        .map_err(|error| format!("gix refs: {error}"))?;
    let references = references_platform
        .all()
        .map_err(|error| format!("gix refs iter: {error}"))?;
    for reference in references {
        let reference = reference.map_err(|error| format!("gix ref: {error}"))?;
        let name = reference.name().as_bstr().to_string();
        if let Some(short) = name.strip_prefix("refs/heads/") {
            heads.push(short.to_string());
        } else if let Some(rest) = name.strip_prefix("refs/remotes/") {
            // git 的 %(refname:short) 会把 refs/remotes/<remote>/HEAD 缩成 <remote>
            // （实测规则：剥 /HEAD 后缀），CLI 的 ends_with("/HEAD") 过滤因此
            // 实际从不触发——这里复刻同样行为保持列表逐项一致。
            let short = rest.strip_suffix("/HEAD").unwrap_or(rest);
            remotes.push(short.to_string());
        } else if let Some(short) = name.strip_prefix("refs/tags/") {
            let date = tag_creatordate(&repo, reference.try_id());
            tags.push((date, short.to_string()));
        }
    }

    // tags：先按名升序建立初始序，再稳定降序——并列 creatordate 保持名序，
    // 对齐 `git tag --sort=-creatordate`（稳定排序）的并列行为。
    tags.sort_by(|left, right| left.1.cmp(&right.1));
    tags.sort_by(|left, right| right.0.cmp(&left.0));
    let tag_names = tags.into_iter().map(|(_, name)| name).collect();

    let mut branches = heads
        .iter()
        .chain(remotes.iter())
        .cloned()
        .collect::<Vec<String>>();
    branches.sort();
    branches.dedup();

    let mut remote_branches = remotes;
    remote_branches.sort();
    let mut local_branches = heads;
    local_branches.sort();

    Ok(RefSnapshot {
        branches,
        remote_branches,
        local_branches,
        tags: tag_names,
    })
}

/// 标签的 creatordate（秒）：annotated tag 取 tagger 时间，lightweight 取指向
/// commit 的 committer 时间；指向 tree/blob 的罕见标签按 0 处理（排到最后）。
fn tag_creatordate(repo: &gix::Repository, id: Option<gix::Id<'_>>) -> i64 {
    let Some(id) = id else {
        return 0;
    };
    let Ok(obj) = repo.find_object(id) else {
        return 0;
    };
    match obj.kind {
        gix::objs::Kind::Tag => match obj.try_into_tag() {
            Ok(tag) => tag
                .tagger()
                .ok()
                .flatten()
                .and_then(|signature| signature.time().ok())
                .map(|time| time.seconds)
                .unwrap_or(0),
            Err(_) => 0,
        },
        gix::objs::Kind::Commit => match obj.try_into_commit() {
            Ok(commit) => commit.time().map(|time| time.seconds).unwrap_or(0),
            Err(_) => 0,
        },
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// 与 repository_management 测试同款沙箱（进程内自增序号防并行撞名）。
    struct Sandbox(PathBuf);
    impl Sandbox {
        fn new() -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static SEQUENCE: AtomicU64 = AtomicU64::new(0);
            let sequence = SEQUENCE.fetch_add(1, Ordering::SeqCst);
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "branchline-gix-{}-{unique}-{sequence}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn git(&self, args: &[&str]) {
            self.git_env(args, &[]);
        }

        /// 带环境变量（如 GIT_COMMITTER_DATE）的 git 调用。
        fn git_env(&self, args: &[&str], envs: &[(&str, &str)]) {
            let output = std::process::Command::new("git")
                .args(["-C", self.0.to_str().unwrap()])
                .args([
                    "-c",
                    "user.name=branchline-test",
                    "-c",
                    "user.email=test@branchline.local",
                ])
                .envs(envs.iter().copied())
                .args(args)
                .output()
                .expect("git 可用");
            assert!(
                output.status.success(),
                "git {args:?} 失败：{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        fn git_output(&self, args: &[&str]) -> String {
            let output = std::process::Command::new("git")
                .args(["-C", self.0.to_str().unwrap()])
                .args(args)
                .output()
                .expect("git 可用");
            assert!(
                output.status.success(),
                "git {args:?} 失败：{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).to_string()
        }

        fn write(&self, name: &str, content: &str) {
            std::fs::write(self.0.join(name), content).unwrap();
        }

        fn token(&self) -> String {
            repository_state_token(self.0.to_str().unwrap()).expect("gix token")
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn seeded_repo() -> Sandbox {
        let sandbox = Sandbox::new();
        sandbox.git(&["init", "-q", "-b", "main"]);
        sandbox.write("a.txt", "hello\n");
        sandbox.git(&["add", "."]);
        sandbox.git(&["commit", "-q", "-m", "init"]);
        sandbox
    }

    #[test]
    fn token_is_deterministic_for_same_state() {
        let sandbox = seeded_repo();
        let first = sandbox.token();
        let second = sandbox.token();
        assert_eq!(first, second, "同一状态两次计算必须相同");
        assert_eq!(first.len(), 16, "与 CLI 版同为 16 位十六进制");
    }

    #[test]
    fn token_senses_worktree_and_index_changes() {
        let sandbox = seeded_repo();
        let baseline = sandbox.token();

        // unstaged：修改已跟踪文件
        sandbox.write("a.txt", "changed\n");
        let after_modify = sandbox.token();
        assert_ne!(baseline, after_modify, "修改已跟踪文件必须换 token");

        // staged：git add（HEAD↔index 段必须被覆盖，否则暂存界面不刷新）
        sandbox.git(&["add", "."]);
        let after_stage = sandbox.token();
        assert_ne!(after_modify, after_stage, "git add 必须换 token");

        // commit：staged 段清空 + HEAD 前进
        sandbox.git(&["commit", "-q", "-m", "change"]);
        assert_ne!(sandbox.token(), baseline, "提交必须换 token");
    }

    #[test]
    fn token_senses_untracked_but_not_ignored_files() {
        let sandbox = seeded_repo();
        let baseline = sandbox.token();

        sandbox.write("new.txt", "untracked\n");
        assert_ne!(sandbox.token(), baseline, "untracked 文件必须换 token");

        // ignored：CLI 口径下 ignored 文件变化不影响 token（构建产物不触发刷新）。
        sandbox.write(".gitignore", "ignored-dir/\n");
        sandbox.git(&["add", ".gitignore"]);
        sandbox.git(&["commit", "-q", "-m", "ignore"]);
        let with_ignore = sandbox.token();
        std::fs::create_dir_all(sandbox.0.join("ignored-dir")).unwrap();
        sandbox.write("ignored-dir/build.log", "noise\n");
        assert_eq!(
            sandbox.token(),
            with_ignore,
            "ignored 文件变化不得换 token（对齐 CLI 敏感性）"
        );
    }

    #[test]
    fn token_senses_refs_and_worktree_changes() {
        let sandbox = seeded_repo();
        let baseline = sandbox.token();

        // refs：新建分支
        sandbox.git(&["branch", "feature"]);
        assert_ne!(sandbox.token(), baseline, "新分支必须换 token");

        // worktree：新增链接工作区
        let linked = sandbox.0.join("linked");
        sandbox.git(&["worktree", "add", linked.to_str().unwrap(), "-b", "wt"]);
        assert_ne!(sandbox.token(), baseline, "新增 worktree 必须换 token");
    }

    #[test]
    fn token_accepts_subdirectory_path() {
        // CLI 版经 repository_root 容忍子目录路径，gix 用 discover 对齐。
        let sandbox = seeded_repo();
        let nested = sandbox.0.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        let token = repository_state_token(nested.to_str().unwrap()).expect("子目录也能算");
        assert_eq!(token, sandbox.token(), "子目录与根路径算出同一 token");
    }

    /// 建一个带分支/远端引用/双类标签的仓库，gix 与 CLI 的 refs 枚举逐字段对拍。
    #[test]
    fn read_refs_matches_cli_output_field_by_field() {
        let sandbox = seeded_repo();

        // 第二个提交（晚于首个），lightweight 标签指在它上。
        sandbox.write("b.txt", "second\n");
        sandbox.git(&["add", "."]);
        sandbox.git(&["commit", "-q", "-m", "second"]);
        sandbox.git(&["tag", "light-second"]);

        // annotated tag：带明确 tagger 时间的最早标签（应排最后）。
        sandbox.git_env(
            &["tag", "-a", "annotated-early", "-m", "early"],
            &[("GIT_COMMITTER_DATE", "2020-01-01T00:00:00Z")],
        );

        // 分支：含嵌套名（feat/1248）。
        sandbox.git(&["branch", "feat/1248"]);
        sandbox.git(&["branch", "topic"]);

        // 远端引用不走网络：手工建 tracking refs + HEAD 符号引用。
        let commit = sandbox.git_output(&["rev-parse", "main"]);
        sandbox.git(&[
            "update-ref",
            &format!("refs/remotes/origin/main"),
            commit.trim(),
        ]);
        sandbox.git(&["update-ref", "refs/remotes/origin/feat/1248", commit.trim()]);
        sandbox.git(&[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
        ]);

        let gix_refs = read_refs(&sandbox.0).expect("gix read_refs");
        let root = sandbox.0.clone();
        let cli_branches = crate::git::parse_branches(&root);
        let cli_remote = crate::git::parse_remote_branches(&root);
        let cli_local = crate::git::parse_local_branches(&root);
        let cli_tags = crate::git::parse_tags(&root);

        assert_eq!(gix_refs.branches, cli_branches, "branches 与 CLI 对拍");
        assert_eq!(
            gix_refs.remote_branches, cli_remote,
            "remote_branches 与 CLI 对拍"
        );
        assert_eq!(
            gix_refs.local_branches, cli_local,
            "local_branches 与 CLI 对拍"
        );
        assert_eq!(
            gix_refs.tags, cli_tags,
            "tags 与 CLI 对拍（creatordate 降序）"
        );

        // 结构自检：origin/HEAD 按 git 短名规则缩成 "origin"、嵌套名在列、
        // annotated 最早排最后。
        assert!(
            gix_refs.remote_branches.iter().any(|name| name == "origin"),
            "origin/HEAD 应缩短为 origin 出现在远端列表"
        );
        assert!(gix_refs.branches.iter().any(|name| name == "feat/1248"));
        assert_eq!(
            gix_refs.tags.last().map(String::as_str),
            Some("annotated-early")
        );
    }
}
