import { useI18n } from '../../i18n'
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, Download, FileArchive, HardDrive, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import type { ConfirmDialogOptions } from '../../components/ConfirmDialog'
import { Button } from '../../components/Button'
import {
  fetchLfsObjects,
  installLfs,
  listLfsFiles,
  loadLfsStatus,
  pruneLfsObjects,
  pullLfsObjects,
  trackLfsPattern,
  untrackLfsPattern,
  type LfsFilesPage,
  type LfsStatus,
} from '../../repository'
import {
  LFS_DEFAULT_LIMIT,
  formatLfsBytes,
  lfsActionConfirmation,
  lfsActionLabel,
  lfsActionRequiresConfirmation,
  lfsDownloadLabel,
  lfsFilesSummary,
  lfsOperationNotice,
  lfsStatusDescription,
  lfsStatusLabel,
  lfsStatusTone,
  shortLfsOid,
  validateLfsPattern,
  type LfsAction,
} from './lfsModel'

/**
 * Git LFS 面板（W3-4）。
 *
 * 只接收 repositoryPath 与回调，不依赖 App 全局状态：
 * - 状态区分「未安装 git-lfs / 仓库未启用 / 已就绪」，未安装时不伪造空列表；
 * - 跟踪模式增删后重新读取状态与文件列表，并通过 onChanged 通知父级刷新仓库快照；
 * - pull / prune 是危险操作：有注入的 confirm 时走统一确认框，否则退回 window.confirm；
 * - 文件列表的 truncated 由后端显式标记，界面如实提示，不伪装成完整结果。
 */
export type LfsPanelProps = {
  repositoryPath: string
  onNotice?: (message: string) => void
  confirm?: (options: ConfirmDialogOptions) => Promise<boolean>
  /** 安装 / 增删模式 / 拉取后可能改动工作区，通知父级刷新仓库快照。 */
  onChanged?: () => void
}

export function LfsPanel({ repositoryPath, onNotice, confirm, onChanged }: LfsPanelProps) {
  const { t } = useI18n()
  const [status, setStatus] = useState<LfsStatus | null>(null)
  const [files, setFiles] = useState<LfsFilesPage | null>(null)
  const [pattern, setPattern] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  const notify = useCallback((message: string) => onNotice?.(message), [onNotice])

  const reload = useCallback(async () => {
    if (!repositoryPath) return
    setLoading(true)
    setError('')
    try {
      const next = await loadLfsStatus(repositoryPath)
      setStatus(next)
      setFiles(next.available ? await listLfsFiles(repositoryPath, LFS_DEFAULT_LIMIT) : null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [repositoryPath])

  useEffect(() => {
    setStatus(null)
    setFiles(null)
    setPattern('')
    void reload()
  }, [reload])

  const ask = async (action: LfsAction): Promise<boolean> => {
    const options = lfsActionConfirmation(action, repositoryPath, t)
    if (confirm) return confirm(options)
    return window.confirm(`${options.title}\n\n${options.message}`)
  }

  const install = async () => {
    setBusy('install')
    setError('')
    try {
      setStatus(await installLfs(repositoryPath))
      notify(t('lfs.installedNotice'))
      onChanged?.()
      await reload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

  const addPattern = async () => {
    const invalid = validateLfsPattern(pattern, t)
    if (invalid) {
      setError(invalid)
      return
    }
    setBusy('track')
    setError('')
    try {
      const next = await trackLfsPattern(repositoryPath, pattern.trim())
      setStatus(next)
      setPattern('')
      notify(t('lfs.patternAdded', { pattern: pattern.trim() }))
      onChanged?.()
      await reload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

  const removePattern = async (value: string) => {
    setBusy(`untrack:${value}`)
    setError('')
    try {
      setStatus(await untrackLfsPattern(repositoryPath, value))
      notify(t('lfs.patternRemoved', { pattern: value }))
      onChanged?.()
      await reload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

  const runOperation = async (action: LfsAction) => {
    if (lfsActionRequiresConfirmation(action) && !(await ask(action))) {
      notify(t('lfs.notApplied'))
      return
    }
    setBusy(action)
    setError('')
    try {
      const report = action === 'fetch'
        ? await fetchLfsObjects(repositoryPath)
        : action === 'pull'
          ? await pullLfsObjects(repositoryPath)
          : await pruneLfsObjects(repositoryPath)
      notify(lfsOperationNotice(report, t))
      await reload()
      onChanged?.()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

  if (!repositoryPath) {
    return <section className="workspace-empty"><HardDrive size={34}/><strong>Git LFS</strong><span>{t('lfs.requiresRepository')}</span></section>
  }

  const tone = lfsStatusTone(status)
  const disabled = loading || busy !== null

  return <section className="structure-panel workspace-page lfs-panel">
    <div className="workspace-page-heading">
      <div>
        <span className="eyebrow">{t('lfs.panelTitle')}</span>
        <h2>Git LFS</h2>
        <p>{lfsStatusDescription(status, t)}</p>
      </div>
      <div className="structure-actions">
        <Button variant="secondary" disabled={disabled} onClick={() => void reload()}><RefreshCw size={14} className={loading ? 'spin' : ''}/>{loading ? t('lfs.loading') : t('repository.tag.refresh')}</Button>
        <Button variant="primary" disabled={disabled || !status?.available || status.installedLocally} onClick={() => void install()}>
          <Download size={14}/>{busy === 'install' ? t('lfs.installing') : status?.installedLocally ? t('lfs.installedHere') : t('lfs.installHere')}
        </Button>
      </div>
    </div>

    <div className={`lfs-status-card lfs-status-${tone}`}>
      <span className="lfs-status-badge">{tone === 'unavailable' ? <AlertTriangle size={15}/> : <Check size={15}/>}{lfsStatusLabel(status, t)}</span>
      <dl>
        <div><dt>{t('lfs.versionLabel')}</dt><dd>{status?.version ?? t('lfs.versionUnavailable')}</dd></div>
        <div><dt>{t('lfs.localInstall')}</dt><dd>{status?.installedLocally ? t('lfs.enabled') : t('lfs.disabled')}</dd></div>
        <div><dt>{t('lfs.patternLabel')}</dt><dd>{status?.patterns.length ?? 0}</dd></div>
        <div><dt>{t('lfs.trackedFiles')}</dt><dd>{status?.trackedFileCount ?? 0}</dd></div>
      </dl>
      {status?.notice && <p className="lfs-status-notice"><AlertTriangle size={14}/>{status.notice}</p>}
    </div>

    {error && <div className="lfs-error" role="alert"><AlertTriangle size={14}/><span>{error}</span><Button variant="icon" onClick={() => setError('')} title={t('common.close')}><X size={14}/></Button></div>}

    <div className="lfs-grid">
      <article className="structure-detail-card">
        <h3><FileArchive size={15}/>{t('lfs.patternLabel')}</h3>
        <p className="lfs-card-hint">{t('lfs.patternNote')}</p>
        <div className="lfs-pattern-input">
          <input
            value={pattern}
            placeholder={t('lfs.patternPlaceholder')}
            spellCheck={false}
            disabled={disabled || !status?.available}
            onChange={(event) => setPattern(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void addPattern() }}
          />
          <Button variant="primary" disabled={disabled || !status?.available} onClick={() => void addPattern()}><Plus size={14}/>{busy === 'track' ? t('lfs.adding') : t('lfs.add')}</Button>
        </div>
        {(status?.patterns.length ?? 0) === 0
          ? <p className="lfs-empty">{t('lfs.noPatterns')}</p>
          : <ul className="lfs-pattern-list">
            {status?.patterns.map((value) => <li key={value}>
              <code>{value}</code>
              <Button variant="icon" title={t('lfs.removePattern', { pattern: value })} disabled={disabled} onClick={() => void removePattern(value)}><Trash2 size={13}/></Button>
            </li>)}
          </ul>}
      </article>

      <article className="structure-detail-card">
        <h3><HardDrive size={15}/>{t('lfs.actionsTitle')}</h3>
        <p className="lfs-card-hint">{t('lfs.actionsNote')}</p>
        <div className="lfs-operation-actions">
          <Button variant="secondary" disabled={disabled || !status?.available} onClick={() => void runOperation('fetch')}><Download size={14}/>{busy === 'fetch' ? t('lfs.fetching') : t('lfs.fetchAction')}</Button>
          <Button variant="secondary" disabled={disabled || !status?.available} onClick={() => void runOperation('pull')}><RefreshCw size={14}/>{busy === 'pull' ? t('lfs.pulling') : t('lfs.pullAction')}</Button>
          <Button variant="danger" disabled={disabled || !status?.available} onClick={() => void runOperation('prune')}><Trash2 size={14}/>{busy === 'prune' ? t('lfs.pruning') : t('lfs.pruneAction')}</Button>
        </div>
        <p className="lfs-action-labels">{(['fetch', 'pull', 'prune'] as LfsAction[]).map((action) => lfsActionLabel(action, t)).join(' · ')}</p>
      </article>
    </div>

    <article className="structure-detail-card lfs-files-card">
      <h3><FileArchive size={15}/>{t('lfs.filesTitle')}</h3>
      <p className="lfs-card-hint">{lfsFilesSummary(files, t)}</p>
      {files?.truncated && <p className="lfs-truncated"><AlertTriangle size={14}/>{t('lfs.truncatedPrefix')} {files.files.length} {t('lfs.truncatedSuffix')}</p>}
      {files && files.files.length > 0 && <div className="lfs-file-table-wrap">
        <table className="lfs-file-table">
          <thead><tr><th>{t('lfs.path')}</th><th>{t('lfs.size')}</th><th>OID</th><th>{t('lfs.status')}</th></tr></thead>
          <tbody>
            {files.files.map((file) => <tr key={`${file.oid}:${file.path}`}>
              <td title={file.path}>{file.path}</td>
              <td>{formatLfsBytes(file.size)}</td>
              <td><code>{shortLfsOid(file.oid)}</code></td>
              <td><span className={file.downloaded ? 'lfs-downloaded' : 'lfs-pointer'}>{lfsDownloadLabel(file, t)}</span></td>
            </tr>)}
          </tbody>
        </table>
      </div>}
    </article>
  </section>
}
