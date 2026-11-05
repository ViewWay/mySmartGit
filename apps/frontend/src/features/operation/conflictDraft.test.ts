import { describe, expect, it } from 'vitest'
import {
  hasConflictMarkers,
  isDraftDirty,
  isSideAvailable,
  parseConflictBlocks,
  resolveConflictBlockInText,
} from './conflictDraft'

const diff3 = [
  'header',
  '<<<<<<< HEAD',
  'main version',
  '||||||| 9a1b2c3',
  'first',
  '=======',
  'feature version',
  '>>>>>>> feat/conflict',
  'footer',
].join('\n')

const zdiff3 = [
  '<<<<<<< HEAD',
  'main version',
  '=======',
  'feature version',
  '||||||| 9a1b2c3',
  'first',
  '>>>>>>> feat/conflict',
].join('\n')

const twoBlocks = [
  'a',
  '<<<<<<< HEAD',
  'ours-1',
  '=======',
  'theirs-1',
  '>>>>>>> feat',
  'middle',
  '<<<<<<< HEAD',
  'ours-2',
  '=======',
  'theirs-2',
  '>>>>>>> feat',
  'z',
].join('\n')

describe('conflict block parsing', () => {
  it('locates a diff3 block including its base section', () => {
    const blocks = parseConflictBlocks(diff3)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].baseStart).toBe(diff3.indexOf('|||||||'))
    expect(blocks[0].separatorStart).toBe(diff3.indexOf('======='))
    expect(blocks[0].endOffset).toBe(diff3.indexOf('>>>>>>> feat/conflict') + '>>>>>>> feat/conflict'.length)
  })

  it('reports no block once the markers are gone', () => {
    expect(parseConflictBlocks('header\nfooter\n')).toEqual([])
    expect(hasConflictMarkers('header\nfooter\n')).toBe(false)
    expect(hasConflictMarkers(diff3)).toBe(true)
  })
})

describe('conflict block resolution over the draft', () => {
  it('drops the diff3 base section when keeping the current side', () => {
    const outcome = resolveConflictBlockInText(diff3, 0, 'current')
    expect(outcome?.text).toBe('header\nmain version\nfooter')
    expect(outcome?.text).not.toContain('first')
    expect(outcome?.text).not.toContain('|||||||')
  })

  it('drops the zdiff3 base section when keeping the incoming side', () => {
    const outcome = resolveConflictBlockInText(zdiff3, 0, 'incoming')
    expect(outcome?.text).toBe('feature version')
    expect(outcome?.remaining).toBe(0)
  })

  it('concatenates both sides without the base section', () => {
    const outcome = resolveConflictBlockInText(diff3, 0, 'both')
    expect(outcome?.text).toBe('header\nmain version\nfeature version\nfooter')
  })

  it('keeps manual edits that were never saved to disk', () => {
    const handEdited = ['header  // 我刚加的手改', ...diff3.split('\n').slice(1)].join('\n')
    const outcome = resolveConflictBlockInText(handEdited, 0, 'current')
    expect(outcome?.text.startsWith('header  // 我刚加的手改')).toBe(true)
    expect(outcome?.text).toBe('header  // 我刚加的手改\nmain version\nfooter')
  })

  it('targets the requested block and reports what is left', () => {
    const first = resolveConflictBlockInText(twoBlocks, 0, 'current')
    expect(first?.remaining).toBe(1)
    expect(first?.text).toBe('a\nours-1\nmiddle\n<<<<<<< HEAD\nours-2\n=======\ntheirs-2\n>>>>>>> feat\nz')
    const second = resolveConflictBlockInText(twoBlocks, 1, 'incoming')
    expect(second?.remaining).toBe(1)
    expect(second?.text).toBe('a\n<<<<<<< HEAD\nours-1\n=======\ntheirs-1\n>>>>>>> feat\nmiddle\ntheirs-2\nz')
    expect(resolveConflictBlockInText(twoBlocks, 9, 'current')).toBeNull()
  })

  it('spans the resolved content so the editor can anchor on it', () => {
    const outcome = resolveConflictBlockInText(twoBlocks, 1, 'incoming')
    expect(outcome).not.toBeNull()
    const { text, span } = outcome as NonNullable<typeof outcome>
    expect(text.slice(span.from, span.to)).toBe('theirs-2')
  })
})

describe('draft state helpers', () => {
  it('detects unsaved edits against the on-disk conflict content', () => {
    expect(isDraftDirty('same\n', { result: 'same\n' })).toBe(false)
    expect(isDraftDirty('same\n', { result: 'same\r\n' })).toBe(false)
    expect(isDraftDirty('edited\n', { result: 'same\n' })).toBe(true)
    expect(isDraftDirty('', null)).toBe(false)
  })

  it('keeps the side buttons usable for binary and gitlink conflicts', () => {
    const binary = { binary: true, gitlink: false, current: null, incoming: null }
    expect(isSideAvailable(binary, 'current')).toBe(true)
    expect(isSideAvailable(binary, 'incoming')).toBe(true)
    const text = { binary: false, gitlink: false, current: null, incoming: 'x' }
    expect(isSideAvailable(text, 'current')).toBe(false)
    expect(isSideAvailable(text, 'incoming')).toBe(true)
    // 后端补上索引分侧字段后以字段为准，不再靠能否读出文本猜测。
    expect(isSideAvailable({ ...text, currentAvailable: true }, 'current')).toBe(true)
    expect(isSideAvailable({ ...binary, incomingAvailable: false }, 'incoming')).toBe(false)
  })
})
