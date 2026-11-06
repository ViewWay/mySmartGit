import { useEffect, useMemo, useState } from 'react'

export function useCodeMeasurer(fontFamily: string, fontSize: number, fontStyle = 'normal', fontWeight = '400') {
  const [fontRevision, setFontRevision] = useState(0)
  useEffect(() => {
    const fonts = document.fonts
    if (!fonts) return
    let disposed = false
    const refresh = () => { if (!disposed) setFontRevision((value) => value + 1) }
    void fonts.ready.then(refresh)
    fonts.addEventListener('loadingdone', refresh)
    return () => { disposed = true; fonts.removeEventListener('loadingdone', refresh) }
  }, [])

  return useMemo(() => {
    if (typeof document === 'undefined') return (text: string) => Array.from(text).length * fontSize * 0.6
    const context = document.createElement('canvas').getContext('2d')
    if (!context) throw new Error('Canvas text measurement is unavailable')
    context.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`
    context.fontKerning = 'none'
    const widths = new Map<string, number>()
    return (text: string) => {
      const cached = widths.get(text)
      if (cached !== undefined) return cached
      const width = context.measureText(text).width
      // Bound memory for large/minified diffs; ordinary tokens are reused heavily.
      if (text.length <= 512 && widths.size < 4096) widths.set(text, width)
      return width
    }
  }, [fontFamily, fontSize, fontStyle, fontWeight, fontRevision])
}

export function readCodeGeometry(code: HTMLElement) {
  const style = getComputedStyle(code)
  const pixels = (value: string) => Number.parseFloat(value) || 0
  return {
    // The grid already deducted line numbers, signs and the action gutter. Read
    // the code cell rather than guessing their widths from the outer viewer.
    availableWidth: Math.max(1, code.getBoundingClientRect().width - pixels(style.paddingLeft) - pixels(style.paddingRight) - pixels(style.borderLeftWidth) - pixels(style.borderRightWidth)),
    fontFamily: style.fontFamily,
    fontSize: pixels(style.fontSize),
    fontStyle: style.fontStyle,
    fontWeight: style.fontWeight,
    lineHeight: pixels(style.lineHeight),
    padding: pixels(style.paddingTop) + pixels(style.paddingBottom),
  }
}
