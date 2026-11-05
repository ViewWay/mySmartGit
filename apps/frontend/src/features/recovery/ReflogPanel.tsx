import { useCallback, useEffect, useMemo, useState } from 'react'
import { GitBranch, History, RotateCcw, SearchCode, Trash2 } from 'lucide-react'
import {
  checkoutReflogEntry,
  createBranchFromReflogEntry,
  loadReflogEntries,
  loadRevisionFileDiff,
  loadRevisionFiles,
  type ReflogEntry,
  type RepositoryFile,
  type RepositorySnapshot,
} from '../../repository'
import { Button } from '../../components/Button'
import { DiffPanel } from '../diff/DiffPanel'
import { formatLocalDateTime } from '../../dateTime'
import { useConfirmDialog } from '../../components/ConfirmDialog'
import { describeReflogRestore, reflogActionLabel } from './reflogModel'

type ReflogPanelProps = {
  repository: RepositorySnapshot | null
  busy: boolean
  onBusyChange: (value: boolean) => void
  onSnapshot: (snapshot: RepositorySnapshot) => void
  onNotice: (message: string) => void
  onOpenResetDialog: (entry: ReflogEntry) => void
}

/** Reflog 浏览与恢复面板：按 HEAD / 分支列出条目，内容直接按引用读取，不依赖提交图谱。 */
export function ReflogPanel({ repository, busy, onBusyChange, onSnapshot, onNotice, onOpenResetDialog }: ReflogPanelProps) {
  const { confirm, confirmDialog } = useConfirmDialog()
  const [scope, setScope] = useState('HEAD')
  const [entries, setEntries] = useState<ReflogEntry[]>([])
  const [selected, setSelected] = useState<ReflogEntry | null>(null)
  const [files, setFiles] = useState<RepositoryFile[]>([])
  const [diffFile, setDiffFile] = useState<number | null>(null)
  const [wide, setWide] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [branchName, setBranchName] = useState('')

  const scopes = useMemo(() => ['HEAD', ...(repository?.branches ?? [])], [repository?.branches])

  const refresh = useCallback(async (target: string) => {
    if (!repository) return
    setLoading(true)
    setError(null)
    try {
      const list = await loadReflogEntries(repository.path, target === 'HEAD' ? undefined : target)
      setEntries(list)
      setSelected((current) => (current && list.some((entry) => entry.selector === current.selector) ? current : list[0] ?? null))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setEntries([])
      setSelected(null)
    } finally {
      setLoading(false)
    }
  }, [repository])

  useEffect(() => {
    void refresh(scope)
  }, [scope, refresh])

  useEffect(() => {
    if (!repository || !selected) {
      setFiles([])
      setDiffFile(null)
      return
    }
    let cancelled = false
    loadRevisionFiles(repository.path, selected.commitHash)
      .then((list) => { if (!cancelled) { setFiles(list); setDiffFile(null) } })
      .catch((reason) => { if (!cancelled) { setFiles([]); setError(reason instanceof Error ? reason.message : String(reason)) } })
    return () => { cancelled = true }
  }, [repository, selected?.commitHash])

  const run = async (operation: () => Promise<RepositorySnapshot>, notice: string) => {
    if (!repository) return
    onBusyChange(true)
    try {
      const snapshot = await operation()
      onSnapshot(snapshot)
      onNotice(notice)
      await refresh(scope)
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : String(reason))
    } finally {
      onBusyChange(false)
    }
  }

  const handleCheckout = async (entry: ReflogEntry) => {
    if (!await confirm({ title: '按 Reflog 检出提交', message: `${describeReflogRestore(entry, 'checkout')}`, confirmLabel: '检出提交' })) return
    await run(() => checkoutReflogEntry(repository!.path, entry.commitHash), `已检出 ${entry.shortHash}（分离 HEAD）`)
  }

  const handleCreateBranch = async (entry: ReflogEntry) => {
    const name = branchName.trim()
    if (!name) return onNotice('请先在下方输入新分支名称')
    if (!await confirm({ title: '从 Reflog 创建分支', message: `${describeReflogRestore(entry, 'branch')}\n\n新分支：${name}`, confirmLabel: '创建分支' })) return
    await run(() => createBranchFromReflogEntry(repository!.path, entry.commitHash, name), `已创建分支 ${name}`)
    setBranchName('')
  }

  const handleReset = async (entry: ReflogEntry) => {
    if (!repository?.branch || repository.branch.startsWith('Detached')) {
      return onNotice('当前处于分离 HEAD，请先切换分支再按条目回退')
    }
    if (!await confirm({ title: '按 Reflog 回退当前分支', message: `${describeReflogRestore(entry, 'reset')}\n\n将在 Reset 对话框中选择 soft / mixed / hard 模式。`, confirmLabel: '继续' })) return
    onOpenResetDialog(entry)
  }

  return <section className="reflog-panel">
    <div className="reflog-toolbar">
      <label><SearchCode size={13}/><span>查看范围</span></label>
      <select value={scope} onChange={(event) => setScope(event.target.value)} disabled={loading}>{scopes.map((value) => <option key={value} value={value}>{value === 'HEAD' ? 'HEAD（全局动作）' : value}</option>)}</select>
      <Button variant="icon" title="刷新 Reflog" onClick={() => void refresh(scope)} disabled={loading}><History size={13}/></Button>
      <small>{repository ? `${entries.length} 条记录 · 直接按引用读取，不受提交图谱默认上限影响` : '未打开仓库'}</small>
    </div>
    {error && <div className="rebase-dialog-error"><AlertInline message={error}/></div>}
    <div className="reflog-workspace">
      <div className="reflog-list">
        {entries.map((entry) => <article key={entry.selector} className={selected?.selector === entry.selector ? 'active' : ''}>
          <button className="stash-select" onClick={() => setSelected(entry)}>
            <span className="stash-icon"><GitBranch size={14}/></span>
            <span><strong>{entry.commitTitle || entry.subject}</strong><small>{entry.selector} · {reflogActionLabel(entry.action)} · {formatLocalDateTime(entry.entryTime || entry.commitTime)}</small></span>
          </button>
          <div className="reflog-entry-meta"><small>{entry.shortHash} ← {entry.oldHash === '0000000000000000000000000000000000000000' ? '（初始）' : entry.oldHash.slice(0, 7)}</small>{entry.isHead && <em>当前 HEAD</em>}</div>
        </article>)}
        {!loading && entries.length === 0 && <div className="workspace-hint"><History size={26}/><strong>该引用暂无 Reflog 记录</strong><span>Reflog 默认保留约 90 天，过期对象会被 gc 清理。</span></div>}
        {loading && <div className="workspace-hint"><History size={26} className="spin"/><strong>正在读取 Reflog…</strong></div>}
      </div>
      <div className="reflog-detail">
        {selected && <>
          <div className="reflog-detail-heading"><div><strong>{selected.subject}</strong><span>{selected.commitHash} · {selected.author} · {formatLocalDateTime(selected.commitTime)}</span></div></div>
          <div className="reflog-restore-actions">
            <Button variant="secondary" disabled={busy} onClick={() => void handleCheckout(selected)}><SearchCode size={13}/>检出此提交</Button>
            <Button variant="secondary" disabled={busy} onClick={() => void handleCreateBranch(selected)}><GitBranch size={13}/>创建分支</Button>
            <Button variant="danger" disabled={busy} onClick={() => void handleReset(selected)}><RotateCcw size={13}/>回退当前分支</Button>
            <input value={branchName} onChange={(event) => setBranchName(event.target.value)} placeholder="新分支名，如 recovery/fix"/>
          </div>
          {files.length > 0 && diffFile === null && <div className="reflog-file-hint"><Trash2 size={13}/><span>该对象改动 {files.length} 个文件：</span><code>{files.slice(0, 6).map((file) => file.path).join('、')}{files.length > 6 ? ' …' : ''}</code></div>}
          {diffFile !== null && <div className="reflog-diff-overlay"><DiffPanel files={files} repositoryPath={repository?.path} wide={wide} onWideChange={setWide} initialFile={diffFile} onActiveFileChange={setDiffFile} hideFileList loadRows={async (path) => loadRevisionFileDiff(repository!.path, selected.commitHash, path, true)} onClose={() => setDiffFile(null)}/></div>}
          {files.length > 0 && diffFile === null && <div className="reflog-file-list">{files.map((file, index) => <button key={file.path} onClick={() => setDiffFile(index)}><span>{file.path}</span><small>+{file.add} -{file.del}</small></button>)}</div>}
        </>}
        {!selected && <div className="workspace-hint"><SearchCode size={26}/><strong>选择左侧条目查看内容</strong><span>历史对象（含被重写的提交与旧 Stash）都可直接打开，无需其出现在提交图谱中。</span></div>}
      </div>
    </div>
    {confirmDialog}
  </section>
}

function AlertInline({ message }: { message: string }) {
  return <span>{message}</span>
}
