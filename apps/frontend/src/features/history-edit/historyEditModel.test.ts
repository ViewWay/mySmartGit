import { describe, expect, it } from 'vitest'
import {
  buildActionPayload,
  createRows,
  hasReordered,
  moveRow,
  orderCommitsOldFirst,
  renderTodoPreview,
  setRowAction,
  setRowMessage,
  summarizeRows,
  summarizeWithReorder,
  validateRows,
  type HistoryEditRow,
} from './historyEditModel'
import type { HistoryEditEntry } from '../../repository'

function entry(hashSeed: string, title: string): HistoryEditEntry {
  const hash = hashSeed.repeat(40).slice(0, 40)
  return {
    hash,
    shortHash: hash.slice(0, 7),
    title,
    message: `${title}\n\n正文`,
    author: '测试者',
    email: 't@example.com',
    commitTime: '2026-01-01T00:00:00+08:00',
    parents: [],
    isMerge: false,
    tree: 'tree',
  }
}

const entries = [entry('a', '改动 A'), entry('b', '改动 B'), entry('c', '改动 C')]

describe('history edit row operations', () => {
  it('creates pick rows prefilled with original messages', () => {
    const rows = createRows(entries)
    expect(rows).toHaveLength(3)
    expect(rows[0].action).toBe('pick')
    expect(rows[1].message).toContain('改动 B')
  })

  it('moves rows up and down with boundary clamping', () => {
    const rows = createRows(entries)
    const moved = moveRow(rows, 2, -1)
    expect(moved.map((row) => row.entry.title)).toEqual(['改动 A', '改动 C', '改动 B'])
    // 越界返回同一引用（不触发重渲染）。
    expect(moveRow(rows, 0, -1)).toBe(rows)
    expect(moveRow(rows, 2, 1)).toBe(rows)
    // 不可变：原数组不被修改。
    expect(rows.map((row) => row.entry.title)).toEqual(['改动 A', '改动 B', '改动 C'])
    const back = moveRow(moved, 1, 1)
    expect(back.map((row) => row.entry.title)).toEqual(['改动 A', '改动 B', '改动 C'])
  })

  it('sets action and message immutably', () => {
    const rows = createRows(entries)
    const next = setRowAction(rows, 0, 'drop')
    expect(next[0].action).toBe('drop')
    expect(rows[0].action).toBe('pick')
    const typed = setRowMessage(next, 0, '新消息')
    expect(typed[0].message).toBe('新消息')
  })
})

describe('history edit validation mirrors backend rules', () => {
  it('rejects squash/fixup without a preceding kept commit', () => {
    let rows = createRows(entries)
    rows = setRowAction(rows, 0, 'squash')
    expect(validateRows(rows).join()).toContain('squash 之前必须有保留的提交')
    rows = setRowAction(createRows(entries), 0, 'fixup')
    expect(validateRows(rows).join()).toContain('fixup')
    // 前一条被 drop 后 squash 同样无效。
    rows = setRowAction(setRowAction(createRows(entries), 0, 'drop'), 1, 'squash')
    expect(validateRows(rows).join()).toContain('drop 也不行')
    // drop 不影响 pick，pick 之后的 squash 合法。
    rows = setRowAction(setRowAction(createRows(entries), 0, 'drop'), 2, 'squash')
    expect(validateRows(rows)).toEqual([])
  })

  it('requires non-empty message for reword only', () => {
    let rows = setRowAction(createRows(entries), 1, 'reword')
    rows = setRowMessage(rows, 1, '   ')
    expect(validateRows(rows).join()).toContain('reword 需要新的提交消息')
    rows = setRowMessage(rows, 1, '合法消息')
    expect(validateRows(rows)).toEqual([])
    // squash 缺省消息合法（自动合并），drop 空消息也合法。
    rows = setRowMessage(setRowAction(createRows(entries), 2, 'squash'), 2, '')
    expect(validateRows(rows)).toEqual([])
  })

  it('flags empty sequence', () => {
    expect(validateRows([] as HistoryEditRow[]).length).toBe(1)
  })
})

describe('history edit summary and payload', () => {
  it('counts kept, dropped, folded, reworded and expected result size', () => {
    let rows = createRows(entries)
    rows = setRowAction(rows, 1, 'drop')
    rows = setRowAction(rows, 2, 'fixup')
    const summary = summarizeRows(rows)
    expect(summary).toMatchObject({ total: 3, dropped: 1, folded: 1, reworded: 0, resultCount: 1, changed: true })
    expect(summarizeRows(createRows(entries)).changed).toBe(false)
  })

  it('detects reorder as a change even with pure picks', () => {
    const rows = moveRow(moveRow(createRows(entries), 0, 1), 1, 1)
    expect(summarizeRows(rows).changed).toBe(false) // 动作没变
    expect(summarizeWithReorder(entries, rows).changed).toBe(true) // 顺序变了
    expect(hasReordered(entries, createRows(entries))).toBe(false)
  })

  it('builds payload in new order with messages only for reword/squash', () => {
    let rows = createRows(entries)
    rows = setRowAction(rows, 0, 'reword')
    rows = setRowMessage(rows, 0, '新消息 A')
    rows = setRowAction(rows, 2, 'squash')
    rows = setRowMessage(rows, 2, '合并说明')
    const payload = buildActionPayload(rows)
    expect(payload.map((item) => item.hash)).toEqual([entries[0].hash, entries[1].hash, entries[2].hash])
    expect(payload[0]).toEqual({ hash: entries[0].hash, action: 'reword', message: '新消息 A' })
    expect(payload[1].message).toBeNull()
    expect(payload[2].message).toBe('合并说明')
  })
})

describe('history edit todo preview', () => {
  it('mirrors backend compile rules for each action', () => {
    let rows = createRows(entries)
    rows = setRowAction(rows, 0, 'drop')
    rows = setRowAction(rows, 1, 'fixup')
    rows = setRowAction(rows, 2, 'edit')
    const lines = renderTodoPreview(rows)
    expect(lines[0]).toMatch(/^# drop /)
    expect(lines[1]).toBe(`pick ${entries[1].hash} # 改动 B`)
    expect(lines[2]).toContain('折叠进上一条并保留目标消息')
    expect(lines[3]).toBe(`edit ${entries[2].hash} # 改动 C（变基在此暂停）`)
  })
})

describe('batch cherry-pick ordering', () => {
  it('sorts old-to-new by author time, keeps selection order on ties, dedupes', () => {
    const commits = [
      { fullHash: 'new', authorTime: '2026-01-03T00:00:00Z' },
      { fullHash: 'old', authorTime: '2026-01-01T00:00:00Z' },
      { fullHash: 'new', authorTime: '2026-01-03T00:00:00Z' },
      { fullHash: 'midA', authorTime: '2026-01-02T00:00:00Z' },
      { fullHash: 'midB', authorTime: '2026-01-02T00:00:00Z' },
      { fullHash: '', authorTime: undefined },
    ]
    expect(orderCommitsOldFirst(commits)).toEqual(['old', 'midA', 'midB', 'new'])
  })
})
