import { useI18n } from '../../i18n'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Copy, ExternalLink, FileCode2, Folder, History, RefreshCw, Search, X } from 'lucide-react'
import { Button } from '../../components/Button'
import { ContextMenu } from '../../components/ContextMenu'
import { loadCommitTree, loadCommitTreeChildren, loadRevisionFilePreview, cancelMediaPreview, loadGitUserConfig, type RevisionFilePreview } from '../../repository'
import { isBooleanRecord, usePersistentState } from '../../persistentState'
import { createMediaRequestId, isStaleRequest } from '../diff/imageDiffModel'
import { useReviewThreads } from '../review/useReviewThreads'
import { threadLineSet, threadsForFile } from '../review/reviewModel'
import { CommitTreePreview, CommitTreeRowList, CommitTreeSummary, TREE_ROW_HEIGHT } from './CommitTreeView'
import {
  ancestorPaths,
  buildTreeContextActions,
  childrenOf,
  createCommitTreeIndex,
  createNameMatcher,
  flattenTreeRows,
  isPreviewableRow,
  needsChildrenFetch,
  toggleExpanded,
  withDirectoryLoading,
  withLoadedChildren,
  withoutDirectoryLoading,
  type CommitTreeIndex,
  type CommitTreeNodeRecord,
  type CommitTreeRow,
  type TreeContextAction,
} from './commitTreeModel'
import './commitTree.css'

export type CommitTreeBrowserProps = {
  repositoryPath: string
  /** 任意可解析的 ref：提交 hash、分支、标签、HEAD^ 等（后端做白名单校验）。 */
  reference: string
  onOpenExternally?: (filePath: string) => void
  /** 打开时定位到某个文件（会自动展开祖先目录）。 */
  initialPath?: string
  /** 右键「查看文件历史」；由 App 层接 HistoryDrawer。 */
  onOpenHistory?: (filePath: string) => void
  /** 右键复制路径/文件名（App 层统一走 copyText 给通知反馈）。 */
  onCopyPath?: (path: string) => void
  onCopyName?: (name: string) => void
}

/**
 * 提交文件树浏览的数据容器：按某个提交看该版本的完整文件树。
 * 大目录两道闸：后端 partial 时改懒加载（单层列表 + 条目上限），前端固定行高窗口化渲染。
 * 「怎么画」全在 CommitTreeView.tsx（纯展示，可脱离后端单测），这里只管「取什么数据」。
 */
export function CommitTreeBrowser({ repositoryPath, reference, onOpenExternally, initialPath, onOpenHistory, onCopyPath, onCopyName }: CommitTreeBrowserProps) {
  const { t } = useI18n()
  const [index, setIndex] = useState<CommitTreeIndex | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = usePersistentState<Record<string, boolean>>('branchline.commitTreeExpanded.v1', {}, isBooleanRecord)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedKind, setSelectedKind] = useState<string | null>(null)
  const [preview, setPreview] = useState<RevisionFilePreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const previewRequestId = useRef<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ row: CommitTreeRow; x: number; y: number } | null>(null)

  // B2 审查评论：按仓库加载线程；作者名取 git config user.name（取不到则留空）。
  const review = useReviewThreads({ repositoryPath })
  const [reviewLine, setReviewLine] = useState<number | null>(null)
  const authorRef = useRef('')
  useEffect(() => {
    let cancelled = false
    loadGitUserConfig()
      .then((config) => { if (!cancelled) authorRef.current = config.userName })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [])
  // 换文件或换 ref 时收起评论区，避免把上一行的面板留在屏幕上。
  useEffect(() => { setReviewLine(null) }, [selected, reference])

  const previewThreadLines = useMemo(
    () => (selected && preview?.kind === 'text' ? threadLineSet(threadsForFile(review.threads, reference, selected)) : new Set<number>()),
    [preview?.kind, reference, review.threads, selected],
  )
  const activeThreads = useMemo(
    () => (reviewLine == null || !selected ? [] : threadsForFile(review.threads, reference, selected).filter((thread) => thread.line === reviewLine)),
    [reference, review.threads, reviewLine, selected],
  )
  const reviewWiring = useMemo(() => ({
    lines: previewThreadLines,
    activeLine: reviewLine,
    threads: activeThreads,
    busy: review.status === 'loading',
    error: review.error,
    onLineClick: (line: number) => setReviewLine((current) => (current === line ? null : line)),
    onCreate: (body: string) => {
      if (reviewLine == null || !selected) return
      review.actions.addThread({ filePath: selected, line: reviewLine, body, author: authorRef.current })
    },
    onReply: (threadId: string, body: string) => review.actions.reply(threadId, body, authorRef.current),
    onResolve: (threadId: string, resolved: boolean) => review.actions.setResolved(threadId, resolved),
    onDelete: (threadId: string) => review.actions.remove(threadId),
    onClose: () => setReviewLine(null),
  }), [activeThreads, previewThreadLines, review, reviewLine, selected])

  const loadTree = useCallback((mode: 'initial' | 'reload') => {
    let cancelled = false
    setLoading(true)
    setError(null)
    if (mode === 'initial') {
      // 换 ref / 换仓库时把选中项与右侧预览一起归零，避免把上一个版本的 blob 留在屏幕上。
      setIndex(null)
      setSelected(null)
      setSelectedKind(null)
      setPreview(null)
    }
    loadCommitTree(repositoryPath, reference)
      .then((tree) => {
        if (cancelled) return
        setIndex(createCommitTreeIndex(tree))
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [reference, repositoryPath])

  useEffect(() => loadTree('initial'), [loadTree])

  // 定位 initialPath：展开祖先目录并选中它。
  useEffect(() => {
    if (!index || !initialPath) return
    const missing = ancestorPaths(initialPath).filter((path) => !expanded[path])
    if (missing.length) {
      setExpanded((current) => {
        const next = { ...current }
        missing.forEach((path) => { next[path] = true })
        return next
      })
    }
    setSelected(initialPath)
    // 懒加载模式下祖先可能还没取过：kind 未知就留给点击补齐，不瞎猜。
    setSelectedKind(findKind(index, initialPath))
  }, [expanded, index, initialPath, setExpanded])

  const fetchDirectory = useCallback((row: CommitTreeRow) => {
    if (!index || !needsChildrenFetch(index, row)) return
    setIndex((current) => (current ? withDirectoryLoading(current, row.path) : current))
    loadCommitTreeChildren(repositoryPath, reference, row.path)
      .then((entries) => setIndex((current) => (current ? withLoadedChildren(current, row.path, entries) : current)))
      .catch((reason: unknown) => {
        // 失败必须摘掉「加载中」：否则那一行永远转圈，而且再点也不会重试。
        setIndex((current) => (current ? withoutDirectoryLoading(current, row.path) : current))
        setError(reason instanceof Error ? reason.message : String(reason))
      })
  }, [index, reference, repositoryPath])

  const handleActivate = useCallback((row: CommitTreeRow) => {
    setSelected(row.path)
    setSelectedKind(row.kind)
    if (!row.hasChildren) return
    const willExpand = !expanded[row.path]
    setExpanded((current) => toggleExpanded(current, row.path))
    if (willExpand) fetchDirectory(row)
  }, [expanded, fetchDirectory, setExpanded])

  // 键盘导航：与点击共用选中/懒加载逻辑，但只在箭头键要求展开时才切换目录状态。
  const handleNavigate = useCallback((row: CommitTreeRow, toggle: boolean) => {
    setSelected(row.path)
    setSelectedKind(row.kind)
    if (!toggle) return
    const willExpand = !expanded[row.path]
    setExpanded((current) => toggleExpanded(current, row.path))
    if (willExpand) fetchDirectory(row)
  }, [expanded, fetchDirectory, setExpanded])

  // 预览：换选中项时取消上一请求，迟到的响应直接丢弃；目录与子模组指针不发请求。
  const previewWanted = Boolean(selected) && isPreviewableRow({ kind: selectedKind ?? '' })
  useEffect(() => {
    if (!selected || !previewWanted) {
      setPreview(null)
      setPreviewError(null)
      setPreviewLoading(false)
      return
    }
    const requestId = createMediaRequestId(selected, reference)
    previewRequestId.current = requestId
    setPreviewLoading(true)
    setPreviewError(null)
    setPreview(null)
    loadRevisionFilePreview(repositoryPath, reference, selected, undefined, requestId)
      .then((result) => {
        if (isStaleRequest(previewRequestId.current, requestId)) { void cancelMediaPreview(requestId); return }
        setPreview(result)
      })
      .catch((reason: unknown) => {
        if (isStaleRequest(previewRequestId.current, requestId)) return
        setPreview(null)
        setPreviewError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!isStaleRequest(previewRequestId.current, requestId)) setPreviewLoading(false)
      })
    return () => {
      if (!isStaleRequest(previewRequestId.current, requestId)) {
        previewRequestId.current = null
        void cancelMediaPreview(requestId)
      }
    }
  }, [previewWanted, reference, repositoryPath, selected])

  const matcher = useMemo(() => createNameMatcher(query), [query])
  const rows = useMemo(() => (index ? flattenTreeRows(index, expanded, matcher) : []), [expanded, index, matcher])

  const runContextAction = useCallback((action: TreeContextAction, row: CommitTreeRow) => {
    setContextMenu(null)
    if (action === 'copyPath') onCopyPath?.(row.path)
    else if (action === 'copyName') onCopyName?.(row.name)
    else if (action === 'openExternal') onOpenExternally?.(row.path)
    else if (action === 'viewHistory') onOpenHistory?.(row.path)
  }, [onCopyName, onCopyPath, onOpenExternally, onOpenHistory])

  const contextActions = contextMenu
    ? buildTreeContextActions(contextMenu.row, { canOpenExternally: Boolean(onOpenExternally), canViewHistory: Boolean(onOpenHistory) })
    : []

  return <div className="commit-tree-browser">
    <div className="commit-tree-pane">
      <div className="commit-tree-toolbar">
        <Search size={13}/>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('repository.tree.filterPlaceholder')} aria-label={t('repository.tree.filterLabel')}/>
        {query && <Button variant="icon" size="compact" onClick={() => setQuery('')} title={t('repository.tree.clearFilter')} aria-label={t('repository.tree.clearFilter')}><X size={13}/></Button>}
        <Button variant="icon" size="compact" onClick={() => loadTree('reload')} title={t('repository.tree.reload')} aria-label={t('repository.tree.reload')}><RefreshCw size={13}/></Button>
      </div>
      <CommitTreeSummary
        loading={loading}
        loaded={Boolean(index)}
        nodeCount={index?.nodeCount ?? 0}
        partial={Boolean(index?.partial)}
        visibleRows={rows.length}/>
      <CommitTreeRowList
        rows={rows}
        selected={selected}
        error={error}
        loading={loading}
        hasIndex={Boolean(index)}
        query={query}
        label={t('repository.tree.titleOf', { reference })}
        onActivate={handleActivate}
        onNavigate={handleNavigate}
        onRowContextMenu={(row, x, y) => setContextMenu({ row, x, y })}
        onDoubleClickRow={(row) => { if (isPreviewableRow(row)) onOpenExternally?.(row.path) }}/>
    </div>
    {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)}>
      <div className="context-menu-title"><Folder size={13}/><span title={contextMenu.row.path}>{contextMenu.row.name}</span></div>
      {contextActions.map((action) => <button
        key={action}
        type="button"
        onClick={() => runContextAction(action, contextMenu.row)}
      >
        {action === 'copyPath' && <><Copy size={14}/><span>{t('repository.tree.context.copyPath')}</span></>}
        {action === 'copyName' && <><FileCode2 size={14}/><span>{t('repository.tree.context.copyName')}</span></>}
        {action === 'openExternal' && <><ExternalLink size={14}/><span>{t('repository.tree.context.openExternal')}</span></>}
        {action === 'viewHistory' && <><History size={14}/><span>{t('repository.tree.context.viewHistory')}</span></>}
      </button>)}
    </ContextMenu>}
    <CommitTreePreview
      selected={selected}
      kind={selectedKind}
      preview={preview}
      loading={previewLoading}
      error={previewError}
      onOpenExternally={onOpenExternally}
      review={reviewWiring}/>
  </div>
}

/**
 * 在已加载的索引里找某一行的 kind。
 * 懒加载回来的节点不在 roots 里，所以 roots 与 childrenByPath 都要看；找不到返回 null（未知）。
 */
function findKind(index: CommitTreeIndex, path: string): string | null {
  const walk = (nodes: CommitTreeNodeRecord[]): string | null => {
    for (const node of nodes) {
      if (node.path === path) return node.kind
      if (node.kind === 'tree') {
        const hit = walk(childrenOf(index, node))
        if (hit) return hit
      }
    }
    return null
  }
  const fromRoots = walk(index.roots)
  if (fromRoots) return fromRoots
  for (const children of Object.values(index.childrenByPath)) {
    const hit = walk(children)
    if (hit) return hit
  }
  return null
}

export { TREE_ROW_HEIGHT }
