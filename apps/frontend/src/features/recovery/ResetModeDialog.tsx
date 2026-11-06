import { useI18n } from '../../i18n'
import { useState } from 'react'
import { AlertTriangle, History, RotateCcw, X } from 'lucide-react'
import { resetRepositoryWithMode, type RepositorySnapshot, type RepositoryResetMode } from '../../repository'
import { Button } from '../../components/Button'
import { resetModeDescription, resetNeedsDangerAck } from './reflogModel'

type ResetModeDialogProps = {
  open: boolean
  repository: RepositorySnapshot | null
  initialCommit?: string
  initialMode?: RepositoryResetMode
  onClose: () => void
  onSnapshot: (snapshot: RepositorySnapshot) => void
  onNotice: (message: string) => void
}

/**
 * Reset 三模式对话框：soft / mixed / hard。
 * hard 模式必须额外勾选危险确认，且后端仍会独立校验 confirmHard，
 * 防止绕过 UI 直接调用。
 */
export function ResetModeDialog({ open, repository, initialCommit = '', initialMode = 'mixed', onClose, onSnapshot, onNotice }: ResetModeDialogProps) {
  const { t } = useI18n()
  const [commit, setCommit] = useState(initialCommit)
  const [mode, setMode] = useState<RepositoryResetMode>(initialMode)
  const [ackDanger, setAckDanger] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!open || !repository) return null
  const trimmed = commit.trim()
  const blocked = !trimmed || busy || (resetNeedsDangerAck(mode) && !ackDanger)
  const run = async () => {
    if (!trimmed) return onNotice(t('reset.targetRequired'))
    setBusy(true)
    try {
      const snapshot = await resetRepositoryWithMode(repository.path, trimmed, mode, mode === 'hard')
      onSnapshot(snapshot)
      onNotice(mode === 'hard'
        ? `已 hard Reset 到 ${trimmed}；本地修改已丢弃，可在 Reflog 面板找回历史提交`
        : `已 ${mode} Reset 到 ${trimmed}，${mode === 'soft' ? t('reset.softKeep') : t('reset.mixedKeep')}`)
      onClose()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  return <div className="modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section className="rebase-dialog recovery-reset-dialog" role="dialog" aria-modal="true" aria-labelledby="recovery-reset-title">
      <div className="rebase-dialog-heading">
        <span className="rebase-dialog-icon"><RotateCcw size={19}/></span>
        <div><span className="eyebrow">{t('reset.title')}</span><h2 id="recovery-reset-title">{t('reset.byMode')} {repository.branch}</h2><p>{t('reset.reflogNote')}</p></div>
        <Button variant="icon" onClick={onClose} disabled={busy} title={t('common.close')}><X size={17}/></Button>
      </div>
      <div className="recovery-reset-body">
        <label className="recovery-reset-commit"><span>{t('reset.target')}</span><input value={commit} onChange={(event) => setCommit(event.target.value)} placeholder={t('reset.targetPlaceholder')}/></label>
        <div className="recovery-reset-modes">{(['soft', 'mixed', 'hard'] as RepositoryResetMode[]).map((value) => <label key={value} className={mode === value ? 'active' : ''}>
          <input type="radio" name="reset-mode" checked={mode === value} onChange={() => { setMode(value); if (value !== 'hard') setAckDanger(false) }}/>
          <div><strong>{value}</strong><small>{resetModeDescription(value, t)}</small></div>
        </label>)}</div>
        {mode === 'hard' && <label className="recovery-reset-danger"><input type="checkbox" checked={ackDanger} onChange={(event) => setAckDanger(event.target.checked)}/><AlertTriangle size={13}/><span>{t('reset.hardConfirm')}</span></label>}
        {mode !== 'hard' && <div className="recovery-reset-note"><History size={13}/><span>{t('reset.softMixedNotePrefix')} {repository.branch} {t('reset.softMixedNoteSuffix')}</span></div>}
      </div>
      <div className="rebase-dialog-actions">
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t('reset.cancel')}</Button>
        <Button variant={mode === 'hard' ? 'danger' : 'primary'} disabled={blocked} onClick={() => void run()}><RotateCcw size={14}/>{busy ? t('reset.resetting') : `执行 ${mode} Reset`}</Button>
      </div>
    </section>
  </div>
}
