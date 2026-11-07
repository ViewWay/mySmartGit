import { useI18n } from '../../i18n'
import { useState } from 'react'
import { Tag, X } from 'lucide-react'
import { Button } from '../../components/Button'

export type CreateTagPayload = {
  tag: string
  commit: string
  message: string
  /** false = 注释标签（-a），true = 签名标签（-s） */
  signed: boolean
  signingKey?: string
  /** 允许把已存在的同名标签移动到新提交（仍需后端二次确认） */
  force: boolean
}

/**
 * 创建注释 / 签名标签。轻量标签不在这里提供 —— 它没有打标签人与说明，
 * 竞品里也只在「快速标签」场景使用，本项目统一走注释标签以保证可追溯。
 */
export function CreateTagDialog({ existingTags, defaultCommit, busy, onClose, onSubmit }: {
  existingTags: string[]
  defaultCommit: string
  busy: boolean
  onClose: () => void
  onSubmit: (payload: CreateTagPayload) => Promise<void>
}) {
  const { t } = useI18n()
  const [tag, setTag] = useState('')
  const [commit, setCommit] = useState(defaultCommit || 'HEAD')
  const [message, setMessage] = useState('')
  const [signed, setSigned] = useState(false)
  const [signingKey, setSigningKey] = useState('')
  const [force, setForce] = useState(false)
  const name = tag.trim()
  const taken = existingTags.includes(name)
  const valid = name.length > 0 && !name.startsWith('-') && message.trim().length > 0 && commit.trim().length > 0 && (!taken || force)
  const key = signingKey.trim()

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section className="branch-dialog worktree-dialog" role="dialog" aria-modal="true" aria-label={t('repository.tag.dialogTitle')}>
      <div className="branch-dialog-heading"><span className="branch-dialog-icon"><Tag size={18}/></span><div><h2>{t('repository.tag.dialogTitle')}</h2><p>{t('repository.tag.dialogHint')}</p></div><Button variant="icon" onClick={onClose} disabled={busy} title={t('common.close')}><X size={16}/></Button></div>
      <form onSubmit={(event) => { event.preventDefault(); if (valid) void onSubmit({ tag: name, commit: commit.trim(), message: message.trim(), signed, signingKey: key || undefined, force }) }}>
        <label>{t('repository.tag.name')}</label>
        <div className="branch-name-input"><input autoFocus value={tag} onChange={(event) => setTag(event.target.value)} placeholder="v1.2.0"/></div>
        {taken && <div className="branch-dialog-hint">{t('tag.existsWithMode', { name, mode: force ? t('repository.tag.overwriteExists') : t('repository.tag.overwriteRequired') })}</div>}
        <label>{t('repository.tag.target')}</label>
        <div className="branch-name-input"><input value={commit} onChange={(event) => setCommit(event.target.value)} placeholder={t('repository.tag.targetPlaceholder')}/></div>
        <label>{t('repository.tag.type')}</label>
        <div className="segmented worktree-mode">
          <button type="button" className={!signed ? 'active' : ''} onClick={() => setSigned(false)}>{t('repository.type.annotated')}</button>
          <button type="button" className={signed ? 'active' : ''} onClick={() => setSigned(true)}>{t('repository.type.signed')}</button>
        </div>
        <label>{t('repository.tag.messageLabel')}</label>
        <div className="branch-name-input"><input value={message} onChange={(event) => setMessage(event.target.value)} placeholder={t('repository.tag.messagePlaceholder')}/></div>
        {signed && <>
          <label>{t('repository.tag.keyLabel')}</label>
          <div className="branch-name-input"><input value={signingKey} onChange={(event) => setSigningKey(event.target.value)} placeholder={t('repository.tag.keyPlaceholder')}/></div>
        </>}
        <label className="auto-fetch-toggle"><span><strong>{t('repository.tag.overwrite')}</strong><small>{t('repository.tag.overwriteNote')}</small></span><input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)}/><span className="toggle-track" aria-hidden="true"><span/></span></label>
        <div className="branch-dialog-hint">{t('repository.tag.gpgNote')}</div>
        <div className="branch-dialog-actions"><Button type="button" variant="secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button><Button type="submit" variant="primary" disabled={!valid || busy}>{busy ? t('repository.tag.creating') : signed ? t('repository.tag.createSigned') : t('repository.tag.createAnnotated')}</Button></div>
      </form>
    </section>
  </div>
}
