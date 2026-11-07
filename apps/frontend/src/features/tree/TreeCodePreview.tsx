import { useEffect, useMemo, useRef } from 'react'
import { foldGutter, foldKeymap, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { defaultKeymap } from '@codemirror/commands'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, StateEffect, StateField } from '@codemirror/state'
import { EditorView, gutter, GutterMarker, keymap, lineNumbers } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { indentationMarkers } from '@replit/codemirror-indentation-markers'
import { matchLanguage } from '../../syntax/languages'

const previewHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: tags.keyword, color: 'var(--syntax-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syntax-number)' },
  { tag: [tags.typeName, tags.className, tags.definition(tags.typeName)], color: 'var(--syntax-type)' },
  { tag: [tags.operatorKeyword, tags.operator], color: 'var(--text)' },
  { tag: [tags.punctuation, tags.bracket], color: 'var(--muted)' },
])

const previewTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--text-primary)' },
  '.cm-scroller': { fontFamily: 'var(--font-code)', fontSize: '12px', lineHeight: '1.55' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--text-tertiary)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 8%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-secondary)' },
  '.cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--accent) 24%, transparent) !important' },
  '.cm-foldGutter .cm-gutterElement': { cursor: 'pointer', color: 'var(--text-tertiary)' },
  '.cm-panels': { backgroundColor: 'var(--surface-chrome)', color: 'var(--text-primary)' },
  '.cm-textfield': { backgroundColor: 'var(--surface-base)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' },
  '.cm-button': { backgroundColor: 'var(--surface-base)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' },
})

/**
 * 只读 CodeMirror 预览：行号、语法折叠、缩进参考线、Ctrl+F 查找。
 * 文本与语言都走 Compartment 热替换，换文件不用重建视图。
 * B2：可选挂审查评论 gutter——有线程的行号旁显示圆点，点击行号/圆点打开评论区。
 */

// 审查线程行号集合：由 props 驱动，经 StateEffect 热替换。
const setThreadLines = StateEffect.define<Set<number>>()
const threadLinesField = StateField.define<Set<number>>({
  create: () => new Set<number>(),
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setThreadLines)) return effect.value
    }
    return value
  },
})

class ReviewDotMarker extends GutterMarker {
  override toDOM(): HTMLElement {
    const element = document.createElement('span')
    element.className = 'cm-review-dot'
    element.setAttribute('aria-hidden', 'true')
    return element
  }
}

const reviewDotMarker = new ReviewDotMarker()

/** 审查 gutter：有线程的行画圆点；点击行号区交给 onLineNumberClick（带 1 起行号）。 */
function reviewGutter(onLineNumberClick: (line: number) => void) {
  return gutter({
    class: 'cm-review-gutter',
    lineMarker: (view, block) =>
      view.state.field(threadLinesField, false)?.has(view.state.doc.lineAt(block.from).number)
        ? reviewDotMarker
        : null,
    // 固定槽宽：圆点出现/消失时行号不抖动。
    initialSpacer: () => reviewDotMarker,
    domEventHandlers: {
      mousedown: (view, block) => {
        onLineNumberClick(view.state.doc.lineAt(block.from).number)
        return true
      },
    },
  })
}

export type TreeCodePreviewProps = {
  text: string
  filePath: string
  /** 有审查线程的行号集合（1 起）；不传则不渲染审查 gutter。 */
  threadLines?: Set<number>
  /** 点击行号/圆点回调；不传则行号区无点击行为。 */
  onLineNumberClick?: (line: number) => void
}

export function TreeCodePreview({ text, filePath, threadLines, onLineNumberClick }: TreeCodePreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const languageCompartment = useRef(new Compartment())
  // 回调经 ref 转发：挂载 effect 只跑一次，仍能用到最新回调。
  const lineClickRef = useRef(onLineNumberClick)
  lineClickRef.current = onLineNumberClick
  const [initialText] = useMemo(() => [text], [])
  // 语言跟随当前文件：切文件（跨扩展名）时热切换语法，而不是冻结在首次挂载的文件。
  const languageDescription = useMemo(() => matchLanguage(filePath), [filePath])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({
      state: EditorState.create({
        doc: initialText,
        extensions: [
          lineNumbers(),
          // 审查 gutter 挂在行号左侧；无回调时也要占位（initialSpacer 固定宽度）。
          reviewGutter((line) => lineClickRef.current?.(line)),
          foldGutter(),
          indentationMarkers({ hideFirstIndent: true }),
          keymap.of([...foldKeymap, ...searchKeymap, ...defaultKeymap]),
          highlightSelectionMatches(),
          search({ top: true }),
          syntaxHighlighting(previewHighlightStyle, { fallback: true }),
          previewTheme,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          languageCompartment.current.of([]),
        ],
      }),
      parent: host,
    })
    viewRef.current = view
    return () => {
      viewRef.current = null
      view.destroy()
    }
    // 文本/语言/gutter 都经 effect 热替换，换文件不重建视图。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: 0 },
      effects: EditorView.scrollIntoView(0, { y: 'start' }),
    })
  }, [text])

  // 线程行号集合变化时热替换 gutter 数据。
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setThreadLines.of(threadLines ?? new Set()) })
  }, [threadLines])

  useEffect(() => {
    let cancelled = false
    // 未知扩展名：清掉上一个文件的语言残留，避免错挂高亮。
    if (!languageDescription) {
      viewRef.current?.dispatch({ effects: languageCompartment.current.reconfigure([]) })
      return
    }
    void languageDescription
      .load()
      .then((support) => {
        if (!cancelled && viewRef.current) viewRef.current.dispatch({ effects: languageCompartment.current.reconfigure(support) })
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [languageDescription])

  return <div ref={hostRef} className="tree-code-preview" data-path={filePath}/>
}