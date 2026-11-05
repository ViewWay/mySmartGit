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
  const [tab, setTab] = useState<RecoveryTab>('reflog')
  const [busy, setBusy] = useState(false)
  const [resetDialog, setResetDialog] = useState<{ commit: string; mode: 'soft' | 'mixed' | 'hard' } | null>(null)

  const openResetForEntry = (entry: ReflogEntry) => setResetDialog({ commit: entry.commitHash, mode: 'mixed' })

  return <section className="workspace-page recovery-page">
    <div className="workspace-page-heading">
      <div><span className="eyebrow">恢复与问题定位</span><h2>历史找回与故障排查</h2><p>Reflog 记录分支与 HEAD 的每一次移动；被重写、被回退的提交即使不在提交图谱中，也能在这里直接打开并恢复。</p></div>
      <Button variant="secondary" disabled={!repository || busy} onClick={() => setResetDialog({ commit: 'HEAD', mode: 'mixed' })}><RotateCcw size={14}/>按模式 Reset…</Button>
    </div>
    <div className="recovery-tabs">
      <button className={tab === 'reflog' ? 'active' : ''} onClick={() => setTab('reflog')}><History size={14}/><span>Reflog 浏览与恢复</span></button>
      <button className={tab === 'bisect' ? 'active' : ''} onClick={() => setTab('bisect')}><ScanSearch size={14}/><span>Bisect 问题定位</span></button>
      <span className="tab-spacer"/>
      {repository?.operation && <small className="recovery-lock"><GitCompareArrows size={12}/>{repository.operation.label}进行中：恢复类操作会被拒绝，请先在操作中心处理</small>}
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
