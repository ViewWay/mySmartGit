# Branchline W6 桌面端体验完善实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Branchline 桌面端具备完整中英文界面、Sourcetree 同构原生菜单、数十种编程语言高亮，以及更接近专业 Git 客户端的视觉与 Diff 阅读体验。

**Architecture:** 前端以 typed 字典 + 领域模块承载 i18n，以 `useNativeMenu` 单桥接驱动 Rust 原生菜单；Diff 与冲突编辑器共用 `@codemirror/language-data` 的 Lezer 高亮；视觉升级通过语义令牌统一落地；自动换行使用可测量行高 + 前缀和虚拟滚动。

**Tech Stack:** React 18、TypeScript、Vite、Vitest、CodeMirror 6、Lezer、Tauri 2.11、Rust、pnpm 10。

**Spec:** `docs/superpowers/specs/2026-11-06-desktop-polish-design.md`

## Global Constraints

- 工作目录固定为 worktree 根：`/Users/yimiliya/github/mySmartGit/.worktrees/w6-polish`；分支 `track/w6-polish`。
- 默认语言中文；英文必须完整，缺失键由 TypeScript 编译失败兜底。
- 不新增 Git 功能、不改变现有命令语义、不翻译 git 自身 stderr。
- 不引入 highlight.js / Prism / 新的主题系统；高亮统一走 CodeMirror Lezer。
- 所有 UI 可见中文必须来自 `src/i18n/messages/zh/**`；技术字符串使用 `// i18n-allow` 标记。
- 保留旧 CSS 变量别名，所有新增样式优先使用语义令牌。
- 每完成一个 Task 运行该 Task 的验证命令并提交一次 commit。
- 全套验证命令：`pnpm typecheck`、`pnpm --filter @branchline/frontend exec vitest run --reporter=dot`、`cargo test --manifest-path apps/desktop/Cargo.toml --quiet`。
- Rust 验证使用 `CARGO_TARGET_DIR=/Users/yimiliya/github/mySmartGit/apps/desktop/target` 复用已有编译缓存。

---

## Phase P0：基础设施

### Task 1：i18n 领域字典与格式化

**Files:**
- Create: `apps/frontend/src/i18n/format.ts`
- Create: `apps/frontend/src/i18n/plural.ts`
- Create: `apps/frontend/src/i18n/messages/zh/{index,common,nav,history,diff,stage,operation,repository,tools,settings,preferences,updates,errors,menu}.ts`
- Create: `apps/frontend/src/i18n/messages/en/{index,common,nav,history,diff,stage,operation,repository,tools,settings,preferences,updates,errors,menu}.ts`
- Modify: `apps/frontend/src/i18n/index.ts`
- Modify: `apps/frontend/src/i18n/i18n.test.ts`

**Interfaces:**
- Produces: `Language`、`MessageKey`、`useI18n(): { language, setLanguage, locale, t, tp, formatDate, formatRelative, formatNumber }`
- Produces: `translate(language: Language, key: string, params?): string`（保留旧签名，供动态错误码使用）
- Produces: `hasMessage(key: string): boolean`
- Produces: `formatDate(language, value, options?)`、`formatRelative(language, value, now?)`、`formatNumber(language, value, options?)`
- Produces: zh 领域导出常量 `common, nav, history, diff, stage, operation, repository, tools, settings, preferences, updates, errors, menu`

- [ ] **Step 1: 写失败测试**

在 `apps/frontend/src/i18n/i18n.test.ts` 追加：

```ts
import { describe, expect, it } from 'vitest'
import { en } from './messages/en'
import { zh } from './messages/zh'
import { formatRelative, translate, tp } from './index'

describe('i18n dictionaries', () => {
  it('keeps English complete against the Chinese key source', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('has no empty values', () => {
    for (const dictionary of [zh, en]) {
      for (const [key, value] of Object.entries(dictionary)) {
        expect(value.trim(), key).not.toBe('')
      }
    }
  })

  it('selects English plural categories', () => {
    expect(tp('en', 'history.commitCount', 1)).toBe('1 commit')
    expect(tp('en', 'history.commitCount', 3)).toBe('3 commits')
    expect(tp('zh', 'history.commitCount', 3)).toBe('3 个提交')
  })

  it('formats relative time per locale', () => {
    const now = Date.parse('2026-11-06T12:00:00Z')
    expect(formatRelative('en', '2026-11-06T11:58:00Z', now)).toBe('2 minutes ago')
    expect(formatRelative('zh', '2026-11-06T11:58:00Z', now)).toBe('2分钟前')
  })

  it('keeps dynamic error keys translatable', () => {
    expect(translate('en', 'errors.unknown')).not.toBe('errors.unknown')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @branchline/frontend exec vitest run src/i18n/i18n.test.ts --reporter=dot`
Expected: FAIL — 找不到 `./messages/en`、`tp`、`formatRelative`。

- [ ] **Step 3: 建立 zh/en 领域字典**

`zh/diff.ts` 示例（其余域按同样结构建立）：

```ts
export const diff = {
  'diff.title': '变更文件',
  'diff.search': '搜索 Diff',
  'diff.wordWrap': '自动换行',
  'diff.layout.unified': '统一 Diff',
  'diff.layout.split': '并排 Diff',
  'diff.whitespace': '显示空白差异',
  'diff.fontIncrease': '放大 Diff 字体',
  'diff.fontDecrease': '缩小 Diff 字体',
  'diff.fontReset': '恢复默认字号',
  'diff.empty': '没有可显示的差异',
} as const
```

`en/diff.ts` 使用 zh 约束完整性：

```ts
import { diff as zhDiff } from '../zh/diff'

export const diff = {
  'diff.title': 'Changed files',
  'diff.search': 'Search diff',
  'diff.wordWrap': 'Word wrap',
  'diff.layout.unified': 'Unified diff',
  'diff.layout.split': 'Side-by-side diff',
  'diff.whitespace': 'Show whitespace',
  'diff.fontIncrease': 'Increase diff font size',
  'diff.fontDecrease': 'Decrease diff font size',
  'diff.fontReset': 'Reset diff font size',
  'diff.empty': 'No changes to display',
} satisfies Record<keyof typeof zhDiff, string>
```

所有现有键原样迁入：`nav.*`、`tab.*`、`sidebar.*` 放 `nav.ts`；`updates.*` 放 `updates.ts`；`language.*`、`common.*` 放 `common.ts`。新增：

```ts
// zh/history.ts
export const history = {
  'history.commitCount.one': '{{count}} 个提交',
  'history.commitCount.other': '{{count}} 个提交',
} as const

// en/history.ts
export const history = {
  'history.commitCount.one': '{{count}} commit',
  'history.commitCount.other': '{{count}} commits',
} as const
```

`zh/index.ts`：

```ts
import { common } from './common'
import { menu } from './menu'
// ...其余域

export const zh = { ...common, ...nav, ...history, ...diff, ...stage, ...operation, ...repository, ...tools, ...settings, ...preferences, ...updates, ...errors, ...menu }
export type MessageKey = keyof typeof zh
```

`en/index.ts`：

```ts
import type { MessageKey } from '../zh'
export const en = { ...common, ...nav, ...history, ...diff, ...stage, ...operation, ...repository, ...tools, ...settings, ...preferences, ...updates, ...errors, ...menu } satisfies Record<MessageKey, string>
```

- [ ] **Step 4: 实现 format/plural 与新的 store**

`format.ts`：

```ts
import type { Language } from './index'

export function localeFor(language: Language) {
  return language === 'zh' ? 'zh-CN' : 'en-US'
}

export function formatDate(language: Language, value: string | number | Date, options?: Intl.DateTimeFormatOptions) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat(localeFor(language), options ?? { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function formatNumber(language: Language, value: number, options?: Intl.NumberFormatOptions) {
  return new Intl.NumberFormat(localeFor(language), options).format(value)
}

export function formatRelative(language: Language, value: string | number | Date, now = Date.now()) {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime()
  if (Number.isNaN(timestamp)) return String(value)
  const seconds = Math.round((timestamp - now) / 1000)
  const formatter = new Intl.RelativeTimeFormat(localeFor(language), { numeric: 'auto' })
  const thresholds: Array<[Intl.RelativeTimeFormatUnit, number]> = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]
  for (const [unit, size] of thresholds) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit)
  }
  return formatter.format(seconds, 'second')
}
```

`plural.ts`：

```ts
import type { Language } from './index'
import { localeFor } from './format'

export function pluralCategory(language: Language, count: number): Intl.LDMLPluralRule {
  return new Intl.PluralRules(localeFor(language)).select(count)
}
```

`index.ts` 保留 `setLanguage/getLanguage/subscribe`，把字典访问改为：

```ts
export function translate(language: Language, key: string, params?: Record<string, string | number>) {
  const dictionary = MESSAGES[language] as Record<string, string>
  const template = dictionary[key] ?? (MESSAGES.zh as Record<string, string>)[key] ?? key
  if (!params) return template
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

export function hasMessage(key: string) {
  return key in MESSAGES.zh
}

export function tp(language: Language, key: string, count: number, params?: Record<string, string | number>) {
  return translate(language, `${key}.${pluralCategory(language, count)}`, { count, ...params })
}
```

`useI18n()` 返回 `t: (key: MessageKey, params?) => string`、`tp`、`formatDate`、`formatRelative`、`formatNumber`。`t` 内部仍调用 `translate`，使动态代码也能复用。

- [ ] **Step 5: 运行测试**

Run: `pnpm --filter @branchline/frontend exec vitest run src/i18n/i18n.test.ts --reporter=dot && pnpm typecheck`
Expected: PASS；typecheck 无错误。

- [ ] **Step 6: 提交**

```bash
git add apps/frontend/src/i18n
git commit -m "feat(i18n): 建立领域字典、单复数与本地化格式化"
```

---

### Task 2：i18n 覆盖率与错误码校验脚本

**Files:**
- Create: `scripts/check-i18n.mjs`
- Create: `scripts/i18n-baseline.json`
- Create: `scripts/check-error-codes.mjs`
- Create: `scripts/lib/i18n-scan.mjs`
- Create: `scripts/lib/i18n-scan.test.mjs`
- Modify: root `package.json`

**Interfaces:**
- Produces: `scanI18n(rootDir): { total: number; files: Record<string, number> }`
- Produces: `npm run check:i18n`、`npm run check:i18n:update`、`npm run check:error-codes`

- [ ] **Step 1: 写扫描器测试**

`scripts/lib/i18n-scan.test.mjs`：

```js
import { describe, expect, it } from 'vitest'
import { scanSource } from './i18n-scan.mjs'

describe('scanSource', () => {
  it('counts Chinese literals and JSX text but skips comments and imports', () => {
    const source = `
      // 注释不计入
      import { t } from './i18n'
      const ok = t('common.save')
      export const A = () => <button title="中文标题">中文文本</button>
      const raw = '硬编码'
    `
    expect(scanSource(source, 'A.tsx')).toBe(2)
  })

  it('honors i18n-allow', () => {
    expect(scanSource(`export const x = '中文' // i18n-allow`, 'A.ts')).toBe(0)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test scripts/lib/i18n-scan.test.mjs`（若仓库没有 node test 依赖则用 `pnpm --filter @branchline/frontend exec vitest run ../../scripts/lib/i18n-scan.test.mjs`）
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现扫描器**

`scripts/lib/i18n-scan.mjs` 使用 TypeScript 编译器 API：

```js
import ts from 'typescript'

const CJK = /[\u3400-\u9fff]/

export function scanSource(source, fileName) {
  const isTsx = fileName.endsWith('.tsx')
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  let count = 0
  const visit = (node) => {
    const allowed = source.slice(source.lastIndexOf('\n', node.getStart(file)) + 1, source.indexOf('\n', node.getEnd())).includes('i18n-allow')
    if (!allowed && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node))) {
      if (CJK.test(node.getText(file))) count += 1
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return
    node.forEachChild(visit)
  }
  visit(file)
  return count
}
```

`scripts/check-i18n.mjs`：

```js
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { scanSource } from './lib/i18n-scan.mjs'

const root = new URL('..', import.meta.url).pathname
const srcRoot = join(root, 'apps/frontend/src')
const baselinePath = join(root, 'scripts/i18n-baseline.json')
const update = process.argv.includes('--update')

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'i18n' ? [] : walk(path)
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [path] : []
  })
}

const files = {}
for (const path of walk(srcRoot)) {
  const count = scanSource(readFileSync(path, 'utf8'), path)
  if (count) files[relative(root, path).replaceAll('\\', '/')] = count
}
const total = Object.values(files).reduce((sum, count) => sum + count, 0)
if (update) {
  writeFileSync(baselinePath, JSON.stringify({ total, files }, null, 2) + '\n')
  console.log(`i18n baseline updated: ${total} occurrences in ${Object.keys(files).length} files`)
  process.exit(0)
}
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
const regressions = Object.entries(files).filter(([path, count]) => count > (baseline.files[path] ?? 0))
if (total > baseline.total || regressions.length) {
  console.error(`i18n regression: ${total} > ${baseline.total}`)
  for (const [path, count] of regressions) console.error(`  ${path}: ${count} > ${baseline.files[path] ?? 0}`)
  process.exit(1)
}
console.log(`i18n coverage OK: ${total} occurrences (baseline ${baseline.total})`)
```

`scripts/check-error-codes.mjs`：读取 `apps/desktop/src/**/*.rs` 中 `code: "([a-z0-9.]+)"` 与 `CommandError::new\("([a-z0-9.]+)"`，再读取 `apps/frontend/src/i18n/messages/{zh,en}/errors.ts` 中的键，要求每个 code 在两份字典中都有 `'errors.<code>'`。缺失时输出并退出 1。

根 `package.json` scripts 追加：

```json
"check:i18n": "node scripts/check-i18n.mjs",
"check:i18n:update": "node scripts/check-i18n.mjs --update",
"check:error-codes": "node scripts/check-error-codes.mjs"
```

- [ ] **Step 4: 生成初始 baseline**

Run: `pnpm check:i18n:update && pnpm check:i18n`
Expected: baseline 记录当前约 2,700 处；再次运行输出 `i18n coverage OK`。

- [ ] **Step 5: 提交**

```bash
git add package.json scripts
git commit -m "feat(i18n): 新增覆盖率基线扫描与错误码校验脚本"
```

---

### Task 3：共享偏好存储

**Files:**
- Create: `apps/frontend/src/preferences.ts`
- Create: `apps/frontend/src/preferences.test.ts`
- Modify: `apps/frontend/src/App.tsx`（后续 Task 10 接入）
- Modify: `apps/frontend/src/features/diff/DiffPanel.tsx`（后续 Task 12 接入）

**Interfaces:**
- Produces: `Preferences { theme: 'light'|'dark'; diffLayout: 'unified'|'split'; wordWrap: boolean; showWhitespace: boolean; diffFontSize: number }`
- Produces: `getPreferences()`、`setPreference<K>(key, value)`、`subscribePreferences(listener)`、`usePreferences()`
- 旧键兼容：`branchline.theme.v1`、`branchline.diffView.v1`、`branchline.diffFontSize.v1`

- [ ] **Step 1: 写失败测试**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPreferences, resetPreferencesForTests, setPreference, subscribePreferences } from './preferences'

describe('preferences', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => {} } })
    resetPreferencesForTests()
  })

  it('defaults to light unified layout', () => {
    expect(getPreferences()).toEqual({ theme: 'light', diffLayout: 'unified', wordWrap: false, showWhitespace: false, diffFontSize: 12 })
  })

  it('updates and persists a preference', () => {
    const listener = vi.fn()
    const unsubscribe = subscribePreferences(listener)
    setPreference('wordWrap', true)
    expect(getPreferences().wordWrap).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('clamps font size', () => {
    setPreference('diffFontSize', 99)
    expect(getPreferences().diffFontSize).toBe(24)
    setPreference('diffFontSize', 1)
    expect(getPreferences().diffFontSize).toBe(9)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @branchline/frontend exec vitest run src/preferences.test.ts --reporter=dot`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

```ts
import { useSyncExternalStore } from 'react'

export type ThemePreference = 'light' | 'dark'
export type DiffLayout = 'unified' | 'split'
export interface Preferences {
  theme: ThemePreference
  diffLayout: DiffLayout
  wordWrap: boolean
  showWhitespace: boolean
  diffFontSize: number
}

const STORAGE_KEY = 'branchline.preferences.v1'
const MIN_FONT_SIZE = 9
const MAX_FONT_SIZE = 24
const DEFAULTS: Preferences = { theme: 'light', diffLayout: 'unified', wordWrap: false, showWhitespace: false, diffFontSize: 12 }
const listeners = new Set<() => void>()
let current = read()

function storage() {
  try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null }
}

function readLegacy(): Partial<Preferences> {
  const store = storage()
  if (!store) return {}
  const result: Partial<Preferences> = {}
  const theme = store.getItem('branchline.theme.v1')
  if (theme === 'light' || theme === 'dark') result.theme = theme
  const view = store.getItem('branchline.diffView.v1')
  if (view) { try { const parsed = JSON.parse(view); if (parsed === 'unified' || parsed === 'split') result.diffLayout = parsed } catch {} }
  const fontSize = Number(store.getItem('branchline.diffFontSize.v1'))
  if (Number.isFinite(fontSize) && fontSize > 0) result.diffFontSize = fontSize
  return result
}

function normalize(value: Partial<Preferences>): Preferences {
  return {
    theme: value.theme === 'dark' ? 'dark' : 'light',
    diffLayout: value.diffLayout === 'split' ? 'split' : 'unified',
    wordWrap: value.wordWrap === true,
    showWhitespace: value.showWhitespace === true,
    diffFontSize: Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(value.diffFontSize ?? DEFAULTS.diffFontSize))),
  }
}

function read(): Preferences {
  const store = storage()
  if (!store) return DEFAULTS
  const raw = store.getItem(STORAGE_KEY)
  if (!raw) return normalize(readLegacy())
  try { return normalize(JSON.parse(raw)) } catch { return DEFAULTS }
}

export function getPreferences() { return current }

export function setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]) {
  const next = normalize({ ...current, [key]: value })
  if (JSON.stringify(next) === JSON.stringify(current)) return
  current = next
  try { storage()?.setItem(STORAGE_KEY, JSON.stringify(next)) } catch {}
  for (const listener of listeners) listener()
}

export function subscribePreferences(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePreferences() {
  return useSyncExternalStore(subscribePreferences, getPreferences, () => DEFAULTS)
}

export function resetPreferencesForTests() {
  current = read()
  for (const listener of listeners) listener()
}
```

- [ ] **Step 4: 运行测试并提交**

Run: `pnpm --filter @branchline/frontend exec vitest run src/preferences.test.ts --reporter=dot && pnpm typecheck`
Expected: PASS。

```bash
git add apps/frontend/src/preferences.ts apps/frontend/src/preferences.test.ts
git commit -m "feat(preferences): 新增共享偏好存储与旧键迁移"
```

---

### Task 4：git-client 错误规范化

**Files:**
- Modify: `packages/git-client/src/index.ts`
- Create: `packages/git-client/src/errors.ts`
- Create: `packages/git-client/src/errors.test.ts`
- Create: `apps/frontend/src/errors.ts`
- Create: `apps/frontend/src/errors.test.ts`

**Interfaces:**
- Produces: `BranchlineCommandError { code, params, detail }`、`BranchlineCommandError.from(unknown)`
- Produces: `errorPresentation(error, t): { message: string; detail?: string }`
- `invoke` 统一抛出 `BranchlineCommandError`

- [ ] **Step 1: 写失败测试**

`packages/git-client/src/errors.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { BranchlineCommandError } from './errors'

describe('BranchlineCommandError', () => {
  it('passes through existing errors', () => {
    const error = new BranchlineCommandError('git.fetch.failed', { branch: 'main' }, 'fatal')
    expect(BranchlineCommandError.from(error)).toBe(error)
  })

  it('normalizes structured Tauri rejections', () => {
    const error = BranchlineCommandError.from({ code: 'git.push.rejected', params: { branch: 'main' }, detail: 'non-fast-forward' })
    expect(error.code).toBe('git.push.rejected')
    expect(error.params.branch).toBe('main')
    expect(error.detail).toBe('non-fast-forward')
  })

  it('falls back to unknown with raw detail', () => {
    const error = BranchlineCommandError.from(new Error('boom'))
    expect(error.code).toBe('errors.unknown')
    expect(error.detail).toBe('boom')
  })
})
```

`apps/frontend/src/errors.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { BranchlineCommandError } from '@branchline/git-client'
import { errorPresentation } from './errors'

const t = ((key: string, params?: Record<string, string | number>) => key === 'errors.git.fetch.failed' ? `拉取失败：${params?.branch}` : key === 'errors.unknown' ? '发生未知错误' : key)

describe('errorPresentation', () => {
  it('translates known codes', () => {
    expect(errorPresentation(new BranchlineCommandError('git.fetch.failed', { branch: 'main' }), t).message).toBe('拉取失败：main')
  })

  it('falls back to unknown and keeps technical detail', () => {
    const result = errorPresentation(new BranchlineCommandError('missing.code', {}, 'fatal: bad revision'), t)
    expect(result.message).toBe('errors.unknown')
    expect(result.detail).toBe('fatal: bad revision')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @branchline/frontend exec vitest run ../../packages/git-client/src/errors.test.ts src/errors.test.ts --reporter=dot`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

`packages/git-client/src/errors.ts`：

```ts
export interface CommandErrorPayload {
  code?: unknown
  params?: unknown
  detail?: unknown
}

export class BranchlineCommandError extends Error {
  readonly code: string
  readonly params: Record<string, string>
  readonly detail?: string

  constructor(code: string, params: Record<string, string> = {}, detail?: string) {
    super(detail || code)
    this.name = 'BranchlineCommandError'
    this.code = code
    this.params = params
    this.detail = detail
  }

  static from(error: unknown): BranchlineCommandError {
    if (error instanceof BranchlineCommandError) return error
    if (typeof error === 'object' && error !== null && typeof (error as CommandErrorPayload).code === 'string') {
      const payload = error as CommandErrorPayload
      const params = typeof payload.params === 'object' && payload.params !== null
        ? Object.fromEntries(Object.entries(payload.params as Record<string, unknown>).map(([key, value]) => [key, String(value)]))
        : {}
      return new BranchlineCommandError(payload.code as string, params, typeof payload.detail === 'string' ? payload.detail : undefined)
    }
    return new BranchlineCommandError('errors.unknown', {}, error instanceof Error ? error.message : String(error))
  }
}
```

`packages/git-client/src/index.ts`：

```ts
import { BranchlineCommandError } from './errors'
export { BranchlineCommandError } from './errors'

async function invoke<T>(command: string, args: Record<string, unknown>) {
  if (!isTauriRuntime()) {
    throw new BranchlineCommandError('errors.desktopOnly')
  }
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  try {
    return await tauriInvoke<T>(command, args)
  } catch (error) {
    throw BranchlineCommandError.from(error)
  }
}
```

`apps/frontend/src/errors.ts`：

```ts
import { BranchlineCommandError } from '@branchline/git-client'

type Translate = (key: string, params?: Record<string, string | number>) => string

export function errorPresentation(error: unknown, t: Translate) {
  const normalized = BranchlineCommandError.from(error)
  const key = normalized.code.startsWith('errors.') ? normalized.code : `errors.${normalized.code}`
  const message = t(key, normalized.params)
  return {
    message: message === key ? t('errors.unknown') : message,
    detail: normalized.detail,
  }
}
```

在 `errors.ts` 字典中补充 `errors.unknown`、`errors.desktopOnly`、`errors.git.fetch.failed` 两语条目，供测试与首批接入使用。

- [ ] **Step 4: 运行测试并提交**

Run: `pnpm --filter @branchline/frontend exec vitest run ../../packages/git-client/src/errors.test.ts src/errors.test.ts --reporter=dot && pnpm typecheck`
Expected: PASS。

```bash
git add packages/git-client/src apps/frontend/src/errors.ts apps/frontend/src/errors.test.ts apps/frontend/src/i18n/messages
git commit -m "feat(errors): 统一命令错误结构与前端呈现"
```

---

## Phase P1：代码高亮

### Task 5：语言注册表与分组高亮器

**Files:**
- Create: `apps/frontend/src/syntax/languages.ts`
- Create: `apps/frontend/src/syntax/highlight.ts`
- Create: `apps/frontend/src/syntax/highlight.test.ts`
- Create: `apps/frontend/src/syntax/diffHighlights.ts`
- Create: `apps/frontend/src/syntax/diffHighlights.test.ts`
- Modify: `apps/frontend/package.json`（新增 `@codemirror/language-data`、`@codemirror/lang-*` 由 language-data 传递依赖提供）

**Interfaces:**
- Produces: `matchLanguage(path): LanguageDescription | null`
- Produces: `tokenizeBlock(code, language): SyntaxToken[][]`、`highlightBlock(code, language, description): SyntaxToken[][]`、`clearHighlightCache()`
- Produces: `buildDiffHighlightIndex(rows, language): Map<number, SyntaxToken[]>`（纯函数，便于测试）
- Produces: `useDiffHighlights(rows, filePath): Map<number, SyntaxToken[]>`

- [ ] **Step 1: 安装依赖**

Run: `pnpm --filter @branchline/frontend add @codemirror/language-data`
Expected: 安装成功，lockfile 更新。

- [ ] **Step 2: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { javascript } from '@codemirror/lang-javascript'
import { matchLanguage } from './languages'
import { clearHighlightCache, highlightBlock, tokenizeBlock } from './highlight'
import { buildDiffHighlightIndex } from './diffHighlights'

const language = javascript({ typescript: true }).language

describe('matchLanguage', () => {
  it('matches common filenames', () => {
    expect(matchLanguage('src/App.tsx')?.name).toBe('TypeScript')
    expect(matchLanguage('Dockerfile')?.name).toBe('Dockerfile')
    expect(matchLanguage('Makefile')?.name).toBe('C')
    expect(matchLanguage('unknown.zzz')).toBeNull()
  })
})

describe('tokenizeBlock', () => {
  it('highlights keywords, strings, and cross-line comments', () => {
    const tokens = tokenizeBlock('const a = 1\n/* line\ncomment */\nconst b = "x"', language)
    expect(tokens).toHaveLength(4)
    expect(tokens[0].some((token) => token.className?.includes('tok-keyword'))).toBe(true)
    expect(tokens.flat().some((token) => token.className?.includes('tok-string'))).toBe(true)
    expect(tokens[1].some((token) => token.className?.includes('tok-comment'))).toBe(true)
    expect(tokens[2].some((token) => token.className?.includes('tok-comment'))).toBe(true)
  })

  it('caches identical blocks', () => {
    clearHighlightCache()
    const first = highlightBlock('let x = 1', language, { name: 'TypeScript' } as never)
    const second = highlightBlock('let x = 1', language, { name: 'TypeScript' } as never)
    expect(second).toBe(first)
  })
})

describe('buildDiffHighlightIndex', () => {
  it('uses old and new streams independently', () => {
    const rows = [
      { kind: 'del', code: 'const oldName = 1', old: 1 },
      { kind: 'add', code: 'const newName = 1', next: 1 },
      { kind: 'same', code: 'return', old: 2, next: 2 },
    ]
    const index = buildDiffHighlightIndex(rows, language)
    expect(index.get(0)?.some((token) => token.className?.includes('tok-keyword'))).toBe(true)
    expect(index.get(1)?.some((token) => token.className?.includes('tok-keyword'))).toBe(true)
  })
})
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm --filter @branchline/frontend exec vitest run src/syntax --reporter=dot`
Expected: FAIL — 模块不存在。

- [ ] **Step 4: 实现 languages.ts**

```ts
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'

const filenameOverrides: Record<string, string> = {
  dockerfile: 'Dockerfile',
  makefile: 'C',
  'cmakelists.txt': 'CMake',
  '.gitignore': 'Shell',
  '.env': 'Properties files',
}

export function matchLanguage(path: string): LanguageDescription | null {
  if (!path) return null
  const filename = path.replaceAll('\\', '/').split('/').pop() ?? ''
  const lower = filename.toLowerCase()
  const override = filenameOverrides[lower]
  if (override) {
    const description = languages.find((item) => item.name === override)
    if (description) return description
  }
  return LanguageDescription.matchFilename(languages, filename)
}
```

- [ ] **Step 5: 实现 highlight.ts**

```ts
import type { Language, LanguageDescription } from '@codemirror/language'
import { syntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { classHighlighter, highlightCode } from '@lezer/highlight'

export interface SyntaxToken {
  text: string
  className: string | null
}

const CACHE_LIMIT = 200
const cache = new Map<string, SyntaxToken[][]>()

export function tokenizeBlock(code: string, language: Language | null): SyntaxToken[][] {
  if (!language) return code.split('\n').map((line) => (line ? [{ text: line, className: null }] : []))
  const lines: SyntaxToken[][] = [[]]
  const state = EditorState.create({ doc: code, extensions: [language] })
  highlightCode(code, syntaxTree(state), classHighlighter, (text, classes) => {
    lines[lines.length - 1].push({ text, className: classes || null })
  }, () => {
    lines.push([])
  })
  return lines
}

export function highlightBlock(code: string, language: Language | null, description: LanguageDescription): SyntaxToken[][] {
  if (!language) return tokenizeBlock(code, null)
  const key = `${description.name}\u0000${code}`
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const result = tokenizeBlock(code, language)
  cache.set(key, result)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
  return result
}

export function clearHighlightCache() {
  cache.clear()
}
```

- [ ] **Step 6: 实现 diffHighlights.ts**

```ts
import type { Language } from '@codemirror/language'
import type { RepositoryDiffLine } from '@branchline/git-models'
import { tokenizeBlock, type SyntaxToken } from './highlight'

export function buildDiffHighlightIndex(rows: RepositoryDiffLine[], language: Language | null) {
  const index = new Map<number, SyntaxToken[]>()
  if (!language || !rows.length) return index
  const oldRows: number[] = []
  const newRows: number[] = []
  const oldLines: string[] = []
  const newLines: string[] = []
  rows.forEach((row, rowIndex) => {
    if (row.kind !== 'add') { oldRows.push(rowIndex); oldLines.push(row.code) }
    if (row.kind !== 'del') { newRows.push(rowIndex); newLines.push(row.code) }
  })
  const oldTokens = tokenizeBlock(oldLines.join('\n'), language)
  const newTokens = tokenizeBlock(newLines.join('\n'), language)
  oldRows.forEach((rowIndex, lineIndex) => index.set(rowIndex, oldTokens[lineIndex] ?? []))
  newRows.forEach((rowIndex, lineIndex) => index.set(rowIndex, newTokens[lineIndex] ?? []))
  return index
}
```

`useDiffHighlights` 的加载逻辑放在同文件：

```ts
import { useEffect, useMemo, useState } from 'react'
import type { Language, LanguageDescription } from '@codemirror/language'
import { matchLanguage } from './languages'

export function useLanguageDescription(path: string) {
  const description = useMemo(() => matchLanguage(path), [path])
  const [language, setLanguage] = useState<Language | null>(null)
  useEffect(() => {
    let cancelled = false
    setLanguage(null)
    if (!description) return
    void description.load().then((support) => { if (!cancelled) setLanguage(support.language) }).catch(() => { if (!cancelled) setLanguage(null) })
    return () => { cancelled = true }
  }, [description])
  return { description, language }
}

export function useDiffHighlights(rows: RepositoryDiffLine[], path: string) {
  const { language } = useLanguageDescription(path)
  return useMemo(() => buildDiffHighlightIndex(rows, language), [rows, language])
}
```

- [ ] **Step 7: 运行测试并提交**

Run: `pnpm --filter @branchline/frontend exec vitest run src/syntax --reporter=dot && pnpm typecheck`
Expected: PASS（若 `Makefile` 映射名称与 language-data 实际名称不同，按实际 `languages` 名称修正测试与覆盖表）。

```bash
git add apps/frontend/package.json pnpm-lock.yaml apps/frontend/src/syntax
git commit -m "feat(syntax): 新增语言注册表、分组高亮与 Diff 索引"
```

---

### Task 6：DiffPanel 接入分组高亮

**Files:**
- Modify: `apps/frontend/src/features/diff/HighlightedCode.tsx`
- Modify: `apps/frontend/src/features/diff/DiffPanel.tsx`
- Modify: `apps/frontend/src/features/diff/DiffPanel.test.ts`
- Modify: `apps/frontend/src/styles/features.css`

**Interfaces:**
- Consumes: `useDiffHighlights(rows, path)`、`SyntaxToken`
- Produces: `HighlightedCode({ code, tokens?, filePath })`（保留旧调用兼容）

- [ ] **Step 1: 写失败测试**

在 `DiffPanel.test.ts` 追加纯渲染断言：

```ts
import { renderToStaticMarkup } from 'react-dom/server'
import { HighlightedCode } from './HighlightedCode'

it('renders pre-tokenized classes', () => {
  const html = renderToStaticMarkup(<HighlightedCode code="const a = 1" tokens={[{ text: 'const', className: 'tok-keyword' }, { text: ' a = 1', className: null }]} filePath="a.ts"/>)
  expect(html).toContain('tok-keyword')
  expect(html).toContain('const')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @branchline/frontend exec vitest run src/features/diff/DiffPanel.test.ts --reporter=dot`
Expected: FAIL — `tokens` 未定义或类名缺失。

- [ ] **Step 3: 改造 HighlightedCode**

保留 memo 组件，新增可选 `tokens`；有 tokens 时直接渲染 `span.tok-*`，无 tokens 时保持现有 tokenizer 作为兜底（迁移完成后删除）。

```tsx
export const HighlightedCode = memo(function HighlightedCode({ code, filePath, tokens }: { code: string; filePath: string; tokens?: SyntaxToken[] }) {
  const fallback = useMemo(() => tokenize(code || ' ', languageForPath(filePath)), [code, filePath])
  const parts = tokens ?? fallback
  return <code className="highlighted-code">{parts.map((token, index) => token.className
    ? <span key={index} className={token.className}>{token.text}</span>
    : <span key={index}>{token.text}</span>)}</code>
})
```

- [ ] **Step 4: DiffPanel 构建索引**

在 `sourceRows` 之后：

```ts
const diffHighlights = useDiffHighlights(sourceRows, activeFileInfo?.path ?? '')
```

统一视图渲染改为：

```tsx
<HighlightedCode code={row.code} filePath={activeFileInfo?.path ?? ''} tokens={diffHighlights.get(entry.sourceIndex)}/>
```

并排视图：

```tsx
<HighlightedCode code={row.code} filePath={activeFileInfo?.path ?? ''} tokens={diffHighlights.get(sourceIndex)}/>
```

- [ ] **Step 5: 补 token 样式**

在 `styles/tokens.css` 新增 `--syntax-function/property/tag/attribute/operator/punctuation/meta/regexp/inserted/deleted/invalid`；在 `styles/features.css` 新增：

```css
.tok-comment { color: var(--syntax-comment); font-style: italic; }
.tok-keyword { color: var(--syntax-keyword); }
.tok-string, .tok-regexp { color: var(--syntax-string); }
.tok-number, .tok-bool, .tok-null { color: var(--syntax-number); }
.tok-typeName, .tok-className, .tok-namespace { color: var(--syntax-type); }
.tok-function, .tok-variableName.tok-definition { color: var(--syntax-function); }
.tok-propertyName { color: var(--syntax-property); }
.tok-tagName { color: var(--syntax-tag); }
.tok-attributeName { color: var(--syntax-attribute); }
.tok-operator, .tok-punctuation { color: var(--text-secondary); }
.tok-invalid { color: var(--danger); }
```

- [ ] **Step 6: 验证并提交**

Run: `pnpm --filter @branchline/frontend exec vitest run src/features/diff --reporter=dot && pnpm typecheck && pnpm build`
Expected: PASS；构建成功，确认语言包按需分包。

```bash
git add apps/frontend/src/features/diff apps/frontend/src/styles
git commit -m "feat(diff): Diff 行改用 Lezer 分组高亮"
```

---

### Task 7：冲突编辑器动态语言与本地化块操作

**Files:**
- Modify: `apps/frontend/src/features/operation/ConflictCodeEditor.tsx`
- Modify: `apps/frontend/src/features/operation/ConflictCodeEditor.test.tsx`（若无则新建）
- Modify: `apps/frontend/src/i18n/messages/zh/operation.ts`
- Modify: `apps/frontend/src/i18n/messages/en/operation.ts`

**Interfaces:**
- Consumes: `matchLanguage(path)`、`useI18n()`
- Produces: `ConflictCodeEditor` 新增 props `labels?: { current: string; incoming: string; both: string }`
- 删除静态 `languageForPath` 与 6 个 lang 包直接依赖（由 language-data 传递）

- [ ] **Step 1: 写失败测试**

```tsx
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConflictCodeEditor } from './ConflictCodeEditor'

it('renders localized conflict actions', () => {
  const html = renderToStaticMarkup(<ConflictCodeEditor value={'<<<<<<< HEAD\na\n=======\nb\n>>>>>>> branch'} filePath="a.py" blocks={[{ from: 0, to: 31, current: 'a', incoming: 'b' }]} activeBlock={0} onChange={() => {}} onResolveBlock={() => {}} onSave={() => {}} saveLabel="Save" labels={{ current: 'Use current', incoming: 'Use incoming', both: 'Keep both' }}/>)
  expect(html).toContain('Use current')
  expect(html).not.toContain('采用当前更改')
})
```

（若组件无法在无 DOM 环境渲染 CodeMirror，改为测试 `buildConflictActions(labels)` 纯函数并断言返回值；不得留下跳过测试。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @branchline/frontend exec vitest run src/features/operation/ConflictCodeEditor.test.tsx --reporter=dot`
Expected: FAIL — props/本地化不存在。

- [ ] **Step 3: 改造语言加载**

删除 `@codemirror/lang-*` 静态导入与 `languageForPath`，改为：

```ts
function useEditorLanguage(filePath: string) {
  const description = useMemo(() => matchLanguage(filePath), [filePath])
  const [language, setLanguage] = useState<Extension>([])
  useEffect(() => {
    let cancelled = false
    if (!description) { setLanguage([]); return }
    void description.load().then((support) => { if (!cancelled) setLanguage(support) }).catch(() => { if (!cancelled) setLanguage([]) })
    return () => { cancelled = true }
  }, [description])
  return language
}
```

创建编辑器后，在语言变化时 `languageCompartment.current.reconfigure(language)`；初始 state 使用 `languageCompartment.current.of([])`。

- [ ] **Step 4: 本地化块操作**

`ConflictActionsWidget` 构造函数接收 `labels`，`toDOM()` 使用 `labels.current/incoming/both`。App 调用处传入 `t('operation.conflict.useCurrent')` 等。字典新增：

```ts
// zh/operation.ts
'operation.conflict.useCurrent': '采用当前更改',
'operation.conflict.useIncoming': '采用传入的更改',
'operation.conflict.keepBoth': '保留双方更改',
// en/operation.ts
'operation.conflict.useCurrent': 'Use current change',
'operation.conflict.useIncoming': 'Use incoming change',
'operation.conflict.keepBoth': 'Keep both changes',
```

- [ ] **Step 5: 验证并提交**

Run: `pnpm --filter @branchline/frontend exec vitest run src/features/operation --reporter=dot && pnpm typecheck && pnpm build`
Expected: PASS。

```bash
git add apps/frontend/src/features/operation apps/frontend/src/i18n/messages
git commit -m "feat(conflict): 冲突编辑器按文件动态加载语言并本地化块操作"
```

---

## Phase P2：原生菜单与偏好设置

### Task 8：Rust 菜单模块与状态同步

**Files:**
- Create: `apps/desktop/src/menu.rs`
- Modify: `apps/desktop/src/lib.rs`
- Modify: `apps/desktop/Cargo.toml`（如需 `serde_json` 已存在则不重复添加）

**Interfaces:**
- Produces commands: `set_menu_language(language: String, labels: BTreeMap<String, String>)`、`sync_menu_state(state: MenuState)`
- Produces event: `menu-action` `{ id, payload? }`
- Produces Rust `MenuState` 字段与 spec 5.2 一致

- [ ] **Step 1: 写失败测试**

在 `menu.rs` 底部：

```rust
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
        for id in ["file.new-repository", "repo.fetch", "repo.pull", "repo.push", "format.word-wrap", "view.sidebar", "action.abort"] {
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
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test --manifest-path apps/desktop/Cargo.toml menu:: --quiet`
Expected: FAIL — 模块/函数不存在。

- [ ] **Step 3: 实现菜单结构与状态**

`menu.rs` 包含：

```rust
use std::collections::BTreeMap;
use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
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

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct RecentRepository { pub path: String, pub name: String }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuAction { pub id: String, pub payload: Option<serde_json::Value> }

pub struct MenuItemSpec { pub id: &'static str, pub accelerator: Option<&'static str> }

pub fn label(labels: &BTreeMap<String, String>, key: &str, fallback: &str) -> String {
    labels.get(key).cloned().unwrap_or_else(|| fallback.to_string())
}

pub fn enabled_for(id: &str, state: &MenuState) -> bool {
    if state.busy { return false }
    if id.starts_with("action.") {
        return match id { "action.abort" | "action.continue" | "action.skip" => state.operation, _ => state.has_repository && state.has_selection };
    }
    if id.starts_with("repo.") { return state.has_repository }
    if id.starts_with("file.close") { return state.has_repository }
    true
}

pub fn item_specs() -> Vec<MenuItemSpec> { /* 返回所有自定义 id 与 accelerator，覆盖 spec 5.1 */ }
```

`build_menu(app, labels, state) -> tauri::Result<Menu<R>>` 按 spec 5.1 组装；`#[cfg(target_os = "macos")]` 添加应用菜单，非 macOS 在文件/帮助中加入偏好设置与退出。平台条件使用 `tauri::menu::PredefinedMenuItem`。

状态更新：

```rust
pub fn apply_state<R: Runtime>(app: &AppHandle<R>, state: &MenuState) -> tauri::Result<()> {
    let Some(menu) = app.menu() else { return Ok(()) };
    for kind in menu.items()? {
        apply_to_kind(&kind, state)?;
    }
    Ok(())
}

fn apply_to_kind<R: Runtime>(kind: &tauri::menu::MenuItemKind<R>, state: &MenuState) -> tauri::Result<()> {
    match kind {
        tauri::menu::MenuItemKind::Submenu(submenu) => {
            for child in submenu.items()? { apply_to_kind(&child, state)?; }
        }
        tauri::menu::MenuItemKind::MenuItem(item) => { let id = item.id().0.as_str().to_string(); item.set_enabled(enabled_for(&id, state))?; }
        tauri::menu::MenuItemKind::Check(item) => {
            let id = item.id().0.as_str().to_string();
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
```

命令与运行态：

```rust
#[derive(Default)]
pub struct MenuRuntime {
    pub labels: BTreeMap<String, String>,
    pub state: MenuState,
}

#[tauri::command]
pub fn set_menu_language<R: Runtime>(
    app: AppHandle<R>,
    runtime: tauri::State<'_, std::sync::Mutex<MenuRuntime>>,
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
pub fn sync_menu_state<R: Runtime>(
    app: AppHandle<R>,
    runtime: tauri::State<'_, std::sync::Mutex<MenuRuntime>>,
    state: MenuState,
) -> Result<(), String> {
    let mut guard = runtime.lock().map_err(|error| error.to_string())?;
    let rebuild = state.language != guard.state.language || state.recent != guard.state.recent;
    guard.state = state.clone();
    if rebuild {
        let menu = build_menu(&app, &guard.labels, &guard.state).map_err(|error| error.to_string())?;
        app.set_menu(menu).map_err(|error| error.to_string())?;
    } else {
        apply_state(&app, &state).map_err(|error| error.to_string())?;
    }
    Ok(())
}
```

在 `lib.rs`：

```rust
mod menu;
// setup:
.setup(|app| {
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
// invoke_handler 追加:
menu::set_menu_language,
menu::sync_menu_state,
```

`RecentRepository` 派生 `PartialEq, Eq` 以支持重建判断；`MenuState` 派生 `Clone`。

- [ ] **Step 4: 运行 Rust 测试**

Run: `CARGO_TARGET_DIR=/Users/yimiliya/github/mySmartGit/apps/desktop/target cargo test --manifest-path apps/desktop/Cargo.toml menu:: --quiet && CARGO_TARGET_DIR=/Users/yimiliya/github/mySmartGit/apps/desktop/target cargo check --manifest-path apps/desktop/Cargo.toml`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/menu.rs apps/desktop/src/lib.rs
git commit -m "feat(menu): 新增 Sourcetree 同构原生菜单与状态同步命令"
```

---

### Task 9：前端菜单桥、PreferencesDialog 与快捷键去重

**Files:**
- Create: `apps/frontend/src/menu/useNativeMenu.ts`
- Create: `apps/frontend/src/menu/menuBridge.test.ts`（纯 action 映射测试）
- Create: `apps/frontend/src/features/preferences/PreferencesDialog.tsx`
- Modify: `apps/frontend/src/App.tsx`
- Modify: `apps/frontend/src/features/settings/UpdatePanel.tsx`
- Modify: `apps/frontend/src/styles/components.css` / `features.css`
- Modify: `apps/frontend/src/i18n/messages/zh/menu.ts` / `en/menu.ts` / `preferences.ts`

**Interfaces:**
- Consumes: `@tauri-apps/api/event.listen`、`@tauri-apps/api/core.invoke`
- Produces: `useNativeMenu({ onAction, state })`
- Produces: `PreferencesDialog({ open, page, onClose, onPageChange })`
- 菜单 action id 与 App 行为映射（见 Step 4）

- [ ] **Step 1: 写失败测试**

`menuBridge.test.ts` 测试纯映射：

```ts
import { describe, expect, it } from 'vitest'
import { menuActionHandlers } from './menuBridge'

it('maps every menu id to a handler', () => {
  expect(menuActionHandlers['repo.fetch']).toBe('fetch')
  expect(menuActionHandlers['view.sidebar']).toBe('toggle-sidebar')
  expect(menuActionHandlers['format.word-wrap']).toBe('toggle-word-wrap')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @branchline/frontend exec vitest run src/menu --reporter=dot`
Expected: FAIL。

- [ ] **Step 3: 实现 useNativeMenu**

```ts
import { useEffect, useRef } from 'react'
import { isTauriRuntime } from '@branchline/git-client'
import { listen } from '@tauri-apps/api/event'

export interface NativeMenuState {
  language: string
  hasRepository: boolean
  busy: boolean
  operation: boolean
  hasSelection: boolean
  sidebarVisible: boolean
  inspectorVisible: boolean
  diffLayout: string
  wordWrap: boolean
  showWhitespace: boolean
  diffFontSize: number
  theme: string
  recent: Array<{ path: string; name: string }>
}

export function useNativeMenu(onAction: (id: string) => void, labels: Record<string, string>, state: NativeMenuState) {
  const onActionRef = useRef(onAction)
  onActionRef.current = onAction
  const ready = useRef(false)

  useEffect(() => {
    if (!isTauriRuntime()) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void (async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('set_menu_language', { language: state.language, labels })
      ready.current = true
      unlisten = await listen<{ id: string }>('menu-action', (event) => onActionRef.current(event.payload.id))
    })()
    return () => { disposed = true; unlisten?.() }
  }, [state.language, labels])

  useEffect(() => {
    if (!isTauriRuntime()) return
    void (async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('sync_menu_state', { state })
    })()
  }, [state])
}
```

网络请求失败时静默（菜单是增强功能，不能阻塞 UI）。

- [ ] **Step 4: App 接入**

在 App 内新增：

```ts
const preferences = usePreferences()
const [preferencesOpen, setPreferencesOpen] = useState(false)
const [preferencesPage, setPreferencesPage] = useState<'general' | 'updates'>('general')

const runMenuAction = useCallback((id: string) => {
  const actions: Record<string, () => void> = {
    'file.new-repository': () => void handleCreateRepository(),
    'file.open-repository': () => void handleOpenRepository(),
    'file.clone-repository': () => setRepositoryManagerOpen(true),
    'file.close-repository': () => void closeRepository(),
    'app.preferences': () => { setPreferencesPage('general'); setPreferencesOpen(true) },
    'app.check-updates': () => { setPreferencesPage('updates'); setPreferencesOpen(true) },
    'edit.find': () => setSearchMode('locate'),
    'edit.search-repository': () => setWorkspaceView('search'),
    'format.word-wrap': () => setPreference('wordWrap', !preferences.wordWrap),
    'format.diff-unified': () => setPreference('diffLayout', 'unified'),
    'format.diff-split': () => setPreference('diffLayout', 'split'),
    'format.show-whitespace': () => setPreference('showWhitespace', !preferences.showWhitespace),
    'format.font-increase': () => setPreference('diffFontSize', preferences.diffFontSize + 1),
    'format.font-decrease': () => setPreference('diffFontSize', preferences.diffFontSize - 1),
    'format.font-reset': () => setPreference('diffFontSize', 12),
    'view.history': () => setWorkspaceView('history'),
    'view.changes': () => setWorkspaceView('changes'),
    'view.stash': () => setWorkspaceView('stash'),
    'view.recovery': () => setWorkspaceView('recovery'),
    'view.search': () => setWorkspaceView('search'),
    'view.tree': () => setWorkspaceView('tree'),
    'view.compare': () => setWorkspaceView('compare'),
    'view.merge': () => setWorkspaceView('merge'),
    'view.terminal': () => setWorkspaceView('terminal'),
    'view.sidebar': () => setSidebarCollapsed((value) => !value),
    'view.inspector': () => setInspectorCollapsed((value) => !value),
    'view.theme.light': () => setPreference('theme', 'light'),
    'view.theme.dark': () => setPreference('theme', 'dark'),
    'view.language.zh': () => setLanguage('zh'),
    'view.language.en': () => setLanguage('en'),
    'view.reload': () => window.location.reload(),
    'repo.fetch': () => void handleFetch(),
    'repo.pull': () => repository && void handlePullBranch(repository.branch),
    'repo.push': () => void handlePush(),
    'repo.create-branch': () => openCreateBranchDialog(),
    'repo.stash-all': () => void handleStashAll(),
    'action.continue': () => void handleContinueOperation(),
    'action.skip': () => void handleSkipOperation(),
    'action.abort': () => void handleAbortOperation(),
  }
  actions[id]?.()
}, [handleCreateRepository, handleFetch, handleOpenRepository, handlePullBranch, handlePush, preferences, repository, setLanguage, ...])
```

未在 Step 中出现的 handler 名称以 App 现有函数为准；实现时逐一从 App 现有按钮回调中提取，不复制业务逻辑。无法直接映射的菜单项（merge/rebase 等需要选中提交）通过 `setSelected`/dialog state 打开既有对话框。

`useNativeMenu(runMenuAction, menuLabels, menuState)`，其中 `menuLabels` 由 zh/en `menu` 域按当前语言生成（`Object.fromEntries` 已有键），`menuState` 由 repository、operation、selected、collapsed、preferences、language、recentRepositories 派生。

- [ ] **Step 5: 实现 PreferencesDialog**

左栏“通用/更新”；通用页绑定 `usePreferences()`：语言 CompactSelect、主题、Diff 布局、自动换行、显示空白、字号；更新页渲染 `<UpdatePanel/>`。菜单与侧栏“版本与更新”打开更新页，删除 App 中独立 `<UpdateDialog>`。

- [ ] **Step 6: 快捷键去重**

`App.tsx` keydown 处理器在 `isTauriRuntime()` 为真时跳过原生菜单已接管的组合：`⌘N/⌘O/⇧⌘O/⇧⌘W/⌘F/⌘Enter/⌘B/⌘,/⌘+/⌘-/⌘0/⇧⌘F/⌥⌘P/⇧⌘P`；浏览器预览保留全部。`⌘P`、`⌘/`、`w/t/?` 等未进入菜单的快捷键不变。

- [ ] **Step 7: 验证并提交**

Run: `pnpm --filter @branchline/frontend exec vitest run src/menu --reporter=dot && pnpm typecheck && pnpm build`
Expected: PASS。

```bash
git add apps/frontend/src/menu apps/frontend/src/features/preferences apps/frontend/src/App.tsx apps/frontend/src/features/settings/UpdatePanel.tsx apps/frontend/src/i18n/messages
git commit -m "feat(menu): 前端菜单桥、偏好设置对话框与快捷键去重"
```

---

## Phase P3：视觉升级与自动换行

### Task 10：设计令牌与核心组件精修

**Files:**
- Modify: `apps/frontend/src/styles/tokens.css`
- Modify: `apps/frontend/src/styles/components.css`
- Modify: `apps/frontend/src/styles/features.css`
- Modify: `apps/frontend/src/styles/layout.css`
- Modify: `apps/frontend/src/styles/theme-overrides.css`
- Modify: `apps/frontend/src/styles.test.ts`

**Interfaces:**
- 保留旧变量名，新增 `--surface-app/sidebar/content/elevated`、`--border-subtle/border/border-strong`、`--text-primary/secondary/tertiary/inverse`、`--diff-add-bg/diff-del-bg/diff-add-gutter/diff-del-gutter/diff-hunk-bg`
- 字体栈与密度按 spec 7.3

- [ ] **Step 1: 更新样式测试**

把对旧具体值的断言改为令牌存在性/映射断言：

```ts
it('defines the W6 semantic surface scale', () => {
  for (const token of ['--surface-app:', '--surface-sidebar:', '--surface-content:', '--surface-elevated:', '--border-subtle:', '--border:', '--border-strong:', '--text-primary:', '--text-secondary:', '--text-tertiary:', '--diff-add-bg:', '--diff-del-bg:']) {
    expect(tokens).toContain(token)
  }
})

it('keeps legacy aliases mapped to new tokens', () => {
  expect(tokens).toContain('--bg: var(--surface-app);')
  expect(tokens).toContain('--panel: var(--surface-content);')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @branchline/frontend exec vitest run src/styles.test.ts --reporter=dot`
Expected: FAIL — 新令牌不存在。

- [ ] **Step 3: 重写 tokens.css**

暗色示例：

```css
:root {
  color-scheme: dark;
  --surface-app: #151719;
  --surface-sidebar: #1a1d20;
  --surface-content: #202326;
  --surface-elevated: #272b2f;
  --surface-control: #2d3237;
  --surface-hover: #343a40;
  --surface-active: #3b4249;
  --border-subtle: #2b3035;
  --border: #3a4046;
  --border-strong: #4a525a;
  --text-primary: #e8eaed;
  --text-secondary: #a8b0b8;
  --text-tertiary: #7c858e;
  --text-inverse: #141617;
  --accent: #2f81f7;
  --accent-hover: #4a93ff;
  --accent-dim: color-mix(in srgb, var(--accent) 18%, transparent);
  --accent-text: #7ab2ff;
  --success: #3fb950;
  --warning: #d29922;
  --danger: #f85149;
  --danger-solid: #da3633;
  --danger-hover: #f85149;
  --diff-add-bg: color-mix(in srgb, var(--success) 14%, transparent);
  --diff-del-bg: color-mix(in srgb, var(--danger) 14%, transparent);
  --diff-add-gutter: color-mix(in srgb, var(--success) 24%, transparent);
  --diff-del-gutter: color-mix(in srgb, var(--danger) 24%, transparent);
  --diff-hunk-bg: color-mix(in srgb, var(--accent) 12%, transparent);
  --syntax-comment: #8b949e;
  --syntax-keyword: #ff7b72;
  --syntax-string: #a5d6ff;
  --syntax-number: #79c0ff;
  --syntax-type: #ffa657;
  --syntax-function: #d2a8ff;
  --syntax-property: #79c0ff;
  --syntax-tag: #7ee787;
  --syntax-attribute: #ffa657;
  --syntax-operator: #c9d1d9;
  --syntax-punctuation: #8b949e;
  --syntax-meta: #8b949e;
  --syntax-regexp: #a5d6ff;
  --syntax-inserted: #7ee787;
  --syntax-deleted: #ffa198;
  --syntax-invalid: #f85149;
  --font-ui: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Segoe UI", sans-serif;
  --font-code: "SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, monospace;
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 10px;
  --shadow-1: 0 1px 2px rgb(0 0 0 / 30%);
  --shadow-2: 0 8px 24px rgb(0 0 0 / 32%);
  --bg: var(--surface-app);
  --panel: var(--surface-content);
  --panel-2: var(--surface-elevated);
  --panel-3: var(--surface-control);
  --line: var(--border);
  --text: var(--text-primary);
  --muted: var(--text-secondary);
  --faint: var(--text-tertiary);
}
```

`.theme-light` 给出对应浅色值，对比度 ≥ 4.5:1；旧语法变量名映射到新的 `--syntax-*`。

- [ ] **Step 4: 组件精修**

统一按钮高度 24/28/32、segmented 间距 2px、输入框焦点环 `0 0 0 2px var(--accent-dim)`、弹窗圆角 `--radius-lg`、阴影 `--shadow-2`、滚动条 10px、Diff 行高与增删 gutter 使用 `--diff-*-gutter`、空状态图标/文案层级、状态栏 26px。不改布局结构。

- [ ] **Step 5: 验证并提交**

Run: `pnpm --filter @branchline/frontend exec vitest run src/styles.test.ts --reporter=dot && pnpm typecheck && pnpm build`
Expected: PASS。

```bash
git add apps/frontend/src/styles apps/frontend/src/styles.test.ts
git commit -m "style(ui): 升级语义令牌与核心组件视觉"
```

---

### Task 11：自动换行与可变行高虚拟滚动

**Files:**
- Create: `apps/frontend/src/features/diff/wrapModel.ts`
- Create: `apps/frontend/src/features/diff/wrapModel.test.ts`
- Modify: `apps/frontend/src/features/diff/DiffPanel.tsx`
- Modify: `apps/frontend/src/features/diff/DiffPanel.test.ts`
- Modify: `apps/frontend/src/styles/features.css`

**Interfaces:**
- Produces: `countWrappedLines(text, availableWidth, measure, tabSize): number`
- Produces: `buildLineHeights(lines, options): number[]`、`buildOffsets(heights): number[]`、`offsetAtIndex(offsets, index): number`、`indexAtOffset(offsets, offset): number`
- Produces: `useCodeMeasurer(fontFamily, fontSize): (text: string) => number`（DOM 环境 canvas；测试注入假测量器）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { buildLineHeights, buildOffsets, countWrappedLines, indexAtOffset } from './wrapModel'

const measure = (text: string) => text.length * 10

describe('wrapModel', () => {
  it('counts visual lines for long text and explicit newlines', () => {
    expect(countWrappedLines('abcdefghijkl', 100, measure, 4)).toBe(2)
    expect(countWrappedLines('', 100, measure, 4)).toBe(1)
    expect(countWrappedLines('a\tb', 100, measure, 4)).toBe(1)
  })

  it('builds heights with a minimum of one line', () => {
    expect(buildLineHeights(['short', 'aaaaaaaaaaaaaaaaaaaa'], { availableWidth: 100, lineHeight: 20, measure, tabSize: 4 })).toEqual([20, 40])
  })

  it('maps offsets back to indices', () => {
    const offsets = buildOffsets([20, 40, 20])
    expect(offsets).toEqual([0, 20, 60, 80])
    expect(indexAtOffset(offsets, 0)).toBe(0)
    expect(indexAtOffset(offsets, 25)).toBe(1)
    expect(indexAtOffset(offsets, 70)).toBe(2)
    expect(indexAtOffset(offsets, 999)).toBe(2)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @branchline/frontend exec vitest run src/features/diff/wrapModel.test.ts --reporter=dot`
Expected: FAIL。

- [ ] **Step 3: 实现 wrapModel**

```ts
export interface WrapOptions {
  availableWidth: number
  lineHeight: number
  measure: (text: string) => number
  tabSize: number
}

export function countWrappedLines(text: string, availableWidth: number, measure: (text: string) => number, tabSize: number) {
  if (!text) return 1
  const expanded = tabSize > 0 ? text.replaceAll('\t', ' '.repeat(tabSize)) : text
  const width = measure(expanded)
  return Math.max(1, Math.ceil(width / Math.max(1, availableWidth)))
}

export function buildLineHeights(lines: string[], options: WrapOptions) {
  return lines.map((line) => countWrappedLines(line, options.availableWidth, options.measure, options.tabSize) * options.lineHeight)
}

export function buildOffsets(heights: number[]) {
  const offsets = [0]
  heights.forEach((height, index) => offsets.push(offsets[index] + height))
  return offsets
}

export function indexAtOffset(offsets: number[], offset: number) {
  let low = 0
  let high = Math.max(0, offsets.length - 2)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (offsets[mid] <= offset) low = mid
    else high = mid - 1
  }
  return low
}
```

- [ ] **Step 4: DiffPanel 可变行高**

- `const preferences = usePreferences()`；`wrapEnabled = preferences.wordWrap`。
- `measure = useCodeMeasurer(getComputedStyle code font...)`；不可用或未开启换行时按字符数近似。
- 统一视图：`heights = wrapEnabled ? buildLineHeights(unifiedEntries.map(row code), ...) : constant`。
- 并排视图：每对 `max(leftHeight, rightHeight)`。
- 计算 `offsets`、`totalHeight`、`visibleStart/End`：用 `indexAtOffset(offsets, scrollTop - overscanPx)` 等替换 `Math.floor(virtualScrollTop / virtualRowHeight)`。
- 所有 `virtualRowHeight` 引用改为 `heights[index]`；上下 spacer 用 `offsets[virtualStart]` 与 `totalHeight - offsets[virtualEnd]`。
- `blockActionAnchors`、`overviewMarkers`、`scrollToChange`、`jumpSearch` 改用 offsets。
- `!wrapEnabled` 时 heights 全等，行为与改造前一致（现有 DiffPanel 测试必须全绿）。
- CSS：`.code-row, .split-code-side { white-space: pre-wrap; overflow-wrap: anywhere; }` 仅在 `.diff-panel.word-wrap` 下启用；代码字体保持等宽。

- [ ] **Step 5: 验证并提交**

Run: `pnpm --filter @branchline/frontend exec vitest run src/features/diff --reporter=dot && pnpm typecheck && pnpm build`
Expected: PASS，现有滚动/定位测试不回归。

```bash
git add apps/frontend/src/features/diff
git commit -m "feat(diff): 自动换行与可变行高虚拟滚动"
```

---

## Phase P4：全量 i18n 迁移

> 每批统一流程：先用 `pnpm check:i18n` 记录起点；把批次文件中的 JSX 文本、title/aria-label/placeholder、提示消息、错误文案迁移到对应 zh/en 域；运行 `pnpm check:i18n` 确认数量下降；运行测试；提交。每批必须保证 `pnpm typecheck` 通过。

### Task 12：壳层、导航与仓库管理

**Files:**
- `apps/frontend/src/App.tsx`
- `apps/frontend/src/components/CompactSelect.tsx`
- `apps/frontend/src/components/ConfirmDialog.tsx`
- `apps/frontend/src/features/repository/*`（16 个文件）
- 字典：`common.ts`、`nav.ts`、`repository.ts`

- [ ] **Step 1:** 迁移 App 顶栏、侧栏、状态栏、通知、上下文菜单、空状态。
- [ ] **Step 2:** 迁移仓库管理、快速切换、详情、结构树、Worktree、Submodule、ForcePush 对话框。
- [ ] **Step 3:** 日期/时间/数字调用改为 `formatDate/formatRelative/formatNumber`。
- [ ] **Step 4:** 运行 `pnpm check:i18n`、`pnpm typecheck`、相关 vitest；提交：

```bash
git add apps/frontend/src/App.tsx apps/frontend/src/components apps/frontend/src/features/repository apps/frontend/src/i18n/messages
git commit -m "i18n(shell): 迁移壳层、导航与仓库管理文案"
```

### Task 13：历史、图谱、Diff 与文件树

**Files:**
- `features/history/*`、`features/diff/*`、`features/tree/*`、`features/compare/*`
- 字典：`history.ts`、`diff.ts`、`repository.ts`

- [ ] **Step 1:** 迁移提交列表、详情、筛选、搜索摘要、临时提交、相对时间。
- [ ] **Step 2:** 迁移 Diff 工具栏、右键菜单、块操作提示、图片/二进制视图、比较页。
- [ ] **Step 3:** 迁移文件树浏览与提交树。
- [ ] **Step 4:** 验证并提交：

```bash
git add apps/frontend/src/features/history apps/frontend/src/features/diff apps/frontend/src/features/tree apps/frontend/src/features/compare apps/frontend/src/i18n/messages
git commit -m "i18n(history): 迁移历史、Diff、比较与文件树文案"
```

### Task 14：暂存、提交、操作与合并

**Files:**
- `features/staging/*`、`features/operation/*`、`features/merge/*`、`features/branch/*`
- 字典：`stage.ts`、`operation.ts`、`repository.ts`

- [ ] **Step 1:** 迁移暂存页、提交表单、草稿/冲突提示、块操作。
- [ ] **Step 2:** 迁移合并/变基/Cherry-pick/Reset/Revert 对话框与进行中操作面板。
- [ ] **Step 3:** 迁移分支创建与合并队列。
- [ ] **Step 4:** 验证并提交：

```bash
git add apps/frontend/src/features/staging apps/frontend/src/features/operation apps/frontend/src/features/merge apps/frontend/src/features/branch apps/frontend/src/i18n/messages
git commit -m "i18n(operation): 迁移暂存、操作与合并文案"
```

### Task 15：远程、标签、Stash、恢复与搜索

**Files:**
- `features/remote/*`、`features/stash/*`、`features/recovery/*`、`features/search/*`
- 字典：`repository.ts`、`tools.ts`、`operation.ts`

- [ ] **Step 1:** 迁移 Remote/Tag/Worktree 关联操作、报告消息。
- [ ] **Step 2:** 迁移 Stash 列表与操作。
- [ ] **Step 3:** 迁移 Reflog/Bisect/Reset/Recovery。
- [ ] **Step 4:** 迁移深度搜索、替换流程、搜索结果。
- [ ] **Step 5:** 验证并提交：

```bash
git add apps/frontend/src/features/remote apps/frontend/src/features/stash apps/frontend/src/features/recovery apps/frontend/src/features/search apps/frontend/src/i18n/messages
git commit -m "i18n(recovery): 迁移远程、Stash、恢复与搜索文案"
```

### Task 16：设置、凭据、托管、终端、AI、LFS、Gitflow、历史编辑

**Files:**
- `features/settings/*`、`features/credentials/*`、`features/hosting/*`、`features/terminal/*`、`features/ai/*`、`features/lfs/*`、`features/flow/*`、`features/history-edit/*`
- 字典：`settings.ts`、`tools.ts`、`preferences.ts`

- [ ] **Step 1:** 迁移各面板标题、按钮、空状态、表单校验、提示消息。
- [ ] **Step 2:** 迁移终端菜单/快捷键提示、命令流水线；AI 提交消息状态；LFS/Gitflow 引导。
- [ ] **Step 3:** 验证并提交：

```bash
git add apps/frontend/src/features apps/frontend/src/i18n/messages
git commit -m "i18n(tools): 迁移设置、集成、终端与工作流文案"
```

### Task 17：基线归零与断言更新

**Files:**
- `scripts/i18n-baseline.json`
- `apps/frontend/src/styles.test.ts`
- 任何仍含中文的 `*.ts(x)`

- [ ] **Step 1:** 运行 `pnpm check:i18n` 找出剩余计数；逐文件清理（技术字符串加 `// i18n-allow`）。
- [ ] **Step 2:** 把 `styles.test.ts` 中的中文源码字符串断言替换为字典键/组件行为断言，例如：

```ts
it('localizes the committer filter', () => {
  expect(zh['history.filter.committer']).toBe('提交人（可多选）')
  expect(en['history.filter.committer']).toBe('Committers (multi-select)')
  expect(app).toContain("t('history.filter.committer')")
})
```

- [ ] **Step 3:** 运行 `pnpm check:i18n:update`，确认 baseline `total` 为 0；`pnpm check:i18n` 输出 OK。
- [ ] **Step 4:** 运行全套前端测试并提交：

```bash
git add scripts/i18n-baseline.json apps/frontend/src
git commit -m "i18n: 完成全量迁移并清零硬编码中文基线"
```

---

## Phase P5：后端错误与提示本地化

### Task 18：Rust CommandError 与命令分类

**Files:**
- Create: `apps/desktop/src/error.rs`
- Modify: `apps/desktop/src/lib.rs`
- Modify: `apps/desktop/src/commands.rs`（按命令组接入）
- Modify: 各 `git_*.rs` 的 `Err(String)` 入口（按命令组渐进）
- Create: `apps/desktop/src/error.test.rs` 或 `error.rs` 内联测试

**Interfaces:**
- Produces: `CommandError { code: String, params: BTreeMap<String,String>, detail: Option<String> }`
- Produces: `CommandError::new(code)`、`.param(key, value)`、`.detail(message)`、`From<git error>`
- 命令宏 `Result<T, CommandError>`

- [ ] **Step 1: 写失败测试**

```rust
#[test]
fn serializes_structured_errors() {
    let error = CommandError::new("git.fetch.failed").param("remote", "origin").detail("fatal");
    let value = serde_json::to_value(&error).unwrap();
    assert_eq!(value["code"], "git.fetch.failed");
    assert_eq!(value["params"]["remote"], "origin");
    assert_eq!(value["detail"], "fatal");
}

#[test]
fn classifies_common_git_failures() {
    assert_eq!(classify("fatal: not a git repository"), "repository.notGit");
    assert_eq!(classify("! [rejected] main -> main (non-fast-forward)"), "git.push.nonFastForward");
    assert_eq!(classify("CONFLICT (content): Merge conflict in a.ts"), "git.conflict");
}
```

- [ ] **Step 2: 运行确认失败**

Run: `CARGO_TARGET_DIR=/Users/yimiliya/github/mySmartGit/apps/desktop/target cargo test --manifest-path apps/desktop/Cargo.toml error:: --quiet`
Expected: FAIL。

- [ ] **Step 3: 实现 error.rs**

```rust
use std::collections::BTreeMap;
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub params: BTreeMap<String, String>,
    pub detail: Option<String>,
}

impl CommandError {
    pub fn new(code: impl Into<String>) -> Self { Self { code: code.into(), params: BTreeMap::new(), detail: None } }
    pub fn param(mut self, key: impl Into<String>, value: impl Into<String>) -> Self { self.params.insert(key.into(), value.into()); self }
    pub fn detail(mut self, value: impl Into<String>) -> Self { self.detail = Some(value.into()); self }
}

pub fn classify(message: &str) -> &'static str {
    let lower = message.to_lowercase();
    if lower.contains("not a git repository") { return "repository.notGit" }
    if lower.contains("non-fast-forward") || lower.contains("fetch first") { return "git.push.nonFastForward" }
    if lower.contains("conflict") { return "git.conflict" }
    if lower.contains("authentication failed") || lower.contains("permission denied (publickey)") { return "git.auth.failed" }
    if lower.contains("could not resolve host") || lower.contains("network is unreachable") { return "git.network" }
    if lower.contains("already exists") { return "git.branch.exists" }
    if lower.contains("local changes") || lower.contains("would be overwritten") { return "git.worktree.dirty" }
    if lower.contains("lfs") && lower.contains("not") { return "git.lfs.missing" }
    "git.unknown"
}
```

`invoke` 错误类型统一为 `CommandError`，旧 `map_err(|e| e.to_string())` 改为 `map_err(|e| CommandError::new("git.fetch.failed").detail(e.to_string()))` 等命令级默认 code。`impl From<CommandError> for String` 不必提供；前端包装器兼容字符串。

- [ ] **Step 4: 字典与校验**

在 `errors.ts` 两语字典加入 `errors.repository.notGit`、`errors.git.push.nonFastForward`、`errors.git.conflict`、`errors.git.auth.failed`、`errors.git.network`、`errors.git.branch.exists`、`errors.git.worktree.dirty`、`errors.git.lfs.missing`、`errors.git.unknown`、`errors.desktopOnly`。运行 `pnpm check:error-codes` 必须通过。

- [ ] **Step 5: 验证并提交**

Run: `CARGO_TARGET_DIR=/Users/yimiliya/github/mySmartGit/apps/desktop/target cargo test --manifest-path apps/desktop/Cargo.toml --quiet && pnpm check:error-codes && pnpm typecheck`
Expected: PASS。

```bash
git add apps/desktop/src apps/frontend/src/i18n/messages
git commit -m "feat(errors): 后端返回结构化错误码与诊断详情"
```

### Task 19：前端错误呈现与技术详情

**Files:**
- Modify: `apps/frontend/src/App.tsx`（通知、错误条）
- Modify: `apps/frontend/src/components/ConfirmDialog.tsx`（如承载错误）
- Modify: `apps/frontend/src/features/*` 中 `setNotice(String(reason))` 调用点（按批替换为 `errorPresentation`）
- Create: `apps/frontend/src/components/ErrorNotice.tsx`
- Create: `apps/frontend/src/components/ErrorNotice.test.tsx`

**Interfaces:**
- Consumes: `errorPresentation(error, t)`
- Produces: `ErrorNotice({ error, onDismiss })` 渲染本地化摘要 + 可展开“技术详情”

- [ ] **Step 1: 写失败测试**

```tsx
import { renderToStaticMarkup } from 'react-dom/server'
import { ErrorNotice } from './ErrorNotice'

it('renders a localized summary and technical detail', () => {
  const html = renderToStaticMarkup(<ErrorNotice message="拉取失败" detail="fatal: could not read from remote" onDismiss={() => {}}/>)
  expect(html).toContain('拉取失败')
  expect(html).toContain('技术详情')
})
```

- [ ] **Step 2: 实现与替换**

`ErrorNotice` 使用 `<details><summary>{t('errors.technicalDetail')}</summary><pre>{detail}</pre></details>`。把通知状态从 `string` 扩展为 `{ message: string; detail?: string }`（保留 string 兼容），所有 catch 用 `errorPresentation(reason, t)`，不再 `String(reason)`。

- [ ] **Step 3: 验证并提交**

Run: `pnpm --filter @branchline/frontend exec vitest run src/components/ErrorNotice.test.tsx --reporter=dot && pnpm typecheck`
Expected: PASS。

```bash
git add apps/frontend/src/components apps/frontend/src/App.tsx apps/frontend/src/features apps/frontend/src/i18n/messages
git commit -m "feat(errors): 通知展示本地化摘要与可展开技术详情"
```

---

## Phase P6：交付

### Task 20：文档、全量验证、打包与合并

**Files:**
- Modify: `README.md`
- Create: `docs/shortcuts.md`
- Modify: `apps/frontend/src/features/settings/ShortcutOverlay.tsx`（若存在独立组件则同步）

- [ ] **Step 1: 更新文档**

README 增加：中英文切换、偏好设置入口、原生菜单结构、高亮支持语言清单、错误详情说明。`docs/shortcuts.md` 列出 macOS/Windows 快捷键表（与菜单 accelerator 一致）。

- [ ] **Step 2: 全量验证**

```bash
pnpm check:i18n
pnpm check:error-codes
pnpm typecheck
pnpm --filter @branchline/frontend exec vitest run --reporter=dot
CARGO_TARGET_DIR=/Users/yimiliya/github/mySmartGit/apps/desktop/target cargo test --manifest-path apps/desktop/Cargo.toml --quiet
pnpm build
```

Expected: 全部通过；i18n baseline 0；错误码校验通过；前端测试全绿；Rust 测试 0 failed。

- [ ] **Step 3: 打包**

```bash
pnpm desktop:build
```

Expected: 产出 DMG、`.app.tar.gz` 与 `.sig`。记录 DMG 体积，与 W5 产物对比，确认 `language-data` 增量在可接受范围。

- [ ] **Step 4: 启动冒烟**

打开打包后的 App：切换中英文、检查全部菜单 enabled/checked、打开仓库、Diff 换行/字号/布局、打开一个 Python 冲突文件确认高亮与块按钮文案。若无法自动操作，记录人工检查项并明确未验证部分。

- [ ] **Step 5: 提交与合并**

```bash
git add README.md docs
git commit -m "docs: 补充多语言、菜单与高亮使用说明"
cd /Users/yimiliya/github/mySmartGit
git merge --no-ff track/w6-polish -m "merge(w6): 完善多语言、原生菜单、视觉与全语言高亮"
```

合并必须在主工作区执行（linked worktree 不能 checkout 已被主工作区占用的 `master`）。合并前确认 worktree 无未提交变更；合并后运行一次 `pnpm typecheck` 与前端测试。

---

## Self-Review 检查表

- 规格 4.1 字典组织 → Task 1。
- 规格 4.2 迁移与覆盖 → Task 2、Task 12-17。
- 规格 4.3 错误架构 → Task 4、Task 18、Task 19。
- 规格 4.4 菜单双语 → Task 8、Task 9。
- 规格 5.1/5.2 菜单结构与状态 → Task 8。
- 规格 5.3 PreferencesDialog → Task 9。
- 规格 6.1-6.5 高亮 → Task 5-7、Task 10（token 样式）。
- 规格 7.1-7.6 视觉/换行/可访问性 → Task 10、Task 11。
- 规格 8 测试与验收 → 每个 Task + Task 20。
- 规格 9 风险缓解 → baseline 只减不增、错误集中包装、单一菜单桥、可变行高先测高度。
