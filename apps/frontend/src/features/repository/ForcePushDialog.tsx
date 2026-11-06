import { useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { Button } from '../../components/Button'
import { useI18n } from '../../i18n'
import { canConfirmForcePush, forcePushLeaseNote } from './forcePushGuard'

type ForcePushDialogProps = {
  open: boolean
  branch: string
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}

// force-with-lease 强推的二次确认弹窗。组件只负责“确认门槛”，
// 实际调用哪个 Tauri 命令由父级注入的 onConfirm 决定（git.rs: push_repository_with_lease）。
export function ForcePushDialog({ open, branch, busy = false, onCancel, onConfirm }: ForcePushDialogProps) {
  const { t } = useI18n()
  const [typedBranch, setTypedBranch] = useState('')
  useEffect(() => {
    if (open) setTypedBranch('')
  }, [open])
  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [busy, onCancel, open])
  if (!open) return null
  const confirmed = canConfirmForcePush(typedBranch, branch)
  return <div className="modal-backdrop" onPointerDown={() => { if (!busy) onCancel() }}>
    <section className="git-config-dialog force-push-dialog" role="alertdialog" aria-modal="true" aria-labelledby="force-push-title" onPointerDown={(event) => event.stopPropagation()}>
      <div className="git-config-heading">
        <span className="git-config-icon"><AlertTriangle size={18}/></span>
        <div><h2 id="force-push-title">{t('repository.forcePush.title')}</h2><p>{t('repository.forcePush.overwriteBefore')}<strong>{branch}</strong>{t('repository.forcePush.overwriteAfter')}</p></div>
        <Button variant="icon" onClick={onCancel} disabled={busy} title={t('common.close')}><X size={17}/></Button>
      </div>
      <p className="force-push-note">{forcePushLeaseNote(t)}</p>
      <label className="force-push-confirm-field">
        <span>{t('repository.forcePush.confirmPromptBefore')}<strong>{branch}</strong>{t('repository.forcePush.confirmPromptAfter')}</span>
        <div className="git-config-input">
          <input
            autoFocus
            value={typedBranch}
            onChange={(event) => setTypedBranch(event.target.value)}
            placeholder={branch}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      </label>
      <div className="git-config-footer">
        <span>{confirmed ? t('repository.forcePush.confirmedHint') : t('repository.forcePush.mismatchHint')}</span>
        <div>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!confirmed || busy} onClick={onConfirm}>{busy ? t('repository.forcePush.pushing') : t('repository.forcePush.confirm')}</Button>
        </div>
      </div>
    </section>
  </div>
}
