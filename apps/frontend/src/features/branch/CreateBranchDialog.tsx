import { useI18n } from '../../i18n'
import { useEffect, useMemo, useRef, useState } from 'react'
import { GitBranch, X } from 'lucide-react'
import { Button } from '../../components/Button'

type CreateBranchDialogProps = {
  open: boolean
  prefix?: string
  currentBranch: string
  onClose: () => void
  onCreate: (branch: string) => Promise<boolean>
}

function validateBranchName(value: string, t: (key: string) => string) {
  if (!value) return t('repository.branch.nameRequired')
  if (/\s/.test(value)) return t('repository.branch.noSpaces')
  if (value.startsWith('/') || value.endsWith('/') || value.includes('//')) return t('repository.branch.badPathFormat')
  if (value.includes('..') || /[~^:?*\[\\]/.test(value)) return t('repository.branch.unsupportedCharacters')
  if (value.endsWith('.') || value.endsWith('.lock')) return t('repository.branch.badSuffix')
  return null
}

export function CreateBranchDialog({ open, prefix, currentBranch, onClose, onCreate }: CreateBranchDialogProps) {
  const { t } = useI18n()
  const [branch, setBranch] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const error = useMemo(() => validateBranchName(branch.trim(), t), [branch])

  useEffect(() => {
    if (!open) return
    setBranch(prefix ? `${prefix}/` : '')
    setSubmitting(false)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open, prefix])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, open, submitting])

  if (!open) return null
  const submit = async () => {
    const value = branch.trim()
    if (validateBranchName(value, t)) return
    setSubmitting(true)
    const created = await onCreate(value)
    setSubmitting(false)
    if (created) onClose()
  }

  return <div className="modal-backdrop" onPointerDown={() => { if (!submitting) onClose() }}>
    <section className="branch-dialog" role="dialog" aria-modal="true" aria-labelledby="create-branch-title" onPointerDown={(event) => event.stopPropagation()}>
      <div className="branch-dialog-heading"><span className="branch-dialog-icon"><GitBranch size={18}/></span><div><h2 id="create-branch-title">{t('repository.branch.createTitle')}</h2><p>{t('repository.branch.basedOnCurrent')} <strong>{currentBranch}</strong> {t('repository.branch.createStaysHint')}</p></div><Button variant="icon" onClick={onClose} disabled={submitting} title={t('common.close')}><X size={17}/></Button></div>
      <form onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <label htmlFor="new-branch-name">{t('repository.branch.name')}</label>
        <div className={`branch-name-input ${error && branch ? 'invalid' : ''}`}><GitBranch size={15}/><input ref={inputRef} id="new-branch-name" value={branch} onChange={(event) => setBranch(event.target.value)} placeholder={t('repository.branch.namePlaceholder')} autoComplete="off" spellCheck={false}/></div>
        <div className="branch-dialog-hint">{error && branch ? <span className="error">{error}</span> : <span>{t('repository.branch.nameHint')}</span>}</div>
        <div className="branch-dialog-actions"><Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>{t('common.cancel')}</Button><Button type="submit" variant="primary" disabled={Boolean(error) || submitting}><GitBranch size={14}/>{submitting ? t('repository.branch.creating') : t('repository.branch.create')}</Button></div>
      </form>
    </section>
  </div>
}
