import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, GitCommitHorizontal, RefreshCw } from 'lucide-react'
import { Button } from '../../components/Button'
import { loadSubmodulePointerDiff, type SubmodulePointerDiff } from '../../repository'
import { useI18n } from '../../i18n'
import {
  cappedCommits,
  describePointerDiff,
  pointerChangeKind,
  pointerChangeLabel,
  pointerHashPair,
} from './submoduleDiffPresentation'

/**
 * 子模块指针差异（W2-10，对标 EnjoyGit 的 Submodule 差异）。
 *
 * 只展示后端算好的语义：父仓库记录的旧提交 → 子模块当前的新提交，
 * 以及为此新增的提交列表；「打开子模块仓库」的下钻入口仍由外层面板负责，
 * 避免同一屏出现两个互相竞争的导航按钮。
 */
export function SubmodulePointerDiffPanel({ repositoryPath, submodulePath, onNotice }: {
  repositoryPath: string
  submodulePath: string
  onNotice: (message: string) => void
}) {
  const { t } = useI18n()
  const [diff, setDiff] = useState<SubmodulePointerDiff | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      setDiff(await loadSubmodulePointerDiff(repositoryPath, submodulePath))
      return true
    } catch (cause) {
      setDiff(null)
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setBusy(false)
    }
  }, [repositoryPath, submodulePath])

  useEffect(() => {
    void load()
  }, [load])

  if (error) {
    return <article className="structure-detail-card">
      <span className="structure-icon"><AlertTriangle size={18}/></span>
      <h3>{t('repository.submodule.pointerDiffTitle')}</h3>
      <p className="repository-inline-error" role="alert">{error}</p>
      <div className="structure-actions"><Button variant="secondary" disabled={busy} onClick={() => void load()}><RefreshCw size={14}/>{t('repository.details.retry')}</Button></div>
    </article>
  }
  if (!diff) {
    return <article className="structure-detail-card"><span className="structure-icon"><GitCommitHorizontal size={18}/></span><h3>{t('repository.submodule.pointerDiffTitle')}</h3><p className="branch-dialog-hint">{busy ? t('repository.submodule.loadingPointerDiff') : t('repository.submodule.noPointerDiff')}</p></article>
  }

  const kind = pointerChangeKind(diff)
  const hashes = pointerHashPair(diff)
  const lines = describePointerDiff(diff, t)
  const commits = cappedCommits(diff.addedCommits)

  return <article className="structure-detail-card">
    <span className="structure-icon"><GitCommitHorizontal size={18}/></span>
    <h3>{t('repository.submodule.pointerDiffTitle')} · {pointerChangeLabel(kind, t)}</h3>
    <dl>
      <div><dt>{t('repository.submodule.parentRecord')}</dt><dd><code>{hashes.from}</code></dd></div>
      <div><dt>{t('repository.submodule.submoduleCurrent')}</dt><dd><code>{hashes.to}</code></dd></div>
      <div><dt>{t('repository.submodule.changeScope')}</dt><dd>{t('repository.submodule.filesChanged', { count: diff.filesChanged, additions: diff.additions, deletions: diff.deletions })}</dd></div>
      <div><dt>{t('repository.submodule.addedCommits')}</dt><dd>{diff.addedCount}{diff.removedCount > 0 ? t('repository.submodule.droppedSuffix', { count: diff.removedCount }) : ''}</dd></div>
      <div><dt>{t('repository.submodule.innerChanges')}</dt><dd>{diff.dirtyFiles > 0 ? t('repository.submodule.dirtyCount', { count: diff.dirtyFiles }) : t('repository.submodule.cleanWorktree')}</dd></div>
      <div><dt>{t('repository.submodule.urlLabel')}</dt><dd title={diff.url}><code>{diff.url || t('repository.submodule.noUrl')}</code></dd></div>
    </dl>
    <div className="branch-dialog-hint">{lines.map((line) => <p key={line}>{line}</p>)}</div>
    {commits.shown.length > 0 && <div className="structure-list">
      {commits.shown.map((commit) => <div className="tag-row" key={commit.hash} title={commit.hash}>
        <span><GitCommitHorizontal size={14}/></span>
        <span><strong>{commit.title}</strong><small>{commit.shortHash} · {commit.author} · {commit.commitTime}</small></span>
      </div>)}
      {commits.hidden > 0 && <div className="tag-row"><span/><span><small>{t('repository.submodule.hiddenCommits', { count: commits.hidden })}</small></span></div>}
    </div>}
    {diff.warnings.length > 0 && <div className="structure-list">
      {diff.warnings.map((warning) => <div className="tag-row" key={warning}>
        <span><AlertTriangle size={14}/></span>
        <span><small>{warning}</small></span>
      </div>)}
    </div>}
    <div className="structure-actions">
      <Button variant="secondary" disabled={busy} onClick={() => { void load().then((ok) => { if (ok) onNotice(t('repository.submodule.refreshed')) }) }}>
        <RefreshCw size={14} className={busy ? 'spin' : ''}/>{busy ? t('repository.submodule.loadingShort') : t('repository.submodule.refresh')}
      </Button>
    </div>
  </article>
}
