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
pnpm test:git-client
pnpm check:i18n
pnpm check:error-codes
pnpm rust:fmt
pnpm rust:check
cargo test --manifest-path apps/desktop/Cargo.toml
```

## 界面语言与偏好设置

- 界面默认中文，可在偏好设置（⌘,）或侧栏底部按钮切换到英文；语言选择持久化到本地。
- 偏好设置面板（⌘,）提供语言、主题（浅色 / 深色 / 跟随系统，默认跟随系统）、Diff 布局、自动换行、显示空白差异与 Diff 字号设置。
- 全部界面文案（含原生菜单、通知、确认框、错误摘要）均由 `apps/frontend/src/i18n/messages` 的 zh/en 字典提供；`pnpm check:i18n` 保证界面不再出现未迁移的硬编码中文。
- 后端错误统一走结构化 `CommandError`（code + params + detail）：前端显示本地化摘要，git 原始 stderr 折叠在"技术详情"中，不参与翻译。

## 代码高亮

- Diff、文件树与冲突编辑器共用 CodeMirror/Lezer 高亮，通过 `@codemirror/language-data` 动态加载，覆盖 60+ 编程语言（JS/TS、Rust、Python、Go、Java、C/C++、Shell、SQL、YAML、Markdown 等）。
- 语言按文件名/扩展名匹配，未识别的文件按纯文本渲染；高亮结果按内容 LRU 缓存。
- 内置自写的 AsciiDoc 与 Windows Batch 语法模式，并对常用无扩展名文件做特判映射（如 `.gitattributes` → Shell、`Cargo.lock` → TOML、`.prettierrc` → JSON、`ASNTokenTypes.txt` → ASN.1）。
- 高亮配色覆盖全量 Lezer 标签分组：行/块/文档注释细分、HTML 标签与属性、JSON/YAML 键名、Markdown 结构标记（标题、加粗、链接等）与插入/删除行，统一复用 `--syntax-*` 调色板。

## 原生菜单（macOS）

菜单结构与 Sourcetree 同构：Branchline（关于/检查更新/偏好设置）、文件、编辑、格式化（自动换行、Diff 布局、字号）、查看、仓库、动作、窗口、帮助。
原生菜单由 `useNativeMenu` 单桥驱动；状态（是否有仓库、忙闲、Diff 布局、主题、语言）通过 `sync_menu_state` 同步。Windows/Linux 无应用菜单，"偏好设置/关于/退出"放入文件与帮助菜单。

## 界面布局

主界面采用「活动栏 + 动作工具栏 + 详情 tabs」布局：

- 左侧 46px 图标活动栏：提交图谱、暂存与提交、文件树、深度搜索、恢复与定位、Diff 比较、合并队列，操作进行中显示徽标；工具弹层聚合远程管理、Git LFS、Gitflow、SSH 与凭据、托管平台、内置终端；仓库管理置底。
- 顶部动作工具栏：获取 / 拉取（显示落后数）/ 推送（显示领先数）/ 贮藏 / 新建分支，全局搜索居中。
- 侧栏分组：本地分支前缀树 + 仓库结构树（Worktree / Submodule）+ 可折叠的贮藏组与标签组，折叠状态持久化。
- 详情区提供「差异文件 / 文件树」两个 tabs，文件树以紧凑布局浏览所选提交版本的完整文件。

## 代码审查评论

支持 Gerrit 式行级审查评论（设计文档见 `docs/superpowers/specs/2026-11-07-code-review-design.md`）：

- 在文件树预览与 Diff 视图中点击行号、右键「评论此行」或划选多行「评论选中行」发起评论（支持行范围），评论以锚定所在行的浮动评论卡展示，越界自动翻转；支持回复线程与「已解决」标记，行号旁圆点表示已有评论。
- 评论锚定「ref + 文件 + 行号 + 新旧侧」，由 Rust 侧持久化到 `<设置目录>/reviews/<仓库>.json`，离线可用，不依赖 webview 存储。
- 本地草稿可一键发布为 GitHub PR review comments / GitLab MR discussions，逐条报告结果并回填远端 ID，失败线程保留草稿可重试。
- 可拉取远端已有 PR/MR 评审评论合并展示（远端内容只读）。
- 操作说明见 [docs/shortcuts.md](docs/shortcuts.md) 的「审查评论」一节。

## 当前能力

- 打开真实 Git 仓库和 Worktree
- 读取当前分支、远程、领先/落后、Worktree 和 Submodule 数量
- 读取最近 500 条提交、完整提交信息、父级提交和提交/作者时间
- 读取工作区变更和真实文本 Diff
- 多仓库最近记录、Worktree 和 Submodule 快速切换
- 仓库管理支持扫描文件夹批量添加本地 Git 仓库（自动跳过 node_modules、target 等重目录）
- 真实 Fetch、Rust 侧定时自动 Fetch（覆盖全部已开仓库、失败退避、每仓库单飞）
- 真实暂存、取消暂存、提交、Amend 和签名提交
- gitlink 冲突本地优先解析命令
- 虚拟化提交图谱的界面结构
- 按提交信息、Hash、提交人搜索
- 完整提交元数据、父级 Hash、作者和提交日期
- 统一/并排 Diff、宽屏聚焦模式、文件树形/列表视图
- Diff 概览条（mini-map）快速定位变更，划选行 / 变更块局部暂存、取消暂存与恢复
- 分支前缀树（如 `feat/1248`）及前缀级操作入口
- 文件提交历史与逐行 Blame 历史
- 分支前缀删除前预览、二次确认和并发变更校验
- Worktree、Submodule、标签、Stash 和文件/行历史入口
- 暂存、提交模板、Amend、签名提交流程
- 撤销上次提交（修改保留在工作区）
- 文件树彩色语言图标与 IDE 级只读预览（行号、折叠、缩进线、查找）
- 行级审查评论：本地线程持久化，草稿发布与远端评论拉取（GitHub / GitLab）
- 深度搜索：全量历史搜索、差异内容搜索与仓库内容替换
- 恢复与定位：Reflog 找回提交、Bisect 定位问题、按模式 Reset
- 整理历史：重排、合并、改写或删除近期提交
- 任意两个提交/分支的 Diff 比较与合并队列
- 托管平台：查看与创建 GitHub Pull Request / GitLab Merge Request，查看 CI 状态
- Gitflow 工作流、Git LFS 跟踪管理、SSH 密钥与凭据助手管理
- 内置终端、自定义命令流水线与执行命令日志
- AI 提交信息助手
- 浅色 / 深色 / 跟随系统主题和全局快捷键面板
- 在同一仓库切换器中快速进入 Worktree 与 Submodule
- 900px 以上桌面窗口响应式布局

## 后续实现路线

当前使用 Tauri 2 + Rust 后端，通过受控的 Git CLI 读取仓库。后续可将高频只读操作迁移到 `gix` 或 `git2`，复杂写操作继续使用 Git CLI 保持行为兼容。

1. 仓库层：统一 `RepositoryService`（已落地：打开仓库生命周期管理、状态 token/快照/Diff 三缓存、全部 Diff 形态命令接入缓存、文件监听推送 `repository-changed`、仓库发现 `scan` 并入服务；最近仓库持久化仍归前端；其余写操作命令按需渐进接入）。
2. 提交层：流式解析提交、拓扑和 refs，分页送入前端并做可见区域渲染。
3. 操作层：stage、commit、branch、merge、rebase、cherry-pick、stash、tag、remote、worktree 和 submodule。
4. 历史层：继续增加任意文件选择、指定行范围和提交跳转。
5. 自动化层：定时 Fetch 已移入 Rust `RepositoryService`（已落地：单后台线程调度全部已开仓库、可暂停开关由前端设置下发、失败退避封顶 4×、每仓库单飞且手动 Fetch 共用同一单飞、完成推 `repository-auto-fetched` 事件；系统通知已接入——仅在成功↔失败状态转换时提示，稳态静默，文案由前端按语言下发；网络门控已接入——自动任务前置连通性探测，离线跳过本轮且不升级退避；电池供电降频已接入——×3 封顶 30 分钟，接电即恢复，Windows 侧探测待接）；剩余：凭据代理扩展。
6. 冲突层：检测 mode `160000` 的 gitlink 冲突，默认执行本地优先策略，同时保留确认和撤销记录。

分支前缀批量删除会先展示受影响的本地分支，并在后端再次校验删除范围；“删除前缀”实际是删除其下所有实际 refs，Git 本身不存在目录型分支。

## 性能边界

- 提交列表和 Diff 使用窗口化渲染，禁止一次性向前端发送完整大型历史。
- Rust 侧维护可取消的任务队列；搜索、切换仓库和关闭窗口时中止旧任务。
- 文件状态、提交图谱和 Diff 在 Rust 侧 `RepositoryService` 分开缓存，缓存使用条目和字节双重上限；文件监听（notify）失效缓存并向前端推送 `repository-changed`。状态 token 未变时轮询零成本，命中失效需要计算时走 gix 进程内直读（灵敏度对齐 Git CLI，异常自动回退 CLI），快照的分支/标签枚举与提交图谱（revwalk + 装饰渲染）同样走 gix（输出与 CLI 逐项对拍锁定），高频路径零 git 子进程。
- 定时 Fetch 在 Rust 后台线程执行（覆盖全部已开仓库），同一仓库只允许一个网络任务——手动 Fetch 与定时 Fetch 共用单飞。自动任务前置 TCP 连通性探测（github/gitee 任一可达即在线）：判定离线时跳过本轮且不升级失败退避，按基础间隔到点重试；电池供电时降频至 ×3（封顶 30 分钟），接电即恢复；手动 Fetch 不设门控。仓库侧失败退避封顶 4×间隔，成功即恢复。状态跳变（获取失败/恢复）发系统通知，连续失败不重复打扰。
- 文本预览用单次 `git cat-file --batch` 往返完成解析、验型、测长与读取，替代 rev-parse + cat-file 多进程串联，消除文件预览的「正在读取内容」卡顿。
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

## 文档索引

- [docs/shortcuts.md](docs/shortcuts.md)：全局 / Diff / 原生菜单快捷键与审查评论操作说明。
- [docs/git-commit.md](docs/git-commit.md)：Commit message 规范（type / scope / subject / body / footer）。
- [docs/git-emoji.md](docs/git-emoji.md)：Git emoji 提交参考。
- [docs/git-flow.md](docs/git-flow.md)：分支模型与常见工作流（Trunk-Based / Git-Flow / Aone-Flow）。
- `docs/superpowers/specs/`：设计定稿文档（桌面端打磨、Gerrit 式代码审查等）。
