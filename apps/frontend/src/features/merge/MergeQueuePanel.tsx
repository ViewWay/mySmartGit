import { useI18n } from '../../i18n'
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, GitBranch, GitMerge, RefreshCw } from 'lucide-react'
import { loadMergeQueue, type MergeQueueSnapshot, type RepositorySnapshot } from '../../repository'
import { Button } from '../../components/Button'

export function MergeQueuePanel({ repository, onNotice, onSwitchBranch }: { repository: RepositorySnapshot | null; onNotice: (message: string) => void; onSwitchBranch: (branch: string) => Promise<void> }) {
  const { t } = useI18n()
  const [queue, setQueue] = useState<MergeQueueSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const refresh = useCallback(async () => {
    if (!repository) return
    setLoading(true)
    try {
      setQueue(await loadMergeQueue(repository.path))
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [onNotice, repository?.path])
  useEffect(() => { setQueue(null); void refresh() }, [refresh])

  if (!repository) return <section className="workspace-empty"><GitMerge size={34}/><strong>{t('repository.mergeQueue.title')}</strong><span>{t('repository.mergeQueue.openHint')}</span></section>
  return <section className="merge-panel workspace-page">
    <div className="workspace-page-heading"><div><span className="eyebrow">{t('repository.mergeQueue.title')}</span><h2>{t('repository.mergeQueue.mergeInto')} {repository.branch}</h2><p>{t('repository.mergeQueue.sortHint')}</p></div><Button variant="secondary" onClick={() => void refresh()} disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : ''}/>{loading ? t('repository.mergeQueue.refreshing') : t('repository.mergeQueue.refresh')}</Button></div>
    {queue?.conflicts.length ? <div className="conflict-card"><AlertTriangle size={17}/><div><strong>{t('repository.mergeQueue.unresolvedConflicts', { count: queue.conflicts.length })}</strong>{queue.conflicts.map((path) => <code key={path}>{path}</code>)}</div></div> : <div className="queue-healthy"><Check size={14}/>{t('repository.mergeQueue.noConflicts')}</div>}
    <div className="merge-list">
      <div className="merge-list-header"><span>{t('repository.mergeQueue.candidates')}</span><span>{t('repository.mergeQueue.ahead')}</span><span>{t('repository.mergeQueue.behind')}</span><span>{t('repository.mergeQueue.status')}</span><span/></div>
      {queue?.candidates.map((candidate) => <div className="merge-row" key={candidate.branch}><div><GitBranch size={14}/><strong>{candidate.branch}</strong></div><span className="ahead-count">+{candidate.ahead}</span><span>{candidate.behind}</span><span className={candidate.merged ? 'merged-state' : 'ready-state'}>{candidate.merged ? t('repository.mergeQueue.merged') : candidate.ahead ? t('repository.mergeQueue.evaluable') : t('repository.mergeQueue.noNewCommits')}</span><button onClick={() => void onSwitchBranch(candidate.branch)}>{t('repository.mergeQueue.switchTo')}</button></div>)}
      {!loading && queue?.candidates.length === 0 && <div className="workspace-hint"><GitMerge size={26}/><strong>{t('repository.mergeQueue.noOtherBranches')}</strong><span>{t('repository.mergeQueue.emptyHint')}</span></div>}
    </div>
  </section>
}
