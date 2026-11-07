import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HighlightedCode } from './HighlightedCode'

describe('HighlightedCode', () => {
  it('renders pre-tokenized classes', () => {
    const html = renderToStaticMarkup(
      <HighlightedCode
        code="const a = 1"
        tokens={[
          { text: 'const', className: 'tok-keyword' },
          { text: ' a = 1', className: null },
        ]}
        filePath="a.ts"
      />,
    )
    expect(html).toContain('tok-keyword')
    expect(html).toContain('const')
  })

  it('falls back to the local tokenizer without tokens', () => {
    const html = renderToStaticMarkup(<HighlightedCode code="const a = 1" filePath="a.ts" />)
    expect(html).toContain('token keyword')
  })
})
