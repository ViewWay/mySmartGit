import { useI18n } from '../../i18n'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowDown, ArrowUp, History, Loader2, X } from 'lucide-react'
import { Button } from '../../components/Button'
import {
  applyHistoryEditSequence,
  loadHistoryEditSequence,
  previewHistoryEditImpact,
  type HistoryEditImpact,
  type HistoryEditReport,
  type HistoryEditSequence,
} from '../../repository'
import {
  HISTORY_EDIT_ACTIONS,
  buildActionPayload,
  createRows,
  moveRow,
  renderTodoPreview,
  setRowAction,
  setRowMessage,
  summarizeWithReorder,
  validateRows,
  type HistoryEditRow,
  historyEditActionLabel,
} from './historyEditModel'
import './historyEdit.css'

type SequenceEditorProps = {
  open: boolean
  repositoryPath: string
  /** 编辑范围基点（通常是上游分支/合并基/选中提交的下界）。 */
  baseRef: string
  onClose: () => void
  /** 应用成功或停在半途后回调，用于刷新仓库快照。 */
  onChanged?: () => void
}

/** 交互式历史编辑序列编辑器：重排 / drop / squash / fixup / reword / edit，
 * 应用前展示后端影响预览，危险操作需显式确认。 */
export function SequenceEditor({ open, repositoryPath, baseRef, onClose, onChanged }: SequenceEditorProps) {
  const { t } = useI18n()
  const [sequence, setSequence] = useState<HistoryEditSequence | null>(null)
  const [rows, setRows] = useState<HistoryEditRow[]>([])
  const [impact, setImpact] = useState<HistoryEditImpact | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [report, setReport] = useState<HistoryEditReport | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoadError(null)
    setReport(null)
    setConfirmed(false)
    void loadHistoryEditSequence(repositoryPath, baseRef)
      .then((result) => {
        if (cancelled) return
        setSequence(result)
        setRows(createRows(result.entries))
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(String(error))
      })
    return () => {
      cancelled = true
    }
  }, [open, repositoryPath, baseRef])

  const payload = useMemo(() => buildActionPayload(rows), [rows])
  const errors = useMemo(() => validateRows(rows, t), [rows, t])
  const summary = useMemo(() => (sequence ? summarizeWithReorder(sequence.entries, rows) : null), [sequence, rows])

  useEffect(() => {
    if (!open || errors.length > 0 || payload.length === 0) {
      setImpact(null)
      return
    }
    let cancelled = false
    void previewHistoryEditImpact(repositoryPath, baseRef, payload)
      .then((result) => {
        if (!cancelled) setImpact(result)
      })
      .catch(() => {
        if (!cancelled) setImpact(null)
      })
    return () => {
      cancelled = true
    }
  }, [open, repositoryPath, baseRef, payload, errors.length])

  const apply = useCallback(async () => {
    setBusy(true)
    setLoadError(null)
    try {
      const result = await applyHistoryEditSequence(repositoryPath, baseRef, payload)
      setReport(result)
      onChanged?.()
    } catch (error: unknown) {
      setLoadError(String(error))
    } finally {
      setBusy(false)
    }
  }, [baseRef, onChanged, payload, repositoryPath])

  if (!open) return null
  const dangerous = Boolean(impact?.dangerous)
  const blocked = busy || errors.length > 0 || (dangerous && !confirmed) || rows.length === 0
  return (
    <div className="modal-backdrop" onPointerDown={() => { if (!busy) onClose() }}>
      <section className="history-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="history-edit-title" onPointerDown={(event) => event.stopPropagation()}>
        <header className="history-edit-heading">
          <span className="history-edit-icon"><History size={18} /></span>
          <div>
            <h2 id="history-edit-title">{t('historyEdit.title')}</h2>
            <p>{t('historyEdit.branchLabel')} <strong>{sequence?.branch ?? '…'}</strong> {t('historyEdit.baseLabel')} {baseRef}（{sequence ? t('historyEdit.commitCount', { count: sequence.entries.length }) : t('historyEdit.loading')}）</p>
          </div>
          <Button variant="icon" onClick={onClose} disabled={busy} title={t('common.close')}><X size={17} /></Button>
        </header>

        {loadError && <p className="history-edit-error">{loadError}</p>}
        {sequence?.warnings.map((warning) => <p key={warning} className="history-edit-warning">{warning}</p>)}

        <ol className="history-edit-rows">
          {rows.map((row, index) => (
            <li key={row.entry.hash} className={row.action === 'drop' ? 'dropped' : ''}>
              <div className="history-edit-row-main">
                <span className="history-edit-row-tools">
                  <Button variant="icon" title={t('historyEdit.moveUp')} aria-label={t('historyEdit.moveUp')} disabled={busy || index === 0} onClick={() => setRows((prev) => moveRow(prev, index, -1))}><ArrowUp size={14} /></Button>
                  <Button variant="icon" title={t('historyEdit.moveDown')} aria-label={t('historyEdit.moveDown')} disabled={busy || index === rows.length - 1} onClick={() => setRows((prev) => moveRow(prev, index, 1))}><ArrowDown size={14} /></Button>
                </span>
                <code className="history-edit-row-hash">{row.entry.shortHash}</code>
                <span className="history-edit-row-title" title={row.entry.title}>{row.entry.title}</span>
                <select
                  value={row.action}
                  disabled={busy}
                  aria-label={`提交 ${row.entry.shortHash} 的动作`}
                  onChange={(event) => setRows((prev) => setRowAction(prev, index, event.target.value as HistoryEditRow['action']))}
                >
                  {HISTORY_EDIT_ACTIONS.map((action) => <option key={action} value={action}>{historyEditActionLabel(action, t)}</option>)}
                </select>
              </div>
              {(row.action === 'reword' || row.action === 'squash') && (
                <textarea
                  className="history-edit-row-message"
                  value={row.message}
                  rows={3}
                  disabled={busy}
                  placeholder={row.action === 'reword' ? t('historyEdit.newMessagePlaceholder') : t('historyEdit.squashMessagePlaceholder')}
                  aria-label={`提交 ${row.entry.shortHash} 的消息`}
                  onChange={(event) => setRows((prev) => setRowMessage(prev, index, event.target.value))}
                />
              )}
            </li>
          ))}
        </ol>

        {errors.length > 0 && (
          <ul className="history-edit-errors">{errors.map((error) => <li key={error}>{error}</li>)}</ul>
        )}

        {summary && (
          <p className="history-edit-summary">
            {summary.total} {t('historyEdit.summaryUnit')} {summary.resultCount} {t('historyEdit.summaryFixup')} {summary.folded} {t('historyEdit.summaryDrop')} {summary.dropped} {t('historyEdit.summaryReword')} {summary.reworded} {t('historyEdit.summaryEdit')} {summary.edited}
            {summary.changed ? t('historyEdit.willRewrite') : t('historyEdit.noChanges')}
          </p>
        )}

        {rows.length > 0 && (
          <details className="history-edit-todo">
            <summary>{t('historyEdit.showTodo')}</summary>
            <pre>{renderTodoPreview(rows).join('\n')}</pre>
          </details>
        )}

        {impact && (
          <div className={`history-edit-impact ${impact.dangerous ? 'dangerous' : ''}`}>
            <h3>{t('historyEdit.impactTitle')}</h3>
            <p>{t('historyEdit.expectedRewrite')} {impact.rewrittenUpper} {t('historyEdit.commitsUnit')}{impact.upstream ? `；上游 ${impact.upstream}${impact.published ? t('historyEdit.publishedNote') : ''}` : ''}</p>
            {impact.branchesLeftBehind.length > 0 && <p>{t('historyEdit.strandedBranches')}{impact.branchesLeftBehind.join('、')}</p>}
            {impact.tagsOnRewritten.length > 0 && <p>{t('historyEdit.pinnedTags')}{impact.tagsOnRewritten.join('、')}</p>}
            {impact.warnings.map((warning) => <p key={warning} className="history-edit-warning">{warning}</p>)}
            {impact.dangerous && (
              <label className="history-edit-confirm">
                <input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} />
                <span><AlertTriangle size={13} /> {t('historyEdit.ackConfirm')}</span>
              </label>
            )}
          </div>
        )}

        {report && (
          <div className={`history-edit-report ${report.status}`}>
            <p>{report.status === 'completed' ? `完成：分支 ${report.branch} 已重写为 ${report.resultCount} 个提交。` : t('historyEdit.pausedNotice')}</p>
            {report.recovery && <pre>{report.recovery}</pre>}
            {report.notice && <p className="history-edit-notice">{report.notice}</p>}
          </div>
        )}

        <footer className="history-edit-footer">
          <Button variant="secondary" onClick={onClose} disabled={busy}>{t('common.close')}</Button>
          <Button onClick={() => void apply()} disabled={blocked}>
            {busy ? <Loader2 size={14} className="spin" /> : <History size={14} />}
            {t('historyEdit.apply')}
          </Button>
        </footer>
      </section>
    </div>
  )
}
