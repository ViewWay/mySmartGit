import { useI18n } from '../../i18n'
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
  const { t } = useI18n()
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
    if (!await confirm({ title: t('reflog.checkoutTitle'), message: `${describeReflogRestore(entry, 'checkout', t)}`, confirmLabel: t('reflog.checkout') })) return
    await run(() => checkoutReflogEntry(repository!.path, entry.commitHash), `已检出 ${entry.shortHash}（分离 HEAD）`)
  }

  const handleCreateBranch = async (entry: ReflogEntry) => {
    const name = branchName.trim()
    if (!name) return onNotice(t('reflog.branchRequired'))
    if (!await confirm({ title: t('reflog.createBranchTitle'), message: `${describeReflogRestore(entry, 'branch', t)}\n\n${t('reflog.newBranch', { name })}`, confirmLabel: t('reflog.createBranch') })) return
    await run(() => createBranchFromReflogEntry(repository!.path, entry.commitHash, name), `已创建分支 ${name}`)
    setBranchName('')
  }

  const handleReset = async (entry: ReflogEntry) => {
    if (!repository?.branch || repository.branch.startsWith('Detached')) {
      return onNotice(t('reflog.detachedWarning'))
    }
    if (!await confirm({ title: t('reflog.resetBranchTitle'), message: `${describeReflogRestore(entry, 'reset', t)}\n\n${t('reflog.resetModeNote')}`, confirmLabel: t('reflog.continue') })) return
    onOpenResetDialog(entry)
  }

  return <section className="reflog-panel">
    <div className="reflog-toolbar">
      <label><SearchCode size={13}/><span>{t('reflog.viewScope')}</span></label>
      <select value={scope} onChange={(event) => setScope(event.target.value)} disabled={loading}>{scopes.map((value) => <option key={value} value={value}>{value === 'HEAD' ? t('reflog.headScope') : value}</option>)}</select>
      <Button variant="icon" title={t('reflog.refresh')} onClick={() => void refresh(scope)} disabled={loading}><History size={13}/></Button>
      <small>{repository ? `${entries.length} 条记录 · 直接按引用读取，不受提交图谱默认上限影响` : t('reflog.noRepository')}</small>
    </div>
    {error && <div className="rebase-dialog-error"><AlertInline message={error}/></div>}
    <div className="reflog-workspace">
      <div className="reflog-list">
        {entries.map((entry) => <article key={entry.selector} className={selected?.selector === entry.selector ? 'active' : ''}>
          <button className="stash-select" onClick={() => setSelected(entry)}>
            <span className="stash-icon"><GitBranch size={14}/></span>
            <span><strong>{entry.commitTitle || entry.subject}</strong><small>{entry.selector} · {reflogActionLabel(entry.action, t)} · {formatLocalDateTime(entry.entryTime || entry.commitTime)}</small></span>
          </button>
          <div className="reflog-entry-meta"><small>{entry.shortHash} ← {entry.oldHash === '0000000000000000000000000000000000000000' ? t('reflog.initial') : entry.oldHash.slice(0, 7)}</small>{entry.isHead && <em>{t('reflog.currentHead')}</em>}</div>
        </article>)}
        {!loading && entries.length === 0 && <div className="workspace-hint"><History size={26}/><strong>{t('reflog.empty')}</strong><span>{t('reflog.gcNote')}</span></div>}
        {loading && <div className="workspace-hint"><History size={26} className="spin"/><strong>{t('reflog.loading')}</strong></div>}
      </div>
      <div className="reflog-detail">
        {selected && <>
          <div className="reflog-detail-heading"><div><strong>{selected.subject}</strong><span>{selected.commitHash} · {selected.author} · {formatLocalDateTime(selected.commitTime)}</span></div></div>
          <div className="reflog-restore-actions">
            <Button variant="secondary" disabled={busy} onClick={() => void handleCheckout(selected)}><SearchCode size={13}/>{t('reflog.checkoutEntry')}</Button>
            <Button variant="secondary" disabled={busy} onClick={() => void handleCreateBranch(selected)}><GitBranch size={13}/>{t('reflog.createBranchEntry')}</Button>
            <Button variant="danger" disabled={busy} onClick={() => void handleReset(selected)}><RotateCcw size={13}/>{t('reflog.resetBranchEntry')}</Button>
            <input value={branchName} onChange={(event) => setBranchName(event.target.value)} placeholder={t('reflog.branchPlaceholder')}/>
          </div>
          {files.length > 0 && diffFile === null && <div className="reflog-file-hint"><Trash2 size={13}/><span>{t('reflog.changedFiles')} {files.length} {t('reflog.changedFilesSuffix')}</span><code>{files.slice(0, 6).map((file) => file.path).join('、')}{files.length > 6 ? ' …' : ''}</code></div>}
          {diffFile !== null && <div className="reflog-diff-overlay"><DiffPanel files={files} repositoryPath={repository?.path} wide={wide} onWideChange={setWide} initialFile={diffFile} onActiveFileChange={setDiffFile} hideFileList loadRows={async (path) => loadRevisionFileDiff(repository!.path, selected.commitHash, path, true)} onClose={() => setDiffFile(null)}/></div>}
          {files.length > 0 && diffFile === null && <div className="reflog-file-list">{files.map((file, index) => <button key={file.path} onClick={() => setDiffFile(index)}><span>{file.path}</span><small>+{file.add} -{file.del}</small></button>)}</div>}
        </>}
        {!selected && <div className="workspace-hint"><SearchCode size={26}/><strong>{t('reflog.pickEntry')}</strong><span>{t('reflog.historyObjectsHint')}</span></div>}
      </div>
    </div>
    {confirmDialog}
  </section>
}

function AlertInline({ message }: { message: string }) {
  return <span>{message}</span>
}
