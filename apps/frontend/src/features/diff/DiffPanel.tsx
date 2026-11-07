import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type UIEvent } from 'react'
import { AlignJustify, ArrowDown, ArrowRight, ArrowUp, Columns2, Copy, FileCode2, FileText, FolderOpen, History, List, Maximize2, Minimize2, Minus, Plus, RotateCcw, Undo2, ScanText, Search, X, Check, EyeOff } from 'lucide-react'
import { ContextMenu } from '../../components/ContextMenu'
import { Button } from '../../components/Button'
import { loadRepositoryFileDiff, cancelMediaPreview, type ImageFileDiff, type RepositoryDiffLine, type RepositoryFile } from '../../repository'
import { DiffFileList } from './DiffFileList'
import { HighlightedCode } from './HighlightedCode'
import { useDiffHighlights } from '../../syntax/diffHighlights'
import { ImageDiffViewer } from './ImageDiffViewer'
import { createMediaRequestId, mediaTargetKey, planMediaRequest } from './imageDiffModel'
import { buildDiffContextEntries, type DiffContextEntry } from './diffContext'
import { isBooleanRecord, usePersistentState } from '../../persistentState'
import { useI18n } from '../../i18n'
import { usePreferences } from '../../preferences'
import { buildLineHeights, buildOffsets, indexAtOffset, offsetAtIndex } from './wrapModel'
import { readCodeGeometry, useCodeMeasurer } from './useCodeMeasurer'
import { ReviewThreadPanel } from '../review/ReviewThreadPanel'
import { threadsForFile, threadLineSet } from '../review/reviewModel'
import type { ReviewThread, ReviewThreadSide } from '@branchline/git-models'

const useBrowserLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect

type SplitDiffRow = { left?: RepositoryDiffLine; right?: RepositoryDiffLine }
type SplitDiffEntry = { kind: 'row'; row: SplitDiffRow } | { kind: 'omitted'; count: number }
export type DiffLineSide = 'old' | 'new'

/**
 * B3 审查评论接线包：宿主（App）组装后整包传入；不传则 DiffPanel 与原来完全一致。
 * threads 为该仓库全部线程（宿主经 useReviewThreads 加载），面板内部按文件/ref 过滤。
 */
export type DiffReviewWiring = {
  /** 线程锚定的版本 ref（提交 hash / 分支 / 'worktree'）。 */
  reference: string
  threads: ReviewThread[]
  busy: boolean
  error: string | null
  onCreate: (input: { filePath: string; line: number; side: DiffLineSide; body: string }) => void
  onReply: (threadId: string, body: string) => void
  onResolve: (threadId: string, resolved: boolean) => void
  onDelete: (threadId: string) => void
  onClose: () => void
}

type PendingDiffJump = { edge: 'first' | 'last'; direction: -1 | 1; remaining: number }

export function buildStagePatch(filePath: string, rows: RepositoryDiffLine[], fileType?: string, operation: 'stage' | 'restore' | 'unstage' = 'stage', sourceRows?: RepositoryDiffLine[]) {
  if (sourceRows) {
    // A large unchanged interval may be omitted by Git. Preserve those gaps
    // as separate hunks rather than concatenating distant file coordinates.
    const segments: RepositoryDiffLine[][] = [[]]
    let previousOld: number | null = null
    let previousNew: number | null = null
    for (const row of sourceRows) {
      if ((row.old != null && previousOld != null && row.old > previousOld + 1)
        || (row.next != null && previousNew != null && row.next > previousNew + 1)) segments.push([])
      segments[segments.length - 1].push(row)
      if (row.old != null) previousOld = row.old
      if (row.next != null) previousNew = row.next
    }
    if (segments.length > 1) {
      const selectedRows = new Set(rows.filter((row) => row.kind !== 'same'))
      const patches: string[] = segments.flatMap((segment) => {
        const selected = segment.filter((row) => selectedRows.has(row))
        return selected.length ? [buildStagePatch(filePath, selected, undefined, operation, segment)] : []
      })
      return patches.map((patch, index) => index ? patch.slice(patch.indexOf('\n@@') + 1) : patch).join('')
    }
    const selected = new Set(rows.filter((row) => row.kind !== 'same'))
    const reverse = operation !== 'stage'
    const context = (row: RepositoryDiffLine): RepositoryDiffLine => ({
      ...row, kind: 'same',
      code: reverse ? row.newCode ?? row.code : row.oldCode ?? row.code,
      oldCode: reverse ? row.newCode ?? row.code : row.oldCode ?? row.code,
      newCode: reverse ? row.newCode ?? row.code : row.oldCode ?? row.code,
      oldNoNewline: reverse ? row.newNoNewline : row.oldNoNewline,
      newNoNewline: reverse ? row.newNoNewline : row.oldNoNewline,
    })
    const patchRows: RepositoryDiffLine[] = []
    for (let index = 0; index < sourceRows.length;) {
      if (sourceRows[index].kind === 'same') { patchRows.push(context(sourceRows[index++])); continue }
      const removed: RepositoryDiffLine[] = []
      const added: RepositoryDiffLine[] = []
      while (index < sourceRows.length && sourceRows[index].kind !== 'same') {
        const row = sourceRows[index++]
        ;(row.kind === 'del' ? removed : added).push(row)
      }
      for (let offset = 0; offset < Math.max(removed.length, added.length); offset++) {
        const oldRow = removed[offset]
        const newRow = added[offset]
        if (oldRow && selected.has(oldRow)) patchRows.push(oldRow)
        else if (oldRow && !reverse) patchRows.push(context(oldRow))
        if (newRow && selected.has(newRow)) patchRows.push(newRow)
        else if (newRow && reverse) patchRows.push(context(newRow))
      }
    }
    let lastOld = -1
    let lastNew = -1
    patchRows.forEach((row, index) => {
      if (row.kind !== 'add') lastOld = index
      if (row.kind !== 'del') lastNew = index
    })
    const normalized = patchRows.flatMap((row, index): RepositoryDiffLine[] => {
      const oldNoNewline = index === lastOld && Boolean(row.oldNoNewline)
      const newNoNewline = index === lastNew && Boolean(row.newNoNewline)
      // A formerly unterminated last line needs a newline when another selected
      // line follows it. Encode that boundary change instead of concatenating.
      if (row.kind === 'same' && oldNoNewline !== newNoNewline) return [
        { ...row, kind: 'del', oldNoNewline, newNoNewline: false },
        { ...row, kind: 'add', oldNoNewline: false, newNoNewline },
      ]
      return [{ ...row, oldNoNewline, newNoNewline }]
    })
    // Rebase both sides onto the actual apply target. Unselected additions or
    // deletions must not leak their original line offsets into a partial patch.
    let oldLine = sourceRows.find((row) => row.old != null)?.old ?? 1
    let newLine = reverse ? sourceRows.find((row) => row.next != null)?.next ?? 1 : oldLine
    if (reverse) oldLine = newLine
    const rebased = normalized.map((row) => ({ ...row, old: row.kind === 'add' ? null : oldLine++, next: row.kind === 'del' ? null : newLine++ }))
    return buildStagePatch(filePath, rebased, fileType, operation)
  }
  const selected = rows.filter((row) => row.kind !== 'same')
  if (!selected.length) return ''
  const oldValues = rows.filter((row) => row.kind === 'del' || row.kind === 'same')
  const newValues = rows.filter((row) => row.kind === 'add' || row.kind === 'same')
  const first = rows[0] ?? selected[0]
  // A zero-length unified-diff range points at the line before the insertion/deletion.
  const oldCount = oldValues.length
  const newCount = newValues.length
  const firstOldLine = rows.find((row) => row.old != null)?.old
  const firstNewLine = rows.find((row) => row.next != null)?.next
  const oldStart = oldCount ? (firstOldLine ?? 1) : Math.max(0, (first.next ?? 1) - 1)
  const newStart = newCount ? (firstNewLine ?? 1) : Math.max(0, (first.old ?? 1) - 1)
  const body = rows.map((row) => {
    const code = row.kind === 'same'
      ? operation === 'stage' ? row.oldCode ?? row.code : row.newCode ?? row.code
      : row.kind === 'del' ? row.oldCode ?? row.code : row.newCode ?? row.code
    const noNewline = row.kind === 'del' ? row.oldNoNewline : row.kind === 'add' ? row.newNoNewline : operation === 'stage' ? row.oldNoNewline : row.newNoNewline
    return `${row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}${code}${noNewline ? '\n\\ No newline at end of file' : ''}`
  }).join('\n')
  const isNewFile = fileType === 'A' && oldCount === 0
  const isDeletedFile = fileType === 'D' && newCount === 0
  const header = isNewFile
    ? `new file mode 100644\n--- /dev/null\n+++ b/${filePath}`
    : isDeletedFile
      ? `deleted file mode 100644\n--- a/${filePath}\n+++ /dev/null`
      : `--- a/${filePath}\n+++ b/${filePath}`
  return `diff --git a/${filePath} b/${filePath}\n${header}\n@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${body}\n`
}

export function changeBlock(rows: RepositoryDiffLine[], index: number) {
  if (!rows[index] || rows[index].kind === 'same') return []
  let start = index
  let end = index
  while (start > 0 && rows[start - 1].kind !== 'same') start -= 1
  while (end + 1 < rows.length && rows[end + 1].kind !== 'same') end += 1
  // Keep a small amount of surrounding context so Git can anchor the patch
  // at the exact hunk instead of applying a context-free change elsewhere.
  const context = 3
  let contextStart = start
  let contextEnd = end
  while (contextStart > 0 && start - contextStart < context && rows[contextStart - 1].kind === 'same') contextStart -= 1
  while (contextEnd + 1 < rows.length && contextEnd - end < context && rows[contextEnd + 1].kind === 'same') contextEnd += 1
  return rows.slice(contextStart, contextEnd + 1)
}

export function changeLine(rows: RepositoryDiffLine[], index: number) {
  const changed = rows[index]
  if (!changed || changed.kind === 'same') return []
  let changeStart = index
  let changeEnd = index
  while (changeStart > 0 && rows[changeStart - 1].kind !== 'same') changeStart -= 1
  while (changeEnd + 1 < rows.length && rows[changeEnd + 1].kind !== 'same') changeEnd += 1

  const changedRows = rows.slice(changeStart, changeEnd + 1)
  const deletedRows = changedRows.filter((row) => row.kind === 'del')
  const addedRows = changedRows.filter((row) => row.kind === 'add')
  const matchingRows = changed.kind === 'del' ? deletedRows : addedRows
  const matchingIndex = matchingRows.indexOf(changed)
  const counterpart = changed.kind === 'del' ? addedRows[matchingIndex] : deletedRows[matchingIndex]
  const selected = new Set([changed, counterpart].filter((row): row is RepositoryDiffLine => Boolean(row)))

  // A multi-line change needs a precise row patch. Add context only when the
  // selected row already represents the complete contiguous change segment.
  if (selected.size !== changedRows.length) return changedRows.filter((row) => selected.has(row))

  const context = 3
  const before: RepositoryDiffLine[] = []
  for (let cursor = changeStart - 1; cursor >= 0 && before.length < context; cursor -= 1) {
    if (rows[cursor].kind !== 'same') break
    before.unshift(rows[cursor])
  }
  const selectedRows = changedRows.filter((row) => selected.has(row))
  const after: RepositoryDiffLine[] = []
  for (let cursor = changeEnd + 1; cursor < rows.length && after.length < context; cursor += 1) {
    if (rows[cursor].kind !== 'same') break
    after.push(rows[cursor])
  }
  return [...before, ...selectedRows, ...after]
}

const DIFF_FONT_SIZE_KEY = 'branchline.diffFontSize.v1'
const DEFAULT_DIFF_FONT_SIZE = 12
const MIN_DIFF_FONT_SIZE = 9
const MAX_DIFF_FONT_SIZE = 22
const DIFF_VIRTUALIZATION_THRESHOLD = 300
const DIFF_VIRTUAL_OVERSCAN = 24
const DIFF_BLOCK_ACTION_HEIGHT = 40
const EMPTY_FALLBACK_ROWS: Record<string, RepositoryDiffLine[]> = {}
const EMPTY_DIFF_ROWS: RepositoryDiffLine[] = []

export function diffReflowScrollTop(previous: number[], offsets: number[], scrollTop: number, viewportHeight: number, trailingSpace = 0) {
  const index = indexAtOffset(previous, scrollTop)
  const previousHeight = offsetAtIndex(previous, index + 1) - offsetAtIndex(previous, index)
  const fraction = previousHeight > 0 ? Math.min(1, Math.max(0, (scrollTop - offsetAtIndex(previous, index)) / previousHeight)) : 0
  const next = offsetAtIndex(offsets, index) + fraction * (offsetAtIndex(offsets, index + 1) - offsetAtIndex(offsets, index))
  return Math.max(0, Math.min(next, offsetAtIndex(offsets, offsets.length - 1) + trailingSpace - viewportHeight))
}

export function diffScrollTarget(offsets: number[], index: number, viewportHeight: number) {
  return Math.max(0, offsetAtIndex(offsets, index) - viewportHeight / 2)
}

export function diffVirtualWindow(offsets: number[], scrollTop: number, viewportHeight: number, overscan: number) {
  const count = Math.max(0, offsets.length - 1)
  const top = Math.max(0, Math.min(scrollTop, offsetAtIndex(offsets, count) - viewportHeight))
  return {
    start: indexAtOffset(offsets, Math.max(0, top - overscan)),
    end: Math.min(count, indexAtOffset(offsets, top + viewportHeight + overscan) + 1),
  }
}

export function diffActionEdgeSpace(rowHeight: number, toolbarHeight: number) {
  return Math.max(0, toolbarHeight - rowHeight)
}

export function diffSplitRowHeight(fontSize: number, stageActionsEnabled = true) {
  return Math.max(stageActionsEnabled ? 24 : 20, Math.ceil(fontSize * 1.5 + 6))
}

export function shouldRenderLoadedRows(usesLoader: boolean, loadedIdentity: string | null, activeIdentity: string | null) {
  return !usesLoader || Boolean(activeIdentity && loadedIdentity === activeIdentity)
}

export type DiffOverviewEntry =
  | { kind: 'same' | 'add' | 'del'; height?: number }
  | { oldKind: 'same' | 'add' | 'del'; newKind: 'same' | 'add' | 'del'; height?: number }

export type DiffOverviewMarker = {
  index: number
  top: number
  height: number
  kind: 'add' | 'del'
  column: 'unified' | 'old' | 'new'
}

function overviewSideKind(entry: DiffOverviewEntry, side: 'old' | 'new' | 'unified') {
  if (side === 'unified' && 'kind' in entry) return entry.kind
  if (side === 'old' && 'oldKind' in entry) return entry.oldKind
  if (side === 'new' && 'newKind' in entry) return entry.newKind
  return 'same' as const
}

function overviewMarkersForSide(entries: DiffOverviewEntry[], side: 'old' | 'new' | 'unified'): DiffOverviewMarker[] {
  if (!entries.length) return []
  const markers: DiffOverviewMarker[] = []
  const weights = entries.map((entry) => Number.isFinite(entry.height) && (entry.height ?? 0) > 0 ? entry.height! : 1)
  const totalHeight = weights.reduce((total, height) => total + height, 0)
  let start = -1
  let kind: 'add' | 'del' | null = null
  let startOffset = 0
  let segmentHeight = 0
  let offset = 0
  const flush = () => {
    if (start < 0 || !kind) return
    markers.push({
      index: start,
      top: Number((startOffset / totalHeight * 100).toFixed(1)),
      height: Number((segmentHeight / totalHeight * 100).toFixed(1)),
      kind,
      column: side,
    })
    start = -1
    kind = null
    segmentHeight = 0
  }
  entries.forEach((entry, index) => {
    const nextKind = overviewSideKind(entry, side)
    if (nextKind === 'same') {
      flush()
      offset += weights[index]
      return
    }
    if (start >= 0 && kind !== nextKind) flush()
    if (start < 0) {
      start = index
      kind = nextKind
      startOffset = offset
    }
    segmentHeight += weights[index]
    offset += weights[index]
  })
  flush()
  return markers
}

export function diffOverviewMarkers(entries: DiffOverviewEntry[], view: 'unified' | 'split'): DiffOverviewMarker[] {
  return view === 'unified'
    ? overviewMarkersForSide(entries, 'unified')
    : [...overviewMarkersForSide(entries, 'old'), ...overviewMarkersForSide(entries, 'new')]
}

export function diffOverviewViewport(scrollTop: number, scrollHeight: number, clientHeight: number, headerHeight = 0) {
  const contentHeight = Math.max(0, scrollHeight - headerHeight)
  const viewportHeight = Math.max(0, clientHeight - headerHeight)
  const scrollable = Math.max(0, scrollHeight - clientHeight)
  if (contentHeight <= 0 || viewportHeight >= contentHeight || scrollable <= 0) return { top: 0, height: 100 }
  const height = Math.min(100, viewportHeight / contentHeight * 100)
  const top = Math.max(0, Math.min(100 - height, scrollTop / scrollable * (100 - height)))
  return { top, height }
}

export function diffOverviewBounds(viewerTop: number, viewerHeight: number, paneTop: number, paneBorderTop: number, paneClientHeight: number, headerHeight: number) {
  const viewportTop = paneTop - viewerTop + paneBorderTop
  return {
    top: Math.max(0, viewportTop + headerHeight),
    bottom: Math.max(0, viewerHeight - viewportTop - paneClientHeight),
  }
}

export function shouldJumpToFirstChange(scope: 'file' | 'changes', identity: string, previousIdentity: string | null, hasPendingJump = false, canRenderRows = true) {
  return scope === 'file' && !hasPendingJump && canRenderRows && identity !== previousIdentity
}


const isFileMode = (value: unknown): value is 'list' | 'tree' => value === 'list' || value === 'tree'
const isDiffView = (value: unknown): value is 'unified' | 'split' => value === 'unified' || value === 'split'
const isDiffScope = (value: unknown): value is 'file' | 'changes' => value === 'file' || value === 'changes'

function initialDiffFontSize(storageKey: string, defaultSize: number) {
  const stored = Number(window.localStorage.getItem(storageKey))
  return Number.isFinite(stored) && stored >= MIN_DIFF_FONT_SIZE && stored <= MAX_DIFF_FONT_SIZE
    ? stored
    : Math.min(MAX_DIFF_FONT_SIZE, Math.max(MIN_DIFF_FONT_SIZE, defaultSize))
}

function buildSplitRows(rows: RepositoryDiffLine[]): SplitDiffRow[] {
  const result: SplitDiffRow[] = []
  let index = 0
  while (index < rows.length) {
    const row = rows[index]
    if (row.kind === 'same') {
      result.push({ left: row, right: row })
      index += 1
      continue
    }
    const deleted: RepositoryDiffLine[] = []
    const added: RepositoryDiffLine[] = []
    while (index < rows.length && rows[index].kind !== 'same') {
      if (rows[index].kind === 'del') deleted.push(rows[index])
      else added.push(rows[index])
      index += 1
    }
    for (let offset = 0; offset < Math.max(deleted.length, added.length); offset += 1) {
      result.push({ left: deleted[offset], right: added[offset] })
    }
  }
  return result
}

function buildSplitEntries(entries: DiffContextEntry[]): SplitDiffEntry[] {
  const result: SplitDiffEntry[] = []
  let buffer: RepositoryDiffLine[] = []
  const flush = () => {
    if (!buffer.length) return
    buildSplitRows(buffer).forEach((row) => result.push({ kind: 'row', row }))
    buffer = []
  }
  entries.forEach((entry) => {
    if (entry.kind === 'omitted') {
      flush()
      result.push(entry)
    } else {
      buffer.push(entry.row)
    }
  })
  flush()
  return result
}

function unifiedEntryRow(entries: DiffContextEntry[], index: number) {
  const entry = entries[index]
  return entry?.kind === 'line' ? entry.row : undefined
}

function splitEntryRow(entries: SplitDiffEntry[], index: number, side: DiffLineSide) {
  const entry = entries[index]
  if (entry?.kind !== 'row') return undefined
  return side === 'old' ? entry.row.left : entry.row.right
}

type DiffPanelProps = {
  files: RepositoryFile[]
  repositoryPath?: string
  wide: boolean
  onWideChange: (value: boolean) => void
  initialFile?: number
  onActiveFileChange?: (index: number) => void
  onClose?: () => void
  hideFileList?: boolean
  loadRows?: (filePath: string, fileIndex: number | undefined, showWhitespace: boolean) => Promise<RepositoryDiffLine[]>
  viewKey?: string
  reloadKey?: string
  fallbackRows?: Record<string, RepositoryDiffLine[]>
  fallbackChangeRows?: RepositoryDiffLine[]
  onOpenLineHistory?: (filePath: string, line: number, side: DiffLineSide, row: RepositoryDiffLine) => void
  onStagePatch?: (filePath: string, patch: string, description: string) => void
  onRestorePatch?: (filePath: string, patch: string, description: string) => void
  onUnstagePatch?: (filePath: string, patch: string, description: string) => void
  /**
   * 宿主注入的「变更前/变更后」图片配对读取。未提供时 DiffPanel 行为与原来完全一致，
   * 这样既有的所有调用点（暂存区 / 提交 / 比较 / stash）都不会被影响。
   */
  loadImageDiff?: (filePath: string) => Promise<ImageFileDiff>
  /** 「用外部程序打开」入口，需要后端 open_revision_file_externally 命令。 */
  onOpenFileExternally?: (filePath: string) => void
  actionScope?: 'staged' | 'unstaged'
  actionsBusy?: boolean
  allowStage?: boolean
  defaultFontSize?: number
  fontSizeStorageKey?: string
  /** B3 审查评论接线（可选）；未提供时行号无点击行为、面板不渲染。 */
  review?: DiffReviewWiring
}

export function DiffPanel({ files, repositoryPath, wide, onWideChange, initialFile = 0, onActiveFileChange, onClose, hideFileList = false, loadRows, viewKey = '', reloadKey = '', fallbackRows = EMPTY_FALLBACK_ROWS, fallbackChangeRows = EMPTY_DIFF_ROWS, onOpenLineHistory, onStagePatch, onRestorePatch, onUnstagePatch, loadImageDiff, onOpenFileExternally, actionScope, actionsBusy = false, allowStage = false, defaultFontSize = DEFAULT_DIFF_FONT_SIZE, fontSizeStorageKey = DIFF_FONT_SIZE_KEY, review }: DiffPanelProps) {
  const { t } = useI18n()
  const preferences = usePreferences()
  const wrapEnabled = preferences.wordWrap
  const [codeGeometry, setCodeGeometry] = useState<{ left: ReturnType<typeof readCodeGeometry> | null; right: ReturnType<typeof readCodeGeometry> | null; viewportHeight: number }>({ left: null, right: null, viewportHeight: 800 })
  const [activeFile, setActiveFile] = useState(initialFile)
  const [view, setView] = usePersistentState('branchline.diffView.v1', 'unified', isDiffView)
  const [showWhitespace, setShowWhitespace] = usePersistentState('branchline.diffShowWhitespace.v1', true, (value): value is boolean => typeof value === 'boolean')
  const [scope, setScope] = usePersistentState('branchline.diffScope.v1', 'changes', isDiffScope)
  const [fileMode, setFileMode] = usePersistentState('branchline.diffFileMode.v1', 'list', isFileMode)
  const [collapsedFolders, setCollapsedFolders] = usePersistentState('branchline.diffCollapsedFolders.v1', {}, isBooleanRecord)
  const [repositoryRows, setRepositoryRows] = useState<RepositoryDiffLine[]>([])
  const [loadedFileIdentity, setLoadedFileIdentity] = useState<string | null>(null)
  const [loadedRowsKey, setLoadedRowsKey] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffFontSize, setDiffFontSize] = useState(() => initialDiffFontSize(fontSizeStorageKey, defaultFontSize))
  const [lineMenu, setLineMenu] = useState<{ rowIndex: number; sourceIndex: number; side: DiffLineSide; line: number; code: string; x: number; y: number } | null>(null)
  const [activeChange, setActiveChange] = useState<{ fileIndex: number; rowIndex: number } | null>(null)
  const [pendingJump, setPendingJump] = useState<PendingDiffJump | null>(null)
  const autoJumpIdentity = useRef<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)
  const [virtualScrollTop, setVirtualScrollTop] = useState(0)
  const [overviewViewport, setOverviewViewport] = useState({ top: 0, height: 100 })
  const [overviewBounds, setOverviewBounds] = useState({ top: 0, bottom: 0 })
  const searchInputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const codeDiffRef = useRef<HTMLDivElement>(null)
  const pointerInside = useRef(false)
  const rowsCache = useRef(new Map<string, RepositoryDiffLine[]>())
  const splitLeftRef = useRef<HTMLDivElement>(null)
  const splitRightRef = useRef<HTMLDivElement>(null)
  const splitActionsRef = useRef<HTMLDivElement>(null)
  const overviewRef = useRef<HTMLDivElement>(null)
  const overviewDragging = useRef(false)
  // Mirroring one split pane onto the other makes the browser fire that pane's own scroll event. What
  // that event reports is the offset the browser actually stored, which can differ from what was
  // written, so an equality check against the other pane cannot tell the echo apart from a real user
  // scroll. The requested offset is remembered per pane instead and the echo is recognised by it.
  const splitScrollEcho = useRef<{ side: 'left' | 'right'; top: number } | null>(null)
  const virtualScrollFrame = useRef(0)
  const pendingVirtualScrollTop = useRef(0)
  useEffect(() => {
    setActiveFile(initialFile)
    setActiveChange(null)
    setPendingJump(null)
  }, [initialFile])
  useEffect(() => {
    rowsCache.current.clear()
  }, [loadRows, repositoryPath])
  useEffect(() => {
    const file = files[activeFile]
    const loader = loadRows ?? (repositoryPath ? (path: string, _index: number | undefined, whitespace: boolean) => loadRepositoryFileDiff(repositoryPath, path, whitespace) : null)
    if (!file || !loader) {
      setRepositoryRows([])
      setLoadedFileIdentity(null)
      setDiffError(null)
      setDiffLoading(false)
      return
    }
    const fileIdentity = `${viewKey}\0${activeFile}\0${file.path}`
    const cacheKey = `${fileIdentity}\0${reloadKey}\0${showWhitespace}`
    const cachedRows = rowsCache.current.get(cacheKey)
    if (cachedRows) {
      setRepositoryRows(cachedRows)
      setLoadedFileIdentity(fileIdentity)
      setLoadedRowsKey(cacheKey)
      setDiffError(null)
      setDiffLoading(false)
      return
    }
    let cancelled = false
    setDiffLoading(true)
    setDiffError(null)
    loader(file.path, activeFile, showWhitespace)
      .then((rows) => { if (!cancelled) { rowsCache.current.set(cacheKey, rows); setRepositoryRows(rows); setLoadedFileIdentity(fileIdentity); setLoadedRowsKey(cacheKey) } })
      .catch((error) => { if (!cancelled) setDiffError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (!cancelled) setDiffLoading(false) })
    return () => { cancelled = true }
  }, [activeFile, files, loadRows, reloadKey, repositoryPath, showWhitespace, viewKey])
  useEffect(() => {
    window.localStorage.setItem(fontSizeStorageKey, String(diffFontSize))
  }, [diffFontSize, fontSizeStorageKey])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey
      if (!modifier) return
      const panel = panelRef.current
      const activePanel = pointerInside.current || Boolean(panel?.contains(document.activeElement)) || document.querySelectorAll('.diff-panel').length === 1
      if (!activePanel) return
      const increase = event.key === '+' || event.key === '=' || event.code === 'NumpadAdd'
      const decrease = event.key === '-' || event.code === 'NumpadSubtract'
      const reset = event.key === '0' || event.code === 'Numpad0'
      if (!increase && !decrease && !reset) return
      event.preventDefault()
      if (reset) setDiffFontSize(defaultFontSize)
      else setDiffFontSize((value) => Math.min(MAX_DIFF_FONT_SIZE, Math.max(MIN_DIFF_FONT_SIZE, value + (increase ? 1 : -1))))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [defaultFontSize])
  const activeFileInfo = files[activeFile]
  const activeFileIdentity = activeFileInfo ? `${viewKey}\0${activeFile}\0${activeFileInfo.path}` : null
  // --- 图片 / SVG 差异预览（仅在宿主注入 loadImageDiff 时启用；判定与请求计划见 imageDiffModel.ts） ---
  const [mediaAsText, setMediaAsText] = useState(false)
  const [mediaRetry, setMediaRetry] = useState(0)
  const [imagePair, setImagePair] = useState<ImageFileDiff | null>(null)
  const [imageLoading, setImageLoading] = useState(false)
  const [imageError, setImageError] = useState<string | null>(null)
  const mediaRequestId = useRef<string | null>(null)
  const mediaActiveKey = useRef<string | null>(null)
  // 宿主普遍传内联箭头函数，函数身份每次渲染都在变：收进 ref，
  // 请求只由 mediaTargetKey（文件/重试/刷新）驱动，否则 StrictMode 与父组件重渲染都会把 IPC 打成循环。
  const mediaLoader = useRef(loadImageDiff)
  mediaLoader.current = loadImageDiff
  const mediaPath = activeFileInfo?.path ?? null
  const mediaTarget = mediaTargetKey({
    loaderProvided: Boolean(loadImageDiff),
    path: mediaPath,
    identity: activeFileIdentity,
    retry: mediaRetry,
    reloadKey,
    asText: mediaAsText,
  })
  useEffect(() => {
    setMediaAsText(false)
  }, [activeFileIdentity])
  useEffect(() => {
    const action = planMediaRequest(mediaTarget, mediaActiveKey.current)
    if (action === 'reuse') return
    if (action === 'reset' || !mediaTarget || !mediaPath) {
      mediaActiveKey.current = null
      mediaRequestId.current = null
      setImagePair(null)
      setImageError(null)
      setImageLoading(false)
      return
    }
    const loader = mediaLoader.current
    if (!loader) return
    mediaActiveKey.current = mediaTarget
    const requestId = createMediaRequestId(mediaPath, viewKey)
    mediaRequestId.current = requestId
    setImageLoading(true)
    setImageError(null)
    setImagePair(null)
    loader(mediaPath)
      .then((result) => {
        // 迟到的响应（用户已切走）直接丢弃，并通知后端取消。
        if (mediaRequestId.current !== requestId) { void cancelMediaPreview(requestId); return }
        setImagePair(result)
      })
      .catch((reason: unknown) => {
        if (mediaRequestId.current !== requestId) return
        setImageError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (mediaRequestId.current === requestId) setImageLoading(false)
      })
    return () => {
      // 组件卸载 / 换文件 / 关面板都让后端尽早停手，避免大图片继续占内存。
      // 同时把 key 清空：这条请求已经作废，不能让它冒充「已加载」。
      if (mediaRequestId.current === requestId) {
        mediaRequestId.current = null
        mediaActiveKey.current = null
        void cancelMediaPreview(requestId)
      }
    }
  }, [mediaPath, mediaTarget, viewKey])
  const usesMediaView = Boolean(mediaTarget)
  const usesLoader = Boolean(loadRows || repositoryPath)
  const sourceRows = usesLoader ? repositoryRows : (activeFileInfo ? (fallbackRows[activeFileInfo.path] ?? fallbackChangeRows) : EMPTY_DIFF_ROWS)
  const diffHighlights = useDiffHighlights(sourceRows, activeFileInfo?.path ?? '')
  const canStage = actionScope !== 'staged' && (allowStage || actionScope === 'unstaged')
  const canUnstage = actionScope === 'staged' && Boolean(onUnstagePatch)
  const stageActionsEnabled = canUnstage || (canStage && Boolean(onStagePatch || onRestorePatch))
  const expectedRowsKey = [activeFileIdentity, reloadKey, showWhitespace].join('\0')
  const actionsDisabled = actionsBusy || diffLoading || (usesLoader && loadedRowsKey !== expectedRowsKey)
  const lineNumberDigits = sourceRows.reduce((digits, row) => Math.max(digits, String(Math.max(row.old ?? 0, row.next ?? 0)).length), 1)

  // B3 审查评论：行号点击开/关评论区；线程按当前文件 + ref 过滤，新旧行号分开标记。
  const [reviewAnchor, setReviewAnchor] = useState<{ line: number; side: ReviewThreadSide } | null>(null)
  useEffect(() => { setReviewAnchor(null) }, [activeFile, viewKey])
  const fileReviewThreads = useMemo(
    () => (review && activeFileInfo ? threadsForFile(review.threads, review.reference, activeFileInfo.path) : []),
    [review, activeFileInfo],
  )
  const reviewLineMarks = useMemo(() => ({
    old: threadLineSet(fileReviewThreads.filter((thread) => thread.side === 'old')),
    new: threadLineSet(fileReviewThreads.filter((thread) => thread.side === 'new')),
  }), [fileReviewThreads])
  const activeReviewThreads = useMemo(() => (
    reviewAnchor
      ? fileReviewThreads.filter((thread) => thread.line === reviewAnchor.line && thread.side === reviewAnchor.side)
      : []
  ), [fileReviewThreads, reviewAnchor])
  const toggleReviewAnchor = (line: number, side: ReviewThreadSide) => {
    setReviewAnchor((current) => (current && current.line === line && current.side === side ? null : { line, side }))
  }
  /** 行号格子的类名与点击行为：仅当接入审查时才可点。 */
  const renderLineNo = (side: ReviewThreadSide, line: number | null) => {
    if (!review) return { className: 'line-no', onClick: undefined, title: undefined }
    const marked = line != null && reviewLineMarks[side].has(line)
    return {
      className: `line-no${marked ? ' has-review' : ''} review-clickable`,
      onClick: line != null ? () => toggleReviewAnchor(line, side) : undefined,
      title: t('review.diffClickHint'),
    }
  }
  const contextEntries = useMemo(() => buildDiffContextEntries(sourceRows), [sourceRows])
  const unifiedEntries = useMemo<DiffContextEntry[]>(() => scope === 'file'
    ? sourceRows.map((row, sourceIndex) => ({ kind: 'line', row, sourceIndex }))
    : contextEntries, [contextEntries, scope, sourceRows])
  const sourceSplitRows = useMemo(() => buildSplitRows(sourceRows), [sourceRows])
  const splitEntries = useMemo<SplitDiffEntry[]>(() => scope === 'file'
    ? sourceSplitRows.map((row) => ({ kind: 'row', row }))
    : buildSplitEntries(contextEntries), [contextEntries, scope, sourceSplitRows])
  const changeIndices = useMemo(() => {
    const targets: number[] = []
    if (view === 'unified') {
      unifiedEntries.forEach((entry, renderedIndex) => {
        if (entry.kind === 'line' && entry.row.kind !== 'same' && (entry.sourceIndex === 0 || sourceRows[entry.sourceIndex - 1]?.kind === 'same')) targets.push(renderedIndex)
      })
      return targets
    }
    splitEntries.forEach((entry, renderedIndex) => {
      if (entry.kind !== 'row') return
      const same = entry.row.left?.kind === 'same' && entry.row.right?.kind === 'same'
      const previous = splitEntries[renderedIndex - 1]
      const previousSame = !previous || previous.kind === 'omitted' || (previous.row.left?.kind === 'same' && previous.row.right?.kind === 'same')
      if (!same && previousSame) targets.push(renderedIndex)
    })
    return targets
  }, [sourceRows, splitEntries, unifiedEntries, view])
  const visibleEntryCount = view === 'unified' ? unifiedEntries.length : splitEntries.length
  const virtualized = visibleEntryCount > DIFF_VIRTUALIZATION_THRESHOLD
  const baseRowHeight = diffSplitRowHeight(diffFontSize, stageActionsEnabled)
  const fontGeometry = codeGeometry.left ?? codeGeometry.right
  const measure = useCodeMeasurer(fontGeometry?.fontFamily ?? 'monospace', fontGeometry?.fontSize ?? diffFontSize, fontGeometry?.fontStyle, fontGeometry?.fontWeight)
  const heights = useMemo(() => {
    const options = (geometry: typeof fontGeometry) => ({
      availableWidth: geometry?.availableWidth ?? Infinity,
      lineHeight: geometry?.lineHeight ?? diffFontSize * 1.5,
      padding: geometry?.padding ?? 6,
      minHeight: baseRowHeight,
      tabSize: 4,
      measure,
    })
    if (view === 'unified') {
      const wrapped = wrapEnabled ? buildLineHeights(unifiedEntries.map((entry) => entry.kind === 'line' ? entry.row.code : ''), options(codeGeometry.left)) : []
      return unifiedEntries.map((entry, index) => entry.kind === 'omitted' ? (virtualized ? baseRowHeight : 24) : wrapped[index] ?? baseRowHeight)
    }
    const left = wrapEnabled ? buildLineHeights(splitEntries.map((entry) => entry.kind === 'row' ? entry.row.left?.code ?? '' : ''), options(codeGeometry.left)) : []
    const right = wrapEnabled ? buildLineHeights(splitEntries.map((entry) => entry.kind === 'row' ? entry.row.right?.code ?? '' : ''), options(codeGeometry.right)) : []
    return splitEntries.map((entry, index) => entry.kind === 'omitted' ? baseRowHeight : Math.max(left[index] ?? baseRowHeight, right[index] ?? baseRowHeight))
  }, [view, wrapEnabled, unifiedEntries, splitEntries, codeGeometry.left, codeGeometry.right, diffFontSize, baseRowHeight, measure, virtualized])
  const offsets = useMemo(() => buildOffsets(heights), [heights])
  const totalHeight = offsetAtIndex(offsets, visibleEntryCount)
  const blockActionCount = Number(canStage && Boolean(onStagePatch)) + Number(canStage && Boolean(onRestorePatch)) + Number(canUnstage)
  const actionEdgeSpace = blockActionCount ? diffActionEdgeSpace(baseRowHeight, DIFF_BLOCK_ACTION_HEIGHT) : 0
  // Anchor each action stack at the visual center of its whole change block.
  // The stack is positioned outside row flow, so larger buttons never stretch code.
  const blockActionAnchors = useMemo(() => {
    const entries = view === 'unified' ? unifiedEntries : splitEntries
    const changed = entries.map((entry) => entry.kind === 'line'
      ? entry.row.kind !== 'same'
      : entry.kind === 'row' && Boolean((entry.row.left && entry.row.left.kind !== 'same') || (entry.row.right && entry.row.right.kind !== 'same')))
    const anchors = new Map<number, { center: number; toolbarCenter: number; height: number }>()
    const toolbarHalfHeight = blockActionCount * 20 / 2
    for (let start = 0; start < changed.length; start++) {
      if (!changed[start]) continue
      let end = start
      while (end + 1 < changed.length && changed[end + 1]) end++
      const center = (offsets[start] + offsets[end + 1]) / 2
      const anchor = wrapEnabled ? Math.min(end, indexAtOffset(offsets, center)) : Math.floor((start + end) / 2)
      // Small blocks keep both actions visible. Clamp only at file edges, so
      // their toolbar never starts above the first row or grows the scroll area.
      const toolbarCenter = Math.max(toolbarHalfHeight, Math.min(center, offsets[entries.length] + actionEdgeSpace - toolbarHalfHeight))
      anchors.set(anchor, { center: center - offsets[anchor], toolbarCenter: toolbarCenter - offsets[anchor], height: offsets[end + 1] - offsets[start] })
      start = end
    }
    return anchors
  }, [unifiedEntries, splitEntries, view, offsets, wrapEnabled, blockActionCount, actionEdgeSpace])
  const canRenderLoadedRows = shouldRenderLoadedRows(usesLoader, loadedFileIdentity, activeFileIdentity)
  useBrowserLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel || usesMediaView) return
    const panes = view === 'unified' ? [codeDiffRef.current] : [splitLeftRef.current, splitRightRef.current]
    const read = () => {
      const code = (pane: HTMLDivElement | null | undefined) => pane?.querySelector<HTMLElement>('[data-diff-row-index] > code')
      const left = code(panes[0])
      const right = code(panes[1])
      const next = {
        left: left ? readCodeGeometry(left) : null,
        right: right ? readCodeGeometry(right) : null,
        viewportHeight: Math.max(...panes.map((pane) => pane?.clientHeight ?? 0), 1),
      }
      setCodeGeometry((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
    }
    read()
    const observer = new ResizeObserver(read)
    observer.observe(panel)
    for (const pane of panes) {
      if (!pane) continue
      observer.observe(pane)
      const code = pane.querySelector<HTMLElement>('[data-diff-row-index] > code')
      if (code) observer.observe(code)
    }
    // Font variables can change on any ancestor without changing the pane size.
    const mutations = new MutationObserver(read)
    for (let ancestor: HTMLElement | null = panel; ancestor; ancestor = ancestor.parentElement) {
      mutations.observe(ancestor, { attributes: true, attributeFilter: ['class', 'style'] })
    }
    window.addEventListener('resize', read)
    return () => { observer.disconnect(); mutations.disconnect(); window.removeEventListener('resize', read) }
  }, [view, wrapEnabled, diffFontSize, lineNumberDigits, stageActionsEnabled, canRenderLoadedRows, visibleEntryCount, usesMediaView, diffError, measure])
  const windowRange = diffVirtualWindow(offsets, virtualScrollTop, codeGeometry.viewportHeight, DIFF_VIRTUAL_OVERSCAN * baseRowHeight)
  const virtualStart = virtualized ? windowRange.start : 0
  const virtualEnd = virtualized ? windowRange.end : visibleEntryCount
  const virtualTopHeight = offsetAtIndex(offsets, virtualStart)
  const virtualBottomHeight = Math.max(0, totalHeight - offsetAtIndex(offsets, virtualEnd)) + actionEdgeSpace
  const overviewEntries = useMemo<DiffOverviewEntry[]>(() => {
    if (view === 'unified') {
      return [...unifiedEntries.map((entry, index) => ({ kind: entry.kind === 'line' ? entry.row.kind : 'same' as const, height: heights[index] })), ...(actionEdgeSpace ? [{ kind: 'same' as const, height: actionEdgeSpace }] : [])]
    }
    const entries: DiffOverviewEntry[] = splitEntries.map((entry, index) => entry.kind === 'row'
      ? { oldKind: entry.row.left?.kind ?? 'same', newKind: entry.row.right?.kind ?? 'same', height: heights[index] }
      : { oldKind: 'same', newKind: 'same', height: heights[index] })
    if (actionEdgeSpace) entries.push({ oldKind: 'same', newKind: 'same', height: actionEdgeSpace })
    return entries
  }, [splitEntries, unifiedEntries, view, heights, actionEdgeSpace])
  const overviewMarkers = useMemo(() => diffOverviewMarkers(overviewEntries, view), [overviewEntries, view])
  const searchMatches = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return []
    if (view === 'unified') return unifiedEntries.flatMap((entry, index) => entry.kind === 'line' && entry.row.code.toLowerCase().includes(query) ? [index] : [])
    return splitEntries.flatMap((entry, index) => {
      if (entry.kind !== 'row') return []
      return entry.row.left?.code.toLowerCase().includes(query) || entry.row.right?.code.toLowerCase().includes(query) ? [index] : []
    })
  }, [searchQuery, splitEntries, unifiedEntries, view])
  useEffect(() => {
    setSearchIndex((current) => searchMatches.length ? Math.min(current, searchMatches.length - 1) : 0)
  }, [searchMatches.length])
  useEffect(() => {
    setLineMenu(null)
    setActiveChange(null)
    setPendingJump(null)
    setVirtualScrollTop(0)
    splitScrollEcho.current = null
    requestAnimationFrame(() => {
      if (codeDiffRef.current) codeDiffRef.current.scrollTop = 0
      writeSplitScrollTop('left', 0)
      writeSplitScrollTop('right', 0)
    })
  }, [scope, view])
  useEffect(() => {
    setVirtualScrollTop(0)
    splitScrollEcho.current = null
    requestAnimationFrame(() => {
      if (codeDiffRef.current) codeDiffRef.current.scrollTop = 0
      writeSplitScrollTop('left', 0)
      writeSplitScrollTop('right', 0)
    })
  }, [activeFile])
  useEffect(() => {
    if (view !== 'split') return
    requestAnimationFrame(() => {
      const left = splitLeftRef.current
      if (left) writeSplitScrollTop('right', left.scrollTop)
    })
  }, [activeFile, diffLoading, splitEntries.length, view])
  useEffect(() => () => {
    if (virtualScrollFrame.current) cancelAnimationFrame(virtualScrollFrame.current)
  }, [])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return
      const panel = panelRef.current
      const activePanel = pointerInside.current || Boolean(panel?.contains(document.activeElement)) || document.querySelectorAll('.diff-panel').length === 1
      if (!activePanel) return
      event.preventDefault()
      setSearchOpen(true)
      requestAnimationFrame(() => searchInputRef.current?.focus())
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
  const activateFile = useCallback((index: number) => {
    setActiveFile(index)
    onActiveFileChange?.(index)
  }, [onActiveFileChange])
  const selectFile = useCallback((index: number) => {
    setPendingJump(null)
    setActiveChange(null)
    activateFile(index)
  }, [activateFile])
  const openLineMenu = (event: MouseEvent, row: RepositoryDiffLine | undefined, rowIndex: number, side: DiffLineSide, sourceIndex: number) => {
    const line = side === 'old' ? row?.old : row?.next
    if (!row || !line) return
    event.preventDefault()
    setLineMenu({ rowIndex, sourceIndex, side, line, code: row.code, x: event.clientX, y: event.clientY })
  }
  // A wheel or drag produces several scroll events per frame, and each one re-rendered both panes'
  // whole virtual window. Collapsing them to a single update per frame keeps the rows in step with
  // what the compositor is painting instead of re-rendering ahead of it.
  const queueVirtualScrollTop = (top: number) => {
    pendingVirtualScrollTop.current = top
    if (virtualScrollFrame.current) return
    virtualScrollFrame.current = requestAnimationFrame(() => {
      virtualScrollFrame.current = 0
      setVirtualScrollTop(pendingVirtualScrollTop.current)
    })
  }
  const writeSplitScrollTop = (side: 'left' | 'right', top: number) => {
    const pane = side === 'left' ? splitLeftRef.current : splitRightRef.current
    if (!pane || pane.scrollTop === top) return
    pane.scrollTop = top
    splitScrollEcho.current = { side, top }
  }
  // The overview sits beside the right pane, whose horizontal scrollbar may differ from the left.
  const activeScrollPane = () => view === 'unified' ? codeDiffRef.current : splitRightRef.current
  const updateOverviewViewport = () => {
    const pane = activeScrollPane()
    const viewer = overviewRef.current
    if (!pane || !viewer) return
    const bounds = diffOverviewBounds(
      viewer.getBoundingClientRect().top, viewer.clientHeight,
      pane.getBoundingClientRect().top, pane.clientTop, pane.clientHeight,
      0,
    )
    setOverviewBounds((previous) => previous.top === bounds.top && previous.bottom === bounds.bottom ? previous : bounds)
    setOverviewViewport(diffOverviewViewport(
      pane.scrollTop,
      pane.scrollHeight,
      pane.clientHeight,
    ))
  }
  const scrollOverviewTo = (clientY: number, element: HTMLDivElement) => {
    const pane = activeScrollPane()
    if (!pane) return
    const bounds = element.getBoundingClientRect()
    const percent = Math.max(0, Math.min(1, (clientY - bounds.top) / Math.max(1, bounds.height)))
    const target = Math.max(0, pane.scrollHeight - pane.clientHeight) * percent
    if (view === 'unified') {
      pane.scrollTop = target
      handleCodeDiffScroll({ currentTarget: pane } as UIEvent<HTMLDivElement>)
    } else {
      writeSplitScrollTop('left', target)
      writeSplitScrollTop('right', target)
      if (splitActionsRef.current) splitActionsRef.current.scrollTop = target
      queueVirtualScrollTop(target)
    }
    updateOverviewViewport()
  }
  const beginOverviewDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    overviewDragging.current = true
    scrollOverviewTo(event.clientY, event.currentTarget)
  }
  const moveOverviewDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!overviewDragging.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    scrollOverviewTo(event.clientY, event.currentTarget)
  }
  const endOverviewDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    overviewDragging.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  useEffect(() => {
    const viewer = overviewRef.current
    if (!viewer) return
    updateOverviewViewport()
    const observer = new ResizeObserver(updateOverviewViewport)
    observer.observe(viewer)
    const pane = activeScrollPane()
    if (pane) {
      observer.observe(pane)
      // Virtualization and font changes can add/remove horizontal overflow without resizing the viewer.
      for (const child of Array.from(pane.children)) observer.observe(child)
    }
    return () => observer.disconnect()
  }, [activeFile, diffLoading, visibleEntryCount, view, virtualized, virtualStart, virtualEnd, diffFontSize, scope, showWhitespace, canRenderLoadedRows, offsets])
  const handleCodeDiffScroll = (event: UIEvent<HTMLDivElement>) => {
    queueVirtualScrollTop(event.currentTarget.scrollTop)
    updateOverviewViewport()
  }
  const scrollToVirtualEntry = (rowIndex: number) => {
    const pane = activeScrollPane()
    if (!pane) return
    const top = diffScrollTarget(offsets, rowIndex, pane.clientHeight)
    if (view === 'split') {
      writeSplitScrollTop('left', top)
      writeSplitScrollTop('right', top)
      if (splitActionsRef.current) splitActionsRef.current.scrollTop = pane.scrollTop
    } else pane.scrollTop = top
    pendingVirtualScrollTop.current = pane.scrollTop
    setVirtualScrollTop(pane.scrollTop)
    updateOverviewViewport()
  }
  const previousLayout = useRef<{ offsets: number[]; identity: string | null; view: string; scope: string } | null>(null)
  useBrowserLayoutEffect(() => {
    const previous = previousLayout.current
    previousLayout.current = { offsets, identity: activeFileIdentity, view, scope }
    const pane = activeScrollPane()
    if (!pane || usesMediaView) return
    const sameContent = previous?.identity === activeFileIdentity && previous?.view === view && previous?.scope === scope
    const top = previous && sameContent
      ? diffReflowScrollTop(previous.offsets, offsets, pendingVirtualScrollTop.current, pane.clientHeight, actionEdgeSpace)
      : pane.scrollTop
    // Reflow must not let the browser independently anchor the two panes. Keep
    // the code panes, action lane, virtual window and overview on the same offset.
    if (view === 'split') {
      writeSplitScrollTop('left', top)
      writeSplitScrollTop('right', top)
      if (splitActionsRef.current) splitActionsRef.current.scrollTop = pane.scrollTop
    } else pane.scrollTop = top
    pendingVirtualScrollTop.current = pane.scrollTop
    setVirtualScrollTop(pane.scrollTop)
    updateOverviewViewport()
  }, [offsets, activeFileIdentity, view, scope, actionEdgeSpace, codeGeometry.viewportHeight, usesMediaView])
  const scrollToChange = (rowIndex: number) => {
    setActiveChange({ fileIndex: activeFile, rowIndex })
    if (virtualized || wrapEnabled) {
      scrollToVirtualEntry(rowIndex)
      return
    }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      panelRef.current?.querySelectorAll<HTMLElement>(`[data-diff-row-index="${rowIndex}"]`).forEach((element) => element.scrollIntoView({ block: 'center', behavior: 'smooth' }))
    }))
  }
  const scrollToSearch = (rowIndex: number) => {
    if (virtualized || wrapEnabled) {
      scrollToVirtualEntry(rowIndex)
      return
    }
    requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>(`[data-diff-row-index="${rowIndex}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
  }
  const syncSplitScroll = (side: 'left' | 'right') => {
    if (view !== 'split') return
    const source = side === 'left' ? splitLeftRef.current : splitRightRef.current
    if (!source) return
    const top = source.scrollTop
    if (splitActionsRef.current) splitActionsRef.current.scrollTop = top
    updateOverviewViewport()
    if (splitScrollEcho.current?.side === side) {
      // Our own mirrored write coming back: the panes already agree, so neither re-mirroring nor a
      // re-render is needed.
      splitScrollEcho.current = null
      return
    }
    splitScrollEcho.current = null
    writeSplitScrollTop(side === 'left' ? 'right' : 'left', top)
    queueVirtualScrollTop(top)
  }
  const jumpSearch = (direction: -1 | 1) => {
    if (!searchMatches.length) return
    const next = (searchIndex + direction + searchMatches.length) % searchMatches.length
    setSearchIndex(next)
    scrollToSearch(searchMatches[next])
  }
  const adjacentFile = (index: number, direction: -1 | 1) => (index + direction + files.length) % files.length
  const jumpToChange = (direction: -1 | 1) => {
    if (!files.length || diffLoading) return
    const currentPosition = activeChange?.fileIndex === activeFile ? changeIndices.indexOf(activeChange.rowIndex) : -1
    const targetPosition = direction === 1
      ? (currentPosition >= 0 ? currentPosition + 1 : 0)
      : (currentPosition >= 0 ? currentPosition - 1 : changeIndices.length - 1)
    if (targetPosition >= 0 && targetPosition < changeIndices.length) {
      scrollToChange(changeIndices[targetPosition])
      return
    }
    if (files.length === 1) {
      if (changeIndices.length) scrollToChange(changeIndices[direction === 1 ? 0 : changeIndices.length - 1])
      return
    }
    setActiveChange(null)
    setPendingJump({ edge: direction === 1 ? 'first' : 'last', direction, remaining: files.length - 1 })
    activateFile(adjacentFile(activeFile, direction))
  }
  useEffect(() => {
    if (!pendingJump || diffLoading || !activeFileInfo || !activeFileIdentity) return
    if (!canRenderLoadedRows || (wrapEnabled && !fontGeometry)) return
    if (changeIndices.length) {
      autoJumpIdentity.current = activeFileIdentity
      scrollToChange(changeIndices[pendingJump.edge === 'first' ? 0 : changeIndices.length - 1])
      setPendingJump(null)
      return
    }
    if (pendingJump.remaining > 1 && files.length > 1) {
      setPendingJump({ ...pendingJump, remaining: pendingJump.remaining - 1 })
      activateFile(adjacentFile(activeFile, pendingJump.direction))
      return
    }
    setPendingJump(null)
  }, [activateFile, activeFile, activeFileIdentity, activeFileInfo, canRenderLoadedRows, changeIndices, diffLoading, files.length, pendingJump, wrapEnabled, fontGeometry, offsets])
  useEffect(() => {
    if (scope !== 'file') {
      autoJumpIdentity.current = null
      return
    }
    if (diffLoading || !activeFileInfo || !activeFileIdentity || !changeIndices.length || (wrapEnabled && !fontGeometry)) return
    const identity = activeFileIdentity
    if (!shouldJumpToFirstChange(scope, identity, autoJumpIdentity.current, Boolean(pendingJump), canRenderLoadedRows)) return
    autoJumpIdentity.current = identity
    scrollToChange(changeIndices[0])
  }, [activeFileIdentity, activeFileInfo, canRenderLoadedRows, changeIndices, diffLoading, pendingJump, scope, wrapEnabled, fontGeometry, offsets])
  const diffStyle = { '--diff-font-size': `${diffFontSize}px`, '--diff-line-number-width': `${Math.max(2, lineNumberDigits + 1.8)}ch` } as CSSProperties
  const applyPatch = (operation: 'stage' | 'restore' | 'unstage', rows: RepositoryDiffLine[], description: string) => {
    if (actionsDisabled || !activeFileInfo) return
    const callback = operation === 'stage' ? onStagePatch : operation === 'restore' ? onRestorePatch : onUnstagePatch
    callback?.(activeFileInfo.path, buildStagePatch(activeFileInfo.path, rows, activeFileInfo.type, operation, sourceRows), description)
  }
  const renderStageActions = (block: RepositoryDiffLine[], anchor: { center: number; toolbarCenter: number; height: number } | undefined, layout: 'unified' | 'split' = 'unified') => {
    return <span className={'diff-stage-slot ' + (layout === 'split' ? 'split' : '')}>
      {anchor && <>
        <span className="diff-block-range" aria-hidden="true" style={{ top: anchor.center - anchor.height / 2, height: anchor.height }}/>
        <span className="diff-block-actions" role="toolbar" aria-label={t('diff.blockActions')} aria-orientation="vertical" style={{ top: anchor.toolbarCenter }}>
          {canStage && onRestorePatch && <button type="button" disabled={actionsDisabled} className="diff-restore-action" onClick={(event) => { event.stopPropagation(); applyPatch('restore', block, t('diff.blockLabel')) }} title={t('diff.restoreBlock')} aria-label={t('diff.restoreBlock')}>{layout === 'split' ? <ArrowRight size={16}/> : <Undo2 size={16}/>}</button>}
          {canStage && onStagePatch && <button type="button" disabled={actionsDisabled} className="diff-stage-action" onClick={(event) => { event.stopPropagation(); applyPatch('stage', block, t('diff.blockLabel')) }} title={t('diff.stageBlock')} aria-label={t('diff.stageBlock')}><Plus size={16}/></button>}
          {canUnstage && <button type="button" disabled={actionsDisabled} className="diff-stage-action" onClick={(event) => { event.stopPropagation(); applyPatch('unstage', block, t('diff.blockLabel')) }} title={t('diff.unstageBlock')} aria-label={t('diff.unstageBlock')}><Minus size={16}/></button>}
        </span>
      </>}
    </span>
  }
  const renderLineAction = (row: RepositoryDiffLine | undefined, sourceIndex: number) => {
    const sign = row?.kind === 'add' ? '+' : row?.kind === 'del' ? '−' : ''
    if (!row || row.kind === 'same') return <span className="change-sign">{sign}</span>
    const operation = canUnstage ? 'unstage' : canStage && row.kind === 'add' && onStagePatch ? 'stage' : canStage && row.kind === 'del' && onRestorePatch ? 'restore' : null
    if (!operation) return <span className="change-sign">{sign}</span>
    const label = operation === 'unstage' ? t('diff.unstageLine') : operation === 'stage' ? t('diff.stageLine') : t('diff.restoreLine')
    return <button type="button" disabled={actionsDisabled} className={'change-sign line-action-' + row.kind} onClick={(event) => { event.stopPropagation(); applyPatch(operation, changeLine(sourceRows, sourceIndex), t('diff.singleLine')) }} title={label + t('diff.lineActionNote')} aria-label={label}>{sign}</button>
  }
  const renderUnifiedEntry = (entry: DiffContextEntry, index: number) => entry.kind === 'omitted'
    ? <div className="hunk diff-omitted" style={{ height: heights[index] }} key={`omitted-${index}`}>{t('diff.omittedPrefix')} {entry.count} {t('diff.omittedSuffix')}</div>
    : (() => { const row = entry.row; const side: DiffLineSide = row.kind === 'del' ? 'old' : 'new'; const block = row.kind !== 'same' ? changeBlock(sourceRows, entry.sourceIndex) : []; const reviewSide: ReviewThreadSide = side; const reviewLine = row.kind === 'del' ? row.old : row.next; return <div data-diff-row-index={index} style={{ height: heights[index] }} className={`code-row ${row.kind} ${searchMatches.includes(index) ? 'diff-search-match' : ''} ${searchMatches[searchIndex] === index ? 'diff-search-current' : ''} ${lineMenu?.rowIndex === index && lineMenu.side === side ? 'line-context-active' : ''} ${activeChange?.fileIndex === activeFile && activeChange.rowIndex === index ? 'diff-navigation-active' : ''}`} key={index} onContextMenu={(event) => openLineMenu(event, row, index, side, entry.sourceIndex)} title={t('diff.lineHistoryHint')}>
      {renderStageActions(block, blockActionAnchors.get(index))}{(() => { const anchorProps = renderLineNo(reviewSide, reviewLine); return <span {...anchorProps}>{row.old ?? row.next ?? ''}</span> })()}{renderLineAction(row, entry.sourceIndex)}<HighlightedCode code={row.code} filePath={activeFileInfo?.path ?? ''} tokens={diffHighlights.get(entry.sourceIndex)}/>
    </div> })()
  const renderSplitEntry = (entry: SplitDiffEntry, index: number, side: DiffLineSide) => entry.kind === 'omitted'
    ? <div className="hunk diff-omitted" style={{ height: heights[index] }} key={`omitted-${side}-${index}`}>{t('diff.omittedPrefix')} {entry.count} {t('diff.omittedSuffix')}</div>
    : (() => { const row = side === 'old' ? entry.row.left : entry.row.right; const sourceIndex = row ? sourceRows.indexOf(row) : -1; const action = renderLineAction(row, sourceIndex); const reviewSide: ReviewThreadSide = side; const reviewLine = side === 'old' ? row?.old ?? null : row?.next ?? null; return <div data-diff-row-index={index} style={{ height: heights[index] }} className={`split-code-side ${row?.kind ?? 'empty'} ${searchMatches.includes(index) ? 'diff-search-match' : ''} ${searchMatches[searchIndex] === index ? 'diff-search-current' : ''} ${lineMenu?.rowIndex === index && lineMenu.side === side ? 'line-context-active' : ''} ${activeChange?.fileIndex === activeFile && activeChange.rowIndex === index ? 'diff-navigation-active' : ''}`} key={`${side}-${index}`} onContextMenu={(event) => openLineMenu(event, row, index, side, sourceIndex)} title={row ? t('diff.lineHistoryHint') : undefined}>{(() => { const anchorProps = renderLineNo(reviewSide, reviewLine); return <span {...anchorProps}>{side === 'old' ? row?.old ?? '' : row?.next ?? ''}</span> })()}{action}{row ? <HighlightedCode code={row.code} filePath={activeFileInfo?.path ?? ''} tokens={diffHighlights.get(sourceIndex)}/> : <code/>}</div> })()
  const renderSplitActions = (entry: SplitDiffEntry, index: number) => {
    if (entry.kind === 'omitted') return <div className="split-action-row" style={{ height: heights[index] }} key={`actions-${index}`}/>
    const row = entry.row.left ?? entry.row.right
    const sourceIndex = row ? sourceRows.indexOf(row) : -1
    const block = sourceIndex >= 0 ? changeBlock(sourceRows, sourceIndex) : []
    const blockStart = blockActionAnchors.has(index)
    return <div className="split-action-row" style={{ height: heights[index] }} key={`actions-${index}`}>
      {blockStart && renderStageActions(block, blockActionAnchors.get(index), 'split')}
    </div>
  }
  const contextMenuRow = lineMenu
    ? view === 'unified'
      ? unifiedEntryRow(unifiedEntries, lineMenu.rowIndex)
      : splitEntryRow(splitEntries, lineMenu.rowIndex, lineMenu.side)
    : undefined
  const contextMenuActionRows = lineMenu && lineMenu.sourceIndex >= 0 ? changeLine(sourceRows, lineMenu.sourceIndex) : []
  return <section ref={panelRef} className={`diff-panel ${wide ? 'wide' : ''} ${stageActionsEnabled ? 'stage-actions-enabled' : ''} ${wrapEnabled ? 'word-wrap' : ''}`} style={diffStyle} onPointerEnter={() => { pointerInside.current = true }} onPointerLeave={() => { pointerInside.current = false }}>
    <div className="diff-toolbar">
      <div className="diff-title"><FileCode2 size={16}/><strong>{hideFileList ? 'Diff' : t('diff.title')}</strong>{!hideFileList && <span>{files.length}</span>}</div>
      {!hideFileList && <div className="segmented icon-segmented view-switch"><button className={fileMode === 'tree' ? 'active' : ''} onClick={() => setFileMode('tree')} title={t('diff.treeView')} aria-label={t('diff.treeView')}><FolderOpen size={14}/></button><button className={fileMode === 'list' ? 'active' : ''} onClick={() => setFileMode('list')} title={t('diff.listView')} aria-label={t('diff.listView')}><List size={14}/></button></div>}
      <div className="segmented icon-segmented diff-scope"><button className={scope === 'file' ? 'active' : ''} onClick={() => setScope('file')} title={t('diff.showFullFile')} aria-label={t('diff.showFullFile')}><FileText size={14}/></button><button className={scope === 'changes' ? 'active' : ''} onClick={() => setScope('changes')} title={t('diff.changesOnly')} aria-label={t('diff.changesOnly')}><ScanText size={14}/></button></div>
      <button type="button" className={`diff-whitespace-toggle ${showWhitespace ? 'active' : ''}`} onClick={() => setShowWhitespace((value) => !value)} title={showWhitespace ? t('diff.hideWhitespace') : t('diff.showWhitespace')} aria-label={t('diff.showWhitespace')} aria-pressed={showWhitespace}>{showWhitespace ? <Check size={13}/> : <EyeOff size={13}/>}</button>
      <div className="segmented icon-segmented"><button className={view === 'unified' ? 'active' : ''} onClick={() => setView('unified')} title={t('diff.layoutUnified')} aria-label={t('diff.layoutUnified')}><AlignJustify size={14}/></button><button className={view === 'split' ? 'active' : ''} onClick={() => setView('split')} title={t('diff.layoutSplit')} aria-label={t('diff.layoutSplit')}><Columns2 size={14}/></button></div>
      <div className="segmented icon-segmented diff-navigation"><button onClick={() => jumpToChange(-1)} disabled={!files.length || diffLoading} title={t('diff.prevChangeFile')} aria-label={t('diff.prevChange')}><ArrowUp size={14}/></button><button onClick={() => jumpToChange(1)} disabled={!files.length || diffLoading} title={t('diff.nextChangeFile')} aria-label={t('diff.nextChange')}><ArrowDown size={14}/></button></div>
      {searchOpen ? <div className="diff-search-bar" role="search"><Search size={14}/><input ref={searchInputRef} value={searchQuery} onChange={(event) => { setSearchQuery(event.target.value); setSearchIndex(0) }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); jumpSearch(event.shiftKey ? -1 : 1) } if (event.key === 'Escape') { event.preventDefault(); setSearchOpen(false) } }} placeholder={t('diff.searchTitle')} aria-label={t('diff.searchTitle')}/><span>{searchQuery ? (searchMatches.length ? `${searchIndex + 1} / ${searchMatches.length}` : t('diff.searchNoMatch')) : t('diff.searchPlaceholder')}</span><button type="button" onClick={() => jumpSearch(-1)} disabled={!searchMatches.length} title={t('diff.searchPrev')}><ArrowUp size={13}/></button><button type="button" onClick={() => jumpSearch(1)} disabled={!searchMatches.length} title={t('diff.searchNext')}><ArrowDown size={13}/></button><button type="button" onClick={() => { setSearchOpen(false); setSearchQuery('') }} title={t('diff.searchClose')} aria-label={t('diff.searchClose')}><X size={13}/></button></div> : <Button variant="icon" onClick={() => { setSearchOpen(true); requestAnimationFrame(() => searchInputRef.current?.focus()) }} title={t('diff.searchShortcut')} aria-label={t('diff.searchTitle')}><Search size={15}/></Button>}
      <div className="diff-font-controls" title={t('diff.fontSlider')}><button onClick={() => setDiffFontSize((value) => Math.max(MIN_DIFF_FONT_SIZE, value - 1))} disabled={diffFontSize <= MIN_DIFF_FONT_SIZE} aria-label={t('diff.fontDecreaseTitle')}><Minus size={13}/></button><button className="diff-font-size" onClick={() => setDiffFontSize(defaultFontSize)} title={t('diff.fontResetTitle')}>{diffFontSize}px</button><button onClick={() => setDiffFontSize((value) => Math.min(MAX_DIFF_FONT_SIZE, value + 1))} disabled={diffFontSize >= MAX_DIFF_FONT_SIZE} aria-label={t('diff.fontIncreaseTitle')}><Plus size={13}/></button></div>
      <Button variant="icon" onClick={() => onWideChange(!wide)} title={wide ? t('diff.exitWide') : t('diff.wide')}>{wide ? <Minimize2 size={15}/> : <Maximize2 size={15}/>}</Button>
      {onClose && <Button variant="icon" className="diff-close-control" onClick={onClose} title={t('diff.close')}><X size={15}/></Button>}
    </div>
    <div className={`diff-body ${hideFileList ? 'code-only' : ''}`}>
      {!hideFileList && <DiffFileList files={files} activeFile={activeFile} mode={fileMode} onSelectFile={selectFile} collapsedFolders={collapsedFolders} onCollapsedFoldersChange={setCollapsedFolders}/>}
      <div className="diff-viewer" ref={overviewRef}>
      {usesMediaView ? <ImageDiffViewer
        path={activeFileInfo?.path ?? ''}
        pair={imagePair}
        loading={imageLoading}
        error={imageError}
        onRetry={() => setMediaRetry((value) => value + 1)}
        onOpenExternally={onOpenFileExternally && activeFileInfo ? () => onOpenFileExternally(activeFileInfo.path) : undefined}
        onExitToText={() => setMediaAsText(true)}
      /> : <div className={`code-diff ${view}`}>
        <div className="file-header"><div className="file-header-path" title={activeFileInfo?.path}><code title={activeFileInfo?.path}>{activeFileInfo?.path ?? t('diff.noChangedFiles')}</code></div>{activeFileInfo && <span className="file-header-stats"><i>+{activeFileInfo.add}</i> <b>-{activeFileInfo.del}</b></span>}</div>
        {scope === 'changes' && !usesLoader && <div className="hunk">{t('diff.fullBlock')}</div>}
        {diffLoading && !canRenderLoadedRows && <div className="diff-message">{t('diff.loading')}</div>}
        {diffError && <div className="diff-message error">{diffError}</div>}
        {!diffLoading && !diffError && visibleEntryCount === 0 && <div className="diff-message">{t('diff.noTextDiff')}</div>}
        {canRenderLoadedRows && !diffError && view === 'unified' && <div className="unified-diff-pane" ref={codeDiffRef} onScroll={handleCodeDiffScroll}><div className={`unified-diff-content${virtualized ? ' virtual-diff-list' : ''}`} style={{ paddingTop: virtualized ? virtualTopHeight : undefined, paddingBottom: virtualBottomHeight }}>{unifiedEntries.slice(virtualStart, virtualEnd).map((entry, index) => renderUnifiedEntry(entry, index + virtualStart))}</div></div>}
        {canRenderLoadedRows && !diffError && view === 'split' && <div className="split-diff-panes">
          <div ref={splitLeftRef} className="split-diff-pane split-left" aria-label={t('diff.oldPane')} onScroll={() => syncSplitScroll('left')}><div className={`split-diff-content${virtualized ? ' virtual-diff-list' : ''}`} style={{ paddingTop: virtualized ? virtualTopHeight : undefined, paddingBottom: virtualBottomHeight }}>{splitEntries.slice(virtualStart, virtualEnd).map((entry, index) => renderSplitEntry(entry, index + virtualStart, 'old'))}</div></div>
          {stageActionsEnabled && <div ref={splitActionsRef} className="split-diff-actions" aria-label={t('diff.actionsLane')}><div className={`split-diff-content${virtualized ? ' virtual-diff-list' : ''}`} style={{ paddingTop: virtualized ? virtualTopHeight : undefined, paddingBottom: virtualBottomHeight }}>{splitEntries.slice(virtualStart, virtualEnd).map((entry, index) => renderSplitActions(entry, index + virtualStart))}</div></div>}
          <div ref={splitRightRef} className="split-diff-pane split-right" aria-label={t('diff.newPane')} onScroll={() => syncSplitScroll('right')}><div className={`split-diff-content${virtualized ? ' virtual-diff-list' : ''}`} style={{ paddingTop: virtualized ? virtualTopHeight : undefined, paddingBottom: virtualBottomHeight }}>{splitEntries.slice(virtualStart, virtualEnd).map((entry, index) => renderSplitEntry(entry, index + virtualStart, 'new'))}</div></div>
        </div>}
      </div>}
      {overviewMarkers.length > 0 && <div className={`diff-overview ${view === 'split' ? 'split' : ''}`} style={overviewBounds} onPointerDown={beginOverviewDrag} onPointerMove={moveOverviewDrag} onPointerUp={endOverviewDrag} onPointerCancel={endOverviewDrag} title={t('diff.overviewHint')} aria-label={t('diff.overview')}>
        {overviewMarkers.map(({ index, top, height, kind, column }) => <span className={`diff-overview-marker ${kind} ${column}`} key={`${column}-${index}`} style={{ top: `max(0px, min(${top}%, calc(100% - 3px)))`, height: `${height}%` }}/>) }
        <span className="diff-overview-viewport" style={{ top: `${overviewViewport.top}%`, height: `${overviewViewport.height}%` }}/>
      </div>}
      </div>
    </div>
    {review && <div className="diff-review-dock">{reviewAnchor && activeFileInfo && <ReviewThreadPanel
      threads={activeReviewThreads}
      composeLine={reviewAnchor.line}
      busy={review.busy}
      error={review.error}
      onCreate={(body) => { if (reviewAnchor && activeFileInfo) review.onCreate({ filePath: activeFileInfo.path, line: reviewAnchor.line, side: reviewAnchor.side, body }) }}
      onReply={review.onReply}
      onResolve={review.onResolve}
      onDelete={review.onDelete}
      onClose={() => { review.onClose(); setReviewAnchor(null) }}/>}</div>}
    {lineMenu && activeFileInfo && <ContextMenu x={lineMenu.x} y={lineMenu.y} onClose={() => setLineMenu(null)}><div className="context-menu-title"><FileCode2 size={13}/><span>{activeFileInfo.path}:{lineMenu.line} · {lineMenu.side === 'old' ? t('diff.oldLabel') : t('diff.newLabel')}</span></div>{canStage && onStagePatch && contextMenuRow?.kind !== 'same' && <button disabled={actionsDisabled} onClick={() => { applyPatch('stage', contextMenuActionRows, t('diff.singleLine')); setLineMenu(null) }}><Plus size={14}/><span>{t('diff.stageLine')}</span></button>}{canStage && onRestorePatch && contextMenuRow?.kind !== 'same' && <button disabled={actionsDisabled} onClick={() => { applyPatch('restore', contextMenuActionRows, t('diff.singleLine')); setLineMenu(null) }}><RotateCcw size={14}/><span>{t('diff.restoreLine')}</span></button>}{canUnstage && contextMenuRow?.kind !== 'same' && <button disabled={actionsDisabled} onClick={() => { applyPatch('unstage', contextMenuActionRows, t('diff.singleLine')); setLineMenu(null) }}><Minus size={14}/><span>{t('diff.unstageLine')}</span></button>}{onOpenLineHistory && <button onClick={() => { if (contextMenuRow) onOpenLineHistory(activeFileInfo.path, lineMenu.line, lineMenu.side, contextMenuRow); setLineMenu(null) }}><History size={14}/><span>{t('diff.lineHistoryAt', { line: lineMenu.line })}</span></button>}<button onClick={() => { navigator.clipboard?.writeText(lineMenu.code).catch(() => undefined); setLineMenu(null) }}><Copy size={14}/><span>{t('diff.copyLine')}</span></button></ContextMenu>}
  </section>
}
