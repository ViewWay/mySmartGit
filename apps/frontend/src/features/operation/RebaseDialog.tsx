import { useI18n } from '../../i18n'
import { useEffect, useState } from 'react'
import { AlertTriangle, GitBranch, GitCommitHorizontal, GitPullRequest, X } from 'lucide-react'
import { previewRepositoryRebase, type RebasePreview, type RepositorySnapshot } from '../../repository'
import { Button } from '../../components/Button'

export function RebaseDialog({ open, repository, onto, targetLabel, onClose, onStart }: { open: boolean; repository: RepositorySnapshot | null; onto: string | null; targetLabel: string; onClose: () => void; onStart: (onto: string) => Promise<void> }) {
  const { t } = useI18n()
  const [preview, setPreview] = useState<RebasePreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open || !repository || !onto) return
    let cancelled = false
    setPreview(null)
    setError(null)
    setLoading(true)
    previewRepositoryRebase(repository.path, onto)
      .then((value) => { if (!cancelled) setPreview(value) })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, onto, repository?.path])
  if (!open || !repository || !onto) return null
  return <div className="modal-backdrop" onPointerDown={() => { if (!starting) onClose() }}><section className="rebase-dialog" role="dialog" aria-modal="true" aria-labelledby="rebase-title" onPointerDown={(event) => event.stopPropagation()}><div className="rebase-dialog-heading"><span className="rebase-dialog-icon"><GitPullRequest size={19}/></span><div><span className="eyebrow">{t('operation.rebase.title')}</span><h2 id="rebase-title">{t('operation.will')} {repository.branch} {t('operation.rebase.onto')} {targetLabel}</h2><p>{t('operation.rebase.cleanRequired')}</p></div><Button variant="icon" onClick={onClose} disabled={starting} title={t('common.close')}><X size={17}/></Button></div>{loading && <div className="rebase-dialog-loading"><GitPullRequest size={20} className="spin"/>{t('operation.rebase.computing')}</div>}{error && <div className="rebase-dialog-error"><AlertTriangle size={15}/>{error}</div>}{preview && <><div className="rebase-route-summary"><div><GitBranch size={15}/><span>{preview.branch}</span></div><span className="route-arrow">→</span><div><GitCommitHorizontal size={15}/><span>{preview.ontoShortHash}</span></div><small>{t('operation.rebase.commitsToReplay', { count: preview.steps.length })}</small></div><div className="rebase-preview-list"><div className="rebase-preview-heading"><strong>{t('operation.rebase.pendingCommits')}</strong><span>{preview.steps.length}</span></div>{preview.steps.length ? preview.steps.map((step, index) => <div className="rebase-preview-step" key={step.hash}><span className="rebase-preview-index">{index + 1}</span><div><strong>{step.title}</strong><small>{step.shortHash} · {step.author}</small></div></div>) : <div className="rebase-dialog-empty">{t('operation.rebase.upToDate')}</div>}</div></>}<div className="rebase-dialog-actions"><Button variant="secondary" onClick={onClose} disabled={starting}>{t('common.cancel')}</Button><Button variant="primary" onClick={() => { if (!preview || !preview.steps.length) return; setStarting(true); void onStart(preview.onto).finally(() => setStarting(false)) }} disabled={loading || starting || !preview?.steps.length}><GitPullRequest size={14}/>{starting ? t('operation.rebase.starting') : t('operation.rebase.start')}</Button></div></section></div>
}
