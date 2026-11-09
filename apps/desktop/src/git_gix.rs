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

/// 提交图谱批读的 gix 实现（Phase 2 P2c）：进程内 revwalk 替代
/// `git log --all --date-order` 子进程。
///
/// 对拍策略：本函数只产出与 CLI `--pretty` 记录**完全同构**的字段串
/// （`\x1f` 分隔），后处理（截断/title/stash 状态/avatar、stash 剪枝、分道）
/// 全部复用 git.rs 的同一套函数——遍历与取数替换后，字段级行为不可能漂移。
///
/// 语义对齐清单（均已实测确认）：
/// - `--all`：全部 refs（含 refs/stash）+ HEAD 作为 tips；
/// - `--date-order`：`Sorting::ByCommitTime(NewestFirst)`（父在子后，否则提交
///   时间降序；非 topo-order）；
/// - `%D` 装饰串：HEAD 优先（detached 为裸 `HEAD`，否则 `HEAD -> <短名>`），
///   其余引用按**全 refname 降序**渲染；heads/remotes 剥前缀、tags 加 `tag: `、
///   `refs/stash` 保持全名不缩短（stash 状态判定依赖此字面值）；
/// - `%aI/%cI`：`gix_date` 的 ISO8601_STRICT（`%Y-%m-%dT%H:%M:%S%:z`），与
///   `--date=iso-strict` 同格式。
pub fn parse_commits(
    path: &std::path::Path,
    limit: usize,
) -> Result<Vec<crate::models::RepositoryCommit>, String> {
    let max_count = limit.clamp(
        crate::git::COMMIT_GRAPH_LIMIT,
        crate::git::MAX_COMMIT_GRAPH_LIMIT,
    );
    let repo = gix::discover(path).map_err(|error| format!("gix open: {error}"))?;

    // 装饰收集：引用升序遍历，每个 commit 的装饰列表随后反转为降序
    // （git 的 add_decoration 前插语义），HEAD 再前置。
    let mut tips: Vec<gix::hash::ObjectId> = Vec::new();
    let mut decorations: std::collections::HashMap<gix::hash::ObjectId, Vec<String>> =
        std::collections::HashMap::new();
    let references_platform = repo
        .references()
        .map_err(|error| format!("gix refs: {error}"))?;
    let references = references_platform
        .all()
        .map_err(|error| format!("gix refs iter: {error}"))?;
    for reference in references {
        let reference = reference.map_err(|error| format!("gix ref: {error}"))?;
        let Some(id) = reference.try_id() else {
            continue;
        };
        let name = reference.name().as_bstr().to_string();
        tips.push(id.detach());
        decorations
            .entry(id.detach())
            .or_default()
            .push(render_decoration(&name));
    }
    for list in decorations.values_mut() {
        list.reverse();
    }

    // HEAD 装饰：detached 为裸 HEAD，否则 HEAD -> 分支短名（实测规则）。
    let head = repo.head().map_err(|error| format!("gix head: {error}"))?;
    let head_entry = match head.referent_name() {
        Some(branch) => {
            let short = branch.as_bstr().to_string();
            let short = short
                .strip_prefix("refs/heads/")
                .unwrap_or(&short)
                .to_string();
            format!("HEAD -> {short}")
        }
        None => "HEAD".to_string(),
    };
    if let Some(id) = head.id() {
        tips.push(id.detach());
        decorations
            .entry(id.detach())
            .or_default()
            .insert(0, head_entry);
    }

    // 遍历：--date-order 等价排序（父在子后，其余按提交时间降序）。
    // 同秒提交组内的顺序属于 git 实现细节（prio_queue 的 tie 行为跨版本不同，
    // 新版还引入了 lazy-root），不做逐位复刻——剪枝因此必须顺序无关（见下），
    // 字段级行为不依赖组内顺序；异常路径仍可回退 CLI。
    let walk = repo
        .rev_walk(tips)
        .sorting(gix::revision::walk::Sorting::ByCommitTime(
            gix::traverse::commit::simple::CommitTimeOrder::NewestFirst,
        ))
        .selected(|_| true)
        .map_err(|error| format!("gix walk init: {error}"))?;
    let mut truncated = false;
    let mut records: Vec<String> = Vec::new();
    for info in walk.take(max_count) {
        let info = info.map_err(|error| format!("gix walk: {error}"))?;
        let Ok(obj) = repo.find_object(info.id()) else {
            continue;
        };
        let Ok(commit) = obj.try_into_commit() else {
            continue;
        };
        let Ok(decoded) = commit.decode() else {
            continue;
        };
        let decoration = decorations
            .get(&info.id().detach())
            .map(|list| list.join(", "))
            .unwrap_or_default();
        records.push(commit_record(&decoded, &info.id().to_string(), &decoration));
    }

    // 后处理复用 git.rs 同一套实现：截断/title/stash 状态 → stash 剪枝 → 分道。
    // 剪枝前先对全量列表预登记 stash 提交的第二父（index 辅助提交）——gix 的
    // 同秒组内顺序不保证 WIP 先于 index 出现，顺序无关的预登记保证辅助提交
    // 在任何组内顺序下都会被剔除（CLI 路径由 git 的拓扑序天然保证，不需要）。
    let mut commits: Vec<crate::models::RepositoryCommit> = records
        .iter()
        .filter_map(|record| crate::git::commit_from_record(record, &mut truncated))
        .collect();
    let mut stash_helper_parents: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    for commit in &commits {
        if commit.status.as_deref() == Some("stash") {
            stash_helper_parents.extend(commit.parents.iter().skip(1).cloned());
        }
    }
    commits.retain(|commit| !crate::git::stash_prune_decision(commit, &mut stash_helper_parents));
    crate::git::assign_lanes(&mut commits);
    Ok(commits)
}

/// 引用全名 → %D 渲染名。`refs/stash` 保持全名（stash 判定的字面依据），
/// 其余按 git 装饰命名：heads/remotes 剥前缀、tags 加 `tag: `、未知命名空间
/// 保持全名（与 git 对罕见命名空间的行为一致）。
fn render_decoration(name: &str) -> String {
    if let Some(short) = name.strip_prefix("refs/heads/") {
        short.to_string()
    } else if let Some(short) = name.strip_prefix("refs/remotes/") {
        short.to_string()
    } else if let Some(short) = name.strip_prefix("refs/tags/") {
        format!("tag: {short}")
    } else {
        name.to_string()
    }
}

/// 单条提交 → 与 CLI `HISTORY_GRAPH_FORMAT` 记录同构的字段串
/// （hash/parents/author/email/committer/email/aI/cI/D/B，`\x1f` 分隔）。
fn commit_record(commit: &gix::objs::CommitRef<'_>, hash: &str, decoration: &str) -> String {
    let parents = commit
        .parents
        .iter()
        .map(|parent| String::from_utf8_lossy(parent).to_string())
        .collect::<Vec<String>>()
        .join(" ");
    let Ok(author) = commit.author() else {
        return String::new();
    };
    let Ok(committer) = commit.committer() else {
        return String::new();
    };
    let author_time = signature_time_iso(&author);
    let commit_time = signature_time_iso(&committer);
    [
        hash.to_string(),
        parents,
        signature_part(&author),
        signature_part(&committer),
        author_time,
        commit_time,
        decoration.to_string(),
        String::from_utf8_lossy(commit.message).to_string(),
    ]
    .join("\u{1f}")
}

/// 签名 → "name\x1femail" 段（author/committer 共用，UTF-8 lossy 与 CLI 侧一致）。
fn signature_part(signature: &gix::actor::SignatureRef<'_>) -> String {
    format!(
        "{}\u{1f}{}",
        String::from_utf8_lossy(&signature.name),
        String::from_utf8_lossy(&signature.email)
    )
}

/// 签名时间 → ISO8601 strict（`--date=iso-strict` 同格式）；解析失败回退空串。
fn signature_time_iso(signature: &gix::actor::SignatureRef<'_>) -> String {
    signature
        .time()
        .ok()
        .and_then(|time| time.format(gix::date::time::format::ISO8601_STRICT).ok())
        .map(|formatted| {
            // git --date=iso-strict 只对 UTC 渲染 `Z`，gix 的 ISO8601_STRICT
            // 同一时刻给 `+00:00`——对齐 git 的字面形式。
            formatted
                .strip_suffix("+00:00")
                .map(|rest| format!("{rest}Z"))
                .unwrap_or(formatted)
        })
        .unwrap_or_default()
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
        sandbox.git_env(
            &["commit", "-q", "-m", "init"],
            &[("GIT_COMMITTER_DATE", "2026-01-01T00:00:00Z")],
        );
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

    /// 构造多拓扑仓库：分叉双分支 + merge + 独立分支 + 标签 + stash。
    /// 每个提交携带互异的 GIT_COMMITTER_DATE——同秒提交的组内顺序是 git
    /// prio_queue 的实现细节（跨版本不稳定），不属于对拍承诺；互异时间戳让
    /// 两侧行为完全确定，同秒场景另由 tie 测试覆盖结构性断言。
    fn rich_topology_repo() -> Sandbox {
        let sandbox = seeded_repo();
        // 分叉：feature 与 main 各自前进后合并（产生真实 merge 提交）。
        sandbox.git(&["checkout", "-q", "-b", "feature"]);
        sandbox.write("feature.txt", "from feature\n");
        sandbox.git(&["add", "."]);
        sandbox.git_env(
            &["commit", "-q", "-m", "feat: branch work"],
            &[("GIT_COMMITTER_DATE", "2026-01-01T00:00:01Z")],
        );
        sandbox.git(&["checkout", "-q", "main"]);
        sandbox.write("main.txt", "from main\n");
        sandbox.git(&["add", "."]);
        sandbox.git_env(
            &["commit", "-q", "-m", "main: parallel work"],
            &[("GIT_COMMITTER_DATE", "2026-01-01T00:00:02Z")],
        );
        sandbox.git_env(
            &[
                "merge",
                "-q",
                "--no-ff",
                "-m",
                "merge feature into main",
                "feature",
            ],
            &[("GIT_COMMITTER_DATE", "2026-01-01T00:00:03Z")],
        );
        // 独立分支与标签。
        sandbox.git(&["branch", "standalone"]);
        sandbox.git(&["tag", "rel-1"]);
        // stash：产生 stash 提交 + index 辅助提交（剪枝路径的真实素材）。
        sandbox.write("dirty.txt", "uncommitted\n");
        sandbox.git(&["add", "dirty.txt"]);
        sandbox.git_env(
            &["stash"],
            &[("GIT_COMMITTER_DATE", "2026-01-01T00:00:04Z")],
        );
        sandbox
    }

    /// RepositoryCommit 无 PartialEq：serde JSON 逐值对拍（覆盖全部字段）。
    fn commits_json(commits: &[crate::models::RepositoryCommit]) -> Vec<serde_json::Value> {
        commits
            .iter()
            .map(|commit| serde_json::to_value(commit).expect("序列化"))
            .collect()
    }

    /// 同秒提交组内的排序属 git 实现细节（prio_queue 跨版本行为不同），不承诺
    /// 逐位一致；但结构性行为必须稳定：stash 辅助提交被剪枝、stash/merge/
    /// 装饰都在列。顺序无关剪枝（预登记第二父）保证 index 提交无论组内顺序
    /// 如何都不会泄漏进输出。
    #[test]
    fn parse_commits_same_second_ties_keep_structure() {
        let sandbox = rich_topology_repo_same_second();
        let via_gix = crate::git::parse_commits(&sandbox.0, crate::git::COMMIT_GRAPH_LIMIT);
        // 无论 tie 顺序如何，这四条必须都在列且辅助提交被剔除。
        assert!(
            via_gix
                .iter()
                .any(|commit| commit.title == "merge feature into main"),
            "merge 提交应存在"
        );
        assert!(
            via_gix
                .iter()
                .any(|commit| commit.status.as_deref() == Some("stash")),
            "stash 提交应存在"
        );
        assert!(
            !via_gix
                .iter()
                .any(|commit| commit.title.starts_with("index on")),
            "stash index 辅助提交必须被剪枝（WIP 提交本身按设计保留，status=stash）"
        );
        assert!(
            via_gix
                .iter()
                .any(|commit| commit.branches.iter().any(|b| b == "rel-1")),
            "tag 装饰应存在"
        );
        // 条数自洽：init/feat/main/merge/stash 共 5 条（index 辅助被剪枝）。
        assert_eq!(via_gix.len(), 5, "剪枝后应恰为 5 条");
    }

    /// 全部提交同一秒的多拓扑仓库：gix tie 顺序与 CLI 可能不同，用于验证
    /// 顺序无关剪枝的结构稳定性（不做字段级 JSON 对拍）。
    fn rich_topology_repo_same_second() -> Sandbox {
        let sandbox = seeded_repo_same_second();
        sandbox.git(&["checkout", "-q", "-b", "feature"]);
        sandbox.write("feature.txt", "from feature\n");
        sandbox.git(&["add", "."]);
        sandbox.git(&["commit", "-q", "-m", "feat: branch work"]);
        sandbox.git(&["checkout", "-q", "main"]);
        sandbox.write("main.txt", "from main\n");
        sandbox.git(&["add", "."]);
        sandbox.git(&["commit", "-q", "-m", "main: parallel work"]);
        sandbox.git(&[
            "merge",
            "-q",
            "--no-ff",
            "-m",
            "merge feature into main",
            "feature",
        ]);
        sandbox.git(&["branch", "standalone"]);
        sandbox.git(&["tag", "rel-1"]);
        sandbox.write("dirty.txt", "uncommitted\n");
        sandbox.git(&["add", "dirty.txt"]);
        sandbox.git(&["stash"]);
        sandbox
    }

    /// init 提交不带固定时间戳（自然落在当前秒）的种子仓库。
    fn seeded_repo_same_second() -> Sandbox {
        let sandbox = Sandbox::new();
        sandbox.git(&["init", "-q", "-b", "main"]);
        sandbox.write("a.txt", "hello\n");
        sandbox.git(&["add", "."]);
        sandbox.git(&["commit", "-q", "-m", "init"]);
        sandbox
    }

    #[test]
    fn parse_commits_ab_matches_cli_on_rich_topology() {
        let sandbox = rich_topology_repo();
        let via_gix = crate::git::parse_commits(&sandbox.0, crate::git::COMMIT_GRAPH_LIMIT);
        let via_cli = crate::git::parse_commits_cli(&sandbox.0, crate::git::COMMIT_GRAPH_LIMIT);
        assert_eq!(
            via_gix.len(),
            via_cli.len(),
            "条数一致：gix {} vs cli {}",
            via_gix.len(),
            via_cli.len()
        );
        assert_eq!(commits_json(&via_gix), commits_json(&via_cli), "全字段对拍");
        // 结构自检：merge 提交在列、stash 提交在列、辅助提交被剪枝。
        assert!(
            via_gix
                .iter()
                .any(|commit| commit.title == "merge feature into main"),
            "merge 提交应存在"
        );
        assert!(
            via_gix
                .iter()
                .any(|commit| commit.status.as_deref() == Some("stash")),
            "stash 提交应存在"
        );
        assert!(
            !via_gix
                .iter()
                .any(|commit| commit.title.starts_with("index on")),
            "stash index 辅助提交必须被剪枝（WIP 提交本身按设计保留，status=stash）"
        );
        assert!(
            via_gix
                .iter()
                .any(|commit| commit.branches.iter().any(|b| b == "rel-1")),
            "tag 装饰应存在"
        );
    }

    #[test]
    fn parse_commits_ab_matches_cli_on_this_repo_history() {
        // 真实历史对拍：本仓库自身（大量同秒提交是排序稳定性的关键压力面）。
        let Ok(repo_root) = std::path::Path::new(&env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
        else {
            return; // 非常规布局（发布包等）下跳过
        };
        if !repo_root.join(".git").exists() {
            return;
        }
        // 浅克隆（CI depth-1 checkout）下 git CLI 把边界提交渲染为无父 + `grafted`
        // 装饰，gix 读提交对象里的真实 parent 哈希——对拍在浅仓库必然发散。
        // 该测试校验的是排序稳定性而非浅仓库语义，只在完整历史上做。
        let is_shallow = std::process::Command::new("git")
            .args(["rev-parse", "--is-shallow-repository"])
            .current_dir(&repo_root)
            .output()
            .map(|out| String::from_utf8_lossy(&out.stdout).trim() == "true")
            .unwrap_or(false);
        if is_shallow {
            return;
        }
        let via_gix = crate::git::parse_commits(&repo_root, crate::git::COMMIT_GRAPH_LIMIT);
        let via_cli = crate::git::parse_commits_cli(&repo_root, crate::git::COMMIT_GRAPH_LIMIT);
        assert_eq!(via_gix.len(), via_cli.len(), "真实历史条数一致");
        assert_eq!(
            commits_json(&via_gix),
            commits_json(&via_cli),
            "真实历史全字段对拍（重点：同秒提交的排序稳定性）"
        );
    }
}
