import { useI18n } from '../../i18n'
import { useCallback, useEffect, useState } from 'react'
import { Ban, Check, GitCommitHorizontal, Play, AlertTriangle, X } from 'lucide-react'
import {
  advanceRepositoryBisect,
  loadRepositoryBisectStatus,
  markRepositoryBisect,
  resetRepositoryBisect,
  startRepositoryBisect,
  type BisectStatus,
  type RepositorySnapshot,
} from '../../repository'
import { Button } from '../../components/Button'
import { useConfirmDialog } from '../../components/ConfirmDialog'

type BisectPanelProps = {
  repository: RepositorySnapshot | null
  busy: boolean
  onBusyChange: (value: boolean) => void
  onSnapshot: (snapshot: RepositorySnapshot) => void
  onNotice: (message: string) => void
}

/**
 * Bisect 面板：start（bad/good，含 --term-* 映射）→ 逐次标记 → 收敛 → 退出。
 * 后端保证任何异常路径都有 bisect reset 出口；“进行中操作”检测由后端统一拦截。
 */
export function BisectPanel({ repository, busy, onBusyChange, onSnapshot, onNotice }: BisectPanelProps) {
  const { t } = useI18n()
  const { confirm, confirmDialog } = useConfirmDialog()
  const [status, setStatus] = useState<BisectStatus | null>(null)
  const [badRef, setBadRef] = useState('HEAD')
  const [goodRef, setGoodRef] = useState('')
  const [badTerm, setBadTerm] = useState('')
  const [goodTerm, setGoodTerm] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!repository) return
    try {
      setStatus(await loadRepositoryBisectStatus(repository.path))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [repository])

  useEffect(() => {
    void refresh()
    setError(null)
  }, [refresh])

  const guard = async (operation: () => Promise<BisectStatus>, notice: string) => {
    if (!repository) return
    onBusyChange(true)
    try {
      const next = await operation()
      setStatus(next)
      if (notice) onNotice(notice)
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : String(reason))
      await refresh()
    } finally {
      onBusyChange(false)
    }
  }

  const handleStart = () => {
    if (!repository) return
    void guard(() => startRepositoryBisect(repository.path, badRef.trim(), goodRef.trim(), badTerm.trim() || undefined, goodTerm.trim() || undefined), t('bisect.startedNotice'))
  }

  const handleExit = async () => {
    if (!repository || !status) return
    const progress = status.tested.length
    const message = progress
      ? t('bisect.exitConfirm', { progress, branch: status.originalBranch ? t('bisect.backToBranch', { branch: status.originalBranch }) : t('bisect.startState') })
      : t('bisect.exitHint')
    if (!await confirm({ title: t('bisect.exit'), message, confirmLabel: t('bisect.exit'), variant: progress ? 'danger' : 'primary' })) return
    onBusyChange(true)
    try {
      const snapshot = await resetRepositoryBisect(repository.path)
      onSnapshot(snapshot)
      setStatus(await loadRepositoryBisectStatus(repository.path))
      onNotice(t('bisect.exited'))
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : String(reason))
    } finally {
      onBusyChange(false)
    }
  }

  if (!repository) {
    return <section className="workspace-hint"><GitCommitHorizontal size={26}/><strong>{t('bisect.requiresRepository')}</strong></section>
  }

  if (!status?.active) {
    return <section className="bisect-panel">
      <div className="bisect-start">
        <div className="workspace-page-heading"><div><span className="eyebrow">{t('bisect.subtitle')}</span><h2>{t('bisect.title')}</h2><p>{t('bisect.pickIntroPrefix')}{badTerm.trim() || 'bad'}{t('bisect.pickIntroMiddle')}{goodTerm.trim() || 'good'}{t('bisect.pickIntroSuffix')}</p></div></div>
        {error && <div className="rebase-dialog-error">{error}</div>}
        <div className="bisect-start-fields">
          <label><span>{t('bisect.badCommit')}</span><input value={badRef} onChange={(event) => setBadRef(event.target.value)} placeholder={t('bisect.refPlaceholder')}/></label>
          <label><span>{t('bisect.goodCommit')}</span><input value={goodRef} onChange={(event) => setGoodRef(event.target.value)} placeholder={t('bisect.goodPlaceholder')}/></label>
          <div className="bisect-terms">
            <label><span>{t('bisect.termNew')}</span><input value={badTerm} onChange={(event) => setBadTerm(event.target.value)} placeholder={t('bisect.termNewPlaceholder')}/></label>
            <label><span>{t('bisect.termOld')}</span><input value={goodTerm} onChange={(event) => setGoodTerm(event.target.value)} placeholder={t('bisect.termOldPlaceholder')}/></label>
          </div>
          <Button variant="primary" disabled={busy || !badRef.trim() || !goodRef.trim()} onClick={handleStart}><Play size={14}/>{t('bisect.start')}</Button>
        </div>
        <p className="bisect-hint">{t('bisect.startHint')}</p>
      </div>
      {confirmDialog}
    </section>
  }

  const current = status.currentCommit
  return <section className="bisect-panel">
    <div className="bisect-status-head">
      <div><span className="eyebrow">{status.done ? t('bisect.located') : t('bisect.inProgress')}</span><h2>{status.message}</h2></div>
      <div className="bisect-counters"><span><strong>{status.remainingCount}</strong>{t('bisect.candidateCount')}</span><span><strong>{status.stepsEstimate}</strong>{t('bisect.stepEstimate')}</span><span><strong>{status.tested.length}</strong>{t('bisect.logCount')}</span></div>
    </div>
    <div className="bisect-current">
      <div className="bisect-current-card">
        <GitCommitHorizontal size={15}/>
        <div><strong>{current?.title ?? t('bisect.unknownCurrent')}</strong><small>{current ? `${current.shortHash} · ${current.author}` : ''}</small></div>
        {status.done && <em className={`bisect-verdict bad`}>{t('bisect.first')}{status.badTerm}</em>}
      </div>
      <div className="bisect-actions">
        <Button variant="danger" disabled={busy || status.done} onClick={() => void guard(() => markRepositoryBisect(repository.path, 'bad'), '')}><AlertTriangle size={14}/>{t('bisect.badMarked', { term: status.badTerm })}</Button>
        <Button variant="secondary" disabled={busy || status.done} onClick={() => void guard(() => markRepositoryBisect(repository.path, 'good'), '')}><Check size={14}/>{t('bisect.goodMarked', { term: status.goodTerm })}</Button>
        <Button variant="secondary" disabled={busy} onClick={() => void guard(() => markRepositoryBisect(repository.path, 'skip'), '')}><Ban size={14}/>{t('bisect.skip')}</Button>
        <Button variant="secondary" disabled={busy} title={t('bisect.skipHint')} onClick={() => void guard(() => advanceRepositoryBisect(repository.path), '')}><Play size={14}/>{t('bisect.next')}</Button>
        <Button variant="secondary" disabled={busy} onClick={() => void handleExit()}><X size={14}/>{t('bisect.exit')}</Button>
      </div>
    </div>
    {(status.badCommit || status.goodCommits.length > 0) && <div className="bisect-boundaries">
      {status.badCommit && <div><span>{t('bisect.badBoundary')}</span><code>{status.badCommit.shortHash}</code><small>{status.badCommit.title}</small></div>}
      {status.goodCommits.map((commit) => <div key={commit.hash}><span>{t('bisect.goodBoundary')}</span><code>{commit.shortHash}</code><small>{commit.title}</small></div>)}
    </div>}
    <div className="bisect-tested-list">
      <div className="stash-list-heading"><strong>{t('bisect.testedCommits')}</strong><span>{status.tested.length}</span></div>
      {status.tested.map((step, index) => <div className="bisect-step" key={`${step.hash}-${index}`}>
        <em className={`bisect-verdict ${step.verdict === status.goodTerm || step.verdict === 'good' ? 'good' : step.verdict === 'skip' ? 'skip' : 'bad'}`}>{step.verdict}</em>
        <div><strong>{step.title}</strong><small>{step.shortHash} · {step.author}</small></div>
      </div>)}
      {status.done && status.badCommit && <div className="bisect-result"><AlertTriangle size={15}/><span><strong>{status.badCommit.shortHash} {t('bisect.isFirst')}{status.badTerm} {t('bisect.commitUnit')}</strong><small>{status.badCommit.title} {t('bisect.locatedHint')}</small></span></div>}
    </div>
    {error && <div className="rebase-dialog-error">{error}</div>}
    {confirmDialog}
  </section>
}
