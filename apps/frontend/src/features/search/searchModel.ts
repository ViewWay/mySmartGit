type Translate = (key: string, params?: Record<string, string | number>) => string

import type {
  CommitSearchQuery,
  CommitSearchTarget,
  TextSearchQuery,
} from '../../repository'

/**
 * 深度搜索的纯逻辑层：把 UI 表单状态翻译成后端查询，把分页游标与「第 N/M 个」
 * 的算术集中在这里，组件只负责装配。
 *
 * 三条硬性约定（与后端 git_search.rs 一一对应）：
 * 1. 所有上限都是**防御性截断**：后端 `truncated=true` 时 UI 必须显式提示，
 *    绝不把「已索引条数」当「全部命中数」显示。
 * 2. 搜索是重查询：同一时刻只允许一次在跑，新搜索必须让旧搜索的响应作废（见 createSearchGate）。
 * 3. 正则交给 Git 自身处理，前端只做非空与长度校验，绝不自己拼命令。
 */

export const COMMIT_PAGE_SIZE = 100
export const TEXT_PAGE_SIZE = 200
/** 与后端 PATTERN_MAX_CHARS 一致；前端先挡一道，避免无谓的往返。 */
export const MAX_PATTERN_CHARS = 1000
/** 与后端 DEFAULT_TEXT_MAX_MATCHES 一致。 */
export const DEFAULT_MAX_MATCHES = 2000

export type CommitSearchForm = {
  pattern: string
  target: CommitSearchTarget
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
  /** 多行/逗号分隔的原始输入，由 parseReferenceList 拆分。 */
  revisions: string
  paths: string
  excludePaths: string
  maxCommits?: number | null
  pageSize?: number
}

export type TextSearchForm = {
  pattern: string
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
  /** 空字符串表示工作区。 */
  revision: string
  includes: string
  excludePaths: string
  contextLines?: number
  maxMatches?: number | null
  pageSize?: number
}

export const defaultCommitSearchForm = (): CommitSearchForm => ({
  pattern: '',
  target: 'commitMessage',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  revisions: '',
  paths: '',
  excludePaths: '',
  maxCommits: null,
  pageSize: COMMIT_PAGE_SIZE,
})

export const defaultTextSearchForm = (): TextSearchForm => ({
  pattern: '',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  revision: '',
  includes: '',
  excludePaths: '',
  contextLines: 2,
  maxMatches: DEFAULT_MAX_MATCHES,
  pageSize: TEXT_PAGE_SIZE,
})

/** 拆分路径/引用输入：支持换行、逗号、空格混合分隔，忽略空项。 */
export function parseList(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

/**
 * 表单校验：返回人类可读的错误文案，null 表示可以发起请求。
 * 只做「明显不该发出去」的拦截，语义合法性由后端二次校验（单一事实源）。
 */
export function validatePattern(pattern: string, t: Translate): string | null {
  const trimmed = pattern.trim()
  if (!trimmed) return t('search.inputRequired')
  if (trimmed.length > MAX_PATTERN_CHARS) return t('search.patternTooLong', { count: MAX_PATTERN_CHARS })
  if (/[\r\n]/.test(pattern)) return t('search.noNewlines')
  return null
}

export function buildCommitSearchQuery(form: CommitSearchForm, offset = 0, t?: Translate): CommitSearchQuery {
  return {
    pattern: form.pattern.trim(),
    target: form.target,
    caseSensitive: form.caseSensitive,
    wholeWord: form.wholeWord,
    regex: form.regex,
    revisions: parseList(form.revisions),
    paths: parseList(form.paths),
    excludePaths: parseList(form.excludePaths),
    maxCommits: form.maxCommits ?? null,
    pageSize: form.pageSize ?? COMMIT_PAGE_SIZE,
    offset,
  }
}

export function buildTextSearchQuery(form: TextSearchForm, offset = 0, t?: Translate): TextSearchQuery {
  return {
    pattern: form.pattern.trim(),
    caseSensitive: form.caseSensitive,
    wholeWord: form.wholeWord,
    regex: form.regex,
    revision: form.revision.trim() || null,
    includes: parseList(form.includes),
    excludePaths: parseList(form.excludePaths),
    contextLines: form.contextLines ?? 2,
    maxMatches: form.maxMatches ?? DEFAULT_MAX_MATCHES,
    pageSize: form.pageSize ?? TEXT_PAGE_SIZE,
    offset,
  }
}

// ---------------------------------------------------------------------------
// 分页游标：offset 是唯一游标，页码一律由 offset/pageSize 推导，不单独维护状态，
// 因此不可能出现「页码与 offset 各自漂移」导致的重复或漏项。
// ---------------------------------------------------------------------------

export type PageCursor = {
  offset: number
  pageSize: number
  total: number
}

export function totalPages(cursor: PageCursor): number {
  if (cursor.total <= 0) return 0
  const size = cursor.pageSize > 0 ? cursor.pageSize : 1
  return Math.ceil(cursor.total / size)
}

export function currentPage(cursor: PageCursor): number {
  const size = cursor.pageSize > 0 ? cursor.pageSize : 1
  return Math.floor(Math.max(0, cursor.offset) / size) + 1
}

/** 越界一律收敛到合法区间：后端对超范围 offset 返回空页，这里不让 UI 卡死。 */
export function clampOffset(offset: number, total: number, pageSize: number): number {
  if (pageSize <= 0) return 0
  if (total <= 0) return 0
  const last = Math.floor((total - 1) / pageSize) * pageSize
  return Math.min(Math.max(0, offset), last)
}

export function goNextPage(cursor: PageCursor): number {
  const size = cursor.pageSize > 0 ? cursor.pageSize : 1
  const next = cursor.offset + size
  return next >= cursor.total ? cursor.offset : next
}

export function goPrevPage(cursor: PageCursor): number {
  const size = cursor.pageSize > 0 ? cursor.pageSize : 1
  return Math.max(0, cursor.offset - size)
}

export function goLastPage(cursor: PageCursor): number {
  return clampOffset((Math.max(0, totalPages(cursor) - 1)) * (cursor.pageSize || 1), cursor.total, cursor.pageSize)
}

/** 结果区间文案，例如「显示 201-300 / 共 1234 条」。 */
export function rangeLabel(cursor: PageCursor, loadedCount: number, t: Translate): string {
  if (cursor.total === 0) return t('search.noHitsShort')
  const start = cursor.offset + 1
  const end = cursor.offset + Math.max(loadedCount, 0)
  return t('search.rangeLabel', { start, end, total: cursor.total })
}

/** 「第 N/M 个」定位文案；越界或空结果返回 null，由调用方显示空态。 */
export function matchPosition(total: number, offset: number, indexWithinPage: number): { current: number; total: number } | null {
  if (total <= 0) return null
  const current = offset + indexWithinPage + 1
  if (current > total) return null
  return { current, total }
}

// ---------------------------------------------------------------------------
// 有界性与取消的展示语义
// ---------------------------------------------------------------------------

/**
 * 结果横幅：把后端的 truncated/cancelled 翻译成不能被关闭的提醒。
 * 返回 null 表示结果完整，无需提示。
 */
export function resultBanner(page: {
  truncated: boolean
  cancelled: boolean
  notice?: string | null
}, t: Translate): string | null {
  if (page.cancelled) return page.notice ?? t('search.cancelledIncomplete')
  if (page.truncated) return page.notice ?? t('search.truncatedHits')
  return page.notice ?? null
}

/**
 * 截断时 `total` 只代表「已索引条数」，不能显示成「共 N 条」。
 * 这个函数给出用于渲染的总数措辞。
 */
export function totalLabel(page: { total: number; truncated: boolean }, t: Translate): string {
  return page.truncated ? t('search.indexedTruncated', { count: page.total }) : t('search.totalLabel', { count: page.total })
}

/** 提交搜索目标的展示名，供下拉与结果说明复用。 */
const COMMIT_TARGET_KEYS: Record<CommitSearchTarget, string> = {
  commitMessage: 'search.mode.message',
  commitAuthor: 'search.mode.author',
  commitHash: 'search.mode.hash',
  diffPickaxe: 'search.mode.pickaxe',
  diffRegex: 'search.mode.diffRegex',
}

export function commitTargetLabel(target: CommitSearchTarget, t: Translate): string {
  return t(COMMIT_TARGET_KEYS[target])
}

/** pickaxe 与 -G 的语义差别必须在界面上讲清楚，否则用户会把两者当同一种搜索。 */
const COMMIT_TARGET_HINT_KEYS: Record<CommitSearchTarget, string> = {
  commitMessage: 'search.mode.messageHint',
  commitAuthor: 'search.mode.authorHint',
  commitHash: 'search.mode.hashHint',
  diffPickaxe: 'search.mode.pickaxeHint',
  diffRegex: 'search.mode.diffRegexHint',
}

export function commitTargetHint(target: CommitSearchTarget, t: Translate): string {
  return t(COMMIT_TARGET_HINT_KEYS[target])
}

/**
 * 请求闸门：保证「后发起的请求才算数」。
 * 深度搜索是重查询，用户连续改关键字时若不做代际隔离，先发的慢请求会覆盖后发的快请求，
 * 表现为「结果和输入框对不上」。这里用一个自增令牌把过期响应显式丢弃。
 */
export function createSearchGate() {
  let token = 0
  return {
    /** 开启新一代请求，返回本次令牌；调用方完成时把它交给 isCurrent。 */
    begin(): number {
      token += 1
      return token
    },
    isCurrent(candidate: number): boolean {
      return candidate === token
    },
    /** 作废当前代：切换仓库/关闭面板时调用，配合后端 cancel_repository_search。 */
    invalidate(): void {
      token += 1
    },
    current(): number {
      return token
    },
  }
}

/** 目标是否需要差异搜索参数（差异类目标配合路径范围最有价值）。 */
export function isDiffTarget(target: CommitSearchTarget): boolean {
  return target === 'diffPickaxe' || target === 'diffRegex'
}

/** 差异内容搜索时正则开关的措辞差异（-S 走 --pickaxe-regex，-G 本身就是正则）。 */
export function regexSwitchLabel(target: CommitSearchTarget, t: Translate): string {
  if (target === 'diffPickaxe') return t('search.pickaxeRegex')
  if (target === 'diffRegex') return t('search.diffRegexFlag')
  return t('search.regexEngineNote')
}
