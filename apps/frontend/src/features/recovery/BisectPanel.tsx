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
    void guard(() => startRepositoryBisect(repository.path, badRef.trim(), goodRef.trim(), badTerm.trim() || undefined, goodTerm.trim() || undefined), 'Bisect 已开始，请按提示标记当前提交的测试结论')
  }

  const handleExit = async () => {
    if (!repository || !status) return
    const progress = status.tested.length
    const message = progress
      ? `退出将丢弃当前 Bisect 进度（已记录 ${progress} 步结论）。仓库会回到${status.originalBranch ? `分支 ${status.originalBranch}` : 'Bisect 起始状态'}；排查记录不会自动保存。`
      : '退出 Bisect 会回到起始分支，仓库不受影响。'
    if (!await confirm({ title: '退出 Bisect', message, confirmLabel: '退出 Bisect', variant: progress ? 'danger' : 'primary' })) return
    onBusyChange(true)
    try {
      const snapshot = await resetRepositoryBisect(repository.path)
      onSnapshot(snapshot)
      setStatus(await loadRepositoryBisectStatus(repository.path))
      onNotice('已退出 Bisect，仓库状态完整恢复')
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : String(reason))
    } finally {
      onBusyChange(false)
    }
  }

  if (!repository) {
    return <section className="workspace-hint"><GitCommitHorizontal size={26}/><strong>Bisect 需要先打开本地仓库</strong></section>
  }

  if (!status?.active) {
    return <section className="bisect-panel">
      <div className="bisect-start">
        <div className="workspace-page-heading"><div><span className="eyebrow">问题定位</span><h2>二分查找引入问题的提交</h2><p>指定一个确定有问题的提交（{badTerm.trim() || 'bad'}）和一个确定正常的提交（{goodTerm.trim() || 'good'}），Branchline 会逐次检出中间提交让你验证。</p></div></div>
        {error && <div className="rebase-dialog-error">{error}</div>}
        <div className="bisect-start-fields">
          <label><span>坏提交（问题存在）</span><input value={badRef} onChange={(event) => setBadRef(event.target.value)} placeholder="HEAD 或提交号"/></label>
          <label><span>好提交（问题不存在）</span><input value={goodRef} onChange={(event) => setGoodRef(event.target.value)} placeholder="例如 v1.0.0 或提交号"/></label>
          <div className="bisect-terms">
            <label><span>自定义“坏”术语（--term-new）</span><input value={badTerm} onChange={(event) => setBadTerm(event.target.value)} placeholder="默认 bad"/></label>
            <label><span>自定义“好”术语（--term-old）</span><input value={goodTerm} onChange={(event) => setGoodTerm(event.target.value)} placeholder="默认 good"/></label>
          </div>
          <Button variant="primary" disabled={busy || !badRef.trim() || !goodRef.trim()} onClick={handleStart}><Play size={14}/>开始 Bisect</Button>
        </div>
        <p className="bisect-hint">开始前后请保持工作区干净；若仓库正处于合并 / 变基 / Cherry-pick / 冲突或另一个 Bisect 中，Git 会拒绝开始并说明原因。</p>
      </div>
      {confirmDialog}
    </section>
  }

  const current = status.currentCommit
  return <section className="bisect-panel">
    <div className="bisect-status-head">
      <div><span className="eyebrow">{status.done ? '已定位' : '排查进行中'}</span><h2>{status.message}</h2></div>
      <div className="bisect-counters"><span><strong>{status.remainingCount}</strong>个候选提交</span><span><strong>{status.stepsEstimate}</strong>步以内可收敛</span><span><strong>{status.tested.length}</strong>条已记录结论</span></div>
    </div>
    <div className="bisect-current">
      <div className="bisect-current-card">
        <GitCommitHorizontal size={15}/>
        <div><strong>{current?.title ?? '（无法读取当前提交）'}</strong><small>{current ? `${current.shortHash} · ${current.author}` : ''}</small></div>
        {status.done && <em className={`bisect-verdict bad`}>首个{status.badTerm}</em>}
      </div>
      <div className="bisect-actions">
        <Button variant="danger" disabled={busy || status.done} onClick={() => void guard(() => markRepositoryBisect(repository.path, 'bad'), '')}><AlertTriangle size={14}/>有问题（{status.badTerm}）</Button>
        <Button variant="secondary" disabled={busy || status.done} onClick={() => void guard(() => markRepositoryBisect(repository.path, 'good'), '')}><Check size={14}/>正常（{status.goodTerm}）</Button>
        <Button variant="secondary" disabled={busy} onClick={() => void guard(() => markRepositoryBisect(repository.path, 'skip'), '')}><Ban size={14}/>跳过</Button>
        <Button variant="secondary" disabled={busy} title="重新计算并检出下一个候选提交" onClick={() => void guard(() => advanceRepositoryBisect(repository.path), '')}><Play size={14}/>下一个</Button>
        <Button variant="secondary" disabled={busy} onClick={() => void handleExit()}><X size={14}/>退出 Bisect</Button>
      </div>
    </div>
    {(status.badCommit || status.goodCommits.length > 0) && <div className="bisect-boundaries">
      {status.badCommit && <div><span>坏边界</span><code>{status.badCommit.shortHash}</code><small>{status.badCommit.title}</small></div>}
      {status.goodCommits.map((commit) => <div key={commit.hash}><span>好边界</span><code>{commit.shortHash}</code><small>{commit.title}</small></div>)}
    </div>}
    <div className="bisect-tested-list">
      <div className="stash-list-heading"><strong>已测试提交</strong><span>{status.tested.length}</span></div>
      {status.tested.map((step, index) => <div className="bisect-step" key={`${step.hash}-${index}`}>
        <em className={`bisect-verdict ${step.verdict === status.goodTerm || step.verdict === 'good' ? 'good' : step.verdict === 'skip' ? 'skip' : 'bad'}`}>{step.verdict}</em>
        <div><strong>{step.title}</strong><small>{step.shortHash} · {step.author}</small></div>
      </div>)}
      {status.done && status.badCommit && <div className="bisect-result"><AlertTriangle size={15}/><span><strong>{status.badCommit.shortHash} 是首个{status.badTerm}提交</strong><small>{status.badCommit.title} · 可在退出前保留该结论，或复制提交号去修复</small></span></div>}
    </div>
    {error && <div className="rebase-dialog-error">{error}</div>}
    {confirmDialog}
  </section>
}
