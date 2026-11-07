# Gerrit 式代码审查（本地行级评论 + PR 同步）设计

日期：2026-11-07
状态：已与用户对齐的设计定稿（图标/预览/交互子项目 A 已交付于 master bb619ce；本文档覆盖其后续子项目 B）

## 背景与目标

W6 之后 Branchline 已具备：全语言语法高亮的 Diff 与冲突编辑器（P1）、提交文件树浏览（W2-8）、文件树 IDE 级只读预览（A：行号/折叠/缩进线/查找）、GitHub/GitLab PR 列表与详情（hosting 轨道）。

用户诉求：像 Gerrit 一样对代码做行级审查评论——在文件树预览与 Diff 视图上对任意行写评论、组织成线程（可回复、可标记已解决），并把本地草稿一键发布为 GitHub/GitLab 的 PR/MR review comments；同时能拉取远端已有的 review comments 在本地只读展示。

**目标**

1. 本地行级评论：锚定「版本（ref）+ 文件 + 行号 + 新旧侧」，支持回复线程与已解决标记，本地持久化、离线可用。
2. 双载体：DiffPanel 的变更行与文件树 TreeCodePreview 的任意行都能发起/展示评论。
3. PR 同步：草稿一键发布（GitHub review comments / GitLab discussions），发布后回填远端 ID；远端评论拉取合并展示（只读）。
4. 部分失败安全：一次发布 N 条线程，成功者回填 remote，失败者保留草稿并逐条报告，可重试。

**非目标**

- 真正的 Gerrit 服务器集成（Change-Id、Score、Label 等）不在范围内。
- 不做评论的多人协同/账号体系：本地作者取 `git config user.name`。
- 不做远端评论的本地编辑/删除（远端内容始终只读；要改去平台上改）。
- 不做 PR 级「Approve/Request changes」评审结论按钮（后续可加）。

## 方案决定

存储与同步采用**方案 1：Rust 侧 JSON 存储 + hosting 评论命令**：

- 与 hosting.json 同目录、同读写模式（`settings_directory()`），凭据不出后端；
- 复用 `git_hosting.rs` 的 `request_json`（curl）与 `hosting_context`（provider/host/token 解析）；
- 数据不进 localStorage（webview 存储随时可能被清空，审查数据丢失不可接受）。

已否决：方案 2（前端 localStorage，易丢失）、方案 3（SQLite，无既有依赖，过度设计）。

## 数据模型

Rust 结构体与 TS 类型同构（`#[serde(rename_all = "camelCase")]`）：

```rust
pub struct ReviewThread {
    pub id: String,                 // uuid v4（前端生成，后端校验非空）
    pub file_path: String,          // 仓库相对路径，统一 '/' 分隔
    pub reference: String,          // 锚定的 ref：提交 hash / 分支 / 标签
    pub line: u32,                  // 1 起；side=new 时为该版本文件行号或 diff 新侧行号
    pub side: String,               // "new" | "old"（树预览恒为 "new"）
    pub resolved: bool,
    pub created_at: String,         // RFC3339 UTC
    pub updated_at: String,
    pub comments: Vec<ReviewComment>,
    pub remote: Option<ReviewThreadRemote>,
}

pub struct ReviewComment {
    pub id: String,
    pub author: String,             // 写入时刻的 git config user.name（可为空串）
    pub body: String,
    pub created_at: String,
}

pub struct ReviewThreadRemote {
    pub provider: String,           // "github" | "gitlab"
    pub pull_number: u64,
    pub remote_id: String,          // GitHub comment id / GitLab discussion id
    pub web_url: Option<String>,
}
```

文件布局（每仓库一个文件）：

```
<settings_directory()>/reviews/<repository_key>.json
{
  "schemaVersion": 1,
  "threads": [ ReviewThread... ]
}
```

- `repository_key` = 规范化仓库绝对路径（去尾斜杠）SHA-256 前 16 位 hex，避免路径里的特殊字符进文件名；
- 写入：临时文件 + rename 原子替换；文件损坏时返回明确错误而不清空数据；
- 读取：按 `schemaVersion` 兼容；未知字段忽略。

## 后端命令

新模块 `apps/desktop/src/git_review.rs`（本地存储）+ `git_hosting.rs` 增量（同步）。所有命令遵循 P5 的 `CommandError` 包装（`classify()` 失败分类，网络/权限/未配置分别给 code）。

本地 CRUD（纯本地，无网络）：

| 命令 | 签名（要点） | 行为 |
|---|---|---|
| `list_review_threads` | `(repositoryPath) -> Vec<ReviewThread>` | 读文件；不存在返回空 |
| `upsert_review_thread` | `(repositoryPath, thread: ReviewThread)` | 按 id 覆盖插入；维护 updated_at |
| `delete_review_thread` | `(repositoryPath, threadId)` | 删除线程 |
| `set_review_thread_resolved` | `(repositoryPath, threadId, resolved)` | 翻转标记 |

同步（走 hosting 上下文）：

| 命令 | 行为 |
|---|---|
| `fetch_hosting_review_comments(repositoryPath, pullNumber)` | GitHub：`GET {api}/repos/{owner}/{repo}/pulls/{n}/comments`（含 `in_reply_to_id` 归组）；GitLab：`GET {api}/projects/{id}/merge_requests/{n}/discussions`（过滤有 `position`/notes 的 discussion）。返回 `Vec<HostingReviewComment>`：`{ id, filePath, line, side, author, body, createdAt, inReplyTo: Option<String>, webUrl }` |
| `publish_hosting_review(repositoryPath, pullNumber, threadIds: Vec<String>)` | 逐线程发布：先解析 PR head commit SHA（作为 GitHub `commit_id` / GitLab `position.head_sha`）；未发布线程新建评论（GitHub `POST pulls/{n}/comments`，body 带 `commit_id`、`path`、`line`、`side`）；已有 `inReplyTo` 语义的回复走 GitHub `in_reply_to` / GitLab discussion reply。每条成功立即回填该线程 `remote` 并落盘；失败不中断其余线程，最终返回逐条结果 `Vec<ReviewPublishResult> { threadId, ok, remoteId?, error? }` |

**行号语义注意**：GitHub/GitLab 的 diff 行号是「diff 位置」不是文件行号。发布时只允许发布锚定在**当前 PR 源分支 head ref** 上的线程：后端用线程 `reference` 对应 commit 的文件内容行号，通过对比 PR diff 把文件行号换算成 API 要求的 `line`（新侧）或 `original_line`（旧侧）；换算不到（行不在本次 diff 内）的线程发布失败并提示「该行不在 PR 的变更范围内」。这条换算用现有 git 能力（`git diff` 解析 hunk 头）在 `git_hosting.rs`/`git_review.rs` 内实现，hunk 解析做单测。

## 前端设计

### 模块布局

```
apps/frontend/src/features/review/
  reviewModel.ts        // 纯逻辑：线程归组（按文件+行）、锚点查询、回复结构、乐观更新工具
  reviewModel.test.ts
  reviewStore.ts        // invoke 封装（list/upsert/delete/resolve/fetch/publish）
  useReviewThreads.ts   // hook：按 repositoryPath + reference 加载，增删改 + 乐观更新
  useReviewThreads.test.ts
  ReviewThreadPanel.tsx // 评论区 UI：线程列表 + 回复输入 + 已解决开关 + 发布按钮（载体无关）
apps/frontend/src/features/diff/DiffPanel.tsx        // 行级锚点接入
apps/frontend/src/features/tree/TreeCodePreview.tsx  // 行号 gutter 锚点接入
apps/frontend/src/features/hosting/HostingPanel.tsx  // PR 详情「发布全部草稿（N）」+ 远端评论列表
```

### 锚点与交互

- **DiffPanel**：行号槽 hover 出现「+」；点击在行下方展开 `ReviewThreadPanel`（新建或已有线程）；已有评论的行在行号区显示标记（圆点/计数芯片）。锚点键 = `(reference, filePath, line, side)`。
- **TreeCodePreview**：有线程的行号高亮；点击行号打开右侧/下方 `ReviewThreadPanel`；新建评论用选中行号。CodeMirror 侧用一个轻量 gutter 扩展（基于 StateField 标记集合）实现高亮与点击。
- **线程操作**：回复、标记/取消已解决、删除（仅本地线程可删；带 remote 的线程删除只删本地记录，UI 明示）。
- **发布**：`ReviewThreadPanel` 每线程「发布到 PR」；HostingPanel PR 详情「发布全部草稿（N）」调 `publish_hosting_review`，完成后展示逐条成功/失败结果。目标 PR 选择：默认取 `list_hosting_pull_requests` 中 source_branch == 当前分支的开放 PR；没有则要求用户输入 PR 号后再发布。

### 与 A 的衔接

TreeCodePreview 已是只读 CodeMirror，gutter 扩展按 `data-path`/`filePath` + `matchLanguage` 无关地叠加；DiffPanel 已有 blockActionAnchors 行位系统，评论锚点挂在同一 offsets 体系上，不引入第二套行号换算。

## 错误处理

- 本地存储损坏：命令返回结构化错误（code `review.storeCorrupted`），UI 给「文件已损坏，可导出后重置」提示，不静默清空。
- 托管未配置/无 token：`hosting.notConfigured` 既有分类，发布按钮禁用并提示。
- 网络/权限失败：走 `classify()`（`git.network` / `git.auth.failed`）；发布部分失败逐条回显，成功项不回滚。
- 行换算失败（行不在 PR diff 内）：`review.lineNotInDiff` 专用提示。

## i18n

新增 `review` 域词典（zh 源、en 对应），键约 40 个：线程/回复/已解决/发布/拉取/失败原因等全部文案。沿用覆盖率门禁（`pnpm check:i18n` 必须 0/0）。

## 测试策略（TDD）

- **Rust**：`git_review.rs` 存储单测（CRUD、原子写、损坏文件错误、repository_key 稳定性）；hunk 换算单测（含重命名/新增文件边界）；`git_hosting.rs` 评论 JSON 映射 fixture 单测（GitHub/GitLab 各一组真实响应样例）。
- **前端**：`reviewModel` 纯函数（归组、锚点键、乐观更新）；`useReviewThreads`（mock invoke）；DiffPanel/TreeCodePreview 锚点渲染（renderToStaticMarkup / 纯函数）；发布结果归并逻辑。
- **门禁**：`pnpm typecheck`、`vitest`、`cargo test`、`pnpm test:git-client`、`pnpm build`、`check:i18n`、`check:error-codes` 全绿后分切片提交。

## 实施切片

1. **B1 模型与存储**：git_review.rs + 结构体 + CRUD 命令 + 单测；TS 类型镜像。
2. **B2 树预览评论**：reviewStore/hook/ReviewThreadPanel + TreeCodePreview gutter 锚点（先本地闭环，无网络）。
3. **B3 Diff 行评论**：DiffPanel 行锚点接入（复用 B2 组件）。
4. **B4 拉取远端**：fetch_hosting_review_comments + 映射 + HostingPanel 只读展示 + 评论区合并显示。
5. **B5 发布**：publish_hosting_review + hunk 换算 + 逐条结果 UI + 「发布全部草稿」入口。
6. **B6 收尾**：i18n 清零、README/shortcuts 文档、全门禁、打包冒烟。
