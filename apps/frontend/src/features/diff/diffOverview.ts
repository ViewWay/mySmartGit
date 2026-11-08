/** Diff 概览条（mini-map）的纯计算，独立成模块以保持 DiffPanel 纯组件导出。 */
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
