import type { Language, LanguageDescription } from '@codemirror/language'
import { syntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { classHighlighter, highlightCode } from '@lezer/highlight'

export interface SyntaxToken {
  text: string
  className: string | null
}

const CACHE_LIMIT = 200
const cache = new Map<string, SyntaxToken[][]>()

export function tokenizeBlock(code: string, language: Language | null): SyntaxToken[][] {
  if (!language) {
    return code.split('\n').map((line) => (line ? [{ text: line, className: null }] : []))
  }
  const lines: SyntaxToken[][] = [[]]
  const state = EditorState.create({ doc: code, extensions: [language] })
  highlightCode(
    code,
    syntaxTree(state),
    classHighlighter,
    (text, classes) => {
      lines[lines.length - 1].push({ text, className: classes || null })
    },
    () => {
      lines.push([])
    },
  )
  return lines
}

export function highlightBlock(
  code: string,
  language: Language | null,
  description: LanguageDescription,
): SyntaxToken[][] {
  if (!language) return tokenizeBlock(code, null)
  const key = `${description.name}\u0000${code}`
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const result = tokenizeBlock(code, language)
  cache.set(key, result)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
  return result
}

export function clearHighlightCache() {
  cache.clear()
}
