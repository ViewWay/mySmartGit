# Branchline

Branchline 是一个面向大型仓库的桌面 Git 工作台。当前版本使用 Tauri 2 + Rust，并通过 pnpm workspace 管理桌面应用与共享 Git 包。桌面端可以通过系统目录选择器打开真实 Git 仓库或 Worktree，并读取提交、工作区变更、分支、Worktree 和 Submodule 信息。

## 目录结构

```text
apps/frontend/             独立 React/Vite 前端应用
apps/desktop/              独立 Tauri/Rust 桌面后端与宿主
packages/git-models/       前后端共享的仓库、提交、Diff 数据模型
packages/git-client/       Tauri 命令封装和桌面能力边界
```

## 运行

仅查看 Web 演示界面：

```bash
pnpm install
pnpm dev
```

Web 模式无法访问本地文件系统，因此“打开本地仓库”会提示使用桌面版。

运行桌面版前请安装：

- [Rust](https://rustup.rs/)（MSVC 工具链）
- Visual Studio Build Tools 2022，并选择“使用 C++ 的桌面开发”和 Windows SDK

然后运行：

```bash
pnpm install
pnpm desktop:dev
```

在左上角仓库切换器中选择“打开本地仓库”，即可选择现有 Git 仓库或 Worktree。

Web 生产构建：

```bash
pnpm build
```

桌面端构建：

```bash
pnpm desktop:build
```

验证完整 workspace：

```bash
pnpm typecheck
pnpm rust:fmt
pnpm rust:check
cargo test --manifest-path apps/desktop/Cargo.toml
```

## 当前能力

- 打开真实 Git 仓库和 Worktree
- 读取当前分支、远程、领先/落后、Worktree 和 Submodule 数量
- 读取最近 500 条提交、完整提交信息、父级提交和提交/作者时间
- 读取工作区变更和真实文本 Diff
- 多仓库最近记录、Worktree 和 Submodule 快速切换
- 真实 Fetch、每 5 分钟低优先级自动 Fetch
- 真实暂存、取消暂存、提交、Amend 和签名提交
- gitlink 冲突本地优先解析命令
- 虚拟化提交图谱的界面结构
- 按提交信息、Hash、提交人搜索
- 完整提交元数据、父级 Hash、作者和提交日期
- 统一/并排 Diff、宽屏聚焦模式、文件树形/列表视图
- 分支前缀树（如 `feat/1248`）及前缀级操作入口
- 文件提交历史与逐行 Blame 历史
- 分支前缀删除前预览、二次确认和并发变更校验
- Worktree、Submodule、标签、Stash 和文件/行历史入口
- 暂存、提交模板、Amend、签名提交流程
- 深色/浅色主题和全局快捷键面板
- 在同一仓库切换器中快速进入 Worktree 与 Submodule
- 900px 以上桌面窗口响应式布局

## 后续实现路线

当前使用 Tauri 2 + Rust 后端，通过受控的 Git CLI 读取仓库。后续可将高频只读操作迁移到 `gix` 或 `git2`，复杂写操作继续使用 Git CLI 保持行为兼容。

1. 仓库层：统一 `RepositoryService`，支持发现、打开、最近仓库、状态缓存和文件监听。
2. 提交层：流式解析提交、拓扑和 refs，分页送入前端并做可见区域渲染。
3. 操作层：stage、commit、branch、merge、rebase、cherry-pick、stash、tag、remote、worktree 和 submodule。
4. 历史层：继续增加任意文件选择、指定行范围和提交跳转。
5. 自动化层：可暂停的定时 Fetch、网络/电源策略、凭据代理和通知。
6. 冲突层：检测 mode `160000` 的 gitlink 冲突，默认执行本地优先策略，同时保留确认和撤销记录。

分支前缀批量删除会先展示受影响的本地分支，并在后端再次校验删除范围；“删除前缀”实际是删除其下所有实际 refs，Git 本身不存在目录型分支。

## 性能边界

- 提交列表和 Diff 使用窗口化渲染，禁止一次性向前端发送完整大型历史。
- Rust 侧维护可取消的任务队列；搜索、切换仓库和关闭窗口时中止旧任务。
- 文件状态、提交图谱和 Diff 分开缓存，缓存使用条目和字节双重上限。
- 定时 Fetch 在后台低优先级执行，同一仓库只允许一个网络任务。
- 前端避免 Electron 常驻进程；目标空闲内存控制在 100 MB 左右，具体以接入 Tauri 后的基准测试为准。

## 安装包、自动更新与签名

桌面端使用 Tauri 2 bundler 产出 `.dmg` / `.app`（macOS）、`.deb` / `.AppImage`（Linux）与 `.msi` / `.exe`（Windows）。`tauri.conf.json` 已开启 `bundle.createUpdaterArtifacts`，构建时会同时生成 updater 签名产物与 `latest.json`。

更新通道固定为 GitHub Releases：

```text
https://github.com/ViewWay/mySmartGit/releases/latest/download/latest.json
```

客户端在「版本与更新」面板中调用官方 updater 插件检查、下载并安装更新，安装包由内置公钥验签，前端不自行拼接下载地址。

### 生成与配置签名密钥

```bash
pnpm --filter @branchline/desktop exec tauri signer generate -w ~/.branchline/updater.key
```

- 私钥 `updater.key` 只保存在本机或 CI Secret 中，禁止提交；仓库已通过 `.gitignore` 忽略 `*.key`。
- 公钥内容写入 `apps/desktop/tauri.conf.json` 的 `plugins.updater.pubkey`。
- 在 GitHub 仓库 Secrets 中配置：
  - `TAURI_SIGNING_PRIVATE_KEY`：私钥文件内容（或 `tauri signer generate` 输出的 base64 内容）
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥密码（无密码时留空）

### 发布流程

1. 同步升级 `apps/desktop/tauri.conf.json`、`apps/desktop/Cargo.toml` 与根 `package.json` 的版本号。
2. 提交后创建并推送 tag：

   ```bash
   git tag v0.5.1
   git push origin v0.5.1
   ```

3. `.github/workflows/release.yml` 在 macOS（universal）、Ubuntu 22.04 与 Windows 上并行构建，使用 `TAURI_SIGNING_PRIVATE_KEY` 签名后上传安装包、签名文件与 `latest.json`；全部平台完成后再由 `publish-release` 作业把 Draft 转为正式发布，避免半成品清单被客户端拉到。
4. Release 必须为正式发布（非 Draft / 非 Prerelease），否则 `releases/latest` 不会指向它，自动更新无法发现新版本。

`latest.json` 由 CI 按平台合并生成；不要手工编辑或只上传单一平台的清单，否则其他平台会被判定为已是最新。

### 本地验证

```bash
pnpm desktop:build
```

构建日志会列出生成的安装包与 `.sig` 文件。自动更新只能在打包后的桌面应用中验证；浏览器预览会明确提示更新器不可用。

## 界面语言

- 默认简体中文，可在左侧栏底部切换 English / 中文，选择写入 `localStorage` 的 `branchline.language`。
- 文案集中在 `apps/frontend/src/i18n/index.ts`，使用 `{{param}}` 占位符插值，并同步更新 `<html lang>`。
- 当前已覆盖应用外壳（侧栏导航、内容标签页、通用按钮）与「版本与更新」面板；各功能面板的文案仍为中文，按模块逐步迁移，新增文案时请同时补齐 `zh` 与 `en` 两个字典。
