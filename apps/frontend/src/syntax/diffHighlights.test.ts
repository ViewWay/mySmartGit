import { javascript } from '@codemirror/lang-javascript'
import type { RepositoryDiffLine } from '@branchline/git-models'
import { describe, expect, it } from 'vitest'
import { buildDiffHighlightIndex } from './diffHighlights'

const language = javascript({ typescript: true }).language

describe('buildDiffHighlightIndex', () => {
  it('uses old and new streams independently', () => {
    const rows: RepositoryDiffLine[] = [
      { kind: 'del', code: 'const oldName = 1', old: 1, next: null },
      { kind: 'add', code: 'const newName = 1', old: null, next: 1 },
      { kind: 'same', code: 'return', old: 2, next: 2 },
    ]
    const index = buildDiffHighlightIndex(rows, language)
    expect(index.get(0)?.some((token) => token.className?.includes('tok-keyword'))).toBe(true)
    expect(index.get(1)?.some((token) => token.className?.includes('tok-keyword'))).toBe(true)
  })

  it('returns an empty index without a language', () => {
    expect(buildDiffHighlightIndex([{ kind: 'same', code: 'x', old: 1, next: 1 }], null).size).toBe(0)
  })
})
