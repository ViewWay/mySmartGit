import { useI18n } from '../../i18n'
import { useState } from 'react'
import { Archive, Check, CornerDownLeft, GitCommitHorizontal, Plus, Trash2 } from 'lucide-react'
import {
  applyRepositoryStash,
  createRepositoryStash,
  dropRepositoryStash,
  type RepositorySnapshot,
} from '../../repository'
import { formatLocalDateTime } from '../../dateTime'
import { Button } from '../../components/Button'
import { useConfirmDialog } from '../../components/ConfirmDialog'

export function StashPage({ repository, onSelectStash, onSnapshot, onNotice }: { repository: RepositorySnapshot | null; onSelectStash: (reference: string) => void; onSnapshot: (snapshot: RepositorySnapshot) => void; onNotice: (message: string) => void }) {
  const { t } = useI18n()
  const [message, setMessage] = useState('')
  const [includeUntracked, setIncludeUntracked] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const { confirm, confirmDialog } = useConfirmDialog()
  const run = async (key: string, operation: () => Promise<RepositorySnapshot>, notice: string) => {
    if (!repository) return onNotice(t('stash.requiresRepository'))
    setBusy(key)
    try {
      const snapshot = await operation()
      onSnapshot(snapshot)
      onNotice(snapshot.operation
        ? `${snapshot.operation.label}：请处理 ${snapshot.operation.conflicts.length} 个冲突文件`
        : notice)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }
  const selectStash = (reference: string) => {
    onSelectStash(reference)
  }
  const dropStash = async (reference: string) => {
    if (!await confirm({ title: t('stash.dropTitle'), message: `确定删除 ${reference}？`, confirmLabel: t('stash.drop'), variant: 'danger' })) return
    await run(`drop-${reference}`, () => dropRepositoryStash(repository!.path, reference), `已删除 ${reference}`)
  }

  return <section className="workspace-page stash-page">
    <div className="stash-workspace stash-manager">
      <div className="stash-control-pane">
        <div className="stash-compose"><input value={message} onChange={(event) => setMessage(event.target.value)} placeholder={t('stash.messagePlaceholder')}/><label><input type="checkbox" checked={includeUntracked} onChange={(event) => setIncludeUntracked(event.target.checked)}/>{t('stash.includeUntracked')}</label><Button variant="primary" disabled={!repository || busy !== null} onClick={() => void run('create', () => createRepositoryStash(repository!.path, message, includeUntracked), t('stash.saved'))}><Plus size={14}/>{busy === 'create' ? t('stash.saving') : t('stash.create')}</Button></div>
        <div className="stash-list-heading"><strong>{t('stash.listTitle')}</strong><span>{repository?.stashes.length ?? 0}</span></div>
        <div className="stash-list">{repository?.stashes.map((stash) => <article key={stash.reference}>
          <button className="stash-select" onClick={() => selectStash(stash.reference)} title={t('stash.viewInGraph')}><span className="stash-icon"><Archive size={15}/></span><span><strong>{stash.message}</strong><small>{stash.reference} · {stash.author} · {formatLocalDateTime(stash.time)}</small></span></button>
          <div className="stash-actions"><Button variant="icon" disabled={busy !== null} title={t('stash.applyKeep')} onClick={() => void run(`apply-${stash.reference}`, () => applyRepositoryStash(repository.path, stash.reference, false), `已应用 ${stash.reference}`)}><Check size={13}/></Button><Button variant="icon" disabled={busy !== null} title={t('stash.popDrop')} onClick={() => void run(`pop-${stash.reference}`, () => applyRepositoryStash(repository.path, stash.reference, true), `已弹出 ${stash.reference}`)}><CornerDownLeft size={13}/></Button><Button variant="danger" disabled={busy !== null} title={t('stash.drop')} onClick={() => void dropStash(stash.reference)}><Trash2 size={13}/></Button></div>
        </article>)}
          {repository && repository.stashes.length === 0 && <div className="workspace-hint"><Archive size={26}/><strong>{t('stash.empty')}</strong><span>{t('stash.emptyHint')}</span></div>}
          {!repository && <div className="workspace-hint"><Archive size={26}/><strong>{t('stash.requiresRepositoryShort')}</strong></div>}
        </div>
      </div>
      <div className="stash-graph-handoff">
        <GitCommitHorizontal size={32}/><strong>{t('stash.inGraph')}</strong><span>{t('stash.pickHint')}</span>
      </div>
      {confirmDialog}
    </div>
  </section>
}
