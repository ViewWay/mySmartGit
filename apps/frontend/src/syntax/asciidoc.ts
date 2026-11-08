import { StreamLanguage } from '@codemirror/language'
import { tags } from '@lezer/highlight'

/**
 * 轻量 AsciiDoc 语法：CodeMirror 生态没有现成 adoc 模式，这里覆盖常用标记——
 * 区块标题（=xx）、块标题（.Title）、粗体/斜体/行内码、围栏代码块、
 * 列表标记、表格框线、属性行与提示块（NOTE:/WARNING:...）。
 * 标签名与 previewHighlightStyle / branchlineHighlighter 已有的规则对齐，无需新增 CSS。
 */

const BLOCK_FENCES = ['////', '----', '....', '====', '****', '____', '++++'] as const
const FENCE_PATTERN = /^(?:\/{4}|-{4}|\.{4}|={4}|\*{4}|_{4}|\+{4})\s*$/

type AsciiDocState = {
  /** 当前所在围栏块的定界符；null 表示不在块内。 */
  inBlock: string | null
}

export const asciidocLanguage = StreamLanguage.define<AsciiDocState>({
  name: 'AsciiDoc',
  startState: () => ({ inBlock: null }),
  tokenTable: {
    heading: tags.heading,
    strong: tags.strong,
    emphasis: tags.emphasis,
    monospace: tags.monospace,
    url: tags.url,
    listMark: tags.processingInstruction,
    blockMark: tags.punctuation,
    attribute: tags.meta,
    admonition: tags.keyword,
    label: tags.labelName,
    comment: tags.comment,
  },
  token(stream, state) {
    if (stream.sol()) {
      // 围栏定界符：`////` 是注释块，其余块内容按行内码着色。
      if (stream.match(FENCE_PATTERN, false)) {
        let fence: string | null = null
        for (const candidate of BLOCK_FENCES) {
          if (!stream.match(candidate, false)) continue
          fence = candidate
          break
        }
        // 在移动位置前先识别定界符，再翻转到块内/块外状态。
        state.inBlock = fence && state.inBlock === fence ? null : fence
        stream.skipToEnd()
        return 'blockMark'
      }
      if (state.inBlock) {
        stream.skipToEnd()
        return state.inBlock === '////' ? 'comment' : 'monospace'
      }
      // 行注释 //
      if (stream.match(/^\/\//)) {
        stream.skipToEnd()
        return 'comment'
      }
      // 文档属性行 :toc: :author:
      if (stream.match(/^:[\w-]+:/)) {
        stream.skipToEnd()
        return 'attribute'
      }
      // 区块标题 =xx ... ======xx（后面必须跟空白，避免误吞 `====` 定界符）
      if (stream.match(/^={1,6}(?=\s)/)) return 'heading'
      // 无序列表 * - +，有序列表 . ..
      if (stream.match(/^\*{1,6}(?=\s)|^[-+](?=\s)|^\.{1,6}(?=\s)/)) return 'listMark'
      // 块标题 .Title（点后紧跟非空白）
      if (stream.match(/^\.(?=[^\s.])/)) {
        stream.skipToEnd()
        return 'label'
      }
      // 表格框线与单元格前缀
      if (stream.match(/^\|===?\s*$|^!===?\s*$/)) return 'blockMark'
      if (stream.match(/^[|!](?=\S)/)) return 'blockMark'
      // 提示块 NOTE:/TIP:/WARNING:...
      if (stream.match(/^(NOTE|TIP|IMPORTANT|WARNING|CAUTION):/)) return 'admonition'
    }
    if (state.inBlock) {
      stream.skipToEnd()
      return state.inBlock === '////' ? 'comment' : 'monospace'
    }
    // 行内格式：*粗* _斜_ `码` 与链接 https://...[文字]
    if (stream.match(/\*[^*\s][^*]*\*/)) return 'strong'
    if (stream.match(/_[^_\s][^_]*_/)) return 'emphasis'
    if (stream.match(/`[^`\n]+`/)) return 'monospace'
    if (stream.match(/^https?:\/\/[^\s[]+/)) return 'url'
    if (stream.match(/\[[^\]\n]+\]/)) return 'attribute'
    stream.next()
    return null
  },
})

