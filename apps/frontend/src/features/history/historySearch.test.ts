import { describe, expect, it } from 'vitest'
import { commitMatchesQuery, matchingCommitIds, nextSearchMatch, retainUnchangedSearchSummary, visibleHistoryCommits } from './historySearch'
import {
  continueServerCommitSearch,
  initialServerSearchState,
  serverSearchStateAfterPage,
  serverSearchStateFromPage,
  shouldLoadMoreServerSearch,
  startServerCommitSearch,
  type CommitSearchTransport,
  type ServerSearchPageLike,
} from './historySearch'

const commits = [
  { id: 'a1', fullHash: 'aaaa1111', title: 'Prepare release', author: 'Alice' },
  { id: 'b2', fullHash: 'bbbb2222', title: 'Fix login flow', author: 'Bob' },
  { id: 'c3', fullHash: 'cccc3333', title: 'Update docs', author: 'Chen' },
]

describe('history search', () => {
  it('matches title, hash, and author without case sensitivity', () => {
    expect(commitMatchesQuery(commits[1], 'LOGIN')).toBe(true)
    expect(commitMatchesQuery(commits[1], 'bbbb')).toBe(true)
    expect(commitMatchesQuery(commits[1], 'bob')).toBe(true)
    expect(commitMatchesQuery(commits[1], 'missing')).toBe(false)
  })

  it('keeps graph context in locate mode and filters only in filter mode', () => {
    expect(visibleHistoryCommits(commits, 'fix', 'locate')).toEqual(commits)
    expect(visibleHistoryCommits(commits, 'fix', 'filter').map(({ id }) => id)).toEqual(['b2'])
    expect(matchingCommitIds(commits, 'fix')).toEqual(['b2'])
  })

  it('navigates matches circularly in both directions', () => {
    expect(nextSearchMatch(['a1', 'b2'], 'b2', 1)).toBe('a1')
    expect(nextSearchMatch(['a1', 'b2'], 'a1', -1)).toBe('b2')
    expect(nextSearchMatch(['a1', 'b2'], 'missing', 1)).toBe('a1')
    expect(nextSearchMatch([], 'a1', 1)).toBeNull()
  })

  it('reuses an unchanged search summary to avoid another parent render', () => {
    const current = { current: 0, total: 0 }
    expect(retainUnchangedSearchSummary(current, { current: 0, total: 0 })).toBe(current)
    expect(retainUnchangedSearchSummary(current, { current: 1, total: 2 })).toEqual({ current: 1, total: 2 })
  })
})

type Hit = { hash: string; title: string }
type StubPage = ServerSearchPageLike & { items: Hit[] }

function stubPage(overrides: Partial<StubPage>): StubPage {
  return {
    searchId: 'search-1',
    total: 10,
    offset: 0,
    pageSize: 2,
    hasMore: false,
    truncated: false,
    cancelled: false,
    notice: null,
    items: [],
    ...overrides,
  }
}

function keyOf(item: Hit) {
  return item.hash
}

describe('server-driven commit search (W3-3, consumes git_search pagination)', () => {
  it('merges backend pages with monotonically advancing offsets', () => {
    const first = stubPage({ items: [{ hash: 'a', title: 'A' }, { hash: 'b', title: 'B' }], offset: 0, hasMore: true })
    let state = serverSearchStateFromPage(first, 0)
    expect(state.nextOffset).toBe(2)
    const second = stubPage({ items: [{ hash: 'c', title: 'C' }], offset: 2, hasMore: false, total: 3 })
    state = serverSearchStateAfterPage(state, second, keyOf)
    expect(state.items.map((item) => item.hash)).toEqual(['a', 'b', 'c'])
    expect(state.hasMore).toBe(false)
    expect(shouldLoadMoreServerSearch(state)).toBe(false)
  })

  it('dedupes overlapping items and refuses pages from a rescanned searchId', () => {
    const state = serverSearchStateFromPage(stubPage({ items: [{ hash: 'a', title: 'A' }], hasMore: true }), 0)
    const overlapping = serverSearchStateAfterPage(state, stubPage({ items: [{ hash: 'a', title: 'A' }, { hash: 'b', title: 'B' }], offset: 1 }), keyOf)
    expect(overlapping.items.map((item) => item.hash)).toEqual(['a', 'b'])
    // searchId 变化 = 后端已重扫，携带旧 id 的迟到页必须整页丢弃
    const stale = serverSearchStateAfterPage(state, stubPage({ searchId: 'search-2', items: [{ hash: 'z', title: 'Z' }] }), keyOf)
    expect(stale).toBe(state)
  })

  it('surfaces backend truncation/cancellation instead of hiding them', () => {
    const truncatedState = serverSearchStateFromPage(stubPage({ truncated: true, notice: '超过索引上限' }), 0)
    expect(truncatedState.truncated).toBe(true)
    expect(truncatedState.notice).toContain('上限')
    const cancelled = serverSearchStateAfterPage(truncatedState, stubPage({ cancelled: true }), keyOf)
    expect(cancelled.cancelled).toBe(true)
    expect(shouldLoadMoreServerSearch(cancelled)).toBe(false)
  })

  it('start cancels previous tasks, and continue only pages when more remains', async () => {
    const calls: string[] = []
    const transport: CommitSearchTransport<string, StubPage, Hit> = {
      search: async (_path, query) => {
        calls.push(`search:${query}`)
        return stubPage({ items: [{ hash: 'a', title: 'A' }], hasMore: true })
      },
      loadPage: async (_path, searchId, offset, pageSize) => {
        calls.push(`page:${searchId}:${offset}:${pageSize}`)
        return stubPage({ items: [{ hash: 'b', title: 'B' }], offset, hasMore: false })
      },
      cancel: async () => {
        calls.push('cancel')
        return 0
      },
    }
    const page = await startServerCommitSearch(transport, '/repo', 'login')
    expect(page?.items).toHaveLength(1)
    expect(calls).toEqual(['cancel', 'search:login'])
    let state = serverSearchStateFromPage(page!, 1)
    const next = await continueServerCommitSearch(transport, '/repo', state, 100)
    expect(next?.items.map((item) => item.hash)).toEqual(['b'])
    expect(calls[calls.length - 1]).toBe('page:search-1:1:100')
    state = serverSearchStateAfterPage(state, next!, keyOf)
    expect(await continueServerCommitSearch(transport, '/repo', state, 100)).toBeNull()
  })
})
