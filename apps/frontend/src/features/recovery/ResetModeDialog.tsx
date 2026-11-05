import { useState } from 'react'
import { AlertTriangle, History, RotateCcw, X } from 'lucide-react'
import { resetRepositoryWithMode, type RepositorySnapshot, type RepositoryResetMode } from '../../repository'
import { Button } from '../../components/Button'
import { RESET_MODE_DESCRIPTIONS, resetNeedsDangerAck } from './reflogModel'

type ResetModeDialogProps = {
  open: boolean
  repository: RepositorySnapshot | null
  initialCommit?: string
  initialMode?: RepositoryResetMode
  onClose: () => void
  onSnapshot: (snapshot: RepositorySnapshot) => void
  onNotice: (message: string) => void
}

/**
 * Reset 三模式对话框：soft / mixed / hard。
 * hard 模式必须额外勾选危险确认，且后端仍会独立校验 confirmHard，
 * 防止绕过 UI 直接调用。
 */
export function ResetModeDialog({ open, repository, initialCommit = '', initialMode = 'mixed', onClose, onSnapshot, onNotice }: ResetModeDialogProps) {
  const [commit, setCommit] = useState(initialCommit)
  const [mode, setMode] = useState<RepositoryResetMode>(initialMode)
  const [ackDanger, setAckDanger] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!open || !repository) return null
  const trimmed = commit.trim()
  const blocked = !trimmed || busy || (resetNeedsDangerAck(mode) && !ackDanger)
  const run = async () => {
    if (!trimmed) return onNotice('请输入目标提交（Hash、分支名、HEAD@{n} 或 stash@{n}）')
    setBusy(true)
    try {
      const snapshot = await resetRepositoryWithMode(repository.path, trimmed, mode, mode === 'hard')
      onSnapshot(snapshot)
      onNotice(mode === 'hard'
        ? `已 hard Reset 到 ${trimmed}；本地修改已丢弃，可在 Reflog 面板找回历史提交`
        : `已 ${mode} Reset 到 ${trimmed}，${mode === 'soft' ? '暂存区与工作区保持原样' : '工作区修改已保留为未暂存'}`)
      onClose()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  return <div className="modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section className="rebase-dialog recovery-reset-dialog" role="dialog" aria-modal="true" aria-labelledby="recovery-reset-title">
      <div className="rebase-dialog-heading">
        <span className="rebase-dialog-icon"><RotateCcw size={19}/></span>
        <div><span className="eyebrow">回退（Reset）</span><h2 id="recovery-reset-title">按模式回退 {repository.branch}</h2><p>目标提交之后的提交不会从仓库消失：它们仍会保留在 Reflog 中，可在恢复面板找回。</p></div>
        <Button variant="icon" onClick={onClose} disabled={busy} title="关闭"><X size={17}/></Button>
      </div>
      <div className="recovery-reset-body">
        <label className="recovery-reset-commit"><span>目标提交</span><input value={commit} onChange={(event) => setCommit(event.target.value)} placeholder="例如 1a2b3c4、HEAD@{2}、main~3 或 stash@{1}"/></label>
        <div className="recovery-reset-modes">{(['soft', 'mixed', 'hard'] as RepositoryResetMode[]).map((value) => <label key={value} className={mode === value ? 'active' : ''}>
          <input type="radio" name="reset-mode" checked={mode === value} onChange={() => { setMode(value); if (value !== 'hard') setAckDanger(false) }}/>
          <div><strong>{value}</strong><small>{RESET_MODE_DESCRIPTIONS[value]}</small></div>
        </label>)}</div>
        {mode === 'hard' && <label className="recovery-reset-danger"><input type="checkbox" checked={ackDanger} onChange={(event) => setAckDanger(event.target.checked)}/><AlertTriangle size={13}/><span>我已确认：hard 模式会丢弃目标提交之后的所有提交，并清空暂存区与已跟踪文件的本地修改。</span></label>}
        {mode !== 'hard' && <div className="recovery-reset-note"><History size={13}/><span>soft / mixed 不改动工作区文件内容，但仍会移动 {repository.branch} 的分支指针。</span></div>}
      </div>
      <div className="rebase-dialog-actions">
        <Button variant="secondary" onClick={onClose} disabled={busy}>取消</Button>
        <Button variant={mode === 'hard' ? 'danger' : 'primary'} disabled={blocked} onClick={() => void run()}><RotateCcw size={14}/>{busy ? '正在回退…' : `执行 ${mode} Reset`}</Button>
      </div>
    </section>
  </div>
}
