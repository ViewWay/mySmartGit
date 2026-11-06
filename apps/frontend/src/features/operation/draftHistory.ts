/**
 * 三栏合并视图的草稿撤销栈（纯函数，便于单测）。
 * 撤销/重做以"草稿文本"为唯一事实源：块操作、批量选边、恢复冲突、手工编辑都入栈；
 * 编辑器（CodeMirror）不再自带 history，避免两套栈互相打架。
 */

export type DraftChangeReason = 'edit' | 'block' | 'batch' | 'restore' | 'swap'

export type DraftHistoryEntry = {
  text: string
  reason: DraftChangeReason
  /** 变更时间戳（毫秒），用于连续手工编辑的合并窗口；由调用方注入以便测试。 */
  at: number
}

export type DraftHistory = {
  past: DraftHistoryEntry[]
  present: DraftHistoryEntry
  future: DraftHistoryEntry[]
}

/** 历史深度上限：桌面客户端冲突文件可能很大，限制驻留文本数量。 */
export const DRAFT_HISTORY_LIMIT = 100

/** 同一轮手工编辑的合并窗口：窗口内的连续 edit 只算一步撤销。 */
export const DRAFT_EDIT_COALESCE_MS = 700

export function createDraftHistory(text: string, at = Date.now()): DraftHistory {
  return { past: [], present: { text, reason: 'swap', at }, future: [] }
}

export function pushDraftHistory(
  history: DraftHistory,
  text: string,
  reason: DraftChangeReason,
  at = Date.now(),
): DraftHistory {
  if (text === history.present.text) return history
  // 换文件（swap）直接重置：撤销绝不能跨文件。
  if (reason === 'swap') return createDraftHistory(text, at)
  // 窗口内的连续手工编辑合并成一步，避免一次退码就毁掉一整段输入。
  if (
    reason === 'edit'
    && history.present.reason === 'edit'
    && at - history.present.at <= DRAFT_EDIT_COALESCE_MS
  ) {
    return { past: history.past, present: { text, reason, at }, future: [] }
  }
  const past = [...history.past, history.present]
  const trimmed = past.length > DRAFT_HISTORY_LIMIT ? past.slice(past.length - DRAFT_HISTORY_LIMIT) : past
  return { past: trimmed, present: { text, reason, at }, future: [] }
}

export function undoDraftHistory(history: DraftHistory): DraftHistory | null {
  const previous = history.past[history.past.length - 1]
  if (!previous) return null
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: capFuture([history.present, ...history.future]),
  }
}

export function redoDraftHistory(history: DraftHistory): DraftHistory | null {
  const next = history.future[0]
  if (!next) return null
  return {
    past: capPast([...history.past, history.present]),
    present: next,
    future: history.future.slice(1),
  }
}

export function canUndoDraft(history: DraftHistory): boolean {
  return history.past.length > 0
}

export function canRedoDraft(history: DraftHistory): boolean {
  return history.future.length > 0
}

function capPast(past: DraftHistoryEntry[]): DraftHistoryEntry[] {
  return past.length > DRAFT_HISTORY_LIMIT ? past.slice(past.length - DRAFT_HISTORY_LIMIT) : past
}

// 重做栈不丢旧边界：超出上限时从最早（最深处）的一侧裁剪。
function capFuture(future: DraftHistoryEntry[]): DraftHistoryEntry[] {
  return future.length > DRAFT_HISTORY_LIMIT ? future.slice(0, DRAFT_HISTORY_LIMIT) : future
}
