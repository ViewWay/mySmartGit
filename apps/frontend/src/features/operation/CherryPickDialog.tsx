import { useI18n } from '../../i18n'
import { useEffect, useRef, useState } from 'react'
import { GitCommitHorizontal, GitMerge, X } from 'lucide-react'
import { Button } from '../../components/Button'

type CherryPickDialogProps = {
  open: boolean
  commit: { id: string; title: string; parents: Array<{ hash: string; title: string; author: string; time: string }> }
  currentBranch: string
  onClose: () => void
  onConfirm: (mainline?: number) => Promise<void>
}

export function CherryPickDialog({ open, commit, currentBranch, onClose, onConfirm }: CherryPickDialogProps) {
  const { t } = useI18n()
  const [mainline, setMainline] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const isMerge = commit.parents.length > 1

  useEffect(() => {
    if (!open) return
    setMainline(1)
    setSubmitting(false)
    submittingRef.current = false
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submittingRef.current) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  const submit = async () => {
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    try {
      await onConfirm(isMerge ? mainline : undefined)
    } finally {
      submittingRef.current = false
      setSubmitting(false)
      onClose()
    }
  }

  return <div className="modal-backdrop" onPointerDown={() => { if (!submitting) onClose() }}>
    <section className="branch-dialog cherry-pick-dialog" role="dialog" aria-modal="true" aria-labelledby="cherry-pick-title" onPointerDown={(event) => event.stopPropagation()}>
      <div className="branch-dialog-heading"><span className="branch-dialog-icon"><GitCommitHorizontal size={18}/></span><div><h2 id="cherry-pick-title">{t('operation.cherryPick.title')}</h2><p>{t('operation.will')} <strong>{commit.id}</strong> {t('operation.cherryPick.applyTo')} <strong>{currentBranch}</strong>。</p></div><Button variant="icon" onClick={onClose} disabled={submitting} title={t('common.close')}><X size={17}/></Button></div>
      <div className="cherry-pick-dialog-body">
        <div className="cherry-pick-commit-summary"><strong>{commit.title}</strong><code>{commit.id}</code></div>
        {isMerge && <div className="cherry-pick-mainline"><div className="cherry-pick-section-heading"><GitMerge size={16}/><strong>{t('operation.cherryPick.pickMainline')}</strong><span>{t('operation.cherryPick.parents', { count: commit.parents.length })}</span></div><div className="cherry-pick-parent-list">{commit.parents.map((parent, index) => <label className={`cherry-pick-parent-option ${mainline === index + 1 ? 'selected' : ''}`} key={parent.hash}><input type="radio" name="cherry-pick-mainline" value={index + 1} checked={mainline === index + 1} onChange={() => setMainline(index + 1)}/><span className="cherry-pick-parent-index">{index + 1}</span><span><strong>{parent.title}</strong><code>{parent.hash.slice(0, 12)} · {parent.author} · {parent.time}</code></span></label>)}</div></div>}
        <div className="branch-dialog-actions"><Button variant="secondary" onClick={onClose} disabled={submitting}>{t('common.cancel')}</Button><Button variant="primary" onClick={() => void submit()} disabled={submitting}><GitCommitHorizontal size={14}/>{submitting ? t('operation.cherryPick.executing') : t('operation.cherryPick.confirm')}</Button></div>
      </div>
    </section>
  </div>
}
