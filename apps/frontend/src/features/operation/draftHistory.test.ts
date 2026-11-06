import { describe, expect, it } from 'vitest'
import {
  DRAFT_EDIT_COALESCE_MS,
  DRAFT_HISTORY_LIMIT,
  canRedoDraft,
  canUndoDraft,
  createDraftHistory,
  pushDraftHistory,
  redoDraftHistory,
  undoDraftHistory,
} from './draftHistory'

describe('draft undo/redo stack', () => {
  it('undoes and redoes block operations one step at a time', () => {
    let h = createDraftHistory('conflict A')
    h = pushDraftHistory(h, 'resolved A', 'block', 1000)
    h = pushDraftHistory(h, 'resolved A + B', 'block', 2000)
    expect(canUndoDraft(h)).toBe(true)
    const undone = undoDraftHistory(h)
    expect(undone?.present.text).toBe('resolved A')
    expect(canRedoDraft(undone ?? h)).toBe(true)
    const redone = redoDraftHistory(undone ?? h)
    expect(redone?.present.text).toBe('resolved A + B')
  })

  it('coalesces manual edits inside the window into a single undo step', () => {
    let h = createDraftHistory('base')
    h = pushDraftHistory(h, 'ba', 'edit', 1000)
    h = pushDraftHistory(h, 'bas1', 'edit', 1000 + DRAFT_EDIT_COALESCE_MS / 2)
    h = pushDraftHistory(h, 'bas12', 'edit', 1000 + DRAFT_EDIT_COALESCE_MS)
    expect(h.past).toHaveLength(1)
    const undone = undoDraftHistory(h)
    expect(undone?.present.text).toBe('base')
  })

  it('keeps separate undo boundaries outside the coalescing window', () => {
    let h = createDraftHistory('base')
    h = pushDraftHistory(h, 'typing-1', 'edit', 1000)
    h = pushDraftHistory(h, 'typing-2', 'edit', 1000 + DRAFT_EDIT_COALESCE_MS + 1)
    expect(h.past).toHaveLength(2)
    expect(undoDraftHistory(h)?.present.text).toBe('typing-1')
  })

  it('never coalesces block / batch / restore entries', () => {
    let h = createDraftHistory('base')
    h = pushDraftHistory(h, 'b1', 'block', 1000)
    h = pushDraftHistory(h, 'b2', 'block', 1001)
    h = pushDraftHistory(h, 'batch', 'batch', 1002)
    h = pushDraftHistory(h, 'restored', 'restore', 1003)
    expect(h.past).toHaveLength(4)
  })

  it('drops the redo stack when a new change is pushed after undo', () => {
    let h = createDraftHistory('v0')
    h = pushDraftHistory(h, 'v1', 'block', 1000)
    const undone = undoDraftHistory(h) ?? h
    expect(canRedoDraft(undone)).toBe(true)
    const pushed = pushDraftHistory(undone, 'v2', 'block', 2000)
    expect(canRedoDraft(pushed)).toBe(false)
  })

  it('resets the whole stack on file swap so undo can never cross files', () => {
    let h = createDraftHistory('file-a original')
    h = pushDraftHistory(h, 'file-a edited', 'block', 1000)
    h = pushDraftHistory(h, 'file-b original', 'swap', 2000)
    expect(canUndoDraft(h)).toBe(false)
    expect(h.past).toEqual([])
    expect(h.future).toEqual([])
  })

  it('ignores no-op pushes when the text is unchanged', () => {
    const h = createDraftHistory('same', 1000)
    expect(pushDraftHistory(h, 'same', 'edit', 1500)).toBe(h)
  })

  it('caps history depth so long editing sessions cannot grow unbounded', () => {
    let h = createDraftHistory('start')
    for (let index = 0; index <= DRAFT_HISTORY_LIMIT + 10; index += 1) {
      h = pushDraftHistory(h, `state-${index}`, 'block', 1000 + index * 5000)
    }
    expect(h.past.length).toBeLessThanOrEqual(DRAFT_HISTORY_LIMIT)
    let steps = 0
    let current: typeof h | null = h
    while (current && canUndoDraft(current)) {
      current = undoDraftHistory(current)
      steps += 1
    }
    expect(steps).toBeLessThanOrEqual(DRAFT_HISTORY_LIMIT)
  })
})
