export interface WrapOptions {
  availableWidth: number
  lineHeight: number
  measure: (text: string) => number
  tabSize: number
  /** Combined top/bottom code padding, applied once per source row. */
  padding?: number
  minHeight?: number
}

// The app targets ES2020 typings; the desktop webview provides Intl.Segmenter.
const { Segmenter } = Intl as typeof Intl & {
  Segmenter: new (locale: undefined, options: { granularity: 'grapheme' }) => { segment(text: string): Iterable<{ segment: string }> }
}
const graphemes = new Segmenter(undefined, { granularity: 'grapheme' })

/** CSS pre-wrap: preserve hard breaks, prefer words, break oversized words anywhere. */
export function countWrappedLines(text: string, availableWidth: number, measure: (text: string) => number, tabSize: number) {
  const width = Math.max(1, availableWidth || 1)
  const spaceWidth = measure(' ')
  const tabWidth = Math.max(0, tabSize) * spaceWidth
  let lines = 0
  for (const hardLine of text.split(/\r\n|[\r\n]/)) {
    lines++
    let x = 0
    for (const token of hardLine.match(/[ \t]+|[^ \t]+/g) ?? []) {
      if (/^[ \t]/.test(token)) {
        // pre-wrap hangs trailing whitespace; it only causes a break if text follows.
        for (const char of token) {
          if (char === ' ') x += spaceWidth
          else if (tabWidth > 0) {
            let advance = tabWidth - x % tabWidth
            if (advance < spaceWidth / 2) advance += tabWidth
            x += advance
          }
        }
        continue
      }
      const tokenWidth = measure(token)
      if (x > 0 && x + tokenWidth > width) { lines++; x = 0 }
      if (tokenWidth <= width) { x += tokenWidth; continue }
      // A wide glyph cannot be split into fractions; totalWidth / width undercounts.
      let fragment = ''
      for (const { segment } of graphemes.segment(token)) {
        const next = fragment + segment
        if (fragment && measure(next) > width) {
          lines++
          fragment = segment
        } else fragment = next
      }
      x = measure(fragment)
    }
  }
  return lines
}

export function buildLineHeights(lines: string[], options: WrapOptions): number[] {
  return lines.map((line) => Math.max(options.minHeight ?? 0, Math.ceil(
    countWrappedLines(line, options.availableWidth, options.measure, options.tabSize) * options.lineHeight + (options.padding ?? 0),
  )))
}

/** Includes an end sentinel so spacer heights use the same geometry as rows. */
export function buildOffsets(heights: number[]): number[] {
  const offsets = [0]
  heights.forEach((height, index) => offsets.push(offsets[index] + height))
  return offsets
}

export function offsetAtIndex(offsets: number[], index: number): number {
  return offsets[Math.max(0, Math.min(offsets.length - 1, Math.floor(index)))] ?? 0
}

export function indexAtOffset(offsets: number[], offset: number): number {
  let low = 0
  let high = Math.max(0, offsets.length - 2)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (offsets[mid] <= offset) low = mid
    else high = mid - 1
  }
  return low
}
