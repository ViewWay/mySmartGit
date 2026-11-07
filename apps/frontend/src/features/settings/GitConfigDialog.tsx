import { useI18n } from '../../i18n'
import { useEffect, useRef, useState } from 'react'
import { FileText, GitBranch, Mail, RefreshCw, Settings2, User, X } from 'lucide-react'
import { loadGitUserConfig, updateGitUserConfig, type GitUserConfig } from '../../repository'
import { Button } from '../../components/Button'

type GitConfigDialogProps = {
  open: boolean
  onClose: () => void
  onNotice: (message: string) => void
}

const emptyConfig: GitUserConfig = {
  userName: '',
  userEmail: '',
  defaultBranch: 'main',
  autocrlf: 'false',
  pullStrategy: 'merge',
  commitTemplateContent: '',
}

export function GitConfigDialog({ open, onClose, onNotice }: GitConfigDialogProps) {
  const { t } = useI18n()
  const [config, setConfig] = useState<GitUserConfig>(emptyConfig)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    loadGitUserConfig()
      .then((value) => {
        setConfig(value)
        requestAnimationFrame(() => nameRef.current?.focus())
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoading(false))
  }, [open])

  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose, open, saving])

  if (!open) return null
  const save = async () => {
    if (!config.userName.trim()) return setError(t('gitconfig.nameRequired'))
    if (!config.userEmail.includes('@')) return setError(t('gitconfig.emailRequired'))
    if (!config.defaultBranch.trim()) return setError(t('gitconfig.branchRequired'))
    setSaving(true)
    setError(null)
    try {
      setConfig(await updateGitUserConfig({
        ...config,
        userName: config.userName.trim(),
        userEmail: config.userEmail.trim(),
        defaultBranch: config.defaultBranch.trim(),
        commitTemplateContent: config.commitTemplateContent ?? '',
      }))
      onNotice(t('gitconfig.saved'))
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  return <div className="modal-backdrop" onPointerDown={() => { if (!saving) onClose() }}>
    <section className="git-config-dialog" role="dialog" aria-modal="true" aria-labelledby="git-config-title" onPointerDown={(event) => event.stopPropagation()}>
      <div className="git-config-heading"><span className="git-config-icon"><Settings2 size={18}/></span><div><h2 id="git-config-title">{t('gitconfig.title')}</h2><p>{t('gitconfig.subtitle')}</p></div><Button variant="icon" onClick={onClose} disabled={saving} title={t('common.close')}><X size={17}/></Button></div>
      <form onSubmit={(event) => { event.preventDefault(); void save() }}>
        {loading ? <div className="git-config-loading"><RefreshCw className="spin" size={18}/><span>{t('gitconfig.loading')}</span></div> : <>
          <div className="git-config-section"><div className="git-config-section-title"><User size={14}/><div><strong>{t('gitconfig.identity')}</strong><span>{t('gitconfig.identityHint')}</span></div></div><div className="git-config-fields"><label><span>{t('gitconfig.userName')}</span><div className="git-config-input"><User size={14}/><input ref={nameRef} value={config.userName} onChange={(event) => setConfig((value) => ({ ...value, userName: event.target.value }))} placeholder={t('gitconfig.userNamePlaceholder')} autoComplete="off"/></div></label><label><span>{t('gitconfig.email')}</span><div className="git-config-input"><Mail size={14}/><input value={config.userEmail} onChange={(event) => setConfig((value) => ({ ...value, userEmail: event.target.value }))} placeholder="name@example.com" autoComplete="email" spellCheck={false}/></div></label></div></div>
          <div className="git-config-section"><div className="git-config-section-title"><GitBranch size={14}/><div><strong>{t('gitconfig.repoDefaults')}</strong><span>{t('gitconfig.repoDefaultsHint')}</span></div></div><div className="git-config-fields"><label><span>{t('gitconfig.defaultBranch')}</span><div className="git-config-input"><GitBranch size={14}/><input value={config.defaultBranch} onChange={(event) => setConfig((value) => ({ ...value, defaultBranch: event.target.value }))} placeholder="main" spellCheck={false}/></div></label><label><span>{t('gitconfig.autocrlf')}</span><div className="git-config-choice">{([['true', 'Windows'], ['input', t('gitconfig.autocrlfTrue')], ['false', t('gitconfig.autocrlfFalse')]] as const).map(([value, label]) => <button type="button" className={config.autocrlf === value ? 'active' : ''} key={value} onClick={() => setConfig((current) => ({ ...current, autocrlf: value }))}>{label}</button>)}</div></label><label><span>{t('gitconfig.pullStrategy')}</span><div className="git-config-choice">{([['merge', t('gitconfig.pullMerge')], ['rebase', t('gitconfig.pullRebase')], ['ff-only', t('gitconfig.pullFfOnly')]] as const).map(([value, label]) => <button type="button" className={config.pullStrategy === value ? 'active' : ''} key={value} onClick={() => setConfig((current) => ({ ...current, pullStrategy: value }))}>{label}</button>)}</div></label></div></div>
          <div className="git-config-section"><div className="git-config-section-title"><FileText size={14}/><div><strong>{t('gitconfig.globalTemplate')}</strong><span>{t('gitconfig.globalTemplateHint')}</span></div></div><label className="git-config-template-field"><textarea value={config.commitTemplateContent ?? ''} onChange={(event) => setConfig((value) => ({ ...value, commitTemplateContent: event.target.value }))} placeholder={t('gitconfig.globalTemplatePlaceholder')} spellCheck={false}/></label></div>
        </>}
        <div className="git-config-footer"><span className={error ? 'git-config-error' : ''}>{error ?? t('gitconfig.savedNote')}</span><div><Button type="button" variant="secondary" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button><Button type="submit" variant="primary" disabled={loading || saving}>{saving ? t('gitconfig.saving') : t('gitconfig.save')}</Button></div></div>
      </form>
    </section>
  </div>
}
