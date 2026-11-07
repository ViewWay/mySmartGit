import { useEffect, useMemo, useRef } from 'react'
import { foldGutter, foldKeymap, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { defaultKeymap } from '@codemirror/commands'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
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
 */
export function TreeCodePreview({ text, filePath }: { text: string; filePath: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const languageCompartment = useRef(new Compartment())
  const [initialText, initialPath] = useMemo(() => [text, filePath], [])
  const languageDescription = useMemo(() => matchLanguage(initialPath), [initialPath])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({
      state: EditorState.create({
        doc: initialText,
        extensions: [
          lineNumbers(),
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
    // initialText/initialPath 取自首次挂载：换文件由下方 effect 热替换，不重建视图。
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

  useEffect(() => {
    let cancelled = false
    if (!languageDescription) return
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