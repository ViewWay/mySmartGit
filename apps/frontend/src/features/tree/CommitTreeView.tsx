import { useEffect, useRef, useState } from 'react'
import { Box, ChevronDown, ChevronRight, ExternalLink, FileText, Folder, Link2 } from 'lucide-react'
import { Button } from '../../components/Button'
import type { RevisionFilePreview } from '../../repository'
import { formatByteSize } from '../diff/imageDiffModel'
import { ImageDiffViewer } from '../diff/ImageDiffViewer'
import { computeTreeWindow, isPreviewableRow, type CommitTreeRow } from './commitTreeModel'
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
  return <div className="commit-tree-summary">
    {loaded
      ? <>已扫描 {partial ? <>≥ </> : ''}{nodeCount} 个条目{partial ? <> · <span className="commit-tree-lazy-flag">超出一次成树上限，已切换懒加载</span></> : ' · 已完整成树'}</>
      : loading ? '正在读取文件树…' : '尚未读取'}
    {visibleRows > 0 && <>{' · 可视 '}{visibleRows}</>}
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
}

function rowIcon(kind: string) {
  if (kind === 'tree') return <Folder size={12}/>
  if (kind === 'commit') return <Box size={12}/>
  if (kind === 'symlink') return <Link2 size={12}/>
  return <FileText size={12}/>
}

/**
 * 窗口化的行列表：滚动位置与视口高度都由本组件持有（它只依赖固定行高），
 * 渲染的永远只是可视区 + overscan，几万个节点也不会进 DOM。
 */
export function CommitTreeRowList({ rows, selected, error, loading, hasIndex, query, label, onActivate }: CommitTreeRowListProps) {
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
  const window = computeTreeWindow(rows.length, scrollTop, viewportHeight, TREE_ROW_HEIGHT)
  const visible = rows.slice(window.start, window.end)
  return <div
    ref={scrollRef}
    className="commit-tree-scroll"
    role="tree"
    aria-label={label}
    onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
  >
    {error && <div className="commit-tree-error">{error}</div>}
    {loading && <div className="commit-tree-empty">正在读取文件树…</div>}
    {!loading && hasIndex && rows.length === 0 && <div className="commit-tree-empty">{query ? <>没有匹配「{query}」的节点。</> : '该版本没有已跟踪的文件。'}</div>}
    {rows.length > 0 && <>
      <div style={{ height: `${window.topSpacer}px` }}/>
      {visible.map((row) => <div
        key={row.key}
        role="treeitem"
        aria-expanded={row.hasChildren ? row.expanded : undefined}
        aria-selected={selected === row.path}
        className={`commit-tree-row ${selected === row.path ? 'active' : ''}`}
        style={{ paddingLeft: `${8 + row.depth * 12}px` }}
        title={row.path}
        onClick={() => onActivate(row)}
      >
        {row.hasChildren
          ? <button type="button" className="tree-expander" aria-label={row.expanded ? `收起 ${row.name}` : `展开 ${row.name}`} onClick={(event) => { event.stopPropagation(); onActivate(row) }}>
            {row.expanded ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}
          </button>
          : <span className="tree-expander" aria-hidden="true"/>}
        {rowIcon(row.kind)}
        <span className="commit-tree-name">{row.name}</span>
        {row.loadingChildren && <span className="commit-tree-state">读取中…</span>}
        {row.emptyChildren && row.hasChildren && <span className="commit-tree-state">空目录</span>}
        {row.sizeBytes != null && <span className="commit-tree-size">{formatByteSize(row.sizeBytes)}</span>}
      </div>)}
      <div style={{ height: `${window.bottomSpacer}px` }}/>
      {window.end - window.start < rows.length && <div className="commit-tree-virtual-hint">窗口化渲染：当前只画 {window.end - window.start} / {rows.length} 行（滚动以加载其余部分）</div>}
    </>}
  </div>
}

export type CommitTreePreviewProps = {
  selected: string | null
  /** 选中行的 kind，用于把目录/子模组挡在预览请求之前。 */
  kind: string | null
  preview: RevisionFilePreview | null
  loading?: boolean
  error?: string | null
  onOpenExternally?: (filePath: string) => void
}

/**
 * 右侧预览：文本截断展示、图片/SVG 交给 ImageDiffViewer（variant="single"），
 * 二进制、超大、目录、子模组各有一句人话，而不是甩一个后端错误。
 */
export function CommitTreePreview({ selected, kind, preview, loading, error, onOpenExternally }: CommitTreePreviewProps) {
  const imagePair: ImageFileDiff | null = preview?.media
    ? { path: preview.path, fromReference: '', toReference: preview.reference, before: null, after: preview.media, identical: false, error: null }
    : null
  const note = !selected
    ? '点击左侧任意文件查看该版本下的内容；图片与 SVG 会直接预览。'
    : kind === 'tree'
      ? '目录没有内容可预览，请展开后选择其中的文件。'
      : kind === 'commit'
        ? '这是子模组指针（gitlink），指向另一个仓库的提交，本身没有文件内容。'
        : null
  return <div className="commit-tree-preview">
    <div className="commit-tree-preview-header">
      <FileText size={13}/>
      <code title={selected ?? undefined}>{selected ?? '选择左侧文件查看内容'}</code>
      {kind === 'tree' && <span>目录不可预览</span>}
      {kind === 'commit' && <span>子模组指针</span>}
      {preview && <span>{formatByteSize(preview.sizeBytes)}{preview.truncated ? ' · 已截断' : ''}</span>}
      <span className="commit-tree-spacer"/>
      {selected && onOpenExternally && isPreviewableRow({ kind: kind ?? '' }) && <Button size="compact" onClick={() => onOpenExternally(selected)} title="用系统默认程序打开"><ExternalLink size={13}/><span>外部打开</span></Button>}
    </div>
    <div className="commit-tree-preview-body">
      {note && <div className="commit-tree-preview-note">{note}</div>}
      {selected && loading && <div className="commit-tree-preview-note">正在读取内容…</div>}
      {selected && !loading && error && <div className="commit-tree-error">{error}</div>}
      {selected && !loading && !note && preview?.kind === 'text' && <pre>{preview.text ?? ''}</pre>}
      {selected && !loading && !note && preview && !preview.media && (preview.kind === 'binary' || preview.kind === 'too_large') && (
        <div className="commit-tree-preview-note">
          {preview.kind === 'too_large'
            ? <>文件超过预览上限（只读了元数据），不适合内联展示，可用外部程序打开。</>
            : <>{preview.error ?? '该文件不适合内联预览，可用外部程序打开。'}</>}
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
