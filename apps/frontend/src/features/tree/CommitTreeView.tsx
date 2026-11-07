import { useI18n } from '../../i18n'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Box, ChevronDown, ChevronRight, Copy, ExternalLink, FileText, Folder, Link2 } from 'lucide-react'
import { Button } from '../../components/Button'
import type { RevisionFilePreview } from '../../repository'
import { formatByteSize } from '../diff/imageDiffModel'
import { ImageDiffViewer } from '../diff/ImageDiffViewer'
import { computeTreeWindow, isPreviewableRow, navigateTreeRows, type CommitTreeRow, type TreeNavigationKey } from './commitTreeModel'
import { fileIconClass } from './fileIcon'
import { TreeCodePreview } from './TreeCodePreview'
import { ReviewThreadPanel } from '../review/ReviewThreadPanel'
import type { ReviewThread } from '@branchline/git-models'
import type { ImageFileDiff } from '../../repository'

/** 固定行高，与 commitTree.css 的 .commit-tree-row 保持一致；窗口化依赖它。 */
export const TREE_ROW_HEIGHT = 22

/**
 * 纯展示层：数据容器（CommitTreeBrowser）只负责取数，这里负责「怎么画」，
 * 于是窗口化、图标、懒加载占位与降级文案都能脱离后端被 renderToStaticMarkup 直接测到。
 */

export type CommitTreeSummaryProps = {
  loading: boolean
  loaded: boolean
  nodeCount: number
  partial: boolean
  visibleRows: number
}

/** 概览条。partial 时 nodeCount 只是后端有界扫描的下界，文案必须说「≥」而不是「共」。 */
export function CommitTreeSummary({ loading, loaded, nodeCount, partial, visibleRows }: CommitTreeSummaryProps) {
  const { t } = useI18n()
  return <div className="commit-tree-summary">
    {loaded
      ? <>{t('repository.tree.scanCount', { count: partial ? `≥ ${nodeCount}` : nodeCount })}{partial ? <> · <span className="commit-tree-lazy-flag">{t('repository.tree.lazyFallback')}</span></> : t('repository.tree.completeTree')}</>
      : loading ? t('repository.tree.loading') : t('repository.tree.notLoaded')}
    {visibleRows > 0 && <>{t('repository.tree.visibleRows')}{visibleRows}</>}
  </div>
}

export type CommitTreeRowListProps = {
  rows: CommitTreeRow[]
  selected: string | null
  error: string | null
  loading: boolean
  hasIndex: boolean
  query: string
  /** 无障碍：给 tree 区域一个可读的名字。 */
  label: string
  onActivate: (row: CommitTreeRow) => void
  /** 键盘导航：把新的选中行（以及是否要切换展开态）交给数据容器处理。 */
  onNavigate?: (row: CommitTreeRow, toggle: boolean) => void
  /** 右键菜单：把行与指针位置交给数据容器决定画什么。 */
  onRowContextMenu?: (row: CommitTreeRow, x: number, y: number) => void
  /** 双击行（仅文件行会被数据容器用于外部打开）。 */
  onDoubleClickRow?: (row: CommitTreeRow) => void
}

function rowIcon(kind: string, name: string) {
  if (kind === 'tree') return <Folder size={12}/>
  if (kind === 'commit') return <Box size={12}/>
  if (kind === 'symlink') return <Link2 size={12}/>
  const iconClass = fileIconClass(name)
  if (iconClass) return <span className={`file-icon ${iconClass}`} aria-hidden="true"/>
  return <FileText size={12}/>
}

function FileHeaderIcon({ name }: { name: string }) {
  const iconClass = fileIconClass(name)
  return iconClass ? <span className={`file-icon ${iconClass}`} aria-hidden="true"/> : <FileText size={13}/>
}

/**
 * 窗口化的行列表：滚动位置与视口高度都由本组件持有（它只依赖固定行高），
 * 渲染的永远只是可视区 + overscan，几万个节点也不会进 DOM。
 */
const NAVIGATION_KEYS = new Set(['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])

export function CommitTreeRowList({ rows, selected, error, loading, hasIndex, query, label, onActivate, onNavigate, onRowContextMenu, onDoubleClickRow }: CommitTreeRowListProps) {
  const { t } = useI18n()
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(480)
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = scrollRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box) setViewportHeight(box.height)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const selectedIndex = rows.findIndex((row) => row.path === selected)
  // 键盘移动选中后让目标行保持可见；点击选中本来就在视口内，scrollIntoView 是幂等的。
  useEffect(() => {
    if (!selected) return
    const node = scrollRef.current?.querySelector(`[data-path="${CSS.escape(selected)}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [rows, selected])
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onNavigate || !rows.length) return
    if (event.key === 'Enter' || event.key === ' ') {
      const row = rows.find((item) => item.path === selected)
      if (row) {
        event.preventDefault()
        onNavigate(row, false)
      }
      return
    }
    if (!NAVIGATION_KEYS.has(event.key)) return
    event.preventDefault()
    const nav = navigateTreeRows(rows, selectedIndex, event.key as TreeNavigationKey)
    if (nav.index === null) return
    const row = rows[nav.index]
    if (row) onNavigate(row, Boolean(nav.togglePath))
  }
  const window = computeTreeWindow(rows.length, scrollTop, viewportHeight, TREE_ROW_HEIGHT)
  const visible = rows.slice(window.start, window.end)
  return <div
    ref={scrollRef}
    className="commit-tree-scroll"
    role="tree"
    aria-label={label}
    tabIndex={0}
    onKeyDown={handleKeyDown}
    onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
  >
    {error && <div className="commit-tree-error">{error}</div>}
    {loading && <div className="commit-tree-empty">{t('repository.tree.loading')}</div>}
    {!loading && hasIndex && rows.length === 0 && <div className="commit-tree-empty">{query ? <>{t('repository.tree.noMatchPrefix')}{query}{t('repository.tree.noMatchSuffix')}</> : t('repository.tree.noTrackedFiles')}</div>}
    {rows.length > 0 && <>
      <div style={{ height: `${window.topSpacer}px` }}/>
      {visible.map((row) => <div
        key={row.key}
        role="treeitem"
        aria-expanded={row.hasChildren ? row.expanded : undefined}
        aria-selected={selected === row.path}
        data-path={row.path}
        className={`commit-tree-row ${selected === row.path ? 'active' : ''}`}
        style={{ paddingLeft: `${8 + row.depth * 12}px` }}
        title={row.path}
        onClick={() => onActivate(row)}
        onContextMenu={onRowContextMenu ? (event) => { event.preventDefault(); onRowContextMenu(row, event.clientX, event.clientY) } : undefined}
        onDoubleClick={() => onDoubleClickRow?.(row)}
      >
        {row.hasChildren
          ? <button type="button" className="tree-expander" aria-label={row.expanded ? t('repository.tree.collapseName', { name: row.name }) : t('repository.tree.expandName', { name: row.name })} onClick={(event) => { event.stopPropagation(); onActivate(row) }}>
            {row.expanded ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}
          </button>
          : <span className="tree-expander" aria-hidden="true"/>}
        {rowIcon(row.kind, row.name)}
        <span className="commit-tree-name">{row.name}</span>
        {row.loadingChildren && <span className="commit-tree-state">{t('repository.tree.reading')}</span>}
        {row.emptyChildren && row.hasChildren && <span className="commit-tree-state">{t('repository.tree.emptyDirectory')}</span>}
        {row.sizeBytes != null && <span className="commit-tree-size">{formatByteSize(row.sizeBytes)}</span>}
      </div>)}
      <div style={{ height: `${window.bottomSpacer}px` }}/>
      {window.end - window.start < rows.length && <div className="commit-tree-virtual-hint">{t('repository.tree.windowedPrefix')}{window.end - window.start} / {rows.length}{t('repository.tree.windowedSuffix')}</div>}
    </>}
  </div>
}

/** B2 审查评论接线包：调用方（CommitTreeBrowser）组装后整包传入。 */
export type TreeReviewWiring = {
  /** 当前预览文件中有线程的行号集合。 */
  lines: Set<number>
  activeLine: number | null
  /** 活动行上的线程（已按文件/ref 过滤排序）。 */
  threads: ReviewThread[]
  busy: boolean
  error: string | null
  onLineClick: (line: number) => void
  onCreate: (body: string) => void
  onReply: (threadId: string, body: string) => void
  onResolve: (threadId: string, resolved: boolean) => void
  onDelete: (threadId: string) => void
  onClose: () => void
}

export type CommitTreePreviewProps = {
  selected: string | null
  /** 选中行的 kind，用于把目录/子模组挡在预览请求之前。 */
  kind: string | null
  preview: RevisionFilePreview | null
  loading?: boolean
  error?: string | null
  onOpenExternally?: (filePath: string) => void
  /** 审查评论接线（B2）；不传则预览与原来完全一致。 */
  review?: TreeReviewWiring
}

/**
 * 右侧预览：文本截断展示、图片/SVG 交给 ImageDiffViewer（variant="single"），
 * 二进制、超大、目录、子模组各有一句人话，而不是甩一个后端错误。
 */
export function CommitTreePreview({ selected, kind, preview, loading, error, onOpenExternally, review }: CommitTreePreviewProps) {
  const { t } = useI18n()
  const imagePair: ImageFileDiff | null = preview?.media
    ? { path: preview.path, fromReference: '', toReference: preview.reference, before: null, after: preview.media, identical: false, error: null }
    : null
  const note = !selected
    ? t('repository.tree.selectHint')
    : kind === 'tree'
      ? t('repository.tree.directoryHint')
      : kind === 'commit'
        ? t('repository.tree.gitlinkHint')
        : null
  return <div className="commit-tree-preview">
    <div className="commit-tree-preview-header">
      <FileHeaderIcon name={selected ? selected.replace(/\\/g, '/').split('/').pop() ?? '' : ''}/>
      <code title={selected ?? undefined}>{selected ?? t('repository.tree.selectFile')}</code>
      {kind === 'tree' && <span>{t('repository.tree.directoryNotPreviewable')}</span>}
      {kind === 'commit' && <span>{t('repository.tree.gitlink')}</span>}
      {preview && <span>{formatByteSize(preview.sizeBytes)}{preview.truncated ? t('repository.tree.truncated') : ''}</span>}
      <span className="commit-tree-spacer"/>
      {selected && onOpenExternally && isPreviewableRow({ kind: kind ?? '' }) && <Button size="compact" onClick={() => onOpenExternally(selected)} title={t('repository.tree.openExternally')}><ExternalLink size={13}/><span>{t('repository.tree.externalOpen')}</span></Button>}
      {preview?.kind === 'text' && <Button size="compact" onClick={() => navigator.clipboard?.writeText(preview.text ?? '').catch(() => undefined)} title={t('repository.tree.copyContent')} aria-label={t('repository.tree.copyContent')}><Copy size={13}/></Button>}
    </div>
    <div className="commit-tree-preview-body">
      {note && <div className="commit-tree-preview-note">{note}</div>}
      {selected && loading && <div className="commit-tree-preview-note">{t('repository.tree.loadingContent')}</div>}
      {selected && !loading && error && <div className="commit-tree-error">{error}</div>}
      {selected && !loading && !note && preview?.kind === 'text' && <TreeCodePreview
        text={preview.text ?? ''}
        filePath={preview.path}
        threadLines={review?.lines}
        onLineNumberClick={review?.onLineClick}/>}
      {selected && !loading && !note && review && review.activeLine != null && <ReviewThreadPanel
        threads={review.threads}
        composeLine={review.activeLine}
        busy={review.busy}
        error={review.error}
        onCreate={review.onCreate}
        onReply={review.onReply}
        onResolve={review.onResolve}
        onDelete={review.onDelete}
        onClose={review.onClose}/>}
      {selected && !loading && !note && preview && !preview.media && (preview.kind === 'binary' || preview.kind === 'too_large') && (
        <div className="commit-tree-preview-note">
          {preview.kind === 'too_large'
            ? <>{t('repository.tree.tooLargeHint')}</>
            : <>{preview.error ?? t('repository.tree.notInlineHint')}</>}
        </div>
      )}
      {selected && !loading && !note && preview?.media && <ImageDiffViewer
        variant="single"
        path={preview.path}
        pair={imagePair}
        loading={false}
        error={null}
        onOpenExternally={onOpenExternally ? () => onOpenExternally(preview.path) : undefined}/>}
    </div>
  </div>
}
