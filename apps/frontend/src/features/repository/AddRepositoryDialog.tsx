import { useEffect, useRef, useState } from 'react'
import { CloudDownload, FolderGit2, FolderOpen, Plus, RefreshCw, X } from 'lucide-react'
import { Button } from '../../components/Button'
import { cloneRepositoryWithSubmodules, createRepository, pickRepositoryDirectory, type RepositoryDetails } from '../../repository'
import { useI18n } from '../../i18n'
import { parseCloneDepth } from './submoduleAddForm'

export function AddRepositoryDialog({ mode, initialParent, onClose, onCreated }: {
  mode: 'clone' | 'init'
  initialParent: string
  onClose: () => void
  onCreated: (repository: RepositoryDetails) => void
}) {
  const { t } = useI18n()
  const [source, setSource] = useState('')
  const [parent, setParent] = useState(initialParent)
  const [name, setName] = useState('')
  const [recurse, setRecurse] = useState(false)
  const [depth, setDepth] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLElement>(null)
  const destination = parent ? `${parent.replace(/[\\/]+$/, '')}${parent.includes('\\') ? '\\' : '/'}${name}` : ''
  const validName = Boolean(name.trim()) && !/^[.]+$|[<>:"/\\|?*\x00-\x1f]|[. ]$/.test(name)
  const cloneDepth = parseCloneDepth(depth)
  const canSubmit = validName && Boolean(parent.trim()) && (mode !== 'clone' || (Boolean(source.trim()) && !cloneDepth.error))
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    dialogRef.current?.querySelector('input')?.focus()
    return () => { if (previousFocus?.isConnected) previousFocus.focus() }
  }, [])
  useEffect(() => {
    if (!busy && !dialogRef.current?.contains(document.activeElement)) dialogRef.current?.querySelector('input')?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (!busy) onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [busy, onClose])

  const browse = async () => {
    try {
      const path = await pickRepositoryDirectory(t('repository.add.pickParentTitle'))
      if (path) setParent(path)
    } catch (error) { setError(String(error)) }
  }
  const submit = async () => {
    if (!canSubmit || busy) return
    setBusy(true)
    setError('')
    try {
      if (mode === 'clone') onCreated(await cloneRepositoryWithSubmodules(destination, source.trim(), recurse, cloneDepth.depth, null, false))
      else onCreated(await createRepository(destination, null))
    }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); setBusy(false) }
  }

  return <div className="modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section ref={dialogRef} className="branch-dialog repository-add-dialog" role="dialog" aria-modal="true" aria-labelledby="repository-add-title" onKeyDown={(event) => {
      if (event.key === 'Tab') {
        const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)') ?? [])
        const target = event.shiftKey ? items[items.length - 1] : items[0]
        if (document.activeElement === (event.shiftKey ? items[0] : items[items.length - 1])) { event.preventDefault(); target?.focus() }
      }
    }}>
      <div className="branch-dialog-heading"><span className="branch-dialog-icon"><FolderGit2 size={19}/></span><div><h2 id="repository-add-title">{mode === 'clone' ? t('repository.add.cloneTitle') : t('repository.add.initTitle')}</h2><p>{mode === 'clone' ? t('repository.add.cloneHint') : t('repository.add.initHint')}</p></div><Button variant="icon" title={t('common.close')} disabled={busy} onClick={onClose}><X size={17}/></Button></div>
      <form onSubmit={(event) => { event.preventDefault(); void submit() }}>
        {mode === 'clone' && <label>{t('repository.add.source')}<input value={source} onChange={(event) => setSource(event.target.value)} onBlur={() => {
          if (!name) setName(source.trim().replace(/[\\/]+$/, '').split(/[/:\\]/).pop()?.replace(/\.git$/, '') ?? '')
        }} placeholder={t('repository.add.sourcePlaceholder')} spellCheck={false} disabled={busy}/></label>}
        {mode === 'clone' && <div className="repository-clone-options">
          <label className="repository-checkbox"><input type="checkbox" checked={recurse} onChange={(event) => setRecurse(event.target.checked)} disabled={busy}/><span>{t('repository.add.recurseSubmodules')}</span></label>
          <label>{t('repository.add.depth')}<input value={depth} onChange={(event) => setDepth(event.target.value)} placeholder={t('repository.add.depthPlaceholder')} inputMode="numeric" spellCheck={false} disabled={busy}/></label>
          {cloneDepth.error && <p className="repository-inline-error" role="alert">{cloneDepth.error}</p>}
          <small>{t('repository.add.depthNote')}</small>
        </div>}
        <label>{t('repository.add.parent')}<span className="repository-directory-input"><input value={parent} onChange={(event) => setParent(event.target.value)} placeholder={t('repository.add.parentPlaceholder')} disabled={busy}/><Button type="button" variant="secondary" onClick={() => void browse()} disabled={busy} title={t('repository.add.pickParent')}><FolderOpen size={15}/></Button></span></label>
        <label>{t('repository.add.name')}<input value={name} onChange={(event) => setName(event.target.value)} placeholder="my-project" spellCheck={false} disabled={busy}/></label>
        <div className="repository-destination"><span>{t('repository.add.destination')}</span><code>{destination || t('repository.add.destinationHint')}</code><small>{t('repository.add.destinationNote')}</small></div>
        {error && <p className="repository-inline-error" role="alert">{error}</p>}
        <div className="branch-dialog-actions"><Button type="button" variant="secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button><Button type="submit" variant="primary" disabled={!canSubmit || busy}>{busy ? <RefreshCw size={14} className="spin"/> : mode === 'clone' ? <CloudDownload size={14}/> : <Plus size={14}/>}<span>{busy ? (mode === 'clone' ? t('repository.add.cloning') : t('repository.add.creating')) : mode === 'clone' ? t('repository.add.clone') : t('repository.add.create')}</span></Button></div>
      </form>
    </section>
  </div>
}
