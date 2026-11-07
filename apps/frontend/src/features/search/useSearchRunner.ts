import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getLanguage, translate } from '../../i18n'
import {
  cancelRepositorySearch,
  loadCommitSearchPage,
  loadRepositoryTextPage,
  searchCommits,
  searchRepositoryText,
} from '../../repository'
import type {
  CommitSearchPage,
  CommitSearchQuery,
  TextSearchPage,
  TextSearchQuery,
} from '../../repository'
import { createSearchGate } from './searchModel'

/**
 * 深度搜索的执行编排：代际闸门 + 分页 + 取消。
 *
 * 为什么要闸门：`git log -S/-G` 在大仓库上可能要几秒到几十秒。用户改关键字时
 * 如果直接并发发请求，慢的旧请求会覆盖快的新请求，界面出现「结果与输入不符」。
 * 这里对每个入口都做了两件事：
 * 1. 本地代际令牌：过期响应直接丢弃；
 * 2. 远端取消：新搜索开始前通知后端中止上一个任务（后端同仓库同类型只允许单飞）。
 */
export function useSearchRunner(repositoryPath: string | null | undefined) {
  const gateRef = useRef(createSearchGate())
  const [commitPage, setCommitPage] = useState<CommitSearchPage | null>(null)
  const [textPage, setTextPage] = useState<TextSearchPage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 切换仓库：本地令牌作废 + 通知后端中止，避免旧仓库的结果落到新仓库界面上。
  useEffect(() => {
    gateRef.current.invalidate()
    setCommitPage(null)
    setTextPage(null)
    setError(null)
    if (repositoryPath) {
      // 不 await：这是「尽力中止」，失败也不能卡住切换。
      void cancelRepositorySearch(repositoryPath).catch(() => {})
    }
  }, [repositoryPath])

  // 组件卸载（关闭窗口/切走页面）同样要中止在跑的重查询。
  useEffect(() => {
    const gate = gateRef.current
    return () => {
      gate.invalidate()
    }
  }, [])

  const runCommitSearch = useCallback(async (query: CommitSearchQuery) => {
    if (!repositoryPath) {
      setError(translate(getLanguage(), 'search.requiresRepository'))
      return null
    }
    const token = gateRef.current.begin()
    setBusy(true)
    setError(null)
    try {
      // 先请求后端中止上一代任务，再发起本次扫描：避免两个全历史扫描同时跑。
      await cancelRepositorySearch(repositoryPath).catch(() => {})
      const page = await searchCommits(repositoryPath, query)
      if (!gateRef.current.isCurrent(token)) return null
      setCommitPage(page)
      return page
    } catch (caught) {
      if (!gateRef.current.isCurrent(token)) return null
      setError(caught instanceof Error ? caught.message : String(caught))
      setCommitPage(null)
      return null
    } finally {
      if (gateRef.current.isCurrent(token)) setBusy(false)
    }
  }, [repositoryPath])

  const runTextSearch = useCallback(async (query: TextSearchQuery) => {
    if (!repositoryPath) {
      setError(translate(getLanguage(), 'search.requiresRepository'))
      return null
    }
    const token = gateRef.current.begin()
    setBusy(true)
    setError(null)
    try {
      await cancelRepositorySearch(repositoryPath).catch(() => {})
      const page = await searchRepositoryText(repositoryPath, query)
      if (!gateRef.current.isCurrent(token)) return null
      setTextPage(page)
      return page
    } catch (caught) {
      if (!gateRef.current.isCurrent(token)) return null
      setError(caught instanceof Error ? caught.message : String(caught))
      setTextPage(null)
      return null
    } finally {
      if (gateRef.current.isCurrent(token)) setBusy(false)
    }
  }, [repositoryPath])

  /** 翻页走缓存索引，因此不加闸门：同一代搜索内的分页不该互相作废。 */
  const loadCommitPage = useCallback(async (searchId: string, offset: number, pageSize: number) => {
    if (!repositoryPath || !searchId) return null
    try {
      const page = await loadCommitSearchPage(repositoryPath, searchId, offset, pageSize)
      setCommitPage(page)
      return page
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      return null
    }
  }, [repositoryPath])

  const loadTextPage = useCallback(async (
    searchId: string,
    offset: number,
    pageSize: number,
    contextLines: number,
  ) => {
    if (!repositoryPath || !searchId) return null
    try {
      const page = await loadRepositoryTextPage(repositoryPath, searchId, offset, pageSize, contextLines)
      setTextPage(page)
      return page
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      return null
    }
  }, [repositoryPath])

  const stop = useCallback(async () => {
    if (!repositoryPath) return
    gateRef.current.invalidate()
    setBusy(false)
    try {
      await cancelRepositorySearch(repositoryPath)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [repositoryPath])

  return useMemo(
    () => ({ commitPage, textPage, busy, error, runCommitSearch, runTextSearch, loadCommitPage, loadTextPage, stop }),
    [commitPage, textPage, busy, error, runCommitSearch, runTextSearch, loadCommitPage, loadTextPage, stop],
  )
}
