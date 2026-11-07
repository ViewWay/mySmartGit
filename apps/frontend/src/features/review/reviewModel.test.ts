// 审查评论纯逻辑单测。fixture 全部合成，不读文件。
import { describe, expect, it } from 'vitest'
import type { ReviewThread } from '@branchline/git-models'
import {
  buildComment,
  createReviewId,
  groupThreadsByLine,
  reviewAnchorKey,
  threadAnchorKey,
  threadLineSet,
  threadsForFile,
  buildThread,
  withResolved,
  withRepliedComment,
  withUpsertedThread,
  withoutThread,
} from './reviewModel'

function thread(input: Partial<ReviewThread> & { id: string }): ReviewThread {
  return {
    filePath: 'src/a.ts',
    reference: 'feat',
    line: 3,
    side: 'new',
    resolved: false,
    createdAt: '2026-11-07T00:00:00Z',
    updatedAt: '2026-11-07T00:00:00Z',
    comments: [{ id: `${input.id}-c1`, author: 'dev', body: 'note', createdAt: '2026-11-07T00:00:00Z' }],
    remote: null,
    ...input,
  }
}

describe('reviewModel 锚点与归组', () => {
  it('anchor key 区分文件、行号与新旧侧', () => {
    expect(reviewAnchorKey('a.ts', 3)).toBe('a.ts#new:3')
    expect(reviewAnchorKey('a.ts', 3, 'old')).toBe('a.ts#old:3')
    expect(reviewAnchorKey('b.ts', 3)).not.toBe(reviewAnchorKey('a.ts', 3))
    expect(threadAnchorKey({ filePath: 'a.ts', line: 7, side: 'old' })).toBe('a.ts#old:7')
  })

  it('threadsForFile 只留同 ref + 同文件的线程并按行排序', () => {
    const list = [
      thread({ id: 't3', line: 5 }),
      thread({ id: 't1', line: 2, reference: 'other' }),
      thread({ id: 't2', line: 2 }),
      thread({ id: 't4', filePath: 'b.ts', line: 1 }),
      thread({ id: 't5', line: 2, createdAt: '2026-11-06T00:00:00Z' }),
    ]
    const result = threadsForFile(list, 'feat', 'src/a.ts')
    expect(result.map((item) => item.id)).toEqual(['t5', 't2', 't3'])
  })

  it('threadLineSet 去重行号供 gutter 高亮', () => {
    const set = threadLineSet([thread({ id: 't1', line: 2 }), thread({ id: 't2', line: 2 }), thread({ id: 't3', line: 9 })])
    expect([...set].sort((a, b) => a - b)).toEqual([2, 9])
  })

  it('groupThreadsByLine 保持行内创建顺序', () => {
    const groups = groupThreadsByLine([
      thread({ id: 'a', line: 2, createdAt: '2026-11-06T00:00:00Z' }),
      thread({ id: 'b', line: 2, createdAt: '2026-11-07T00:00:00Z' }),
    ])
    expect(groups.get(2)!.map((item) => item.id)).toEqual(['a', 'b'])
  })

  it('createReviewId 生成 uuid 形状', () => {
    const id = createReviewId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(createReviewId()).not.toBe(id)
  })

  it('buildThread 组装锚定草稿', () => {
    const draft = buildThread({ filePath: 'a.ts', line: 4, author: 'dev', body: 'fix this', now: '2026-11-07T01:00:00Z' })
    expect(draft.line).toBe(4)
    expect(draft.side).toBe('new')
    expect(draft.comments).toHaveLength(1)
    expect(draft.comments[0].body).toBe('fix this')
  })
})

describe('reviewModel 乐观更新变换', () => {
  const list = [thread({ id: 't1' }), thread({ id: 't2', line: 9 })]

  it('withUpsertedThread 追加新线程 / 按 id 覆盖', () => {
    const appended = withUpsertedThread(list, thread({ id: 't3' }))
    expect(appended).toHaveLength(3)

    const replaced = withUpsertedThread(list, thread({ id: 't1', line: 30 }))
    expect(replaced).toHaveLength(2)
    expect(replaced[0].line).toBe(30)
    expect(list[0].line).toBe(3) // 原数组不变
  })

  it('withRepliedComment 追加回复且原数组不变', () => {
    const next = withRepliedComment(list, 't1', buildComment('me', 'ok', '2026-11-07T01:00:00Z'))
    expect(next[0].comments).toHaveLength(2)
    expect(list[0].comments).toHaveLength(1)
  })

  it('withResolved / withoutThread 按目标生效', () => {
    expect(withResolved(list, 't2', true).find((item) => item.id === 't2')?.resolved).toBe(true)
    expect(withoutThread(list, 't2')).toHaveLength(1)
    expect(withoutThread(list, 'missing')).toHaveLength(2)
  })
})
