import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, GitCommitHorizontal, RefreshCw } from 'lucide-react'
import { Button } from '../../components/Button'
import { loadSubmodulePointerDiff, type SubmodulePointerDiff } from '../../repository'
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
      <h3>Submodule 差异</h3>
      <p className="repository-inline-error" role="alert">{error}</p>
      <div className="structure-actions"><Button variant="secondary" disabled={busy} onClick={() => void load()}><RefreshCw size={14}/>重试</Button></div>
    </article>
  }
  if (!diff) {
    return <article className="structure-detail-card"><span className="structure-icon"><GitCommitHorizontal size={18}/></span><h3>Submodule 差异</h3><p className="branch-dialog-hint">{busy ? '正在读取指针差异…' : '暂无差异数据。'}</p></article>
  }

  const kind = pointerChangeKind(diff)
  const hashes = pointerHashPair(diff)
  const lines = describePointerDiff(diff)
  const commits = cappedCommits(diff.addedCommits)

  return <article className="structure-detail-card">
    <span className="structure-icon"><GitCommitHorizontal size={18}/></span>
    <h3>Submodule 差异 · {pointerChangeLabel(kind)}</h3>
    <dl>
      <div><dt>父仓库记录</dt><dd><code>{hashes.from}</code></dd></div>
      <div><dt>子模块当前</dt><dd><code>{hashes.to}</code></dd></div>
      <div><dt>改动范围</dt><dd>{diff.filesChanged} 个文件 · +{diff.additions}/-{diff.deletions}</dd></div>
      <div><dt>新增提交</dt><dd>{diff.addedCount}{diff.removedCount > 0 ? ` · 丢掉 ${diff.removedCount} 个` : ''}</dd></div>
      <div><dt>子模块内改动</dt><dd>{diff.dirtyFiles > 0 ? `${diff.dirtyFiles} 个文件未提交` : '工作区干净'}</dd></div>
      <div><dt>地址</dt><dd title={diff.url}><code>{diff.url || '未登记地址'}</code></dd></div>
    </dl>
    <div className="branch-dialog-hint">{lines.map((line) => <p key={line}>{line}</p>)}</div>
    {commits.shown.length > 0 && <div className="structure-list">
      {commits.shown.map((commit) => <div className="tag-row" key={commit.hash} title={commit.hash}>
        <span><GitCommitHorizontal size={14}/></span>
        <span><strong>{commit.title}</strong><small>{commit.shortHash} · {commit.author} · {commit.commitTime}</small></span>
      </div>)}
      {commits.hidden > 0 && <div className="tag-row"><span/><span><small>另有 {commits.hidden} 个提交未列出（后端同样有上限保护）</small></span></div>}
    </div>}
    {diff.warnings.length > 0 && <div className="structure-list">
      {diff.warnings.map((warning) => <div className="tag-row" key={warning}>
        <span><AlertTriangle size={14}/></span>
        <span><small>{warning}</small></span>
      </div>)}
    </div>}
    <div className="structure-actions">
      <Button variant="secondary" disabled={busy} onClick={() => { void load().then((ok) => { if (ok) onNotice('已重新读取 Submodule 差异') }) }}>
        <RefreshCw size={14} className={busy ? 'spin' : ''}/>{busy ? '读取中…' : '刷新差异'}
      </Button>
    </div>
  </article>
}
