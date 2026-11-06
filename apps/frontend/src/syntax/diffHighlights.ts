import { useEffect, useMemo, useState } from 'react'
import type { Language, LanguageDescription } from '@codemirror/language'
import type { RepositoryDiffLine } from '@branchline/git-models'
import { matchLanguage } from './languages'
import { tokenizeBlock, type SyntaxToken } from './highlight'

export function buildDiffHighlightIndex(rows: RepositoryDiffLine[], language: Language | null) {
  const index = new Map<number, SyntaxToken[]>()
  if (!language || !rows.length) return index
  const oldRows: number[] = []
  const newRows: number[] = []
  const oldLines: string[] = []
  const newLines: string[] = []
  rows.forEach((row, rowIndex) => {
    if (row.kind !== 'add') {
      oldRows.push(rowIndex)
      oldLines.push(row.code)
    }
    if (row.kind !== 'del') {
      newRows.push(rowIndex)
      newLines.push(row.code)
    }
  })
  const oldTokens = tokenizeBlock(oldLines.join('\n'), language)
  const newTokens = tokenizeBlock(newLines.join('\n'), language)
  oldRows.forEach((rowIndex, lineIndex) => index.set(rowIndex, oldTokens[lineIndex] ?? []))
  newRows.forEach((rowIndex, lineIndex) => index.set(rowIndex, newTokens[lineIndex] ?? []))
  return index
}

export function useLanguageDescription(path: string) {
  const description = useMemo<LanguageDescription | null>(() => matchLanguage(path), [path])
  const [language, setLanguage] = useState<Language | null>(null)
  useEffect(() => {
    let cancelled = false
    setLanguage(null)
    if (!description) return
    void description
      .load()
      .then((support) => {
        if (!cancelled) setLanguage(support.language)
      })
      .catch(() => {
        if (!cancelled) setLanguage(null)
      })
    return () => {
      cancelled = true
    }
  }, [description])
  return { description, language }
}

export function useDiffHighlights(rows: RepositoryDiffLine[], path: string) {
  const { language } = useLanguageDescription(path)
  return useMemo(() => buildDiffHighlightIndex(rows, language), [rows, language])
}
