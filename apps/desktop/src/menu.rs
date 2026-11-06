use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::{
    AboutMetadata, CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItem,
    MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::{AppHandle, Manager, Runtime, State};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MenuState {
    pub language: String,
    pub has_repository: bool,
    pub busy: bool,
    pub operation: bool,
    pub has_selection: bool,
    pub sidebar_visible: bool,
    pub inspector_visible: bool,
    pub diff_layout: String,
    pub word_wrap: bool,
    pub show_whitespace: bool,
    pub diff_font_size: u32,
    pub theme: String,
    pub recent: Vec<RecentRepository>,
}

impl Default for MenuState {
    fn default() -> Self {
        Self {
            language: "zh".to_string(),
            has_repository: false,
            busy: false,
            operation: false,
            has_selection: false,
            sidebar_visible: true,
            inspector_visible: true,
            diff_layout: "unified".to_string(),
            word_wrap: false,
            show_whitespace: false,
            diff_font_size: 12,
            theme: "dark".to_string(),
            recent: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct RecentRepository {
    pub path: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuAction {
    pub id: String,
    pub payload: Option<serde_json::Value>,
}

#[derive(Clone, Copy, Debug)]
pub struct MenuItemSpec {
    pub id: &'static str,
    pub accelerator: Option<&'static str>,
}

const ITEM_SPECS: &[MenuItemSpec] = &[
    MenuItemSpec { id: "file.new-repository", accelerator: Some("CmdOrCtrl+N") },
    MenuItemSpec { id: "file.open-repository", accelerator: Some("CmdOrCtrl+O") },
    MenuItemSpec { id: "file.clone-repository", accelerator: Some("Shift+CmdOrCtrl+O") },
    MenuItemSpec { id: "file.close-repository", accelerator: Some("Shift+CmdOrCtrl+W") },
    MenuItemSpec { id: "app.check-updates", accelerator: None },
    MenuItemSpec { id: "app.preferences", accelerator: Some("CmdOrCtrl+,") },
    MenuItemSpec { id: "edit.find", accelerator: Some("CmdOrCtrl+F") },
    MenuItemSpec { id: "edit.find-next", accelerator: Some("CmdOrCtrl+G") },
    MenuItemSpec { id: "edit.find-previous", accelerator: Some("Shift+CmdOrCtrl+G") },
    MenuItemSpec { id: "edit.search-repository", accelerator: Some("Alt+CmdOrCtrl+F") },
    MenuItemSpec { id: "format.word-wrap", accelerator: None },
    MenuItemSpec { id: "format.diff-unified", accelerator: None },
    MenuItemSpec { id: "format.diff-split", accelerator: None },
    MenuItemSpec { id: "format.show-whitespace", accelerator: None },
    MenuItemSpec { id: "format.font-increase", accelerator: Some("CmdOrCtrl+=") },
    MenuItemSpec { id: "format.font-decrease", accelerator: Some("CmdOrCtrl+-") },
    MenuItemSpec { id: "format.font-reset", accelerator: Some("CmdOrCtrl+0") },
    MenuItemSpec { id: "view.history", accelerator: None },
    MenuItemSpec { id: "view.changes", accelerator: None },
    MenuItemSpec { id: "view.stash", accelerator: None },
    MenuItemSpec { id: "view.recovery", accelerator: None },
    MenuItemSpec { id: "view.search", accelerator: None },
    MenuItemSpec { id: "view.tree", accelerator: None },
    MenuItemSpec { id: "view.compare", accelerator: None },
    MenuItemSpec { id: "view.merge", accelerator: None },
    MenuItemSpec { id: "view.terminal", accelerator: None },
    MenuItemSpec { id: "view.sidebar", accelerator: Some("CmdOrCtrl+B") },
    MenuItemSpec { id: "view.inspector", accelerator: None },
    MenuItemSpec { id: "view.theme.light", accelerator: None },
    MenuItemSpec { id: "view.theme.dark", accelerator: None },
    MenuItemSpec { id: "view.language.zh", accelerator: None },
    MenuItemSpec { id: "view.language.en", accelerator: None },
    MenuItemSpec { id: "view.reload", accelerator: Some("CmdOrCtrl+R") },
    MenuItemSpec { id: "repo.fetch", accelerator: Some("Shift+CmdOrCtrl+F") },
    MenuItemSpec { id: "repo.pull", accelerator: Some("Alt+CmdOrCtrl+P") },
    MenuItemSpec { id: "repo.push", accelerator: Some("Shift+CmdOrCtrl+P") },
    MenuItemSpec { id: "repo.commit", accelerator: Some("CmdOrCtrl+Enter") },
    MenuItemSpec { id: "repo.undo-last-commit", accelerator: None },
    MenuItemSpec { id: "repo.create-branch", accelerator: None },
    MenuItemSpec { id: "repo.stash-all", accelerator: None },
    MenuItemSpec { id: "repo.remotes", accelerator: None },
    MenuItemSpec { id: "repo.tags", accelerator: None },
    MenuItemSpec { id: "repo.worktrees", accelerator: None },
    MenuItemSpec { id: "repo.submodules", accelerator: None },
    MenuItemSpec { id: "repo.lfs", accelerator: None },
    MenuItemSpec { id: "repo.gitflow", accelerator: None },
    MenuItemSpec { id: "action.merge", accelerator: None },
    MenuItemSpec { id: "action.rebase", accelerator: None },
    MenuItemSpec { id: "action.cherry-pick", accelerator: None },
    MenuItemSpec { id: "action.revert", accelerator: None },
    MenuItemSpec { id: "action.reset", accelerator: None },
    MenuItemSpec { id: "action.continue", accelerator: None },
    MenuItemSpec { id: "action.skip", accelerator: None },
    MenuItemSpec { id: "action.abort", accelerator: None },
    MenuItemSpec { id: "help.shortcuts", accelerator: None },
    MenuItemSpec { id: "help.docs", accelerator: None },
    MenuItemSpec { id: "help.report-issue", accelerator: None },
    MenuItemSpec { id: "help.check-updates", accelerator: None },
];

#[cfg(test)]
pub fn item_specs() -> Vec<MenuItemSpec> {
    ITEM_SPECS.to_vec()
}

fn accelerator_for(id: &str) -> Option<&'static str> {
    ITEM_SPECS
        .iter()
        .find(|spec| spec.id == id)
        .and_then(|spec| spec.accelerator)
}

pub fn label(labels: &BTreeMap<String, String>, key: &str, fallback: &str) -> String {
    labels.get(key).cloned().unwrap_or_else(|| fallback.to_string())
}

fn item_label(labels: &BTreeMap<String, String>, id: &str, fallback: &str) -> String {
    label(labels, &format!("menu.{id}"), fallback)
}

pub fn enabled_for(id: &str, state: &MenuState) -> bool {
    if id == "file.recent.empty" {
        return false;
    }
    if state.busy {
        return false;
    }
    if id.starts_with("action.") {
        return match id {
            "action.continue" | "action.skip" | "action.abort" => state.operation,
            _ => state.has_repository && state.has_selection,
        };
    }
    if id.starts_with("repo.") {
        return state.has_repository;
    }
    if id == "file.close-repository" {
        return state.has_repository;
    }
    true
}

fn text_item<R: Runtime, M: Manager<R>>(
    manager: &M,
    labels: &BTreeMap<String, String>,
    id: &'static str,
    fallback: &str,
) -> tauri::Result<MenuItem<R>> {
    let mut builder = MenuItemBuilder::with_id(id, item_label(labels, id, fallback));
    if let Some(accelerator) = accelerator_for(id) {
        builder = builder.accelerator(accelerator);
    }
    builder.build(manager)
}

fn check_item<R: Runtime, M: Manager<R>>(
    manager: &M,
    labels: &BTreeMap<String, String>,
    id: &'static str,
    fallback: &str,
    checked: bool,
) -> tauri::Result<CheckMenuItem<R>> {
    let mut builder = CheckMenuItemBuilder::with_id(id, item_label(labels, id, fallback))
        .checked(checked);
    if let Some(accelerator) = accelerator_for(id) {
        builder = builder.accelerator(accelerator);
    }
    builder.build(manager)
}

fn about_metadata<R: Runtime, M: Manager<R>>(manager: &M) -> AboutMetadata<'static> {
    AboutMetadata {
        name: Some("Branchline".to_string()),
        version: Some(manager.package_info().version.to_string()),
        ..Default::default()
    }
}

fn recent_submenu<R: Runtime, M: Manager<R>>(
    manager: &M,
    labels: &BTreeMap<String, String>,
    state: &MenuState,
) -> tauri::Result<Submenu<R>> {
    let mut builder = SubmenuBuilder::with_id(
        manager,
        "file.recent",
        label(labels, "menu.file.recent", "Recent Repositories"),
    );
    if state.recent.is_empty() {
        builder = builder.item(
            &MenuItemBuilder::with_id(
                "file.recent.empty",
                label(labels, "menu.file.recent.empty", "No Recent Repositories"),
            )
            .enabled(false)
            .build(manager)?,
        );
    } else {
        for (index, repository) in state.recent.iter().take(10).enumerate() {
            builder = builder.text(format!("file.recent.{index}"), repository.name.clone());
        }
    }
    builder.build()
}

fn file_menu<R: Runtime, M: Manager<R>>(
    manager: &M,
    labels: &BTreeMap<String, String>,
    state: &MenuState,
) -> tauri::Result<Submenu<R>> {
    let builder = SubmenuBuilder::with_id(manager, "file", label(labels, "menu.file", "File"))
        .item(&text_item(manager, labels, "file.new-repository", "New Repository…")?)
        .item(&text_item(manager, labels, "file.open-repository", "Open Repository…")?)
        .item(&text_item(manager, labels, "file.clone-repository", "Clone Repository…")?)
        .separator()
        .item(&recent_submenu(manager, labels, state)?)
        .separator()
        .item(&text_item(manager, labels, "file.close-repository", "Close Repository")?);
    #[cfg(not(target_os = "macos"))]
    let builder = builder
        .separator()
        .item(&text_item(manager, labels, "app.preferences", "Preferences…")?)
        .separator()
        .item(&PredefinedMenuItem::quit(
            manager,
            Some(label(labels, "menu.app.quit", "Quit Branchline").as_str()),
        )?);
    builder.build()
}

fn edit_menu<R: Runtime, M: Manager<R>>(
    manager: &M,
    labels: &BTreeMap<String, String>,
) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::with_id(manager, "edit", label(labels, "menu.edit", "Edit"))
        .item(&PredefinedMenuItem::undo(
            manager,
            Some(label(labels, "menu.edit.undo", "Undo").as_str()),
        )?)
        .item(&PredefinedMenuItem::redo(
            manager,
            Some(label(labels, "menu.edit.redo", "Redo").as_str()),
        )?)
        .separator()
        .item(&PredefinedMenuItem::cut(
            manager,
            Some(label(labels, "menu.edit.cut", "Cut").as_str()),
        )?)
        .item(&PredefinedMenuItem::copy(
            manager,
            Some(label(labels, "menu.edit.copy", "Copy").as_str()),
        )?)
        .item(&PredefinedMenuItem::paste(
            manager,
            Some(label(labels, "menu.edit.paste", "Paste").as_str()),
        )?)
        .item(&PredefinedMenuItem::select_all(
            manager,
            Some(label(labels, "menu.edit.selectAll", "Select All").as_str()),
        )?)
        .separator()
        .item(&text_item(manager, labels, "edit.find", "Find…")?)
        .item(&text_item(manager, labels, "edit.find-next", "Find Next")?)
        .item(&text_item(manager, labels, "edit.find-previous", "Find Previous")?)
        .item(&text_item(
            manager,
            labels,
            "edit.search-repository",
            "Search Repository…",
        )?)
        .build()
}

fn format_menu<R: Runtime, M: Manager<R>>(
    manager: &M,
    labels: &BTreeMap<String, String>,
    state: &MenuState,
) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::with_id(manager, "format", label(labels, "menu.format", "Format"))
        .item(&check_item(
            manager,
            labels,
            "format.word-wrap",
            "Word Wrap",
            state.word_wrap,
        )?)
        .separator()
        .item(&check_item(
            manager,
            labels,
            "format.diff-unified",
            "Unified Diff",
            state.diff_layout == "unified",
        )?)
        .item(&check_item(
            manager,
            labels,
            "format.diff-split",
            "Split Diff",
            state.diff_layout == "split",
        )?)
        .item(&check_item(
            manager,
            labels,
            "format.show-whitespace",
            "Show Whitespace",
            state.show_whitespace,
        )?)
        .separator()
        .item(&text_item(
            manager,
            labels,
            "format.font-increase",
            "Increase Font Size",
        )?)
        .item(&text_item(
            manager,
            labels,
            "format.font-decrease",
            "Decrease Font Size",
        )?)
        .item(&text_item(
            manager,
            labels,
            "format.font-reset",
            "Reset Font Size",
        )?)
        .build()
}

fn theme_submenu<R: Runtime, M: Manager<R>>(
    manager: &M,
    labels: &BTreeMap<String, String>,
    state: &MenuState,
) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::with_id(manager, "view.theme", label(labels, "menu.view.theme", "Theme"))
        .item(&check_item(
            manager,
            labels,
            "view.theme.light",
            "Light",
            state.theme == "light",
        )?)
        .item(&check_item(
            manager,
            labels,
            "view.theme.dark",
            "Dark",
            state.theme == "dark",
        )?)
        .build()
}

fn language_submenu<R: Runtime, M: Manager<R>>(
    manager: &M,
    labels: &BTreeMap<String, String>,
    state: &MenuState,
) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::with_id(
        manager,
        "view.language",
        label(labels, "menu.view.language", "Language"),
    )
    .item(&check_item(
        manager,
        labels,
        "view.language.zh",
        "简体中文",
        state.language == "zh",
    )?)
    .item(&check_item(
        manager,
        labels,
        "view.language.en",
        "English",
        state.language == "en",
    )?)
    .build()
}

fn view_menu<R: Runtime, M: Manager<R>>(
    manager: &M,
    labels: &BTreeMap<String, String>,
    state: &MenuState,
) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::with_id(manager, "view", label(labels, "menu.view", "View"))
        .item(&text_item(manager, labels, "view.history", "History")?)
        .item(&text_item(manager, labels, "view.changes", "Changes")?)
        .item(&text_item(manager, labels, "view.stash", "Stash")?)
        .item(&text_item(manager, labels, "view.recovery", "Recovery")?)
        .item(&text_item(manager, labels, "view.search", "Search")?)
        .item(&text_item(manager, labels, "view.tree", "File Tree")?)
        .item(&text_item(manager, labels, "view.compare", "Compare")?)
        .item(&text_item(manager, labels, "view.merge", "Merge Queue")?)
        .item(&text_item(manager, labels, "view.terminal", "Terminal")?)
        .separator()
        .item(&check_item(
            manager,
            labels,
            "view.sidebar",
            "Sidebar",
            state.sidebar_visible,
        )?)
        .item(&check_item(
            manager,
            labels,
            "view.inspector",
            "Inspector",
            state.inspector_visible,
        )?)
        .separator()
        .item(&theme_submenu(manager, labels, state)?)
        .item(&language_submenu(manager, labels, state)?)
        .separator()
        .item(&text_item(manager, labels, "view.reload", "Reload")?)
        .build()
}

fn repository_menu<R: Runtime, M: Manager<R>>(
    manager: &M,
    labels: &BTreeMap<String, String>,
) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::with_id(
        manager,
        "repository",
        label(labels, "menu.repository", "Repository"),
    )
    .item(&text_item(manager, labels, "repo.fetch", "Fetch")?)
    .item(&text_item(manager, labels, "repo.pull", "Pull")?)
    .item(&text_item(manager, labels, "repo.push", "Push")?)
    .item(&text_item(manager, labels, "repo.commit", "Commit…")?)
    .separator()
    .item(&text_item(
        manager,
        labels,
        "repo.undo-last-commit",
        "Undo Last Commit",
    )?)
    .item(&text_item(
        manager,
        labels,
        "repo.create-branch",
        "Create Branch…",
    )?)
    .item(&text_item(
        manager,
        labels,
        "repo.stash-all",
        "Stash All Changes…",
    )?)
    .separator()
    .item(&text_item(manager, labels, "repo.remotes", "Remotes…")?)
    .item(&text_item(manager, labels, "repo.tags", "Tags…")?)
    .item(&text_item(manager, labels, "repo.worktrees", "Worktrees…")?)
    .item(&text_item(manager, labels, "repo.submodules", "Submodules…")?)
    .item(&text_item(manager, labels, "repo.lfs", "Git LFS…")?)
    .item(&text_item(manager, labels, "repo.gitflow", "Gitflow…")?)
    .build()
}

fn actions_menu<R: Runtime, M: Manager<R>>(
    manager: &M,
    labels: &BTreeMap<String, String>,
) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::with_id(manager, "actions", label(labels, "menu.actions", "Actions"))
        .item(&text_item(manager, labels, "action.merge", "Merge…")?)
        .item(&text_item(manager, labels, "action.rebase", "Rebase…")?)
        .item(&text_item(manager, labels, "action.cherry-pick", "Cherry-pick…")?)
        .item(&text_item(manager, labels, "action.revert", "Revert…")?)
        .item(&text_item(manager, labels, "action.reset", "Reset…")?)
        .separator()
        .item(&text_item(
            manager,
            labels,
            "action.continue",
            "Continue Operation",
        )?)
        .item(&text_item(manager, labels, "action.skip", "Skip Operation")?)
        .item(&text_item(manager, labels, "action.abort", "Abort Operation")?)
        .build()
}

#[cfg(target_os = "macos")]
fn window_menu<R: Runtime, M: Manager<R>>(
    manager: &M,
    labels: &BTreeMap<String, String>,
) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::with_id(manager, "window", label(labels, "menu.window", "Window"))
        .item(&PredefinedMenuItem::minimize(
            manager,
            Some(label(labels, "menu.window.minimize", "Minimize").as_str()),
        )?)
        .item(&PredefinedMenuItem::maximize(
            manager,
            Some(label(labels, "menu.window.zoom", "Zoom").as_str()),
        )?)
        .separator()
        .item(&PredefinedMenuItem::bring_all_to_front(
            manager,
            Some(label(labels, "menu.window.bringAllToFront", "Bring All to Front").as_str()),
        )?)
        .build()
}

#[cfg(target_os = "macos")]
fn app_menu<R: Runtime, M: Manager<R>>(
    manager: &M,
    labels: &BTreeMap<String, String>,
) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::with_id(manager, "app", label(labels, "menu.app", "Branchline"))
        .item(&PredefinedMenuItem::about(
            manager,
            Some(label(labels, "menu.app.about", "About Branchline").as_str()),
            Some(about_metadata(manager)),
        )?)
        .item(&text_item(
            manager,
            labels,
            "app.check-updates",
            "Check for Updates…",
        )?)
        .separator()
        .item(&text_item(manager, labels, "app.preferences", "Preferences…")?)
        .separator()
        .item(&PredefinedMenuItem::services(
            manager,
            Some(label(labels, "menu.app.services", "Services").as_str()),
        )?)
        .separator()
        .item(&PredefinedMenuItem::hide(
            manager,
            Some(label(labels, "menu.app.hide", "Hide Branchline").as_str()),
        )?)
        .item(&PredefinedMenuItem::hide_others(
            manager,
            Some(label(labels, "menu.app.hideOthers", "Hide Others").as_str()),
        )?)
        .item(&PredefinedMenuItem::show_all(
            manager,
            Some(label(labels, "menu.app.showAll", "Show All").as_str()),
        )?)
        .separator()
        .item(&PredefinedMenuItem::quit(
            manager,
            Some(label(labels, "menu.app.quit", "Quit Branchline").as_str()),
        )?)
        .build()
}

fn help_menu<R: Runtime, M: Manager<R>>(
    manager: &M,
    labels: &BTreeMap<String, String>,
) -> tauri::Result<Submenu<R>> {
    let builder = SubmenuBuilder::with_id(manager, "help", label(labels, "menu.help", "Help"))
        .item(&text_item(
            manager,
            labels,
            "help.shortcuts",
            "Keyboard Shortcuts",
        )?)
        .item(&text_item(manager, labels, "help.docs", "Documentation")?)
        .item(&text_item(manager, labels, "help.report-issue", "Report an Issue")?)
        .separator()
        .item(&text_item(
            manager,
            labels,
            "help.check-updates",
            "Check for Updates…",
        )?);
    #[cfg(not(target_os = "macos"))]
    let builder = builder
        .separator()
        .item(&PredefinedMenuItem::about(
            manager,
            Some(label(labels, "menu.help.about", "About Branchline").as_str()),
            Some(about_metadata(manager)),
        )?);
    builder.build()
}

pub fn build_menu<R: Runtime, M: Manager<R>>(
    manager: &M,
    labels: &BTreeMap<String, String>,
    state: &MenuState,
) -> tauri::Result<Menu<R>> {
    let mut builder = MenuBuilder::new(manager);
    #[cfg(target_os = "macos")]
    {
        builder = builder.item(&app_menu(manager, labels)?);
    }
    builder = builder
        .item(&file_menu(manager, labels, state)?)
        .item(&edit_menu(manager, labels)?)
        .item(&format_menu(manager, labels, state)?)
        .item(&view_menu(manager, labels, state)?)
        .item(&repository_menu(manager, labels)?)
        .item(&actions_menu(manager, labels)?);
    #[cfg(target_os = "macos")]
    {
        builder = builder.item(&window_menu(manager, labels)?);
    }
    builder = builder.item(&help_menu(manager, labels)?);
    builder.build()
}

pub fn apply_state<R: Runtime>(app: &AppHandle<R>, state: &MenuState) -> tauri::Result<()> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    for kind in menu.items()? {
        apply_to_kind(&kind, state)?;
    }
    Ok(())
}

fn apply_to_kind<R: Runtime>(
    kind: &tauri::menu::MenuItemKind<R>,
    state: &MenuState,
) -> tauri::Result<()> {
    match kind {
        tauri::menu::MenuItemKind::Submenu(submenu) => {
            for child in submenu.items()? {
                apply_to_kind(&child, state)?;
            }
        }
        tauri::menu::MenuItemKind::MenuItem(item) => {
            let id = item.id().0.clone();
            item.set_enabled(enabled_for(&id, state))?;
        }
        tauri::menu::MenuItemKind::Check(item) => {
            let id = item.id().0.clone();
            item.set_enabled(enabled_for(&id, state))?;
            match id.as_str() {
                "view.sidebar" => item.set_checked(state.sidebar_visible)?,
                "view.inspector" => item.set_checked(state.inspector_visible)?,
                "format.word-wrap" => item.set_checked(state.word_wrap)?,
                "format.show-whitespace" => item.set_checked(state.show_whitespace)?,
                "format.diff-unified" => item.set_checked(state.diff_layout == "unified")?,
                "format.diff-split" => item.set_checked(state.diff_layout == "split")?,
                "view.theme.light" => item.set_checked(state.theme == "light")?,
                "view.theme.dark" => item.set_checked(state.theme == "dark")?,
                "view.language.zh" => item.set_checked(state.language == "zh")?,
                "view.language.en" => item.set_checked(state.language == "en")?,
                _ => {}
            }
        }
        _ => {}
    }
    Ok(())
}

#[derive(Default)]
pub struct MenuRuntime {
    pub labels: BTreeMap<String, String>,
    pub state: MenuState,
}

#[tauri::command]
pub fn set_menu_language(
    app: AppHandle,
    runtime: State<'_, Mutex<MenuRuntime>>,
    language: String,
    labels: BTreeMap<String, String>,
) -> Result<(), String> {
    let mut guard = runtime.lock().map_err(|error| error.to_string())?;
    guard.labels = labels;
    guard.state.language = language;
    let menu = build_menu(&app, &guard.labels, &guard.state).map_err(|error| error.to_string())?;
    app.set_menu(menu).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn sync_menu_state(
    app: AppHandle,
    runtime: State<'_, Mutex<MenuRuntime>>,
    state: MenuState,
) -> Result<(), String> {
    let mut guard = runtime.lock().map_err(|error| error.to_string())?;
    let rebuild =
        state.language != guard.state.language || state.recent != guard.state.recent;
    guard.state = state.clone();
    if rebuild {
        let menu =
            build_menu(&app, &guard.labels, &guard.state).map_err(|error| error.to_string())?;
        app.set_menu(menu).map_err(|error| error.to_string())?;
    } else {
        apply_state(&app, &state).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_label_is_used_when_translation_missing() {
        let labels = BTreeMap::new();
        assert_eq!(label(&labels, "menu.file", "File"), "File");
    }

    #[test]
    fn item_specs_include_required_actions() {
        let ids: Vec<&str> = item_specs().iter().map(|spec| spec.id).collect();
        for id in [
            "file.new-repository",
            "repo.fetch",
            "repo.pull",
            "repo.push",
            "format.word-wrap",
            "view.sidebar",
            "action.abort",
        ] {
            assert!(ids.contains(&id), "missing {id}");
        }
    }

    #[test]
    fn required_items_follow_repository_state() {
        let empty = MenuState::default();
        let open = MenuState { has_repository: true, ..MenuState::default() };
        assert!(!enabled_for("repo.fetch", &empty));
        assert!(enabled_for("repo.fetch", &open));
        assert!(!enabled_for("action.abort", &open));
        assert!(enabled_for("action.abort", &MenuState { operation: true, ..open.clone() }));
    }
}
