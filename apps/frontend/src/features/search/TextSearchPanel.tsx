import { useI18n } from '../../i18n'
import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, FilePen, Loader2, RotateCcw, Search, ShieldAlert, Wand2 } from 'lucide-react'
import { Button } from '../../components/Button'
import { useConfirmDialog } from '../../components/ConfirmDialog'
import {
  applyTextReplace,
  listTextReplaceBackups,
  loadRepository,
  loadRepositoryTextFile,
  previewTextReplace,
  saveRepositoryTextFile,
  undoTextReplace,
} from '../../repository'
import type {
  ReplaceBackupSummary,
  ReplacePreview,
  RepositorySnapshot,
  RepositoryTextFile,
  TextSearchMatch,
} from '../../repository'
import {
  TEXT_PAGE_SIZE,
  buildTextSearchQuery,
  currentPage,
  defaultTextSearchForm,
  goLastPage,
  goNextPage,
  goPrevPage,
  matchPosition,
  rangeLabel,
  resultBanner,
  totalLabel,
  totalPages,
  validatePattern,
  type TextSearchForm,
} from './searchModel'
import {
  applyBlocker,
  backupLabel,
  buildReplaceQuery,
  canApply,
  canSaveFile,
  defaultReplaceForm,
  replacementConfirmation,
  reportNotice,
  undoNotice,
  validateReplaceForm,
  type ReplaceForm,
} from './replaceFlow'
import type { useSearchRunner } from './useSearchRunner'

type Runner = ReturnType<typeof useSearchRunner>

type TextSearchPanelProps = {
  runner: Runner
  repository: RepositorySnapshot | null
  onSnapshot: (snapshot: RepositorySnapshot) => void
  onNotice: (message: string) => void
}

/** 仓库全文搜索（git grep）+ dry-run 替换 + 撤销 + 内置编辑器。 */
export function TextSearchPanel({ runner, repository, onSnapshot, onNotice }: TextSearchPanelProps) {
  const { t } = useI18n()
  const [form, setForm] = useState<TextSearchForm>(defaultTextSearchForm)
  const [replaceForm, setReplaceForm] = useState<ReplaceForm>(defaultReplaceForm)
  const [preview, setPreview] = useState<ReplacePreview | null>(null)
  const [backups, setBackups] = useState<ReplaceBackupSummary[]>([])
  const [replacing, setReplacing] = useState(false)
  const [invalid, setInvalid] = useState<string | null>(null)
  const [editor, setEditor] = useState<{ file: RepositoryTextFile; draft: string } | null>(null)
  const { confirm, confirmDialog } = useConfirmDialog()

  const page = runner.textPage
  const banner = page ? resultBanner(page, t) : null
  const repositoryPath = repository?.path ?? null
  const blocker = applyBlocker(preview, t)

  const patch = (changes: Partial<TextSearchForm>) => setForm((current) => ({ ...current, ...changes }))
  const patchReplace = (changes: Partial<ReplaceForm>) => {
    setReplaceForm((current) => ({ ...current, ...changes }))
    // 条件一变，旧预览立刻作废：不能让用户拿上一次的命中范围去确认这一次的替换。
    setPreview(null)
  }

  useEffect(() => {
    setPreview(null)
    setEditor(null)
    if (!repositoryPath) {
      setBackups([])
      return
    }
    void listTextReplaceBackups(repositoryPath).then(setBackups).catch(() => setBackups([]))
  }, [repositoryPath])

  const submit = async (offset = 0) => {
    const error = validatePattern(form.pattern, t)
    setInvalid(error)
    if (error) return
    await runner.runTextSearch(buildTextSearchQuery(form, offset))
  }

  const cursor = page
    ? { offset: page.offset, pageSize: page.pageSize || TEXT_PAGE_SIZE, total: page.total }
    : null
  const pages = cursor ? totalPages(cursor) : 0

  const runPreview = async () => {
    if (!repositoryPath) return
    const error = validateReplaceForm(replaceForm, null, t)
    setInvalid(error)
    if (error) return
    setReplacing(true)
    try {
      const result = await previewTextReplace(repositoryPath, buildReplaceQuery(replaceForm))
      setPreview(result)
      setInvalid(null)
      // 截断或全跳过时直接说明，不给确认机会。
      if (result.truncated) onNotice(result.notice ?? t('search.previewTruncated'))
      else if (result.totalOccurrences === 0) onNotice(t('search.noReplaceableHits'))
    } catch (error) {
      setInvalid(error instanceof Error ? error.message : String(error))
      setPreview(null)
    } finally {
      setReplacing(false)
    }
  }

  const runApply = async () => {
    if (!repositoryPath || !preview || !canApply(preview)) return
    const accepted = await confirm({
      title: t('search.confirmBulkReplace'),
      message: replacementConfirmation(preview, t).join('\n'),
      confirmLabel: t('search.writeReplace'),
      variant: 'danger',
    })
    if (!accepted) {
      onNotice(t('search.writeApplied'))
      return
    }
    setReplacing(true)
    try {
      // 一次预览只允许执行一次：后端会取走计划，重复调用直接失败。
      const report = await applyTextReplace(repositoryPath, preview.previewId, true)
      setPreview(null)
      onNotice(reportNotice(report, t))
      const next = await listTextReplaceBackups(repositoryPath)
      setBackups(next)
      // 替换只改工作区，重新拉快照让「暂存与提交」看到新状态。
      onSnapshot(await loadRepository(repositoryPath))
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setReplacing(false)
    }
  }

  const runUndo = async (replaceId: string) => {
    if (!repositoryPath) return
    const accepted = await confirm({
      title: t('search.undoReplace'),
      message: t('search.undoReplaceWarning'),
      confirmLabel: t('search.undo'),
      variant: 'danger',
    })
    if (!accepted) return
    setReplacing(true)
    try {
      const report = await undoTextReplace(repositoryPath, replaceId)
      onNotice(undoNotice(report, t))
      setBackups(await listTextReplaceBackups(repositoryPath))
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setReplacing(false)
    }
  }

  const openEditor = useCallback(async (match: TextSearchMatch) => {
    if (!repositoryPath) return
    try {
      // 搜索结果里的行号是 1 起，编辑器按它滚动定位。
      const file = await loadRepositoryTextFile(repositoryPath, match.filePath, null, match.revision ?? null)
      setEditor({ file, draft: file.content })
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    }
  }, [repositoryPath, onNotice])

  const saveEditor = async () => {
    if (!repositoryPath || !editor) return
    const guard = canSaveFile(editor.file, t)
    if (!guard.ok) {
      onNotice(guard.reason ?? t('search.notSavable'))
      return
    }
    try {
      const saved = await saveRepositoryTextFile(repositoryPath, editor.file.filePath, editor.draft, editor.file.checksum)
      setEditor({ file: saved, draft: saved.content })
      onNotice(saved.notice ?? t('search.saved'))
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    }
  }

  return <section className="search-panel">
    <div className="search-form">
      <label className="search-field search-field-grow">
        <span>{t('search.keyword')}</span>
        <input
          value={form.pattern}
          placeholder={t('search.keywordPlaceholder')}
          onChange={(event) => patch({ pattern: event.target.value })}
          onKeyDown={(event) => { if (event.key === 'Enter') void submit(0) }}
        />
      </label>
      <label className="search-field">
        <span>{t('search.scope')}</span>
        <input
          value={form.revision}
          placeholder={t('search.scopePlaceholder')}
          onChange={(event) => patch({ revision: event.target.value })}
        />
      </label>
      <Button variant="primary" disabled={runner.busy || !form.pattern.trim()} onClick={() => void submit(0)}>
        {runner.busy ? <Loader2 size={14} className="spin" /> : <Search size={14} />}{t('search.searchContent')}
      </Button>
      {runner.busy && <Button variant="secondary" onClick={() => void runner.stop()}>{t('search.abort')}</Button>}
    </div>

    <div className="search-options">
      <label><input type="checkbox" checked={form.caseSensitive} onChange={(event) => patch({ caseSensitive: event.target.checked })}/><span>{t('search.caseSensitive')}</span></label>
      <label><input type="checkbox" checked={form.wholeWord} onChange={(event) => patch({ wholeWord: event.target.checked })}/><span>{t('search.wholeWord')}</span></label>
      <label><input type="checkbox" checked={form.regex} onChange={(event) => patch({ regex: event.target.checked })}/><span>{t('search.regex')}</span></label>
      <label><span>{t('search.contextLines')}</span><input type="number" min={0} max={10} value={form.contextLines ?? 2} onChange={(event) => patch({ contextLines: Number(event.target.value) || 0 })}/></label>
      <label><span>{t('search.hitLimit')}</span><input type="number" min={1} value={form.maxMatches ?? ''} onChange={(event) => patch({ maxMatches: event.target.value ? Number(event.target.value) : null })}/></label>
    </div>

    <details className="search-scope">
      <summary>{t('search.pathFilter')}</summary>
      <div className="search-form search-form-stacked">
        <label className="search-field"><span>{t('search.includePaths')}</span><textarea rows={2} value={form.includes} placeholder={'apps/**\n*.rs'} onChange={(event) => patch({ includes: event.target.value })}/></label>
        <label className="search-field"><span>{t('search.excludePaths')}</span><textarea rows={2} value={form.excludePaths} placeholder="pnpm-lock.yaml" onChange={(event) => patch({ excludePaths: event.target.value })}/></label>
      </div>
    </details>

    {invalid && <p className="search-error">{invalid}</p>}
    {runner.error && <p className="search-error">{runner.error}</p>}

    {page && cursor && <div className="search-results">
      <header className="search-results-header">
        <span>{page.pattern}｜{totalLabel(page, t)}｜{page.matchedFiles} {t('search.filesUnit')}</span>
        <span className="search-pager">
          <Button size="compact" variant="icon" disabled={cursor.offset <= 0} onClick={() => void runner.loadTextPage(page.searchId, goPrevPage(cursor), cursor.pageSize, form.contextLines ?? 2)}><ChevronLeft size={14}/></Button>
          <span>{pages ? `${currentPage(cursor)} / ${pages}` : '0 / 0'}</span>
          <span>{rangeLabel(cursor, page.items.length, t)}</span>
          <Button size="compact" variant="icon" disabled={!page.hasMore} onClick={() => void runner.loadTextPage(page.searchId, goNextPage(cursor), cursor.pageSize, form.contextLines ?? 2)}><ChevronRight size={14}/></Button>
          <Button size="compact" variant="secondary" disabled={pages <= 1} onClick={() => void runner.loadTextPage(page.searchId, goLastPage(cursor), cursor.pageSize, form.contextLines ?? 2)}>{t('search.lastPage')}</Button>
        </span>
      </header>
      {banner && <p className="search-banner"><ShieldAlert size={13}/>{banner}</p>}
      {page.items.length === 0 && !banner && <p className="search-empty">{t('search.noHits')}</p>}
      <ul className="search-list search-list-lines">
        {page.items.map((item, index) => {
          const position = matchPosition(page.total, page.offset, index)
          return <li key={`${item.filePath}:${item.lineNumber}:${index}`}>
            <div className="search-line">
              <button className="search-line-head" onClick={() => void openEditor(item)}>
                <span className="search-item-index">{position ? t('search.matchPosition', { current: position.current, total: position.total }) : ''}</span>
                <code>{item.filePath}:{item.lineNumber}</code>
                {item.binary && <em className="search-binary-tag">{t('search.binaryHit')}</em>}
                <FilePen size={12}/>
              </button>
              {!item.binary && <pre className="search-line-body">{item.content}</pre>}
              {(item.contextBefore.length > 0 || item.contextAfter.length > 0) && <pre className="search-line-context">
                {[...item.contextBefore.map((line) => `  ${line}`), ...item.contextAfter.map((line) => `  ${line}`)].join('\n')}
              </pre>}
            </div>
          </li>
        })}
      </ul>
    </div>}

    <div className="search-replace">
      <h3><Wand2 size={14}/>{t('search.bulkReplace')}</h3>
      <div className="search-form">
        <label className="search-field search-field-grow"><span>{t('search.find')}</span><input value={replaceForm.pattern} onChange={(event) => patchReplace({ pattern: event.target.value })}/></label>
        <label className="search-field search-field-grow"><span>{t('search.replaceWith')}</span><input value={replaceForm.replacement} onChange={(event) => patchReplace({ replacement: event.target.value })}/></label>
        <Button variant="secondary" disabled={replacing || !repositoryPath || !replaceForm.pattern.trim()} onClick={() => void runPreview()}>
          {replacing ? <Loader2 size={14} className="spin" /> : null}{t('search.previewHits')}
        </Button>
        <Button
          variant="danger"
          disabled={replacing || !repositoryPath || !canApply(preview)}
          title={blocker ?? undefined}
          onClick={() => void runApply()}
        >{t('search.writeReplace')}</Button>
      </div>
      <div className="search-options">
        <label><input type="checkbox" checked={replaceForm.caseSensitive} onChange={(event) => patchReplace({ caseSensitive: event.target.checked })}/><span>{t('search.caseSensitive')}</span></label>
        <label><input type="checkbox" checked={replaceForm.wholeWord} onChange={(event) => patchReplace({ wholeWord: event.target.checked })}/><span>{t('search.wholeWord')}</span></label>
        <label><input type="checkbox" checked={replaceForm.regex} onChange={(event) => patchReplace({ regex: event.target.checked })}/><span>{t('search.regex')}</span></label>
      </div>
      <details className="search-scope">
        <summary>{t('search.replaceLimits')}</summary>
        <div className="search-form search-form-stacked">
          <label className="search-field"><span>{t('search.replaceIncludePaths')}</span><textarea rows={2} value={replaceForm.includes} onChange={(event) => patchReplace({ includes: event.target.value })}/></label>
          <label className="search-field"><span>{t('search.excludePaths')}</span><textarea rows={2} value={replaceForm.excludePaths} onChange={(event) => patchReplace({ excludePaths: event.target.value })}/></label>
          <label className="search-field"><span>{t('search.fileLimit')}</span><input type="number" min={1} value={replaceForm.maxFiles ?? ''} onChange={(event) => patchReplace({ maxFiles: event.target.value ? Number(event.target.value) : null })}/></label>
        </div>
      </details>

      {preview && <div className="search-preview">
        <p className="search-banner"><ShieldAlert size={13}/>{preview.notice ?? t('search.hitSummary', { fileCount: preview.fileCount, occurrences: preview.totalOccurrences })}</p>
        <ul>
          {preview.files.slice(0, 20).map((file) => <li key={file.filePath}>
            <code>{file.filePath}</code>
            {file.skipped
              ? <em className="search-skipped">{t('search.skippedPrefix')}{file.skipped}</em>
              : <span>{file.occurrences} {t('search.matchesLines')} {file.sampleLines.slice(0, 6).join(', ')}</span>}
          </li>)}
        </ul>
        {preview.files.length > 20 && <small>{t('search.moreFilesPrefix')} {preview.files.length - 20} {t('search.moreFilesSuffix')}</small>}
      </div>}
      {!preview && blocker && replaceForm.pattern.trim() && <p className="search-empty">{blocker}</p>}

      {backups.length > 0 && <div className="search-backups">
        <h4>{t('search.undoableReplace')}</h4>
        <ul>
          {backups.map((backup) => <li key={backup.replaceId}>
            <span>{backupLabel(backup, t)}</span>
            <Button size="compact" variant="secondary" disabled={replacing} onClick={() => void runUndo(backup.replaceId)}><RotateCcw size={12}/>{t('search.undo')}</Button>
          </li>)}
        </ul>
      </div>}
    </div>

    {editor && <div className="search-editor">
      <header>
        <code>{editor.file.filePath}</code>
        <span>{editor.file.lineCount} {t('search.linesUnit')} {editor.file.sizeBytes} {t('search.bytes')}{editor.file.revision ? t('search.revisionSnapshot', { revision: editor.file.revision }) : ''}</span>
        <Button size="compact" variant="secondary" onClick={() => setEditor(null)}>{t('common.close')}</Button>
        <Button size="compact" variant="primary" disabled={!canSaveFile(editor.file, t).ok} onClick={() => void saveEditor()}>{t('search.save')}</Button>
      </header>
      {editor.file.notice && <p className="search-banner"><ShieldAlert size={13}/>{editor.file.notice}</p>}
      {!canSaveFile(editor.file, t).ok && <p className="search-error">{canSaveFile(editor.file, t).reason}</p>}
      <textarea rows={16} value={editor.draft} disabled={editor.file.binary} onChange={(event) => setEditor({ ...editor, draft: event.target.value })}/>
    </div>}
    {confirmDialog}
  </section>
}
