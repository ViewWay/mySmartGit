import { useI18n } from '../../i18n'
import { useState } from 'react'
import { GitCompareArrows, History, RotateCcw, ScanSearch } from 'lucide-react'
import type { ReflogEntry, RepositorySnapshot } from '../../repository'
import { Button } from '../../components/Button'
import { ReflogPanel } from './ReflogPanel'
import { BisectPanel } from './BisectPanel'
import { ResetModeDialog } from './ResetModeDialog'
import './recovery.css'

type RecoveryPageProps = {
  repository: RepositorySnapshot | null
  onSnapshot: (snapshot: RepositorySnapshot) => void
  onNotice: (message: string) => void
}

type RecoveryTab = 'reflog' | 'bisect'

/** 恢复与问题定位入口：Reflog 浏览 / Bisect 排查 / 按模式 Reset。 */
export function RecoveryPage({ repository, onSnapshot, onNotice }: RecoveryPageProps) {
  const { t } = useI18n()
  const [tab, setTab] = useState<RecoveryTab>('reflog')
  const [busy, setBusy] = useState(false)
  const [resetDialog, setResetDialog] = useState<{ commit: string; mode: 'soft' | 'mixed' | 'hard' } | null>(null)

  const openResetForEntry = (entry: ReflogEntry) => setResetDialog({ commit: entry.commitHash, mode: 'mixed' })

  return <section className="workspace-page recovery-page">
    <div className="workspace-page-heading">
      <div><span className="eyebrow">{t('recovery.title')}</span><h2>{t('recovery.subtitle')}</h2><p>{t('recovery.description')}</p></div>
      <Button variant="secondary" disabled={!repository || busy} onClick={() => setResetDialog({ commit: 'HEAD', mode: 'mixed' })}><RotateCcw size={14}/>{t('recovery.resetAction')}</Button>
    </div>
    <div className="recovery-tabs">
      <button className={tab === 'reflog' ? 'active' : ''} onClick={() => setTab('reflog')}><History size={14}/><span>{t('recovery.reflogCard')}</span></button>
      <button className={tab === 'bisect' ? 'active' : ''} onClick={() => setTab('bisect')}><ScanSearch size={14}/><span>{t('recovery.bisectCard')}</span></button>
      <span className="tab-spacer"/>
      {repository?.operation && <small className="recovery-lock"><GitCompareArrows size={12}/>{t('recovery.operationBusyLabel', { label: repository.operation.label })}</small>}
    </div>
    {tab === 'reflog' && <ReflogPanel
      repository={repository}
      busy={busy}
      onBusyChange={setBusy}
      onSnapshot={onSnapshot}
      onNotice={onNotice}
      onOpenResetDialog={openResetForEntry}
    />}
    {tab === 'bisect' && <BisectPanel
      repository={repository}
      busy={busy}
      onBusyChange={setBusy}
      onSnapshot={onSnapshot}
      onNotice={onNotice}
    />}
    <ResetModeDialog
      open={resetDialog !== null}
      repository={repository}
      initialCommit={resetDialog?.commit ?? 'HEAD'}
      initialMode={resetDialog?.mode ?? 'mixed'}
      onClose={() => setResetDialog(null)}
      onSnapshot={onSnapshot}
      onNotice={onNotice}
    />
  </section>
}
