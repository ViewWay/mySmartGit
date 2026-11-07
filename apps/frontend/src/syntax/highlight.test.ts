import { javascript } from '@codemirror/lang-javascript'
import { describe, expect, it } from 'vitest'
import { matchLanguage } from './languages'
import { clearHighlightCache, highlightBlock, tokenizeBlock } from './highlight'

const language = javascript({ typescript: true }).language

describe('matchLanguage', () => {
  it('matches common filenames', () => {
    expect(matchLanguage('src/App.tsx')?.name).toBe('TSX')
    expect(matchLanguage('src/main.ts')?.name).toBe('TypeScript')
    expect(matchLanguage('Dockerfile')?.name).toBe('Dockerfile')
    expect(matchLanguage('Makefile')?.name).toBe('C')
    expect(matchLanguage('unknown.zzz')).toBeNull()
  })

  it('matches tree-preview paths with any supported extension', () => {
    expect(matchLanguage('src/main/java/org/openmuc/jdlms/APduBlockingQueue.java')?.name).toBe('Java')
    expect(matchLanguage('src/lib.rs')?.name).toBe('Rust')
    expect(matchLanguage('cmd/server/main.go')?.name).toBe('Go')
    expect(matchLanguage('styles/main.css')?.name).toBe('CSS')
    expect(matchLanguage('py/main.py')?.name).toBe('Python')
    expect(matchLanguage('doc/readme')).toBeNull()
  })
})

describe('tokenizeBlock', () => {
  it('highlights keywords, strings, and cross-line comments', () => {
    const tokens = tokenizeBlock('const a = 1\n/* line\ncomment */\nconst b = "x"', language)
    expect(tokens).toHaveLength(4)
    expect(tokens[0].some((token) => token.className?.includes('tok-keyword'))).toBe(true)
    expect(tokens.flat().some((token) => token.className?.includes('tok-string'))).toBe(true)
    expect(tokens[1].some((token) => token.className?.includes('tok-comment'))).toBe(true)
    expect(tokens[2].some((token) => token.className?.includes('tok-comment'))).toBe(true)
  })

  it('returns plain tokens without a language', () => {
    expect(tokenizeBlock('hello\nworld', null)).toEqual([
      [{ text: 'hello', className: null }],
      [{ text: 'world', className: null }],
    ])
  })

  it('caches identical blocks', () => {
    clearHighlightCache()
    const description = { name: 'TypeScript' } as never
    const first = highlightBlock('let x = 1', language, description)
    const second = highlightBlock('let x = 1', language, description)
    expect(second).toBe(first)
  })
})
