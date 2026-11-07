mod commands;
mod error;
mod git;
mod git_ai;
mod git_credentials;
mod git_flow;
mod git_hosting;
mod git_lfs;
mod git_terminal;
mod git_media;
mod git_tree;
mod git_remote;
mod git_recovery;
mod git_review;
mod git_history_edit;
mod git_search;
mod git_submodule;
mod menu;
mod models;
mod repository_management;

use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // 自定义 / 随包 Git 目录必须在任何 Git 子进程启动前前置到 PATH。
            git_credentials::configure_process_path();
            let runtime = menu::MenuRuntime::default();
            if let Ok(built) = menu::build_menu(app.handle(), &runtime.labels, &runtime.state) {
                let _ = app.set_menu(built);
            }
            app.manage(std::sync::Mutex::new(runtime));
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.clone();
            let _ = app.emit("menu-action", menu::MenuAction { id, payload: None });
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_repository_details,
            commands::load_repository_readme,
            commands::create_repository,
            commands::open_repository_in_vscode,
            commands::load_git_user_config,
            commands::update_git_user_config,
            commands::update_repository_commit_template,
            commands::clear_repository_commit_template,
            commands::load_command_logs,
            commands::clear_command_logs,
            commands::load_repository,
            commands::load_repository_history,
            commands::load_repository_state_token,
            commands::load_file_diff,
            commands::load_unstaged_file_diff,
            commands::load_staged_file_diff,
            commands::load_commit_stats,
            commands::load_commit_files,
            commands::fetch_repository,
            commands::stage_files,
            commands::stage_patch,
            commands::unstage_patch,
            commands::restore_patch,
            commands::unstage_files,
            commands::discard_worktree_files,
            commands::commit_repository,
            commands::resolve_gitlink_conflicts_local,
            commands::load_conflict_file,
            commands::resolve_conflict_file,
            commands::resolve_conflict_block,
            commands::launch_conflict_mergetool,
            commands::load_file_history,
            commands::load_file_commit_diff,
            commands::load_file_blame,
            commands::load_line_history,
            commands::preview_branch_prefix,
            commands::delete_branch_prefix,
            commands::switch_repository_branch,
            commands::create_repository_branch,
            commands::merge_repository_reference,
            commands::cherry_pick_repository_commit,
            commands::pull_repository_branch,
            commands::push_repository,
            commands::reset_repository_to_commit,
            commands::undo_last_commit,
            commands::revert_repository_commit,
            commands::rebase_repository_onto,
            commands::preview_repository_rebase,
            commands::continue_repository_operation,
            commands::skip_repository_operation,
            commands::abort_repository_operation,
            commands::create_repository_tag,
            commands::delete_repository_branch,
            commands::compare_repository_refs,
            commands::load_compare_file_diff,
            commands::load_merge_queue,
            commands::create_repository_worktree,
            commands::remove_repository_worktree,
            commands::set_repository_worktree_lock,
            commands::prune_repository_worktrees,
            commands::initialize_repository_submodule,
            commands::update_repository_submodule,
            commands::sync_repository_submodules,
            commands::deinitialize_repository_submodule,
            commands::create_repository_stash,
            commands::create_scoped_repository_stash,
            commands::apply_repository_stash,
            commands::drop_repository_stash,
            commands::load_stash_files,
            commands::load_stash_file_diff,
            commands::load_repository_remotes,
            commands::load_repository_tag_details,
            commands::add_repository_remote,
            commands::remove_repository_remote,
            commands::rename_repository_remote,
            commands::set_repository_remote_url,
            commands::rename_repository_branch,
            commands::set_repository_branch_upstream,
            commands::create_repository_annotated_tag,
            commands::create_repository_signed_tag,
            commands::delete_repository_tag,
            commands::delete_repository_remote_tag,
            commands::push_repository_tags,
            commands::push_repository_with_lease,
            // W1-5 恢复与问题定位（Reflog / Bisect / Reset 模式）
            commands::load_reflog_entries,
            commands::load_revision_files,
            commands::load_revision_file_diff,
            commands::checkout_reflog_entry,
            commands::create_branch_from_reflog_entry,
            commands::reset_repository_with_mode,
            commands::start_repository_bisect,
            commands::load_repository_bisect_status,
            commands::mark_repository_bisect,
            commands::advance_repository_bisect,
            commands::reset_repository_bisect,
            // W2-8 图片/SVG 差异预览 与 提交文件树浏览
            commands::load_media_blob,
            commands::load_image_file_diff,
            commands::cancel_media_preview,
            commands::load_commit_tree,
            commands::load_commit_tree_children,
            commands::load_revision_file_preview,
            commands::open_revision_file_externally,
            // W2-9 历史深度搜索与仓库全文搜索/替换
            commands::search_commits,
            commands::load_commit_search_page,
            commands::search_repository_text,
            commands::load_repository_text_page,
            commands::preview_text_replace,
            commands::apply_text_replace,
            commands::undo_text_replace,
            commands::list_text_replace_backups,
            commands::load_repository_text_file,
            commands::save_repository_text_file,
            commands::cancel_repository_search,
            // W2-10 子模块添加、递归/浅克隆与指针差异
            commands::add_repository_submodule,
            commands::list_repository_submodule_details,
            commands::load_submodule_pointer_diff,
            commands::clone_repository_with_options,
            // W3-1 交互式历史编辑
            commands::load_history_edit_sequence,
            commands::preview_history_edit_impact,
            commands::apply_history_edit_sequence,
            commands::reword_history_commit,
            commands::drop_history_commit,
            commands::cherry_pick_history_commits,
            // W3-3 流式提交历史
            commands::start_repository_history_stream,
            commands::load_repository_history_next_page,
            commands::start_repository_file_history_stream,
            commands::load_repository_file_history_next_page,
            commands::start_repository_line_history_stream,
            commands::load_repository_line_history_next_page,
            commands::cancel_repository_history_stream,
            commands::cancel_repository_history,
            // W3-4 Git LFS 与 Gitflow
            crate::git_lfs::lfs_status,
            crate::git_lfs::lfs_install,
            crate::git_lfs::lfs_track_pattern,
            crate::git_lfs::lfs_untrack_pattern,
            crate::git_lfs::lfs_list_files,
            crate::git_lfs::lfs_fetch,
            crate::git_lfs::lfs_pull,
            crate::git_lfs::lfs_prune,
            crate::git_flow::load_gitflow_config,
            crate::git_flow::save_gitflow_config,
            crate::git_flow::list_gitflow_branches,
            crate::git_flow::start_gitflow_branch,
            crate::git_flow::finish_gitflow_branch,
            // W3-5 AI 提交消息
            crate::git_ai::load_ai_settings,
            crate::git_ai::save_ai_settings,
            crate::git_ai::clear_ai_api_key,
            crate::git_ai::generate_commit_message,
            // W3-6 SSH 密钥、凭据助手与 Git 运行时
            crate::git_credentials::api::load_git_runtime_info,
            crate::git_credentials::api::set_custom_git_directory,
            crate::git_credentials::api::load_ssh_keys,
            crate::git_credentials::api::generate_ssh_key,
            crate::git_credentials::api::read_ssh_public_key,
            crate::git_credentials::api::delete_ssh_key,
            crate::git_credentials::api::set_credential_helper,
            crate::git_credentials::api::get_credential_helpers,
            // W4-1 GitHub / GitLab 托管、PR/MR 与 CI
            crate::git_hosting::load_hosting_settings,
            crate::git_hosting::save_hosting_settings,
            crate::git_hosting::clear_hosting_token,
            crate::git_hosting::detect_hosting_repository,
            crate::git_hosting::list_hosting_pull_requests,
            crate::git_hosting::create_hosting_pull_request,
            crate::git_hosting::load_hosting_pull_request,
            crate::git_hosting::fetch_hosting_review_comments,
            // 子项目 B1 本地行级审查评论（Gerrit 式）
            crate::git_review::list_review_threads,
            crate::git_review::upsert_review_thread,
            crate::git_review::delete_review_thread,
            crate::git_review::set_review_thread_resolved,
            // W4-2 内置终端与命令流水线
            crate::git_terminal::start_terminal_session,
            crate::git_terminal::read_terminal_output,
            crate::git_terminal::write_terminal,
            crate::git_terminal::resize_terminal,
            crate::git_terminal::close_terminal_session,
            crate::git_terminal::list_terminal_sessions,
            crate::git_terminal::load_pipeline_commands,
            crate::git_terminal::save_pipeline_commands,
            crate::git_terminal::run_pipeline_command,
            crate::git_terminal::cancel_pipeline_command,
            // W6 原生菜单
            menu::set_menu_language,
            menu::sync_menu_state,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Branchline 失败");
}
