use crate::{
    git,
    models::{
        BlameLine, DiffLine, FileHistoryEntry, GitUserConfig, MergeQueueSnapshot,
        RepositoryCommitStats, RepositoryComparison, RepositoryFile, RepositorySnapshot,
    },
};
use std::path::Path;

fn task_error(action: &str, error: impl std::fmt::Display) -> String {
    format!("{action}失败：{error}")
}

#[tauri::command]
pub async fn load_repository_details(repository_path: String) -> Result<crate::repository_management::RepositoryDetails, String> {
    tauri::async_runtime::spawn_blocking(move || crate::repository_management::load_repository_details(&repository_path))
        .await.map_err(|error| task_error("读取仓库信息", error))?
}

#[tauri::command]
pub async fn load_repository_readme(repository_path: String) -> Result<Option<crate::repository_management::RepositoryReadme>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::repository_management::load_repository_readme(&repository_path))
        .await.map_err(|error| task_error("读取 README", error))?
}

#[tauri::command]
pub async fn create_repository(destination: String, source: Option<String>) -> Result<crate::repository_management::RepositoryDetails, String> {
    tauri::async_runtime::spawn_blocking(move || crate::repository_management::create_repository(&destination, source.as_deref()))
        .await.map_err(|error| task_error("创建仓库", error))?
}

#[tauri::command]
pub async fn open_repository_in_vscode(repository_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::repository_management::open_repository_in_vscode(&repository_path))
        .await.map_err(|error| task_error("打开 VS Code", error))?
}

fn operation_snapshot(
    repository_path: &str,
    result: Result<(), String>,
    action: &str,
) -> Result<RepositorySnapshot, String> {
    match result {
        Ok(()) => git::read_repository(repository_path),
        Err(error) => {
            let snapshot = git::read_repository(repository_path)?;
            if snapshot.operation.is_some() {
                Ok(snapshot)
            } else {
                Err(task_error(action, error))
            }
        }
    }
}

#[tauri::command]
pub async fn load_git_user_config() -> Result<GitUserConfig, String> {
    tauri::async_runtime::spawn_blocking(git::load_git_user_config)
        .await
        .map_err(|error| task_error("读取 Git 配置", error))
}

#[tauri::command]
pub async fn update_git_user_config(
    user_name: String,
    user_email: String,
    default_branch: String,
    autocrlf: String,
    pull_strategy: String,
    commit_template_content: String,
) -> Result<GitUserConfig, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::update_git_user_config(
            &user_name,
            &user_email,
            &default_branch,
            &autocrlf,
            &pull_strategy,
            &commit_template_content,
        )
    })
    .await
    .map_err(|error| task_error("保存 Git 配置", error))?
}

#[tauri::command]
pub async fn update_repository_commit_template(
    repository_path: String,
    content: String,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::update_repository_commit_template(&repository_path, &content)
    })
    .await
    .map_err(|error| task_error("保存仓库提交模板", error))?
}

#[tauri::command]
pub async fn clear_repository_commit_template(
    repository_path: String,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || git::clear_repository_commit_template(&repository_path))
        .await
        .map_err(|error| task_error("移除仓库提交模板", error))?
}

#[tauri::command]
pub async fn load_command_logs() -> Result<Vec<crate::models::CommandLogEntry>, String> {
    Ok(git::load_command_logs())
}

#[tauri::command]
pub async fn clear_command_logs() -> Result<(), String> {
    git::clear_command_logs();
    Ok(())
}

#[tauri::command]
pub async fn load_repository(path: String) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || git::read_repository(&path))
        .await
        .map_err(|error| task_error("读取仓库", error))?
}

#[tauri::command]
pub async fn load_repository_history(
    path: String,
    commit_limit: usize,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::read_repository_with_commit_limit(&path, commit_limit)
    })
    .await
    .map_err(|error| task_error("读取扩展提交图谱", error))?
}

#[tauri::command]
pub async fn load_repository_state_token(repository_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git::repository_state_token(&repository_path))
        .await
        .map_err(|error| task_error("检查仓库状态", error))?
}

#[tauri::command]
pub async fn load_file_diff(
    repository_path: String,
    file_path: String,
    show_whitespace: bool,
) -> Result<Vec<DiffLine>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::parse_diff(Path::new(&repository_path), &file_path, show_whitespace)
    })
    .await
    .map_err(|error| task_error("读取 Diff", error))?
}

#[tauri::command]
pub async fn load_unstaged_file_diff(
    repository_path: String,
    file_path: String,
    show_whitespace: bool,
) -> Result<Vec<DiffLine>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::parse_unstaged_diff(Path::new(&repository_path), &file_path, show_whitespace)
    })
    .await
    .map_err(|error| task_error("读取未暂存 Diff", error))?
}

#[tauri::command]
pub async fn load_staged_file_diff(
    repository_path: String,
    file_path: String,
    show_whitespace: bool,
) -> Result<Vec<DiffLine>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::parse_staged_diff(Path::new(&repository_path), &file_path, show_whitespace)
    })
    .await
    .map_err(|error| task_error("读取已暂存 Diff", error))?
}

#[tauri::command]
pub async fn fetch_repository(repository_path: String) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::fetch_repository(&repository_path)?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error("Fetch", error))?
}

#[tauri::command]
pub async fn stage_files(
    repository_path: String,
    file_paths: Vec<String>,
    force: bool,
) -> Result<Vec<RepositoryFile>, String> {
    tauri::async_runtime::spawn_blocking(move || git::stage_files(&repository_path, &file_paths, force))
        .await
        .map_err(|error| task_error("暂存文件", error))?
}

#[tauri::command]
pub async fn stage_patch(
    repository_path: String,
    patch: String,
) -> Result<Vec<RepositoryFile>, String> {
    tauri::async_runtime::spawn_blocking(move || git::stage_patch(&repository_path, &patch))
        .await
        .map_err(|error| task_error("暂存修改块", error))?
}

#[tauri::command]
pub async fn restore_patch(
    repository_path: String,
    patch: String,
) -> Result<Vec<RepositoryFile>, String> {
    tauri::async_runtime::spawn_blocking(move || git::restore_patch(&repository_path, &patch))
        .await
        .map_err(|error| task_error("还原修改块", error))?
}

#[tauri::command]
pub async fn unstage_patch(
    repository_path: String,
    patch: String,
) -> Result<Vec<RepositoryFile>, String> {
    tauri::async_runtime::spawn_blocking(move || git::unstage_patch(&repository_path, &patch))
        .await
        .map_err(|error| task_error("取消暂存修改块", error))?
}

#[tauri::command]
pub async fn unstage_files(
    repository_path: String,
    file_paths: Vec<String>,
) -> Result<Vec<RepositoryFile>, String> {
    tauri::async_runtime::spawn_blocking(move || git::unstage_files(&repository_path, &file_paths))
        .await
        .map_err(|error| task_error("取消暂存", error))?
}

#[tauri::command]
pub async fn discard_worktree_files(
    repository_path: String,
    file_paths: Vec<String>,
) -> Result<Vec<RepositoryFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::discard_worktree_files(&repository_path, &file_paths)
    })
    .await
    .map_err(|error| task_error("丢弃改动", error))?
}

#[tauri::command]
pub async fn load_commit_stats(
    repository_path: String,
    commit: String,
) -> Result<RepositoryCommitStats, String> {
    tauri::async_runtime::spawn_blocking(move || git::load_commit_stats(&repository_path, &commit))
        .await
        .map_err(|error| task_error("读取提交统计", error))?
}

#[tauri::command]
pub async fn load_commit_files(
    repository_path: String,
    commit: String,
) -> Result<Vec<RepositoryFile>, String> {
    tauri::async_runtime::spawn_blocking(move || git::load_commit_files(&repository_path, &commit))
        .await
        .map_err(|error| task_error("读取提交文件", error))?
}

#[tauri::command]
pub async fn commit_repository(
    repository_path: String,
    message: String,
    amend: bool,
    sign: bool,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::commit_repository(&repository_path, &message, amend, sign)?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error("提交", error))?
}

#[tauri::command]
pub async fn resolve_gitlink_conflicts_local(repository_path: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::resolve_gitlink_conflicts_local(&repository_path)
    })
    .await
    .map_err(|error| task_error("解决 Gitlink 冲突", error))?
}

#[tauri::command]
pub async fn load_conflict_file(
    repository_path: String,
    file_path: String,
) -> Result<crate::models::ConflictFileContent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::load_conflict_file(&repository_path, &file_path)
    })
    .await
    .map_err(|error| task_error("读取冲突文件", error))?
}

#[tauri::command]
pub async fn resolve_conflict_file(
    repository_path: String,
    file_path: String,
    strategy: String,
    content: Option<String>,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::resolve_conflict_file(&repository_path, &file_path, &strategy, content.as_deref())?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error("保存冲突解决结果", error))?
}

#[tauri::command]
pub async fn resolve_conflict_block(
    repository_path: String,
    file_path: String,
    block_index: usize,
    strategy: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::resolve_conflict_block(&repository_path, &file_path, block_index, &strategy)
    })
    .await
    .map_err(|error| task_error("解决冲突块", error))?
}

#[tauri::command]
pub async fn launch_conflict_mergetool(
    repository_path: String,
    file_path: String,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::launch_conflict_mergetool(&repository_path, &file_path)?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error("打开外部合并工具", error))?
}

#[tauri::command]
pub async fn load_file_history(
    repository_path: String,
    file_path: String,
) -> Result<Vec<FileHistoryEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::load_file_history(&repository_path, &file_path)
    })
    .await
    .map_err(|error| task_error("读取文件历史", error))?
}

#[tauri::command]
pub async fn load_file_commit_diff(
    repository_path: String,
    commit: String,
    file_path: String,
    show_whitespace: bool,
) -> Result<Vec<DiffLine>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::load_file_commit_diff(&repository_path, &commit, &file_path, show_whitespace)
    })
    .await
    .map_err(|error| task_error("读取文件提交 Diff", error))?
}

#[tauri::command]
pub async fn load_file_blame(
    repository_path: String,
    file_path: String,
    revision: Option<String>,
) -> Result<Vec<BlameLine>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::load_file_blame(&repository_path, &file_path, revision.as_deref())
    })
    .await
    .map_err(|error| task_error("读取逐行归属", error))?
}

#[tauri::command]
pub async fn load_line_history(
    repository_path: String,
    file_path: String,
    line: usize,
    revision: Option<String>,
) -> Result<Vec<FileHistoryEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::load_line_history(&repository_path, &file_path, line, revision.as_deref())
    })
    .await
    .map_err(|error| task_error("读取指定行历史", error))?
}

#[tauri::command]
pub async fn preview_branch_prefix(
    repository_path: String,
    prefix: String,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::preview_branch_prefix(&repository_path, &prefix)
    })
    .await
    .map_err(|error| task_error("读取分支前缀", error))?
}

#[tauri::command]
pub async fn delete_branch_prefix(
    repository_path: String,
    prefix: String,
    branches: Vec<String>,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::delete_branch_prefix(&repository_path, &prefix, &branches)?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error("删除分支前缀", error))?
}

#[tauri::command]
pub async fn switch_repository_branch(
    repository_path: String,
    branch: String,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::switch_repository_branch(&repository_path, &branch)?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error("切换分支", error))?
}

#[tauri::command]
pub async fn create_repository_branch(
    repository_path: String,
    branch: String,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::create_repository_branch(&repository_path, &branch)?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error("创建分支", error))?
}

#[tauri::command]
pub async fn merge_repository_reference(
    repository_path: String,
    reference: String,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        operation_snapshot(
            &repository_path,
            git::merge_repository_reference(&repository_path, &reference),
            "合并",
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn cherry_pick_repository_commit(
    repository_path: String,
    commit: String,
    mainline: Option<usize>,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = match mainline {
            Some(mainline) => git::cherry_pick_repository_commit_with_mainline(
                &repository_path,
                &commit,
                Some(mainline),
            ),
            None => git::cherry_pick_repository_commit(&repository_path, &commit),
        };
        operation_snapshot(
            &repository_path,
            result,
            "Cherry-pick",
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn pull_repository_branch(
    repository_path: String,
    branch: String,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::pull_repository_branch(&repository_path, &branch)?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error("拉取分支", error))?
}

#[tauri::command]
pub async fn push_repository(repository_path: String) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::push_repository(&repository_path)?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error("推送分支", error))?
}

#[tauri::command]
pub async fn push_repository_with_lease(
    repository_path: String,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::push_repository_with_lease(&repository_path)?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error("强制推送分支", error))?
}

#[tauri::command]
pub async fn reset_repository_to_commit(
    repository_path: String,
    commit: String,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::reset_repository_to_commit(&repository_path, &commit)?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error("回退提交", error))?
}

#[tauri::command]
pub async fn undo_last_commit(repository_path: String) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let message = git::undo_last_commit(&repository_path)?;
        let mut snapshot = git::read_repository(&repository_path)?;
        snapshot.undo_commit_message = Some(message);
        Ok(snapshot)
    })
    .await
    .map_err(|error| task_error("撤回上一次提交", error))?
}

#[tauri::command]
pub async fn revert_repository_commit(
    repository_path: String,
    commit: String,
    mainline: Option<usize>,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        operation_snapshot(
            &repository_path,
            git::revert_repository_commit(&repository_path, &commit, mainline),
            "还原提交",
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn rebase_repository_onto(
    repository_path: String,
    commit: String,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        operation_snapshot(
            &repository_path,
            git::rebase_repository_onto(&repository_path, &commit),
            "变基",
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn preview_repository_rebase(
    repository_path: String,
    onto: String,
) -> Result<crate::models::RebasePreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::preview_repository_rebase(&repository_path, &onto)
    })
    .await
    .map_err(|error| task_error("预览变基", error))?
}

#[tauri::command]
pub async fn continue_repository_operation(
    repository_path: String,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        operation_snapshot(
            &repository_path,
            git::continue_repository_operation(&repository_path),
            "继续 Git 操作",
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn skip_repository_operation(
    repository_path: String,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        operation_snapshot(
            &repository_path,
            git::skip_repository_operation(&repository_path),
            "跳过当前提交",
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn abort_repository_operation(
    repository_path: String,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        operation_snapshot(
            &repository_path,
            git::abort_repository_operation(&repository_path),
            "中止 Git 操作",
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn create_repository_tag(
    repository_path: String,
    tag: String,
    commit: String,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::create_repository_tag(&repository_path, &tag, &commit)?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error("创建标签", error))?
}

#[tauri::command]
pub async fn delete_repository_branch(
    repository_path: String,
    branch: String,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::delete_repository_branch(&repository_path, &branch)?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error("删除分支", error))?
}

#[tauri::command]
pub async fn compare_repository_refs(
    repository_path: String,
    base: String,
    target: String,
) -> Result<RepositoryComparison, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::compare_repository_refs(&repository_path, &base, &target)
    })
    .await
    .map_err(|error| task_error("比较分支", error))?
}

#[tauri::command]
pub async fn load_compare_file_diff(
    repository_path: String,
    base: String,
    target: String,
    file_path: String,
    show_whitespace: bool,
) -> Result<Vec<DiffLine>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::parse_compare_diff(&repository_path, &base, &target, &file_path, show_whitespace)
    })
    .await
    .map_err(|error| task_error("读取比较 Diff", error))?
}

#[tauri::command]
pub async fn load_merge_queue(repository_path: String) -> Result<MergeQueueSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || git::load_merge_queue(&repository_path))
        .await
        .map_err(|error| task_error("读取合并队列", error))?
}

#[tauri::command]
pub async fn create_repository_worktree(
    repository_path: String,
    worktree_path: String,
    branch: String,
    create_branch: bool,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::create_repository_worktree(&repository_path, &worktree_path, &branch, create_branch)?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error("创建 Worktree", error))?
}

#[tauri::command]
pub async fn remove_repository_worktree(
    repository_path: String,
    worktree_path: String,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::remove_repository_worktree(&repository_path, &worktree_path)?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error("移除 Worktree", error))?
}

#[tauri::command]
pub async fn set_repository_worktree_lock(
    repository_path: String,
    worktree_path: String,
    locked: bool,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::set_repository_worktree_lock(&repository_path, &worktree_path, locked)?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error(if locked { "锁定 Worktree" } else { "解锁 Worktree" }, error))?
}

#[tauri::command]
pub async fn prune_repository_worktrees(repository_path: String) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::prune_repository_worktrees(&repository_path)?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error("清理 Worktree", error))?
}

#[tauri::command]
pub async fn initialize_repository_submodule(
    repository_path: String,
    submodule_path: String,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::initialize_repository_submodule(&repository_path, &submodule_path)?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error("初始化 Submodule", error))?
}

#[tauri::command]
pub async fn update_repository_submodule(
    repository_path: String,
    submodule_path: Option<String>,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::update_repository_submodule(&repository_path, submodule_path.as_deref())?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error("更新 Submodule", error))?
}

#[tauri::command]
pub async fn sync_repository_submodules(repository_path: String) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::sync_repository_submodules(&repository_path)?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error("同步 Submodule URL", error))?
}

#[tauri::command]
pub async fn deinitialize_repository_submodule(
    repository_path: String,
    submodule_path: String,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::deinitialize_repository_submodule(&repository_path, &submodule_path)?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error("取消初始化 Submodule", error))?
}

#[tauri::command]
pub async fn create_repository_stash(
    repository_path: String,
    message: String,
    include_untracked: bool,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::create_repository_stash(&repository_path, &message, include_untracked)?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error("创建 Stash", error))?
}

#[tauri::command]
pub async fn create_scoped_repository_stash(
    repository_path: String,
    scope: String,
    message: String,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::create_scoped_repository_stash(&repository_path, &scope, &message)?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error("快速 Stash", error))?
}

#[tauri::command]
pub async fn apply_repository_stash(
    repository_path: String,
    reference: String,
    pop: bool,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        operation_snapshot(
            &repository_path,
            git::apply_repository_stash(&repository_path, &reference, pop),
            "应用 Stash",
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn drop_repository_stash(
    repository_path: String,
    reference: String,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::drop_repository_stash(&repository_path, &reference)?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error("删除 Stash", error))?
}

#[tauri::command]
pub async fn load_stash_files(
    repository_path: String,
    reference: String,
) -> Result<Vec<crate::models::RepositoryFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::load_stash_files(&repository_path, &reference)
    })
    .await
    .map_err(|error| task_error("读取 Stash 文件", error))?
}

#[tauri::command]
pub async fn load_stash_file_diff(
    repository_path: String,
    reference: String,
    file_path: String,
    show_whitespace: bool,
) -> Result<Vec<DiffLine>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::load_stash_file_diff(&repository_path, &reference, &file_path, show_whitespace)
    })
    .await
    .map_err(|error| task_error("读取 Stash Diff", error))?
}

// ---------------------------------------------------------------------------------------------
// 远程仓库 / 分支上游 / 标签管理：实现位于 src/git_remote.rs，本文件只做 Tauri 包装。
// 破坏性操作的 confirm 由前端二次确认后传 true，Rust 层不会自作主张执行。
// ---------------------------------------------------------------------------------------------

use crate::git_remote;
use crate::models::{RemoteOperationReport, RepositoryRemoteDetail, RepositoryTagDetail};

#[tauri::command]
pub async fn load_repository_remotes(
    repository_path: String,
) -> Result<Vec<RepositoryRemoteDetail>, String> {
    tauri::async_runtime::spawn_blocking(move || git_remote::list_repository_remotes(&repository_path))
        .await
        .map_err(|error| task_error("读取远程列表", error))?
}

#[tauri::command]
pub async fn load_repository_tag_details(
    repository_path: String,
) -> Result<Vec<RepositoryTagDetail>, String> {
    tauri::async_runtime::spawn_blocking(move || git_remote::list_repository_tag_details(&repository_path))
        .await
        .map_err(|error| task_error("读取标签详情", error))?
}

#[tauri::command]
pub async fn add_repository_remote(
    repository_path: String,
    name: String,
    url: String,
    fetch: bool,
) -> Result<RemoteOperationReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_remote::add_repository_remote(&repository_path, &name, &url, fetch)
    })
    .await
    .map_err(|error| task_error("添加远程仓库", error))?
}

#[tauri::command]
pub async fn remove_repository_remote(
    repository_path: String,
    name: String,
    confirm: bool,
) -> Result<RemoteOperationReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_remote::remove_repository_remote(&repository_path, &name, confirm)
    })
    .await
    .map_err(|error| task_error("删除远程仓库", error))?
}

#[tauri::command]
pub async fn rename_repository_remote(
    repository_path: String,
    old_name: String,
    new_name: String,
    confirm: bool,
) -> Result<RemoteOperationReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_remote::rename_repository_remote(&repository_path, &old_name, &new_name, confirm)
    })
    .await
    .map_err(|error| task_error("重命名远程仓库", error))?
}

#[tauri::command]
pub async fn set_repository_remote_url(
    repository_path: String,
    name: String,
    url: String,
    push: bool,
    confirm: bool,
) -> Result<RemoteOperationReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_remote::set_repository_remote_url(&repository_path, &name, &url, push, confirm)
    })
    .await
    .map_err(|error| task_error("设置远程地址", error))?
}

#[tauri::command]
pub async fn rename_repository_branch(
    repository_path: String,
    old_name: String,
    new_name: String,
    confirm: bool,
) -> Result<RemoteOperationReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_remote::rename_repository_branch(&repository_path, &old_name, &new_name, confirm)
    })
    .await
    .map_err(|error| task_error("重命名分支", error))?
}

#[tauri::command]
pub async fn set_repository_branch_upstream(
    repository_path: String,
    branch: String,
    upstream: Option<String>,
) -> Result<RemoteOperationReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_remote::set_repository_branch_upstream(&repository_path, &branch, upstream.as_deref())
    })
    .await
    .map_err(|error| task_error("设置上游跟踪分支", error))?
}

#[tauri::command]
pub async fn create_repository_annotated_tag(
    repository_path: String,
    tag: String,
    commit: String,
    message: String,
    force: bool,
    confirm: bool,
) -> Result<RemoteOperationReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_remote::create_repository_annotated_tag(
            &repository_path, &tag, &commit, &message, force, confirm,
        )
    })
    .await
    .map_err(|error| task_error("创建注释标签", error))?
}

#[tauri::command]
pub async fn create_repository_signed_tag(
    repository_path: String,
    tag: String,
    commit: String,
    message: String,
    signing_key: Option<String>,
    force: bool,
    confirm: bool,
) -> Result<RemoteOperationReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_remote::create_repository_signed_tag(
            &repository_path,
            &tag,
            &commit,
            &message,
            signing_key.as_deref(),
            force,
            confirm,
        )
    })
    .await
    .map_err(|error| task_error("创建签名标签", error))?
}

#[tauri::command]
pub async fn delete_repository_tag(
    repository_path: String,
    tag: String,
    confirm: bool,
) -> Result<RemoteOperationReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_remote::delete_repository_tag(&repository_path, &tag, confirm)
    })
    .await
    .map_err(|error| task_error("删除标签", error))?
}

#[tauri::command]
pub async fn delete_repository_remote_tag(
    repository_path: String,
    remote: String,
    tag: String,
    confirm: bool,
) -> Result<RemoteOperationReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_remote::delete_repository_remote_tag(&repository_path, &remote, &tag, confirm)
    })
    .await
    .map_err(|error| task_error("删除远端标签", error))?
}

#[tauri::command]
pub async fn push_repository_tags(
    repository_path: String,
    remote: String,
    tags: Vec<String>,
    force: bool,
    confirm: bool,
) -> Result<RemoteOperationReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_remote::push_repository_tags(&repository_path, &remote, &tags, force, confirm)
    })
    .await
    .map_err(|error| task_error("推送标签", error))?
}

// ---------------------------------------------------------------------------
// W1-5 恢复与问题定位：Reflog / Bisect / Reset 模式
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn load_reflog_entries(
    repository_path: String,
    branch: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<crate::models::ReflogEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_recovery::load_reflog_entries(&repository_path, branch.as_deref(), limit)
    })
    .await
    .map_err(|error| task_error("读取 Reflog", error))?
}

#[tauri::command]
pub async fn load_revision_files(
    repository_path: String,
    reference: String,
) -> Result<Vec<RepositoryFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_recovery::load_revision_files(&repository_path, &reference)
    })
    .await
    .map_err(|error| task_error("读取历史对象文件", error))?
}

#[tauri::command]
pub async fn load_revision_file_diff(
    repository_path: String,
    reference: String,
    file_path: String,
    show_whitespace: bool,
) -> Result<Vec<DiffLine>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_recovery::load_revision_file_diff(&repository_path, &reference, &file_path, show_whitespace)
    })
    .await
    .map_err(|error| task_error("读取历史对象差异", error))?
}

#[tauri::command]
pub async fn checkout_reflog_entry(repository_path: String, reference: String) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_recovery::checkout_reflog_entry(&repository_path, &reference)?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error("按 Reflog 检出", error))?
}

#[tauri::command]
pub async fn create_branch_from_reflog_entry(
    repository_path: String,
    reference: String,
    branch: String,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_recovery::create_branch_from_reflog_entry(&repository_path, &reference, &branch)?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error("从 Reflog 创建分支", error))?
}

#[tauri::command]
pub async fn reset_repository_with_mode(
    repository_path: String,
    commit: String,
    mode: String,
    confirm_hard: bool,
) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_recovery::reset_repository_with_mode(&repository_path, &commit, &mode, confirm_hard)?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error("回退提交", error))?
}

#[tauri::command]
pub async fn start_repository_bisect(
    repository_path: String,
    bad: String,
    good: String,
    new_term: Option<String>,
    old_term: Option<String>,
) -> Result<crate::models::BisectStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_recovery::start_repository_bisect(
            &repository_path,
            &bad,
            &good,
            new_term.as_deref(),
            old_term.as_deref(),
        )
    })
    .await
    .map_err(|error| task_error("启动 Bisect", error))?
}

#[tauri::command]
pub async fn load_repository_bisect_status(repository_path: String) -> Result<crate::models::BisectStatus, String> {
    tauri::async_runtime::spawn_blocking(move || crate::git_recovery::load_bisect_status(&repository_path))
        .await
        .map_err(|error| task_error("读取 Bisect 状态", error))?
}

#[tauri::command]
pub async fn mark_repository_bisect(
    repository_path: String,
    verdict: String,
) -> Result<crate::models::BisectStatus, String> {
    tauri::async_runtime::spawn_blocking(move || crate::git_recovery::mark_repository_bisect(&repository_path, &verdict))
        .await
        .map_err(|error| task_error("记录 Bisect 结论", error))?
}

#[tauri::command]
pub async fn advance_repository_bisect(repository_path: String) -> Result<crate::models::BisectStatus, String> {
    tauri::async_runtime::spawn_blocking(move || crate::git_recovery::advance_repository_bisect(&repository_path))
        .await
        .map_err(|error| task_error("推进 Bisect", error))?
}

#[tauri::command]
pub async fn reset_repository_bisect(repository_path: String) -> Result<RepositorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_recovery::reset_repository_bisect(&repository_path)?;
        git::read_repository(&repository_path)
    })
    .await
    .map_err(|error| task_error("退出 Bisect", error))?
}

#[tauri::command]
pub async fn load_media_blob(
    repository_path: String,
    reference: String,
    file_path: String,
    request_id: Option<String>,
) -> Result<crate::models::MediaBlob, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_media::describe_revision_blob(
            &repository_path,
            &reference,
            &file_path,
            request_id.as_deref(),
        )
    })
    .await
    .map_err(|error| task_error("读取图片内容", error))?
}

#[tauri::command]
pub async fn load_image_file_diff(
    repository_path: String,
    from_reference: String,
    to_reference: String,
    file_path: String,
    request_id: Option<String>,
) -> Result<crate::models::ImageFileDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_media::load_image_file_diff(
            &repository_path,
            &from_reference,
            &to_reference,
            &file_path,
            request_id.as_deref(),
        )
    })
    .await
    .map_err(|error| task_error("读取图片差异", error))?
}

#[tauri::command]
pub fn cancel_media_preview(request_id: String) -> Result<(), String> {
    crate::git_media::cancel_media_request(&request_id);
    Ok(())
}

#[tauri::command]
pub async fn load_commit_tree(
    repository_path: String,
    reference: String,
    max_entries: Option<usize>,
) -> Result<crate::models::CommitTree, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_tree::load_commit_tree(&repository_path, &reference, max_entries)
    })
    .await
    .map_err(|error| task_error("读取提交文件树", error))?
}

#[tauri::command]
pub async fn load_commit_tree_children(
    repository_path: String,
    reference: String,
    directory_path: String,
) -> Result<Vec<crate::models::CommitTreeEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_tree::load_commit_tree_children(&repository_path, &reference, &directory_path)
    })
    .await
    .map_err(|error| task_error("读取目录子项", error))?
}

#[tauri::command]
pub async fn load_revision_file_preview(
    repository_path: String,
    reference: String,
    file_path: String,
    max_text_bytes: Option<u64>,
    request_id: Option<String>,
) -> Result<crate::models::RevisionFilePreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_tree::load_revision_file_preview(
            &repository_path,
            &reference,
            &file_path,
            max_text_bytes,
            request_id.as_deref(),
        )
    })
    .await
    .map_err(|error| task_error("读取文件内容", error))?
}

#[tauri::command]
pub async fn open_revision_file_externally(
    repository_path: String,
    reference: String,
    file_path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_media::open_revision_file_externally(&repository_path, &reference, &file_path)
    })
    .await
    .map_err(|error| task_error("外部打开文件", error))?
}

#[tauri::command]
pub async fn search_commits(
    repository_path: String,
    query: crate::models::CommitSearchQuery,
) -> Result<crate::models::CommitSearchPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_search::search_commits(&repository_path, query)
    })
    .await
    .map_err(|error| task_error("历史搜索", error))?
}

#[tauri::command]
pub async fn load_commit_search_page(
    repository_path: String,
    search_id: String,
    offset: usize,
    page_size: usize,
) -> Result<crate::models::CommitSearchPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_search::load_commit_search_page(&repository_path, &search_id, offset, page_size)
    })
    .await
    .map_err(|error| task_error("历史搜索翻页", error))?
}

#[tauri::command]
pub async fn search_repository_text(
    repository_path: String,
    query: crate::models::TextSearchQuery,
) -> Result<crate::models::TextSearchPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_search::search_repository_text(&repository_path, query)
    })
    .await
    .map_err(|error| task_error("全文搜索", error))?
}

#[tauri::command]
pub async fn load_repository_text_page(
    repository_path: String,
    search_id: String,
    offset: usize,
    page_size: usize,
    context_lines: usize,
) -> Result<crate::models::TextSearchPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_search::load_repository_text_page(
            &repository_path,
            &search_id,
            offset,
            page_size,
            context_lines,
        )
    })
    .await
    .map_err(|error| task_error("全文搜索翻页", error))?
}

#[tauri::command]
pub async fn preview_text_replace(
    repository_path: String,
    query: crate::models::TextReplaceQuery,
) -> Result<crate::models::ReplacePreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_search::preview_text_replace(&repository_path, query)
    })
    .await
    .map_err(|error| task_error("替换预览", error))?
}

#[tauri::command]
pub async fn apply_text_replace(
    repository_path: String,
    preview_id: String,
    confirm: bool,
) -> Result<crate::models::ReplaceReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_search::apply_text_replace(&repository_path, &preview_id, confirm)
    })
    .await
    .map_err(|error| task_error("执行替换", error))?
}

#[tauri::command]
pub async fn undo_text_replace(
    repository_path: String,
    replace_id: String,
) -> Result<crate::models::ReplaceReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_search::undo_text_replace(&repository_path, &replace_id)
    })
    .await
    .map_err(|error| task_error("撤销替换", error))?
}

#[tauri::command]
pub async fn list_text_replace_backups(
    repository_path: String,
) -> Result<Vec<crate::models::ReplaceBackupSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_search::list_text_replace_backups(&repository_path)
    })
    .await
    .map_err(|error| task_error("列出替换备份", error))?
}

#[tauri::command]
pub async fn load_repository_text_file(
    repository_path: String,
    file_path: String,
    max_bytes: Option<usize>,
    revision: Option<String>,
) -> Result<crate::models::RepositoryTextFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_search::load_repository_text_file(
            &repository_path,
            &file_path,
            max_bytes,
            revision.as_deref(),
        )
    })
    .await
    .map_err(|error| task_error("读取文本文件", error))?
}

#[tauri::command]
pub async fn save_repository_text_file(
    repository_path: String,
    file_path: String,
    content: String,
    base_checksum: String,
) -> Result<crate::models::RepositoryTextFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_search::save_repository_text_file(
            &repository_path,
            &file_path,
            &content,
            &base_checksum,
        )
    })
    .await
    .map_err(|error| task_error("保存文本文件", error))?
}

#[tauri::command]
pub async fn cancel_repository_search(
    repository_path: String,
) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_search::cancel_repository_search(&repository_path)
    })
    .await
    .map_err(|error| task_error("取消搜索", error))
}

#[tauri::command]
pub async fn add_repository_submodule(
    repository_path: String,
    url: String,
    submodule_path: Option<String>,
    name: Option<String>,
    branch: Option<String>,
    confirm: bool,
) -> Result<crate::models::SubmoduleOperationReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_submodule::add_repository_submodule(
            &repository_path,
            &url,
            submodule_path.as_deref(),
            name.as_deref(),
            branch.as_deref(),
            confirm,
        )
    })
    .await
    .map_err(|error| task_error("添加 Submodule", error))?
}

#[tauri::command]
pub async fn list_repository_submodule_details(
    repository_path: String,
) -> Result<Vec<crate::models::RepositorySubmoduleDetail>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_submodule::list_repository_submodule_details(&repository_path)
    })
    .await
    .map_err(|error| task_error("读取 Submodule 明细", error))?
}

#[tauri::command]
pub async fn load_submodule_pointer_diff(
    repository_path: String,
    submodule_path: String,
) -> Result<crate::models::SubmodulePointerDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_submodule::load_submodule_pointer_diff(&repository_path, &submodule_path)
    })
    .await
    .map_err(|error| task_error("读取 Submodule 差异", error))?
}

#[tauri::command]
pub async fn clone_repository_with_options(
    destination: String,
    source: String,
    recurse_submodules: bool,
    depth: Option<usize>,
    branch: Option<String>,
    single_branch: bool,
) -> Result<crate::repository_management::RepositoryDetails, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::repository_management::clone_repository(
            &destination,
            &source,
            &crate::repository_management::clone_options(
                recurse_submodules,
                depth,
                branch,
                single_branch,
            ),
        )
    })
    .await
    .map_err(|error| task_error("克隆仓库", error))?
}

#[tauri::command]
pub async fn load_history_edit_sequence(
    repository_path: String,
    base_ref: String,
) -> Result<crate::models::HistoryEditSequence, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_history_edit::load_history_edit_sequence(&repository_path, &base_ref)
    })
    .await
    .map_err(|error| task_error("读取历史编辑序列", error))?
}

#[tauri::command]
pub async fn preview_history_edit_impact(
    repository_path: String,
    base_ref: String,
    actions: Vec<crate::models::HistoryEditActionInput>,
) -> Result<crate::models::HistoryEditImpact, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_history_edit::preview_history_edit_impact(&repository_path, &base_ref, actions)
    })
    .await
    .map_err(|error| task_error("预览历史编辑影响", error))?
}

#[tauri::command]
pub async fn apply_history_edit_sequence(
    repository_path: String,
    base_ref: String,
    actions: Vec<crate::models::HistoryEditActionInput>,
) -> Result<crate::models::HistoryEditReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_history_edit::apply_history_edit_sequence(&repository_path, &base_ref, actions)
    })
    .await
    .map_err(|error| task_error("应用历史编辑", error))?
}

#[tauri::command]
pub async fn reword_history_commit(
    repository_path: String,
    commit: String,
    message: String,
) -> Result<crate::models::HistoryEditReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_history_edit::reword_history_commit(&repository_path, &commit, &message)
    })
    .await
    .map_err(|error| task_error("改写提交消息", error))?
}

#[tauri::command]
pub async fn drop_history_commit(
    repository_path: String,
    commit: String,
) -> Result<crate::models::HistoryEditReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_history_edit::drop_history_commit(&repository_path, &commit)
    })
    .await
    .map_err(|error| task_error("删除提交", error))?
}

#[tauri::command]
pub async fn cherry_pick_history_commits(
    repository_path: String,
    commits: Vec<String>,
    mainline: Option<usize>,
) -> Result<crate::models::CherryPickBatchReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_history_edit::cherry_pick_history_commits(&repository_path, commits, mainline)
    })
    .await
    .map_err(|error| task_error("批量拣选提交", error))?
}

// ---------------------------------------------------------------------------
// W3-3 流式提交历史：游标分页（apps/desktop/src/git.rs）
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn start_repository_history_stream(
    repository_path: String,
    page_size: Option<usize>,
) -> Result<crate::models::RepositoryHistoryPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::start_repository_history_stream(&repository_path, page_size)
    })
    .await
    .map_err(|error| task_error("开始提交图谱流", error))?
}

#[tauri::command]
pub async fn load_repository_history_next_page(
    session_id: String,
    page_size: Option<usize>,
) -> Result<crate::models::RepositoryHistoryPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::load_repository_history_next_page(&session_id, page_size)
    })
    .await
    .map_err(|error| task_error("续取提交图谱", error))?
}

#[tauri::command]
pub async fn start_repository_file_history_stream(
    repository_path: String,
    file_path: String,
    page_size: Option<usize>,
) -> Result<crate::models::RepositoryHistoryPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::start_repository_file_history_stream(&repository_path, &file_path, page_size)
    })
    .await
    .map_err(|error| task_error("开始文件历史流", error))?
}

#[tauri::command]
pub async fn load_repository_file_history_next_page(
    session_id: String,
    page_size: Option<usize>,
) -> Result<crate::models::RepositoryHistoryPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::load_repository_file_history_next_page(&session_id, page_size)
    })
    .await
    .map_err(|error| task_error("续取文件历史", error))?
}

#[tauri::command]
pub async fn start_repository_line_history_stream(
    repository_path: String,
    file_path: String,
    line: usize,
    revision: Option<String>,
    page_size: Option<usize>,
) -> Result<crate::models::RepositoryHistoryPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::start_repository_line_history_stream(
            &repository_path,
            &file_path,
            line,
            revision.as_deref(),
            page_size,
        )
    })
    .await
    .map_err(|error| task_error("开始行历史流", error))?
}

#[tauri::command]
pub async fn load_repository_line_history_next_page(
    session_id: String,
    page_size: Option<usize>,
) -> Result<crate::models::RepositoryHistoryPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::load_repository_line_history_next_page(&session_id, page_size)
    })
    .await
    .map_err(|error| task_error("续取行历史", error))?
}

#[tauri::command]
pub async fn cancel_repository_history_stream(session_id: String) -> Result<bool, String> {
    Ok(tauri::async_runtime::spawn_blocking(move || {
        git::cancel_repository_history_stream(&session_id)
    })
    .await
    .map_err(|error| task_error("取消历史流", error))?)
}

#[tauri::command]
pub async fn cancel_repository_history(repository_path: String) -> Result<usize, String> {
    Ok(tauri::async_runtime::spawn_blocking(move || {
        git::cancel_repository_history(&repository_path)
    })
    .await
    .map_err(|error| task_error("取消仓库历史流", error))?)
}
