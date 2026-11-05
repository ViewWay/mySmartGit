import { useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { Button } from '../../components/Button'
import { FORCE_PUSH_LEASE_NOTE, canConfirmForcePush } from './forcePushGuard'

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
        <div><h2 id="force-push-title">危险操作：强推分支</h2><p>即将以本地分支覆盖远端 <strong>{branch}</strong>。</p></div>
        <Button variant="icon" onClick={onCancel} disabled={busy} title="关闭"><X size={17}/></Button>
      </div>
      <p className="force-push-note">{FORCE_PUSH_LEASE_NOTE}</p>
      <label className="force-push-confirm-field">
        <span>请输入当前分支名 <strong>{branch}</strong> 以确认</span>
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
        <span>{confirmed ? '确认后将执行 force-with-lease 推送。' : '输入不完全匹配时无法确认。'}</span>
        <div>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>取消</Button>
          <Button variant="primary" disabled={!confirmed || busy} onClick={onConfirm}>{busy ? '正在强推…' : '确认强推'}</Button>
        </div>
      </div>
    </section>
  </div>
}
