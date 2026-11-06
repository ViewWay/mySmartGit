import { describe, expect, it } from 'vitest'
import { parseConflictBlocks } from './conflictDraft'
import { blockSections, conflictBlockCount, locateSectionRanges, paneLabels, resolveAllBlocks } from './threePane'

import { zh } from '../../i18n/messages/zh'
const zhT = (key: string, params?: Record<string, string | number>) => (zh as Record<string, string>)[key] ?? key


const diff3 = [
  'header',
  '<<<<<<< HEAD',
  'main version',
  '||||||| 9a1b2c3',
  'ancestor',
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
  'ancestor',
  '>>>>>>> feat/conflict',
].join('\n')

const plainTwoWay = [
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

describe('three-pane block sections', () => {
  it('splits a diff3 block into current / incoming / base without leaking the ancestor', () => {
    const [block] = parseConflictBlocks(diff3)
    expect(block).toBeDefined()
    const sections = blockSections(diff3, block!)
    expect(sections.current).toBe('main version\n')
    expect(sections.incoming).toBe('feature version\n')
    expect(sections.base).toBe('ancestor\n')
  })

  it('splits a zdiff3 block with the base trailing the incoming side', () => {
    const [block] = parseConflictBlocks(zdiff3)
    expect(block).toBeDefined()
    const sections = blockSections(zdiff3, block!)
    expect(sections.current).toBe('main version\n')
    expect(sections.incoming).toBe('feature version\n')
    expect(sections.base).toBe('ancestor\n')
  })

  it('reports no base for plain two-way conflicts', () => {
    const [block] = parseConflictBlocks(plainTwoWay)
    expect(block).toBeDefined()
    const sections = blockSections(plainTwoWay, block!)
    expect(sections.current).toBe('ours-1\n')
    expect(sections.incoming).toBe('theirs-1\n')
    expect(sections.base).toBeNull()
  })
})

describe('side pane range locating', () => {
  it('locates every block section in the clean side file, in order', () => {
    const sideText = ['a', 'ours-1', 'middle', 'ours-2', 'z'].join('\n')
    const blocks = parseConflictBlocks(plainTwoWay)
    const sections = blocks.map((block) => blockSections(plainTwoWay, block).current)
    const ranges = locateSectionRanges(sideText, sections)
    expect(ranges).toHaveLength(2)
    expect(sideText.slice(ranges[0]!.from, ranges[0]!.to)).toBe('ours-1\n')
    expect(sideText.slice(ranges[1]!.from, ranges[1]!.to)).toBe('ours-2\n')
  })

  it('returns null for a manually edited section without breaking later matches', () => {
    const sideText = ['a', 'ours-1', 'middle', 'ours-2', 'z'].join('\n')
    const ranges = locateSectionRanges(sideText, ['ours-1\n', 'hand-typed text\n', 'ours-2\n'])
    expect(ranges[0]).not.toBeNull()
    expect(ranges[1]).toBeNull()
    expect(ranges[2]).not.toBeNull()
    expect(sideText.slice(ranges[2]!.from, ranges[2]!.to)).toBe('ours-2\n')
  })

  it('matches repeated snippets monotonically instead of always hitting the first copy', () => {
    const sideText = ['dup', 'dup', ''].join('\n')
    const ranges = locateSectionRanges(sideText, ['dup\n', 'dup\n'])
    expect(ranges[0]!.from).toBe(0)
    expect(ranges[1]!.from).toBe(4)
  })
})

describe('batch resolution', () => {
  it('applies one strategy to every remaining block in the draft', () => {
    const outcome = resolveAllBlocks(plainTwoWay, 'incoming')
    expect(outcome.resolved).toBe(2)
    expect(conflictBlockCount(outcome.text)).toBe(0)
    expect(outcome.text).toBe(['a', 'theirs-1', 'middle', 'theirs-2', 'z'].join('\n'))
  })

  it('keeps both sides in block order when batch-keeping both', () => {
    const outcome = resolveAllBlocks(plainTwoWay, 'both')
    expect(outcome.resolved).toBe(2)
    expect(outcome.text).toBe(['a', 'ours-1', 'theirs-1', 'middle', 'ours-2', 'theirs-2', 'z'].join('\n'))
  })

  it('is a no-op on a draft without conflict markers', () => {
    const outcome = resolveAllBlocks('clean text', 'current')
    expect(outcome.resolved).toBe(0)
    expect(outcome.text).toBe('clean text')
  })
})

describe('pane labels with rebase semantics', () => {
  it('consumes backend labels so rebase can flip the meaning of each side', () => {
    const labels = paneLabels({ currentLabel: '变基目标（当前）', incomingLabel: '正在应用的提交' }, zhT)
    expect(labels.current).toBe('变基目标（当前）')
    expect(labels.incoming).toBe('正在应用的提交')
  })

  it('falls back to operation-neutral wording when labels are missing', () => {
    const labels = paneLabels(null, zhT)
    expect(labels.current).toContain('current')
    expect(labels.incoming).toContain('incoming')
    expect(labels.current).not.toContain('本地')
    expect(labels.incoming).not.toContain('远端')
  })

  it('ignores blank labels from stale payloads', () => {
    expect(paneLabels({ currentLabel: '   ', incomingLabel: '' }, zhT).current).toContain('current')
  })
})
