// useReviewThreads：审查线程的状态机核心（纯逻辑、无 React）+ React hook 壳。
// 状态机可脱离 React 单测（useReviewThreads.test.ts），hook 只负责订阅与生命周期。
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { ReviewThread, ReviewThreadSide } from '@branchline/git-models'
import * as model from './reviewModel'
import { desktopReviewBackend, type ReviewBackend } from './reviewStore'

// ---------------------------------------------------------------------------
// 纯状态机（框架无关，测试的主要对象）
// ---------------------------------------------------------------------------

export type ReviewStatus = 'idle' | 'loading' | 'ready'

export type ReviewControllerState = {
  status: ReviewStatus
  /** 当前仓库的全部线程（含锚在其他 ref 上的；展示层用 threadsForFile 过滤）。 */
  threads: ReviewThread[]
  error: string | null
}

/** 乐观状态机：先落乐观态，后端成功用回执覆盖，失败整体回滚。 */
export function createReviewController(options: {
  backend: ReviewBackend
  now?: () => string
}) {
  const now = options.now ?? (() => new Date().toISOString())
  let state: ReviewControllerState = { status: 'idle', threads: [], error: null }
  let repositoryPath: string | null = null
  /** 乐观版本号：仅当没有更新动作发生时才允许回滚/回执落地。 */
  let version = 0
  const listeners = new Set<() => void>()

  const emit = () => { for (const listener of listeners) listener() }
  const setState = (patch: Partial<ReviewControllerState>) => {
    state = { ...state, ...patch }
    emit()
  }

  const load = (path: string) => {
    repositoryPath = path
    version += 1
    const run = version
    setState({ status: 'loading', error: null, threads: [] })
    options.backend
      .list(path)
      .then((threads) => {
        if (run !== version) return
        setState({ status: 'ready', threads })
      })
      .catch((reason: unknown) => {
        if (run !== version) return
        setState({ status: 'ready', error: reason instanceof Error ? reason.message : String(reason) })
      })
  }

  /** 通用乐观执行：先落乐观态，后端成功则用回执覆盖该线程，失败则整体回滚。 */
  const runOptimistic = (
    optimistic: (threads: ReviewThread[]) => ReviewThread[],
    persist: () => Promise<ReviewThread | null>,
  ) => {
    if (!repositoryPath) return
    version += 1
    const run = version
    const snapshot = state.threads
    setState({ threads: optimistic(state.threads), error: null })
    void persist()
      .then((saved) => {
        if (run !== version) return
        setState({ threads: saved ? model.withUpsertedThread(state.threads, saved) : state.threads })
      })
      .catch((reason: unknown) => {
        if (run !== version) return
        setState({
          threads: snapshot,
          error: reason instanceof Error ? reason.message : String(reason),
        })
      })
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    load,
    refresh: () => { if (repositoryPath) load(repositoryPath) },
    addThread(input: { filePath: string; line: number; side?: ReviewThreadSide; body: string; author: string }) {
      const draft = model.buildThread({ ...input, now: now() })
      runOptimistic(
        (threads) => model.withUpsertedThread(threads, draft),
        () => (repositoryPath ? options.backend.upsert(repositoryPath, { ...draft, reference: '' }) : Promise.resolve(null)),
      )
    },
    reply(threadId: string, body: string, author: string) {
      const comment = model.buildComment(author, body, now())
      runOptimistic(
        (threads) => model.withRepliedComment(threads, threadId, comment),
        () => {
          // 乐观应用后 current 已含新评论，直接整体送存，避免二次追加。
          const current = state.threads.find((thread) => thread.id === threadId)
          if (!current || !repositoryPath) return Promise.resolve(null)
          return options.backend.upsert(repositoryPath, current)
        },
      )
    },
    setResolved(threadId: string, resolved: boolean) {
      runOptimistic(
        (threads) => model.withResolved(threads, threadId, resolved),
        () => (repositoryPath ? options.backend.resolve(repositoryPath, threadId, resolved) : Promise.resolve(null)),
      )
    },
    remove(threadId: string) {
      runOptimistic(
        (threads) => model.withoutThread(threads, threadId),
        () => (repositoryPath ? options.backend.remove(repositoryPath, threadId).then(() => null) : Promise.resolve(null)),
      )
    },
  }
}

export type ReviewController = ReturnType<typeof createReviewController>

// ---------------------------------------------------------------------------
// React hook 壳
// ---------------------------------------------------------------------------

/** 按仓库加载审查线程；换仓库自动重载。返回状态 + 操作闭包。 */
export function useReviewThreads(options: { repositoryPath: string | null; backend?: ReviewBackend }) {
  const backend = options.backend ?? desktopReviewBackend
  const controllerRef = useRef<ReviewController | null>(null)
  const getController = useCallback(() => {
    if (!controllerRef.current) {
      controllerRef.current = createReviewController({ backend })
    }
    return controllerRef.current
  }, [backend])
  const controller = getController()

  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  useEffect(() => {
    if (options.repositoryPath) controller.load(options.repositoryPath)
  }, [controller, options.repositoryPath])

  const actions = useMemo(
    () => ({
      refresh: () => controller.refresh(),
      addThread: (input: { filePath: string; line: number; side?: ReviewThreadSide; body: string; author: string }) => controller.addThread(input),
      reply: (threadId: string, body: string, author: string) => controller.reply(threadId, body, author),
      setResolved: (threadId: string, resolved: boolean) => controller.setResolved(threadId, resolved),
      remove: (threadId: string) => controller.remove(threadId),
    }),
    [controller],
  )
  return { ...state, actions }
}
