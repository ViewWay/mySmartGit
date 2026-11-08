// ScanRepositoriesDialog：主动扫描文件夹里的 Git 仓库并批量添加。
// 流程：选目录 → scanGitRepositories → 结果列表（已注册的标记并默认不勾）→
// 勾选未注册项 →「添加所选」逐个 loadRepositoryDetails + onRegister（单个失败跳过）。
import { useEffect, useRef, useState } from 'react'
import { FolderGit2, FolderOpen, RefreshCw, Search, X } from 'lucide-react'
import { Button } from '../../components/Button'
import { loadRepositoryDetails, pickRepositoryDirectory, scanGitRepositories, type RepositoryDetails, type ScannedRepository } from '../../repository'
import { useI18n } from '../../i18n'
import { repositoryCacheKey } from './repositoryPaths'

type ScanRow = ScannedRepository & { registered: boolean; checked: boolean }

export function ScanRepositoriesDialog({ registeredKeys, onClose, onRegister, onNotice }: {
  /** 已注册仓库的 repositoryCacheKey 集合，用于标记扫描结果里已存在的项。 */
  registeredKeys: Set<string>
  onClose: () => void
  onRegister: (repository: RepositoryDetails) => void
  onNotice: (message: string) => void
}) {
  const { t } = useI18n()
  const [root, setRoot] = useState('')
  const [rows, setRows] = useState<ScanRow[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLElement>(null)

  // 用同一份「扫并填结果」逻辑服务两处入口：手动重扫与选完目录自动扫。
  const applyScan = (found: ScannedRepository[]) => setRows(found.map((repo) => ({
    ...repo,
    registered: registeredKeys.has(repositoryCacheKey(repo.path)),
    checked: !registeredKeys.has(repositoryCacheKey(repo.path)),
  })))

  const scanRoot = async (target: string) => {
    setScanning(true)
    setError('')
    try {
      applyScan(await scanGitRepositories(target.trim()))
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : String(scanError))
    } finally { setScanning(false) }
  }

  const runScan = () => { if (root.trim() && !scanning && !adding) void scanRoot(root) }

  const browse = async () => {
    try {
      const path = await pickRepositoryDirectory(t('repository.manager.scanPickTitle'))
      if (path) { setRoot(path); void scanRoot(path) }
    } catch (pickError) { setError(String(pickError)) }
  }

  const checkedCount = rows?.filter((row) => row.checked).length ?? 0
  const addSelected = async () => {
    if (!rows || checkedCount === 0 || adding) return
    setAdding(true)
    setError('')
    let added = 0
    let failed = 0
    try {
      for (const row of rows.filter((item) => item.checked)) {
        try {
          onRegister(await loadRepositoryDetails(row.path))
          added += 1
        } catch {
          // 单个失败跳过继续，最后汇总提示。
          failed += 1
        }
      }
    } finally {
      setAdding(false)
      if (failed > 0) onNotice(t('repository.manager.scanAddFailed', { count: failed }))
      if (added > 0) {
        onNotice(t('repository.manager.scanAdded', { count: added }))
        setRows(rows.map((row) => (row.checked ? { ...row, registered: true, checked: false } : row)))
      }
    }
  }

  const summary = rows
    ? rows.some((row) => !row.registered)
      ? t('repository.manager.scanSummary', { total: rows.length, fresh: rows.filter((row) => !row.registered).length })
      : t('repository.manager.scanSummaryAllRegistered', { total: rows.length })
    : ''

  return <div className="modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget && !adding) onClose() }}>
    <section ref={dialogRef} className="branch-dialog repository-add-dialog repository-scan-dialog" role="dialog" aria-modal="true" aria-labelledby="repository-scan-title">
      <div className="branch-dialog-heading"><span className="branch-dialog-icon"><Search size={19}/></span><div><h2 id="repository-scan-title">{t('repository.manager.scanTitle')}</h2><p>{t('repository.manager.scanHint')}</p></div><Button variant="icon" title={t('common.close')} disabled={adding} onClick={onClose}><X size={17}/></Button></div>
      <label>{t('repository.manager.scanRoot')}<span className="repository-directory-input"><input value={root} onChange={(event) => setRoot(event.target.value)} placeholder={t('repository.manager.scanRootPlaceholder')} spellCheck={false} disabled={scanning || adding}/><Button type="button" variant="secondary" onClick={() => void browse()} disabled={scanning || adding} title={t('repository.manager.scanPickTitle')}><FolderOpen size={15}/></Button></span></label>
      <div className="branch-dialog-actions">
        <Button variant="secondary" onClick={runScan} disabled={!root.trim() || scanning || adding}>{scanning ? <RefreshCw size={14} className="spin"/> : <Search size={14}/>}{t('repository.manager.scanRun')}</Button>
        <span className="repository-scan-spacer"/>
        <Button variant="primary" onClick={() => void addSelected()} disabled={!rows || checkedCount === 0 || scanning || adding}><FolderGit2 size={14}/>{t('repository.manager.scanAddSelected', { count: checkedCount })}</Button>
      </div>
      {error && <p className="repository-inline-error" role="alert">{error}</p>}
      {rows && <div className="repository-scan-results">
        <p className="repository-scan-summary">{summary}</p>
        {rows.length === 0 && <p className="repository-scan-empty">{t('repository.manager.scanEmpty')}</p>}
        {rows.map((row) => <label className="repository-scan-row" key={row.path}>
          <input type="checkbox" checked={row.checked} disabled={row.registered || adding} onChange={(event) => setRows(rows.map((item) => (item.path === row.path ? { ...item, checked: event.target.checked } : item)))}/>
          <span className="repository-scan-row-text"><strong>{row.name}</strong><code title={row.path}>{row.path}</code></span>
          {row.registered && <span className="repository-scan-badge">{t('repository.manager.scanRegistered')}</span>}
        </label>)}
      </div>}
    </section>
  </div>
}
