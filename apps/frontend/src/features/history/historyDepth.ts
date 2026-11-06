import type { FileHistoryEntry, RepositoryCommit, RepositoryHistoryPage } from '../../repository'

/**
 * W3-3 游标式增量分页：历史深度模型从「扩大单次读取上限（2000→×5→10000→20000）」
 * 重写为「按流会话游标续取」。旧的 nextHistoryLoadLimit 机制已整体删除，
 * 不要再引入第二套上限扩展逻辑。
 *
 * 数据契约（后端 git.rs HistoryStream）：
 * - 一个 sessionId = 一个持续读取中的 `git log` 进程快照；
 * - 翻页只追加尾部，已发行条目永不因并发新提交而变化（游标稳定）；
 * - `hasMore=false` 且会话结束即全量读完，没有“上限到了”这种伪终点。
 */

/** 每页取回条数（IPC 受条数+字节双上限约束，超限记录留到下一页，不丢数据）。 */
export const HISTORY_PAGE_SIZE = 500

/** 距列表底部还剩这么多“未加载行”时触发续页（窗口化渲染前提下的预取水位）。 */
export const HISTORY_PREFETCH_ROWS = 12

export type HistoryStreamState = {
  /** 当前流会话；null 表示未开始或已取消。 */
  sessionId: string | null
  /** 会话累计已发出条数 = 前端已合并条数（剪枝条目除外）。 */
  emitted: number
  hasMore: boolean
  loading: boolean
  /** 后端显式截断标记（超长标题/正文），必须透出给用户，不得静默。 */
  truncated: boolean
  notice: string | null
  /** 失效代数：切仓库/换分支/重开视图时 +1，用于丢弃过期响应。 */
  generation: number
}

export function initialHistoryStreamState(generation = 0): HistoryStreamState {
  return {
    sessionId: null,
    emitted: 0,
    hasMore: true,
    loading: false,
    truncated: false,
    notice: null,
    generation,
  }
}

/** 发起新一轮流（切仓库/换分支后必须先 bumpGeneration 再开新流）。 */
export function beginHistoryStream(page: RepositoryHistoryPage): HistoryStreamState {
  return historyStateFromPage(page, 0)
}

export function historyStateFromPage(page: RepositoryHistoryPage, generation: number): HistoryStreamState {
  return {
    sessionId: page.sessionId,
    emitted: page.emitted,
    hasMore: page.hasMore,
    loading: false,
    truncated: page.truncated,
    notice: page.notice ?? null,
    generation,
  }
}

/**
 * 合并一页：游标推进 + 尾部追加。防御性去重（按 fullHash）——正常情况下
 * 后端流不重不漏，但并发请求乱序到达时绝不允许同一提交进两次列表。
 * 前缀不变式：已发行条目保持原顺序与内容（跨页 lane 一致性的前端前提，
 * buildCommitGraphLayout 依赖“整列是全量 log 序列的前缀”这一性质）。
 */
export function mergeHistoryPage(existing: RepositoryCommit[], page: RepositoryHistoryPage): RepositoryCommit[] {
  if (page.kind !== 'graph') return existing
  const seen = new Set(existing.map((commit) => commit.fullHash))
  const appended = page.commits.filter((commit) => !seen.has(commit.fullHash))
  return appended.length ? [...existing, ...appended] : existing
}

/** 续页后的状态推进：只接受与当前会话/代数匹配的页，过期页原样返回状态。 */
export function historyStateAfterPage(state: HistoryStreamState, page: RepositoryHistoryPage): HistoryStreamState {
  if (state.sessionId !== page.sessionId) return state
  if (page.emitted < state.emitted) return state
  return {
    ...state,
    emitted: page.emitted,
    hasMore: page.hasMore,
    loading: false,
    truncated: state.truncated || page.truncated,
    notice: page.notice ?? state.notice,
  }
}

/** 请求代次守卫：代次不一致（切仓库/换分支后）必须丢弃响应并取消旧流。 */
export function isStaleHistoryRequest(state: HistoryStreamState, requestGeneration: number) {
  return state.generation !== requestGeneration
}

/**
 * 是否需要续页：滚动位置进入预取水位。
 * loadedRows=已加载行数，totalRows=后端已确认（emitted）行数下限——
 * 判定只看「可见底部距已加载尾部不足 HISTORY_PREFETCH_ROWS 行」。
 */
export function shouldPrefetchHistory(args: {
  state: HistoryStreamState
  lastVisibleRowIndex: number
}): boolean {
  const { state, lastVisibleRowIndex } = args
  if (!state.hasMore || state.loading || !state.sessionId) return false
  return lastVisibleRowIndex >= state.emitted - HISTORY_PREFETCH_ROWS
}

/** 换仓库/换分支/重新打开视图：递增代次并清空旧会话引用。 */
export function invalidateHistoryStream(state: HistoryStreamState): HistoryStreamState {
  return {
    ...initialHistoryStreamState(state.generation + 1),
    loading: false,
  }
}

/** 标记“正在取下一页”，防止滚动重复触发并发续页。 */
export function markHistoryLoading(state: HistoryStreamState): HistoryStreamState {
  if (!state.sessionId || !state.hasMore || state.loading) return state
  return { ...state, loading: true }
}

/**
 * 文件/行历史流的条目合并（HistoryDrawer 用）：与图谱同款契约——
 * 尾部追加、前缀不变、按 hash 防御性去重。
 */
export function mergeHistoryEntries(existing: FileHistoryEntry[], page: RepositoryHistoryPage): FileHistoryEntry[] {
  if (page.kind !== 'file' && page.kind !== 'line') return existing
  const seen = new Set(existing.map((entry) => entry.hash))
  const appended = page.entries.filter((entry) => !seen.has(entry.hash))
  return appended.length ? [...existing, ...appended] : existing
}
