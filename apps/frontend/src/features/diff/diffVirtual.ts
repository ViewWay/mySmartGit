import { indexAtOffset, offsetAtIndex } from './wrapModel'

/** Diff 虚拟滚动 / 行高 / 滚动定位的纯计算，独立成模块以保持 DiffPanel 纯组件导出。 */
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

export function shouldJumpToFirstChange(scope: 'file' | 'changes', identity: string, previousIdentity: string | null, hasPendingJump = false, canRenderRows = true) {
  return scope === 'file' && !hasPendingJump && canRenderRows && identity !== previousIdentity
}
