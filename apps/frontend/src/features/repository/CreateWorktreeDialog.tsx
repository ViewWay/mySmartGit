import { useEffect, useState } from 'react'
import { GitFork, X } from 'lucide-react'
import { Button } from '../../components/Button'
import { CompactSelect } from '../../components/CompactSelect'
import { useI18n } from '../../i18n'

export function CreateWorktreeDialog({ branches, busy, onClose, onSubmit }: {
  branches: string[]
  busy: boolean
  onClose: () => void
  onSubmit: (path: string, branch: string, createBranch: boolean) => Promise<void>
}) {
  const { t } = useI18n()
  const [path, setPath] = useState('')
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [branch, setBranch] = useState(branches[0] ?? '')
  useEffect(() => { if (mode === 'existing' && !branches.includes(branch)) setBranch(branches[0] ?? '') }, [branch, branches, mode])
  const valid = path.trim().length > 0 && branch.trim().length > 0
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section className="branch-dialog worktree-dialog" role="dialog" aria-modal="true" aria-label={t('repository.worktree.createTitle')}>
      <div className="branch-dialog-heading"><span className="branch-dialog-icon"><GitFork size={18}/></span><div><h2>{t('repository.worktree.createTitle')}</h2><p>{t('repository.worktree.createHint')}</p></div><Button variant="icon" onClick={onClose} disabled={busy} title={t('common.close')}><X size={16}/></Button></div>
      <form onSubmit={(event) => { event.preventDefault(); if (valid) void onSubmit(path.trim(), branch.trim(), mode === 'new') }}>
        <label>{t('repository.worktree.targetDir')}</label><div className="branch-name-input"><input autoFocus value={path} onChange={(event) => setPath(event.target.value)} placeholder={t('repository.worktree.targetDirPlaceholder')}/></div>
        <label>{t('repository.worktree.branchMode')}</label><div className="segmented worktree-mode"><button type="button" className={mode === 'existing' ? 'active' : ''} onClick={() => { setMode('existing'); setBranch(branches[0] ?? '') }}>{t('repository.worktree.existingBranch')}</button><button type="button" className={mode === 'new' ? 'active' : ''} onClick={() => { setMode('new'); setBranch('') }}>{t('repository.worktree.newBranch')}</button></div>
        <label>{mode === 'existing' ? t('repository.worktree.localBranch') : t('repository.worktree.newBranchName')}</label>{mode === 'existing' ? <CompactSelect className="worktree-branch-select" value={branch} options={branches.map((item) => ({ value: item, label: item }))} onChange={setBranch} ariaLabel={t('repository.worktree.selectLocalBranch')}/> : <div className="branch-name-input"><input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="feat/new-worktree"/></div>}
        <div className="branch-dialog-hint">{t('repository.worktree.removeHint')}</div>
        <div className="branch-dialog-actions"><Button type="button" variant="secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button><Button type="submit" variant="primary" disabled={!valid || busy}>{busy ? t('repository.worktree.creating') : t('repository.worktree.create')}</Button></div>
      </form>
    </section>
  </div>
}
