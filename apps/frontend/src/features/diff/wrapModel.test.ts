import { describe, expect, it } from 'vitest'
import { buildLineHeights, buildOffsets, countWrappedLines, indexAtOffset, offsetAtIndex } from './wrapModel'

const measure = (text: string) => Array.from(text).length * 10

describe('countWrappedLines', () => {
  it.each([
    ['abcdefghijkl', 100, 2],
    ['', 100, 1],
    ['a\nb', 100, 2],
    ['a\n\nb\n', 100, 4],
    ['abcdef\r\nxy', 30, 3],
    ['abc', 30, 1],
    ['abc', 29.5, 2],
    ['abc', 0, 3],
    ['abc', -10, 3],
    ['', 0, 1],
    ['abc', Infinity, 1],
    ['\u{1d400}\u{1d400}', 10, 2],
  ])('counts %j at width %s as %s visual lines', (text, width, expected) => {
    expect(countWrappedLines(text, width, measure, 4)).toBe(expected)
  })

  it.each([
    ['a\tb', 50, 1],
    ['abc\tz', 50, 1],
    ['abcd\tz', 50, 2],
    ['a\tb', 40, 2],
    ['a\nabc\tz', 50, 2],
    ['abcde abc\tz', 50, 2],
  ])('advances tabs to four-column stops in %j', (text, width, expected) => {
    expect(countWrappedLines(text, width, measure, 4)).toBe(expected)
  })

  it('supports disabled and alternate tab stops', () => {
    expect(countWrappedLines('a\tb', 20, measure, 0)).toBe(1)
    expect(countWrappedLines('a\tb', 30, measure, 2)).toBe(1)
  })

  it('honors word boundaries before breaking an oversized word anywhere', () => {
    expect(countWrappedLines('aaa aaa aaa', 70, measure, 4)).toBe(2)
    expect(countWrappedLines('aaaa aaaa aaaa', 80, measure, 4)).toBe(3)
    expect(countWrappedLines('abc abcdef', 50, measure, 4)).toBe(3)
  })

  it('lets pre-wrap trailing whitespace hang without adding empty visual lines', () => {
    expect(countWrappedLines('abc   ', 30, measure, 4)).toBe(1)
    expect(countWrappedLines('abc\t', 30, measure, 4)).toBe(1)
  })

  it('measures glyphs rather than dividing total width into impossible fragments', () => {
    const variableMeasure = (text: string) => Array.from(text).reduce((sum, char) => sum + (char === 'W' ? 15 : 5), 0)
    expect(countWrappedLines('WWW', 20, variableMeasure, 4)).toBe(3)
    expect(countWrappedLines('iiW', 20, variableMeasure, 4)).toBe(2)
  })
})

describe('wrap geometry', () => {
  it('builds padded heights with at least one visual line and a row minimum', () => {
    expect(buildLineHeights(['', 'short', 'aaaaaaaaaaaaaaaaaaaa', 'a\nb'], {
      availableWidth: 100, lineHeight: 20, measure, tabSize: 4,
    })).toEqual([20, 20, 40, 40])
    expect(buildLineHeights(['', 'a\nb'], {
      availableWidth: 100, lineHeight: 18, padding: 6, minHeight: 24, measure, tabSize: 4,
    })).toEqual([24, 42])
  })

  it('maps variable row boundaries and the end sentinel in both directions', () => {
    const offsets = buildOffsets([20, 40, 20])
    expect(offsets).toEqual([0, 20, 60, 80])
    expect([-10, 0, 19, 20, 25, 60, 70, 80, 999].map((offset) => indexAtOffset(offsets, offset))).toEqual([0, 0, 0, 1, 1, 2, 2, 2, 2])
    expect([-1, 0, 1, 2, 3, 999].map((index) => offsetAtIndex(offsets, index))).toEqual([0, 0, 20, 60, 80, 80])
  })

  it('handles empty lists without negative indices or undefined offsets', () => {
    expect(buildOffsets([])).toEqual([0])
    expect(indexAtOffset([0], 100)).toBe(0)
    expect(indexAtOffset([], 0)).toBe(0)
    expect(offsetAtIndex([0], 3)).toBe(0)
    expect(offsetAtIndex([], 3)).toBe(0)
  })
})
