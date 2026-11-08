import type { Language, LanguageDescription } from '@codemirror/language'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { highlightCode, tagHighlighter, tags } from '@lezer/highlight'

// 自定义类名映射：在 classHighlighter 的基础上补齐 Markdown/HTML 标签，
// 让 diff 面板与文件预览拿到同一套完整的 tok-* 类（类名与 features.css 对齐）。
const branchlineHighlighter = tagHighlighter([
  { tag: [tags.link, tags.url], class: 'tok-link' },
  { tag: tags.heading, class: 'tok-heading' },
  { tag: tags.emphasis, class: 'tok-emphasis' },
  { tag: tags.strong, class: 'tok-strong' },
  { tag: tags.keyword, class: 'tok-keyword' },
  { tag: tags.atom, class: 'tok-atom' },
  { tag: tags.bool, class: 'tok-bool' },
  { tag: tags.labelName, class: 'tok-labelName' },
  { tag: tags.inserted, class: 'tok-inserted' },
  { tag: tags.deleted, class: 'tok-deleted' },
  { tag: tags.literal, class: 'tok-literal' },
  { tag: tags.string, class: 'tok-string' },
  { tag: tags.number, class: 'tok-number' },
  { tag: [tags.regexp, tags.escape, tags.special(tags.string)], class: 'tok-string2' },
  { tag: tags.variableName, class: 'tok-variableName' },
  { tag: tags.local(tags.variableName), class: 'tok-variableName tok-local' },
  { tag: tags.definition(tags.variableName), class: 'tok-variableName tok-definition' },
  { tag: tags.special(tags.variableName), class: 'tok-variableName2' },
  { tag: tags.definition(tags.propertyName), class: 'tok-propertyName tok-definition' },
  { tag: tags.typeName, class: 'tok-typeName' },
  { tag: tags.namespace, class: 'tok-namespace' },
  { tag: tags.className, class: 'tok-className' },
  { tag: tags.macroName, class: 'tok-macroName' },
  { tag: tags.propertyName, class: 'tok-propertyName' },
  { tag: tags.tagName, class: 'tok-tagName' },
  { tag: tags.attributeName, class: 'tok-attributeName' },
  { tag: [tags.attributeValue, tags.character], class: 'tok-string' },
  { tag: tags.angleBracket, class: 'tok-punctuation' },
  { tag: tags.monospace, class: 'tok-monospace' },
  { tag: tags.strikethrough, class: 'tok-strikethrough' },
  { tag: tags.quote, class: 'tok-quote' },
  { tag: [tags.processingInstruction, tags.contentSeparator], class: 'tok-processingInstruction' },
  { tag: [tags.meta, tags.documentMeta], class: 'tok-meta' },
  { tag: tags.operator, class: 'tok-operator' },
  { tag: tags.comment, class: 'tok-comment' },
  { tag: tags.punctuation, class: 'tok-punctuation' },
  { tag: tags.invalid, class: 'tok-invalid' },
])

export interface SyntaxToken {
  text: string
  className: string | null
}

const CACHE_LIMIT = 200
const cache = new Map<string, SyntaxToken[][]>()

// 裸 EditorState（无编辑器视图）的初始解析视口只有前 3000 字符，
// syntaxTree 返回的只是截至视口的部分树，其后内容整块失去着色——
// 这就是 diff 面板/预览中大文件下半部分没有颜色的原因。
// ensureSyntaxTree 强制解析到文末；超过预算则退回部分树，避免卡死渲染。
const FULL_PARSE_TIMEOUT_MS = 1000

export function tokenizeBlock(code: string, language: Language | null): SyntaxToken[][] {
  if (!language) {
    return code.split('\n').map((line) => (line ? [{ text: line, className: null }] : []))
  }
  const lines: SyntaxToken[][] = [[]]
  const state = EditorState.create({ doc: code, extensions: [language] })
  const tree = ensureSyntaxTree(state, code.length, FULL_PARSE_TIMEOUT_MS) ?? syntaxTree(state)
  highlightCode(
    code,
    tree,
    branchlineHighlighter,
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
