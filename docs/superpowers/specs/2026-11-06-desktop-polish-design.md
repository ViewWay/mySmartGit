# W6 桌面端体验完善设计

- 日期：2026-11-06
- 状态：已确认（用户确认“没有（问题），实现”）
- 分支：`track/w6-polish`
- 范围：多语言全量覆盖、Sourcetree 同构原生菜单、视觉风格升级、全语言代码高亮

## 1. 背景与现状

Branchline 已完成 14 条功能轨道，但桌面端体验仍有四个明显缺口：

1. 前端 109 个 `.ts/.tsx` 文件、约 2,700 处中文硬编码；仅导航、标签和更新面板接入了 `i18n`。
2. 没有原生菜单栏；macOS 上只有默认应用菜单，仓库操作只能通过界面按钮完成。
3. 视觉仍偏通用 Web 面板：中性色层级、控件密度、Diff 可读性和光影统一性不足。
4. Diff 使用手写 tokenizer，只覆盖 JS/TS/Rust/Shell/CSS 五组关键字；冲突编辑器只加载 6 种语言。

现有约束：

- 前端 React 18 + Vite + TypeScript，Tauri 2，Rust 后端。
- 所有后端调用集中在 `packages/git-client/src/index.ts` 的 `invoke` 包装中。
- 冲突编辑器已依赖 CodeMirror 6（`@codemirror/*`、`@lezer/highlight`）。
- Diff 渲染是固定行高虚拟滚动，自动换行不能直接启用。
- 现有 `styles.test.ts` 含对中文源码字符串和固定行高的断言，迁移时需要改为行为断言。

## 2. 目标与非目标

### 目标

- 所有 UI 可见文案支持中文/英文，默认中文，英文完整，无遗漏。
- macOS 原生菜单与 Sourcetree 结构同构，Windows/Linux 可编译并做平台适配。
- Diff 与冲突编辑器支持数十种编程语言，跨行结构正确，滚动性能不退化。
- 设计令牌与核心组件升级，暗色/浅色一致，Diff 更易读。
- 自动换行在统一/并排 Diff 中可用，且保持虚拟滚动性能。
- 每个阶段独立构建、测试、提交。

### 非目标

- 不新增 Git 功能，不改变现有命令语义。
- 不逐句翻译 git 自身输出的英文 stderr；它以“技术详情”呈现。
- 不重排信息架构，不引入第三方主题系统或移动端适配。
- 不把内部日志、测试文案纳入翻译。

## 3. 决策摘要

| 决策 | 结论 |
|---|---|
| 高亮引擎 | CodeMirror `@codemirror/language-data` + Lezer，Diff 与冲突编辑器共用 |
| 后端错误 | 双语摘要（稳定 code）+ 原始诊断详情；git stderr 不翻译 |
| 自动换行 | 统一/并排都支持；基于字符宽度测量与前缀和的可变行高虚拟滚动 |
| 设置入口 | 新增 `PreferencesDialog`（通用 / 更新），替代独立更新弹窗 |
| 分支 | `track/w6-polish` worktree，分阶段提交，验证后合并 master |

## 4. 多语言架构

### 4.1 字典组织

```
apps/frontend/src/i18n/
  index.ts                 # 语言 store、translate、useI18n、格式化入口
  format.ts                # Intl 日期/时间/数字/相对时间
  plural.ts                # 英文单复数
  messages/
    zh/
      index.ts             # 聚合所有域
      common.ts nav.ts history.ts diff.ts stage.ts operation.ts
      repository.ts tools.ts settings.ts preferences.ts updates.ts
      errors.ts menu.ts
    en/
      ...同名文件，类型约束为 Record<MessageKey, string>
```

规则：

- 中文是唯一键源；`MessageKey = keyof typeof zhMessages`。
- 英文模块使用 `satisfies Record<MessageKey, string>`，漏键直接编译失败。
- 键名保持扁平命名空间，如 `diff.wordWrap`、`menu.repository.fetch`、`errors.git.nonFastForward`。
- 现有键（`nav.*`、`tab.*`、`updates.*` 等）原样迁入对应域，避免行为回归。
- 插值继续使用 `{{param}}`；新增 `tp(key, count, params)`，英文按 `Intl.PluralRules` 选择 `.one` / `.other`。
- 日期、时间、数字、相对时间统一走 `format.ts`，禁止在组件中硬编码 `zh-CN`。
- `useI18n()` 返回 `{ language, setLanguage, locale, t, tp, formatDate, formatRelative }`。
- 语言持久化键仍为 `branchline.language`；切换时更新 `<html lang>` 并通知原生菜单。

### 4.2 迁移与覆盖保证

- 按域分 6 批迁移：壳层/导航、历史/Diff、暂存/操作、仓库工具、设置/集成、恢复/搜索/树/比较。
- 新增 `scripts/check-i18n.mjs`：
  - 用 TypeScript AST 扫描 `apps/frontend/src` 下的 JSX 文本和中文字符串字面量。
  - 排除 `i18n/**`、测试文件、注释。
  - 读取 `scripts/i18n-baseline.json`（文件 → 剩余数量），新增中文硬编码或数量增加时 CI 失败。
  - 支持 `// i18n-allow` 标记技术字符串（如协议名、示例代码）。
- 最终阶段 baseline 必须归零。
- 现有源码字符串断言改为组件行为断言或字典键断言。

### 4.3 后端错误与提示

所有命令通过 `packages/git-client/src/index.ts` 的 `invoke` 进入前端，因此在此统一规范化错误：

```ts
export class BranchlineCommandError extends Error {
  code: string
  params: Record<string, string>
  detail?: string
}
```

Rust 侧：

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub params: BTreeMap<String, String>,
    pub detail: Option<String>,
}
```

规则：

- 每个命令组有默认 code（如 `repository.open.failed`、`git.fetch.failed`），命令内可覆盖为更细的 code。
- 常见失败单独分类：认证失败、非快进、冲突、非仓库、远端不存在、分支已存在、工作区不干净、网络失败、LFS 未安装。
- 前端 `translateError(error, t)` 优先查 `errors.<code>`；缺失时显示 `errors.unknown`，原始 `detail` 放在可展开的“技术详情”中。
- 后端 `notice`（当前约 20 处）与操作状态 `label` 改为结构化 `{ code, params }` 或由前端根据 `kind` 生成。
- `scripts/check-error-codes.mjs` 校验 Rust 中出现的 code 都有中英字典条目。
- 未迁移命令仍可返回字符串；包装器归一化为 `errors.unknown` + detail，保证逐步迁移不破坏行为。

### 4.4 原生菜单双语

菜单标签不写两份翻译：前端把当前语言的 `menu.*` 标签表随 `set_menu_language` 传给 Rust；Rust 只负责结构、accelerator、状态。启动时用系统语言建兜底菜单，前端挂载后立即按持久化语言重建。菜单标签的键校验由前端字典类型和脚本完成。

## 5. 原生菜单

### 5.1 结构

macOS 第一项为应用菜单，其余与 Sourcetree 同构：

| 菜单 | 主要项目 |
|---|---|
| Branchline | 关于 Branchline、检查更新…、偏好设置… ⌘,、服务、隐藏、隐藏其他、显示全部、退出 |
| 文件 | 新建仓库… ⌘N、打开仓库… ⌘O、克隆仓库… ⇧⌘O、最近打开、关闭仓库 ⇧⌘W |
| 编辑 | 撤销/重做、剪切/复制/粘贴/全选、查找 ⌘F、查找下一个/上一个、仓库内容搜索 ⌥⌘F |
| 格式化 | 自动换行、统一 Diff / 并排 Diff、显示空白差异、字号增大 ⌘+ / 减小 ⌘- / 重置 ⌘0 |
| 查看 | 提交图谱、暂存与提交、Stash、恢复、深度搜索、文件树、比较、合并队列、终端、侧栏 ⌘B、检查器、主题、语言、重新加载 |
| 仓库 | Fetch ⇧⌘F、Pull ⌥⌘P、Push ⇧⌘P、Commit ⌘Enter、撤回上次提交、创建分支、Stash 全部、远端/标签/Worktree/Submodule/LFS/Gitflow |
| 动作 | 合并、变基、Cherry-pick、Revert、Reset、继续/跳过/中止操作 |
| 窗口 | 最小化、缩放、前置全部窗口 |
| 帮助 | 键盘快捷键、文档、报告问题、检查更新、关于 |

Windows/Linux 无应用菜单，将“偏好设置/关于/退出”放入文件/帮助菜单；菜单标签与 accelerator 使用 `CmdOrCtrl`。

### 5.2 状态与同步

Rust 侧 `MenuState`：

```rust
pub struct MenuState {
    pub language: String,
    pub has_repository: bool,
    pub busy: bool,
    pub operation: bool,
    pub has_selection: bool,
    pub sidebar_visible: bool,
    pub inspector_visible: bool,
    pub diff_layout: String,     // unified | split
    pub word_wrap: bool,
    pub show_whitespace: bool,
    pub diff_font_size: u32,
    pub theme: String,           // light | dark
    pub recent: Vec<RecentRepository>,
}
```

命令：

- `set_menu_language(language, labels: Record<string,string>)`：重建菜单。
- `sync_menu_state(state)`：更新 enabled / checked；语言或最近仓库变化时重建。
- 菜单事件统一 `emit("menu-action", { id, payload? })`。

前端：

- `useNativeMenu` 单一桥接：订阅事件、维护 action registry、订阅语言与偏好变化、同步菜单状态。
- 所有菜单 action 复用现有 App 处理函数，不在菜单桥中复制业务逻辑。
- 原生菜单接管 accelerator；浏览器预览保留 keydown 兜底。Tauri 环境下跳过重复的 web 快捷键，避免双触发。

### 5.3 PreferencesDialog

- 新组件 `apps/frontend/src/features/preferences/PreferencesDialog.tsx`。
- 左栏：通用、更新。
- 通用：语言、主题、Diff 布局、自动换行、显示空白、Diff 字号。
- 更新：复用 `UpdatePanel`。
- 菜单“偏好设置…”⌘, 打开；侧栏“版本与更新”与“检查更新…”都打开更新页。
- 独立 `UpdateDialog` 退役，避免两套入口。

## 6. 代码高亮

### 6.1 引擎

使用 `@codemirror/language-data` 的 `LanguageDescription`：

- `LanguageDescription.matchFilename(languages, path)` 按文件名/扩展名匹配。
- 动态 `load()` 得到 `LanguageSupport`，失败时回退纯文本。
- Diff 与冲突编辑器共用 `HighlightStyle` 与 token CSS。

### 6.2 Diff 高亮

- 新增 `src/syntax/languages.ts`：匹配、别名、覆盖表（Dockerfile、Makefile、CMakeLists.txt、.env、.gitignore 等）。
- 新增 `src/syntax/highlight.ts`：
  - `highlightLines(lines: string[], language: Language): string[][]`。
  - 用 `EditorState.create({ doc: lines.join('\n'), extensions: [language] })` + `syntaxTree` + `highlightCode`。
  - 按 hunk/侧把连续行分组，整组解析后再按换行切分 token，保证块注释、模板字符串跨行正确。
  - LRU 缓存键：`language + '\u0000' + 整组文本`；上限 200 组。
  - 组超过 400 行时按 200 行切块，空闲时计算。
- `DiffPanel` 在渲染前构建 `highlightMap: Map<rowIndex, Token[][]>`；未命中时显示纯文本。
- 替换 `HighlightedCode` 内部实现，保留组件 API，减少调用点改动。

### 6.3 冲突编辑器

- 移除静态 `languageForPath` 的 6 种映射。
- 新增 `useEditorLanguage(filePath)`：动态加载语言，`Compartment.reconfigure`。
- 块操作按钮文案通过 props/回调注入 `t`，不在 Widget 内硬编码中文。

### 6.4 语言覆盖

至少覆盖：

- Web：HTML/XML、CSS/SCSS/Less、JavaScript、TypeScript/TSX、JSON、Vue、Svelte、Markdown
- 配置：YAML、TOML、INI、Dockerfile、Makefile、CMake、Shell/Bash、PowerShell
- 系统：C、C++、Rust、Go、Java、Kotlin、C#、Objective-C、Swift、Dart
- 脚本：Python、Ruby、PHP、Lua、Perl、R、Scala、Julia
- 数据/查询：SQL、GraphQL、Protocol Buffers
- 其他：Diff、Git、Regex、Terraform/HCL

未知语言回退纯文本，不启用自动探测，避免颜色不稳定。

### 6.5 样式

扩展 `--syntax-*`：

```
comment keyword string number type function variable property
tag attribute operator punctuation meta regexp inserted deleted invalid
```

暗色与浅色各一套；Diff 与冲突编辑器共用。新增 token 类使用 `.tok-*`，旧 `.token-*` 保留到迁移完成。

## 7. 视觉升级

### 7.1 方向

Sourcetree/Fork 式的高密度桌面工具：中性灰蓝底、单一蓝色强调、细边框、克制阴影、清晰层级。

### 7.2 令牌

- 表面：`surface-app / sidebar / content / elevated / control / hover / active`。
- 边框：`border-subtle / border / border-strong`。
- 文本：`text-primary / secondary / tertiary / inverse`。
- 状态：`accent / success / warning / danger` 及各自 surface。
- Diff：`diff-add-bg / diff-del-bg / diff-add-gutter / diff-del-gutter / diff-hunk-bg`。
- 语法：见 6.5。
- 保留旧别名，映射到新值，避免一次性重写全部 CSS。

### 7.3 字体与密度

- UI：`-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Segoe UI", sans-serif`。
- 代码：`"SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, monospace`。
- 4px 基准；控件 24/28/32；topbar 44；statusbar 26；行高 1.45。
- 数字、Hash、计数使用 tabular numerals。

### 7.4 组件

Button、segmented、tabs、输入框、菜单、弹窗、滚动条、空状态、Diff 行号/增删槽、冲突块、状态栏统一精修。焦点环、hover、active、disabled 状态统一。

### 7.5 自动换行与可变行高

- 新增 `--diff-font-size`、行高、内边距作为测量输入。
- 用 canvas `measureText` 测量代码字体字符宽度；制表符按 4 空格展开。
- 每行高度 = `ceil(textWidth / availableWidth) * lineHeight`。
- 统一视图按行高前缀和虚拟滚动；并排视图每对行高取左右最大值，左右偏移一致。
- 窗口 resize、字号、字体变化时重算；高亮 token 不改变字体宽度（仅颜色/斜体）。
- 保留现有概览标记、滚动同步、搜索定位行为。

### 7.6 可访问性

- 文本对比度 ≥ 4.5:1，控件/边框 ≥ 3:1。
- 所有图标按钮有本地化 aria-label/title。
- 焦点顺序与 Esc 行为不回归。
- 尊重 `prefers-reduced-motion`。

## 8. 测试与验收

每阶段：

- `pnpm typecheck`
- `pnpm --filter @branchline/frontend exec vitest run --reporter=dot`
- `cargo test --manifest-path apps/desktop/Cargo.toml --quiet`

专项：

- i18n：字典类型完整性、插值、单复数、语言持久化、覆盖 baseline 归零。
- 错误：包装器归一化、code → 字典映射、技术详情展示。
- 高亮：语言映射、8 种代表语言 token、跨行块注释、缓存、性能冒烟。
- 菜单：结构/标签键、action 映射、checked/enabled 状态；macOS 手工检查全部菜单与快捷键。
- 可视：暗/浅色截图、token 双主题完整性、真实仓库长文本/大 Diff/冲突文件。
- 构建：`vite build`、`tauri build`（DMG + updater `.app.tar.gz`/`.sig`）、启动冒烟。

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 全量 i18n 工作量大、遗漏 | 分域字典 + 类型约束 + baseline 只减不增 + 6 批提交 |
| 后端错误改造侵入面大 | 集中在 git-client 包装层；命令级默认 code；逐步细化 |
| 菜单状态漂移 | 单一 MenuState + 单一前端桥接；阶段手工清单 |
| 可变行高破坏 Diff 同步 | 并列行取最大高度 + 前缀和；保留现有滚动同步测试；先做性能/高度测试 |
| language-data 包体增大 | 动态 import 按需分包；DMG 验收记录增量；未知语言纯文本 |
| 视觉升级回归 | token 优先、组件精修、暗/浅截图、不重排布局 |
| 原生菜单难以自动化 | Rust 结构测试 + action 映射测试 + macOS 手工检查清单 |

## 10. 交付物

- 可切换中英文的完整桌面 UI。
- macOS 原生菜单及 Windows/Linux 适配。
- 全语言高亮 Diff 与冲突编辑器。
- 新设计令牌与核心组件样式。
- 覆盖检查脚本、错误 code 校验脚本、测试与文档。
- 更新后的 DMG 与自动更新产物。
