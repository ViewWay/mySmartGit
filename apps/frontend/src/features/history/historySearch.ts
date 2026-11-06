export type HistorySearchMode = 'locate' | 'filter'

export type HistorySearchSummary = {
  current: number
  total: number
}

export type HistorySearchCommit = {
  id: string
  fullHash?: string
  title?: string
  author?: string
}

function normalizedQuery(query: string) {
  return query.trim().toLocaleLowerCase()
}

export function commitMatchesQuery(commit: HistorySearchCommit, query: string) {
  const normalized = normalizedQuery(query)
  if (!normalized) return true
  return `${commit.title ?? ''} ${commit.fullHash ?? commit.id} ${commit.author ?? ''}`
    .toLocaleLowerCase()
    .includes(normalized)
}

export function matchingCommitIds<T extends HistorySearchCommit>(commits: T[], query: string) {
  if (!normalizedQuery(query)) return []
  return commits.filter((commit) => commitMatchesQuery(commit, query)).map((commit) => commit.id)
}

export function visibleHistoryCommits<T extends HistorySearchCommit>(
  commits: T[],
  query: string,
  mode: HistorySearchMode,
) {
  if (mode === 'locate' || !normalizedQuery(query)) return commits
  return commits.filter((commit) => commitMatchesQuery(commit, query))
}

export function nextSearchMatch(matches: string[], selected: string, direction: 1 | -1) {
  if (!matches.length) return null
  const currentIndex = matches.indexOf(selected)
  if (currentIndex < 0) return direction === 1 ? matches[0] : matches[matches.length - 1]
  return matches[(currentIndex + direction + matches.length) % matches.length]
}

export function retainUnchangedSearchSummary(current: HistorySearchSummary, next: HistorySearchSummary) {
  return current.current === next.current && current.total === next.total ? current : next
}

// ---------------------------------------------------------------------------
// W3-3 服务端搜索驱动：全量历史搜索消费 git_search 轨道的后端分页
// （search_commits / load_commit_search_page），不再在前端已加载数组里过滤。
// 上面的 commitMatchesQuery/matchingCommitIds 只保留给「locate 定位已加载行」
// 的视口功能；filter 模式的历史范围判定一律走后端。
// ---------------------------------------------------------------------------

/** git_search 后端分页的最小结构投影（类型来自 repository，不重复实现协议）。 */
export type ServerSearchPageLike = {
  searchId: string
  total: number
  offset: number
  pageSize: number
  hasMore: boolean
  truncated: boolean
  cancelled: boolean
  notice?: string | null
}

export type ServerSearchState<TItem> = {
  searchId: string | null
  items: TItem[]
  /** 下一个待取 offset = items.length（后端 offset 语义）。 */
  nextOffset: number
  total: number
  hasMore: boolean
  loading: boolean
  truncated: boolean
  cancelled: boolean
  notice: string | null
  generation: number
}

export function initialServerSearchState<TItem>(generation = 0): ServerSearchState<TItem> {
  return {
    searchId: null,
    items: [],
    nextOffset: 0,
    total: 0,
    hasMore: false,
    loading: false,
    truncated: false,
    cancelled: false,
    notice: null,
    generation,
  }
}

export function serverSearchStateFromPage<TItem>(
  page: ServerSearchPageLike & { items: TItem[] },
  generation: number,
): ServerSearchState<TItem> {
  return {
    searchId: page.searchId,
    items: page.items,
    nextOffset: page.offset + page.items.length,
    total: page.total,
    hasMore: page.hasMore,
    loading: false,
    truncated: page.truncated,
    cancelled: page.cancelled,
    notice: page.notice ?? null,
    generation,
  }
}

/**
 * 续页合并：防御性按 keyOf 去重（并发乱序到达时绝不重复），
 * 且只接受同一 searchId 的页——searchId 变了说明后端重扫，旧页必须丢弃。
 */
export function serverSearchStateAfterPage<TItem>(
  state: ServerSearchState<TItem>,
  page: ServerSearchPageLike & { items: TItem[] },
  keyOf: (item: TItem) => string,
): ServerSearchState<TItem> {
  if (state.searchId !== null && state.searchId !== page.searchId) return state
  if (page.cancelled) return { ...state, loading: false, cancelled: true }
  const seen = new Set(state.items.map(keyOf))
  const appended = page.items.filter((item) => !seen.has(keyOf(item)))
  const items = appended.length ? [...state.items, ...appended] : state.items
  return {
    ...state,
    searchId: page.searchId,
    items,
    nextOffset: Math.max(state.nextOffset, page.offset + page.items.length),
    total: Math.max(page.total, items.length),
    hasMore: page.hasMore,
    loading: false,
    truncated: state.truncated || page.truncated,
    notice: page.notice ?? state.notice,
  }
}

export function shouldLoadMoreServerSearch<TItem>(state: ServerSearchState<TItem>) {
  return Boolean(state.searchId) && state.hasMore && !state.loading && !state.cancelled
}

export function isStaleServerSearch<TItem>(state: ServerSearchState<TItem>, requestGeneration: number) {
  return state.generation !== requestGeneration
}

/**
 * 可注入的搜索传输（默认实现由 App 接线时传入 git-client 的 searchCommits /
 * loadCommitSearchPage / cancelRepositorySearch；测试注入桩件，不发真实 IPC）。
 */
export type CommitSearchTransport<TQuery, TPage, TItem> = {
  search: (repositoryPath: string, query: TQuery) => Promise<TPage>
  loadPage: (repositoryPath: string, searchId: string, offset: number, pageSize: number) => Promise<TPage>
  cancel: (repositoryPath: string) => Promise<unknown>
}

/**
 * 发起/替换一次服务端搜索：新一轮查询先 cancel 旧任务（切仓库/换分支同理），
 * 再交 search_commits 建索引取首页。被后端标记 cancelled 的过期页返回 null。
 */
export async function startServerCommitSearch<TQuery, TPage extends ServerSearchPageLike & { items: TItem[] }, TItem>(
  transport: CommitSearchTransport<TQuery, TPage, TItem>,
  repositoryPath: string,
  query: TQuery,
): Promise<TPage | null> {
  await transport.cancel(repositoryPath)
  const page = await transport.search(repositoryPath, query)
  return page.cancelled ? null : page
}

/** 续取下一页：offset 严格用已合并条数，杜绝「前端过滤已加载数组」造成的漏项。 */
export async function continueServerCommitSearch<TQuery, TPage extends ServerSearchPageLike & { items: TItem[] }, TItem>(
  transport: CommitSearchTransport<TQuery, TPage, TItem>,
  repositoryPath: string,
  state: ServerSearchState<TItem>,
  pageSize: number,
): Promise<TPage | null> {
  if (!state.searchId || !shouldLoadMoreServerSearch(state)) return null
  const page = await transport.loadPage(repositoryPath, state.searchId, state.nextOffset, pageSize)
  return page.cancelled ? null : page
}
