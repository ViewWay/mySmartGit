import { describe, expect, it } from 'vitest'
import * as historyDepthModule from './historyDepth'
import type { RepositoryCommit, RepositoryHistoryPage } from '../../repository'
import {
  HISTORY_PAGE_SIZE,
  HISTORY_PREFETCH_ROWS,
  beginHistoryStream,
  historyStateAfterPage,
  invalidateHistoryStream,
  isStaleHistoryRequest,
  markHistoryLoading,
  mergeHistoryEntries,
  mergeHistoryPage,
  shouldPrefetchHistory,
} from './historyDepth'

function page(overrides: Partial<RepositoryHistoryPage>): RepositoryHistoryPage {
  return {
    sessionId: 'hist-1',
    kind: 'graph',
    commits: [],
    entries: [],
    emitted: 0,
    hasMore: false,
    truncated: false,
    notice: null,
    pageBytes: 0,
    ...overrides,
  }
}

function commit(fullHash: string, lane = 0): RepositoryCommit {
  return {
    id: fullHash.slice(0, 7),
    fullHash,
    lane,
    color: '#36cfc9',
    title: `提交 ${fullHash}`,
    author: 'tester',
    avatar: 'T',
    time: '2026-01-01T00:00:00+08:00',
    files: 0,
    additions: 0,
    deletions: 0,
  } as RepositoryCommit
}

describe('history cursor pagination (W3-3, replaces the ×5 load-limit model)', () => {
  it('keeps one fixed page size instead of expanding a single-read limit', () => {
    expect(HISTORY_PAGE_SIZE).toBe(500)
    // 旧模型导出必须已消失：模块里不允许再有 ×5 扩上限机制的任何入口。
    expect(Object.keys(historyDepthModule)).not.toContain('nextHistoryLoadLimit')
    expect(Object.keys(historyDepthModule)).not.toContain('DEFAULT_HISTORY_LOAD_LIMIT')
  })

  it('starts a stream session from the first page', () => {
    const first = page({ sessionId: 'hist-7', commits: [commit('a'.repeat(40))], emitted: 1, hasMore: true })
    const state = beginHistoryStream(first)
    expect(state.sessionId).toBe('hist-7')
    expect(state.emitted).toBe(1)
    expect(state.hasMore).toBe(true)
  })

  it('appends pages without touching the already-emitted prefix', () => {
    const loaded = [commit('a'.repeat(40)), commit('b'.repeat(40))]
    const next = page({
      commits: [commit('c'.repeat(40), 1), commit('d'.repeat(40), 1)],
      emitted: 4,
      hasMore: true,
    })
    const merged = mergeHistoryPage(loaded, next)
    expect(merged.map((row) => row.fullHash.slice(0, 1))).toEqual(['a', 'b', 'c', 'd'])
    // 前缀不变式：旧条目引用与内容原样保留（跨页 lane 由后端流状态保证一致）
    expect(merged[0]).toBe(loaded[0])
    expect(merged[1]).toBe(loaded[1])
  })

  it('defensively drops duplicated commits arriving across page boundaries', () => {
    const loaded = [commit('a'.repeat(40))]
    const dup = page({ commits: [commit('a'.repeat(40)), commit('b'.repeat(40))], emitted: 2 })
    const merged = mergeHistoryPage(loaded, dup)
    expect(merged).toHaveLength(2)
    expect(merged[1].fullHash.startsWith('b')).toBe(true)
  })

  it('advances the cursor state and refuses stale sessions or rewound offsets', () => {
    const state = beginHistoryStream(page({ sessionId: 'hist-1', emitted: 2, hasMore: true }))
    const advanced = historyStateAfterPage(state, page({ sessionId: 'hist-1', emitted: 5, hasMore: false }))
    expect(advanced.emitted).toBe(5)
    expect(advanced.hasMore).toBe(false)
    // 过期会话（切仓库后旧流晚到）必须原样拒绝
    const rejected = historyStateAfterPage(advanced, page({ sessionId: 'hist-0', emitted: 9 }))
    expect(rejected).toBe(advanced)
    // 游标回退同样拒绝：emitted 单调递增
    const rewind = historyStateAfterPage(advanced, page({ sessionId: 'hist-1', emitted: 3 }))
    expect(rewind).toBe(advanced)
  })

  it('surfaces explicit truncation flags instead of hiding bounded data', () => {
    const state = beginHistoryStream(page({ emitted: 1, truncated: true, notice: '标题已按预算截断' }))
    expect(state.truncated).toBe(true)
    expect(state.notice).toContain('截断')
  })

  it('prefetches the next page when the viewport nears the loaded tail', () => {
    const state = beginHistoryStream(page({ sessionId: 'hist-1', emitted: 100, hasMore: true }))
    expect(shouldPrefetchHistory({ state, lastVisibleRowIndex: 100 - HISTORY_PREFETCH_ROWS })).toBe(true)
    expect(shouldPrefetchHistory({ state, lastVisibleRowIndex: 20 })).toBe(false)
    // 读完（hasMore=false）或加载中不再触发
    const done = historyStateAfterPage(state, page({ sessionId: 'hist-1', emitted: 120, hasMore: false }))
    expect(shouldPrefetchHistory({ state: done, lastVisibleRowIndex: 119 })).toBe(false)
    expect(shouldPrefetchHistory({ state: markHistoryLoading(state), lastVisibleRowIndex: 99 })).toBe(false)
  })

  it('invalidates the session with a new generation when repository or branch changes', () => {
    const state = beginHistoryStream(page({ sessionId: 'hist-1', emitted: 50, hasMore: true }))
    const invalidated = invalidateHistoryStream(state)
    expect(invalidated.sessionId).toBeNull()
    expect(invalidated.emitted).toBe(0)
    expect(invalidated.generation).toBe(state.generation + 1)
    expect(isStaleHistoryRequest(invalidated, state.generation)).toBe(true)
    expect(markHistoryLoading(invalidated)).toBe(invalidated)
  })

  it('merges file/line stream pages with tail-append and dedupe', () => {
    const existing = [
      { hash: 'a', shortHash: 'a', parents: [], author: '', email: '', committer: '', committerEmail: '', time: '', commitTime: '', title: 'A', message: 'A' },
    ]
    const filePage = page({ kind: 'file', entries: [{ ...existing[0] }, { ...existing[0], hash: 'b', title: 'B' }] })
    const merged = mergeHistoryEntries(existing, filePage)
    expect(merged.map((entry) => entry.hash)).toEqual(['a', 'b'])
    // 类型不符（图谱页误投条目列表）原样返回
    expect(mergeHistoryEntries(existing, page({ kind: 'graph', entries: filePage.entries }))).toBe(existing)
  })
})
