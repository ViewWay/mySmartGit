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
            <h2 id="history-edit-title">交互式编辑历史</h2>
            <p>分支 <strong>{sequence?.branch ?? '…'}</strong> · 基点 {baseRef}（{sequence ? `${sequence.entries.length} 个提交` : '载入中'}）</p>
          </div>
          <Button variant="icon" onClick={onClose} disabled={busy} title="关闭"><X size={17} /></Button>
        </header>

        {loadError && <p className="history-edit-error">{loadError}</p>}
        {sequence?.warnings.map((warning) => <p key={warning} className="history-edit-warning">{warning}</p>)}

        <ol className="history-edit-rows">
          {rows.map((row, index) => (
            <li key={row.entry.hash} className={row.action === 'drop' ? 'dropped' : ''}>
              <div className="history-edit-row-main">
                <span className="history-edit-row-tools">
                  <Button variant="icon" title="上移" aria-label="上移" disabled={busy || index === 0} onClick={() => setRows((prev) => moveRow(prev, index, -1))}><ArrowUp size={14} /></Button>
                  <Button variant="icon" title="下移" aria-label="下移" disabled={busy || index === rows.length - 1} onClick={() => setRows((prev) => moveRow(prev, index, 1))}><ArrowDown size={14} /></Button>
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
                  placeholder={row.action === 'reword' ? '新的提交消息（必填）' : 'squash 合并后的消息（留空则自动拼接上一条）'}
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
            共 {summary.total} 条：保留 {summary.resultCount} · 折叠 {summary.folded} · 丢弃 {summary.dropped} · 改写消息 {summary.reworded} · 停点 {summary.edited}
            {summary.changed ? ' · 将重写历史' : ' · 尚无改动'}
          </p>
        )}

        {rows.length > 0 && (
          <details className="history-edit-todo">
            <summary>查看将写入的 rebase 序列</summary>
            <pre>{renderTodoPreview(rows).join('\n')}</pre>
          </details>
        )}

        {impact && (
          <div className={`history-edit-impact ${impact.dangerous ? 'dangerous' : ''}`}>
            <h3>影响预览</h3>
            <p>预期重写 {impact.rewrittenUpper} 个提交{impact.upstream ? `；上游 ${impact.upstream}${impact.published ? '（已发布：完成后需 --force-with-lease 强推）' : ''}` : ''}</p>
            {impact.branchesLeftBehind.length > 0 && <p>掉队分支：{impact.branchesLeftBehind.join('、')}</p>}
            {impact.tagsOnRewritten.length > 0 && <p>钉在旧提交上的标签：{impact.tagsOnRewritten.join('、')}</p>}
            {impact.warnings.map((warning) => <p key={warning} className="history-edit-warning">{warning}</p>)}
            {impact.dangerous && (
              <label className="history-edit-confirm">
                <input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} />
                <span><AlertTriangle size={13} /> 我已确认这是不可轻易撤销的历史改写</span>
              </label>
            )}
          </div>
        )}

        {report && (
          <div className={`history-edit-report ${report.status}`}>
            <p>{report.status === 'completed' ? `完成：分支 ${report.branch} 已重写为 ${report.resultCount} 个提交。` : '变基已暂停（冲突或停点），请按恢复指引处理。'}</p>
            {report.recovery && <pre>{report.recovery}</pre>}
            {report.notice && <p className="history-edit-notice">{report.notice}</p>}
          </div>
        )}

        <footer className="history-edit-footer">
          <Button variant="secondary" onClick={onClose} disabled={busy}>关闭</Button>
          <Button onClick={() => void apply()} disabled={blocked}>
            {busy ? <Loader2 size={14} className="spin" /> : <History size={14} />}
            应用历史编辑
          </Button>
        </footer>
      </section>
    </div>
  )
}
