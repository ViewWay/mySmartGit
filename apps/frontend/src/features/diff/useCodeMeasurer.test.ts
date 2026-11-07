import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readCodeGeometry, useCodeMeasurer } from './useCodeMeasurer'

afterEach(() => vi.unstubAllGlobals())

function measured(fontFamily: string, fontSize: number) {
  function Probe() {
    const measure = useCodeMeasurer(fontFamily, fontSize)
    return createElement('output', null, measure('abc'))
  }
  return renderToStaticMarkup(createElement(Probe))
}

describe('useCodeMeasurer', () => {
  it('has a deterministic SSR-only fallback without accessing document', () => {
    expect(measured('monospace', 10)).toBe('<output>18</output>')
    expect(measured('monospace', 20)).toBe('<output>36</output>')
  })

  it('uses canvas font metrics instead of the SSR character approximation in a DOM', () => {
    // Canvas is the external boundary: make its measurement depend on the selected font.
    vi.stubGlobal('document', {
      createElement: () => ({ getContext: () => ({
        font: '',
        measureText(text: string) {
          const size = Number(this.font.match(/([\d.]+)px/)?.[1])
          return { width: text.length * size * (this.font.includes('Wide Code') ? 0.8 : 0.5) }
        },
      }) }),
    })
    expect(measured('Narrow Code', 10)).toBe('<output>15</output>')
    expect(measured('Wide Code', 10)).toBe('<output>24</output>')
    expect(measured('Wide Code', 20)).toBe('<output>48</output>')
  })
})

describe('readCodeGeometry', () => {
  it('uses the actual code cell after gutters/signs, subtracting padding and borders', () => {
    const code = { getBoundingClientRect: () => ({ width: 162.5 }) } as HTMLElement
    vi.stubGlobal('getComputedStyle', () => ({
      fontFamily: 'Actual Code', fontSize: '16px', fontWeight: '400', fontStyle: 'normal', lineHeight: '24px',
      paddingLeft: '9px', paddingRight: '9px', paddingTop: '3px', paddingBottom: '3px',
      borderLeftWidth: '1px', borderRightWidth: '1px',
    }))
    expect(readCodeGeometry(code)).toEqual({
      availableWidth: 142.5, fontFamily: 'Actual Code', fontSize: 16,
      fontWeight: '400', fontStyle: 'normal', lineHeight: 24, padding: 6,
    })
  })
})
