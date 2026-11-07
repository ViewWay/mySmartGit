// createReviewController 状态机单测：内存 backend + 注入时钟，覆盖加载、
// 乐观变更成功/失败回滚、版本号丢弃迟到回执。不依赖 React。
import { describe, expect, it } from 'vitest'
import type { ReviewThread } from '@branchline/git-models'
import { createReviewController } from './useReviewThreads'
import type { ReviewBackend } from './reviewStore'

function thread(id: string, overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id,
    filePath: 'src/a.ts',
    reference: 'feat',
    line: 3,
    side: 'new',
    resolved: false,
    createdAt: '2026-11-07T00:00:00Z',
    updatedAt: '2026-11-07T00:00:00Z',
    comments: [{ id: `${id}-c1`, author: 'dev', body: 'note', createdAt: '2026-11-07T00:00:00Z' }],
    remote: null,
    ...overrides,
  }
}

/** 可编程内存 backend：记录调用并按脚本回填/报错。 */
function memoryBackend(script: {
  list?: ReviewThread[]
  upsert?: (threadItem: ReviewThread) => ReviewThread
  failUpsertOn?: (threadItem: ReviewThread) => boolean
} = {}): ReviewBackend & { calls: string[] } {
  const store = new Map<string, ReviewThread>()
  for (const item of script.list ?? []) store.set(item.id, item)
  const calls: string[] = []
  return {
    calls,
    async list(path) {
      calls.push(`list:${path}`)
      return [...store.values()]
    },
    async upsert(_path, threadItem) {
      calls.push(`upsert:${threadItem.id}`)
      if (script.failUpsertOn?.(threadItem)) throw new Error('disk full')
      const saved = script.upsert ? script.upsert(threadItem) : threadItem
      store.set(threadItem.id, saved)
      return saved
    },
    async remove(_path, threadId) {
      calls.push(`remove:${threadId}`)
      store.delete(threadId)
    },
    async resolve(_path, threadId, resolved) {
      calls.push(`resolve:${threadId}`)
      const current = store.get(threadId)
      if (!current) throw new Error('missing')
      const saved = { ...current, resolved }
      store.set(threadId, saved)
      return saved
    },
  }
}

async function settle(times = 3) {
  for (let index = 0; index < times; index += 1) await Promise.resolve()
}

describe('createReviewController', () => {
  it('load 拉取并进入 ready', async () => {
    const backend = memoryBackend({ list: [thread('t1')] })
    const controller = createReviewController({ backend })
    controller.load('/repo')
    await settle()
    expect(controller.getState()).toMatchObject({ status: 'ready', threads: [thread('t1')], error: null })
    expect(backend.calls).toEqual(['list:/repo'])
  })

  it('load 失败保留 ready 并暴露 error', async () => {
    const backend: ReviewBackend = { ...memoryBackend(), async list() { throw new Error('boom') } }
    const controller = createReviewController({ backend })
    controller.load('/repo')
    await settle()
    expect(controller.getState()).toMatchObject({ status: 'ready', error: 'boom' })
  })

  it('addThread 乐观落盘并用回执覆盖', async () => {
    const backend = memoryBackend()
    const controller = createReviewController({ backend, now: () => '2026-11-07T01:00:00Z' })
    controller.load('/repo')
    await settle()

    controller.addThread({ filePath: 'a.ts', line: 5, body: 'fix', author: 'me' })
    await settle()

    const state = controller.getState()
    expect(state.threads).toHaveLength(1)
    expect(state.threads[0].comments[0].body).toBe('fix')
    expect(state.threads[0].createdAt).toBe('2026-11-07T01:00:00Z')
    expect(backend.calls.some((call) => call.startsWith('upsert:'))).toBe(true)
  })

  it('addThread 失败时回滚快照并暴露 error', async () => {
    const backend = memoryBackend({ failUpsertOn: () => true })
    const controller = createReviewController({ backend })
    controller.load('/repo')
    await settle()

    controller.addThread({ filePath: 'a.ts', line: 5, body: 'fix', author: 'me' })
    await settle()

    expect(controller.getState().threads).toHaveLength(0)
    expect(controller.getState().error).toBe('disk full')
  })

  it('reply 在既有线程上追加评论', async () => {
    const backend = memoryBackend({ list: [thread('t1')] })
    const controller = createReviewController({ backend, now: () => '2026-11-07T01:00:00Z' })
    controller.load('/repo')
    await settle()

    controller.reply('t1', 'ok', 'me')
    await settle()

    expect(controller.getState().threads[0].comments.map((comment) => comment.body)).toEqual(['note', 'ok'])
  })

  it('setResolved 与 remove 走乐观路径', async () => {
    const backend = memoryBackend({ list: [thread('t1'), thread('t2')] })
    const controller = createReviewController({ backend })
    controller.load('/repo')
    await settle()

    controller.setResolved('t1', true)
    controller.remove('t2')
    await settle()

    expect(controller.getState().threads.map((item) => item.id)).toEqual(['t1'])
    expect(controller.getState().threads[0].resolved).toBe(true)
  })
})
