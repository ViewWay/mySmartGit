import { useEffect, useState } from 'react'
import { AlertTriangle, Box, Check, Code2, FileText, FolderGit2, GitBranch, Globe, RefreshCw, Star } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '../../components/Button'
import { loadRepositoryDetails, loadRepositoryReadme, type RepositoryDetails, type RepositoryReadme } from '../../repository'
import { useI18n } from '../../i18n'
import type { CatalogRepository } from './repositoryCatalog'

type DetailTab = 'branches' | 'submodules' | 'remotes' | 'readme'
type Translate = (key: string, params?: Record<string, string | number>) => string
const statusKeys: Record<string, string> = { ok: 'repository.details.statusOk', modified: 'repository.details.statusModified', uninitialized: 'repository.details.statusUninitialized', missing: 'repository.details.statusMissing' }

export function RepositoryDetailsPanel({ item, opening, onOpen, onVscode, onToggleFavorite }: {
  item: CatalogRepository
  opening: boolean
  onOpen: (path: string) => void
  onVscode: (path: string) => void
  onToggleFavorite: (item: CatalogRepository) => void
}) {
  const { t } = useI18n()
  const statusLabels = (status: string) => t(statusKeys[status] ?? 'repository.details.statusUnknown')
  const [tab, setTab] = useState<DetailTab>('branches')
  const [details, setDetails] = useState<RepositoryDetails | null>(null)
  const [readme, setReadme] = useState<RepositoryReadme | null | undefined>(undefined)
  const [error, setError] = useState('')
  const [readmeError, setReadmeError] = useState('')
  const [version, setVersion] = useState(0)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setDetails(null)
    setReadme(undefined)
    setReadmeError('')
    void loadRepositoryDetails(item.path).then((value) => { if (!cancelled) setDetails(value) })
      .catch((error) => { if (!cancelled) setError(String(error)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [item.path, version])

  useEffect(() => {
    if (tab !== 'readme' || !details || readme !== undefined) return
    let cancelled = false
    void loadRepositoryReadme(item.path).then((value) => { if (!cancelled) setReadme(value) })
      .catch((error) => { if (!cancelled) setReadmeError(String(error)) })
    return () => { cancelled = true }
  }, [details, item.path, readme, tab])

  const tabs = [
    { id: 'branches', label: t('repository.branch.title'), icon: GitBranch, count: details ? details.branches.length + details.remoteBranches.length : undefined },
    { id: 'submodules', label: 'Submodule', icon: Box, count: details?.submodules.length },
    { id: 'remotes', label: t('repository.branch.remote'), icon: Globe, count: details?.remotes.length },
    { id: 'readme', label: 'README', icon: FileText },
  ] as const

  return <aside className="repository-details" aria-label={t('repository.details.aria')}>
    <header className="repository-detail-heading"><span className="repository-detail-icon"><FolderGit2 size={23}/></span><div><h2>{item.name}</h2><p title={item.path}>{item.path}</p></div><Button variant="icon" title={item.favorite ? t('repository.details.unfavorite') : t('repository.details.favorite')} aria-pressed={item.favorite} onClick={() => onToggleFavorite(item)}><Star size={17} fill={item.favorite ? 'currentColor' : 'none'}/></Button><Button variant="icon" title={t('repository.details.refresh')} disabled={loading} onClick={() => setVersion((value) => value + 1)}><RefreshCw size={16} className={loading ? 'spin' : ''}/></Button></header>
    <div className="repository-detail-actions"><Button variant="primary" disabled={opening || loading || Boolean(error)} onClick={() => onOpen(item.path)}><FolderOpenIcon/>{item.current ? t('repository.details.backToCurrent') : t('repository.details.open')}</Button><Button variant="secondary" onClick={() => onVscode(item.path)}><Code2 size={14}/>{t('repository.details.openInVscode')}</Button>{details && <span className="repository-branch-chip"><GitBranch size={13}/>{details.branch || t('repository.details.noCommits')}</span>}</div>
    <div className="repository-detail-tabs" role="tablist" aria-label={t('repository.details.infoAria')}>{tabs.map(({ id, label, icon: Icon, ...rest }) => <button key={id} role="tab" id={`repository-tab-${id}`} aria-selected={tab === id} aria-controls="repository-detail-content" onClick={() => setTab(id)}><Icon size={14}/>{label}{'count' in rest && rest.count !== undefined && <small>{rest.count}</small>}</button>)}</div>
    <div className="repository-detail-content" id="repository-detail-content" role="tabpanel" aria-labelledby={`repository-tab-${tab}`}>
      {loading ? <div className="repository-detail-empty" role="status"><RefreshCw size={23} className="spin"/><span>{t('repository.details.loading')}</span></div> : error ? <div className="repository-detail-empty"><AlertTriangle size={24}/><strong>{t('repository.details.loadFailed')}</strong><p role="alert">{error}</p><Button onClick={() => setVersion((value) => value + 1)}>{t('repository.details.retry')}</Button></div> : details && <>
        {tab === 'branches' && <>{[[t('repository.details.localBranches'), details.branches], [t('repository.details.remoteBranches'), details.remoteBranches]].map(([label, values]) => <section className="repository-info-section" key={label as string}><h3>{label as string}<small>{(values as string[]).length}</small></h3>{(values as string[]).length ? (values as string[]).map((branch) => <div className="repository-info-row" key={branch}><GitBranch size={14}/><code>{branch}</code>{branch === details.branch && <span className="repository-state-badge"><Check size={11}/>{t('repository.details.current')}</span>}</div>) : <p className="repository-info-empty">{t('repository.details.noneYet', { label: label as string })}</p>}</section>)}</>}
        {tab === 'submodules' && (details.submodules.length ? details.submodules.map((module) => <div className="repository-module-card" key={module.path}><div><Box size={15}/><strong>{module.path}</strong><span className={`repository-state-badge ${module.status === 'ok' ? '' : 'warning'}`}>{statusLabels(module.status)}</span></div><p><code>{module.hash.slice(0, 12)}</code>{module.branch && <span><GitBranch size={12}/>{module.branch}</span>}</p></div>) : <div className="repository-detail-empty"><Box size={26}/><strong>{t('repository.details.noSubmodules')}</strong><span>{t('repository.details.noSubmodulesHint')}</span></div>)}
        {tab === 'remotes' && (details.remotes.length ? details.remotes.map((remote) => <section className="repository-remote-card" key={remote.name}><h3><Globe size={15}/>{remote.name}</h3>{[['Fetch', remote.fetchUrls], ['Push', remote.pushUrls]].map(([label, urls]) => <div key={label as string}><span>{label as string}</span><section>{(urls as string[]).map((url) => <code key={url}>{url}</code>)}</section></div>)}</section>) : <div className="repository-detail-empty"><Globe size={26}/><strong>{t('repository.details.noRemotes')}</strong><span>{t('repository.details.noRemotesHint')}</span></div>)}
        {tab === 'readme' && (readmeError ? <p className="repository-inline-error" role="alert">{readmeError}</p> : readme === undefined ? <div className="repository-detail-empty" role="status"><RefreshCw size={22} className="spin"/>{t('repository.details.loadingReadme')}</div> : readme === null ? <div className="repository-detail-empty"><FileText size={26}/><strong>{t('repository.details.noReadme')}</strong><span>{t('repository.details.noReadmeHint')}</span></div> : <><div className="repository-readme-name"><FileText size={13}/>{readme.name}{readme.truncated && <span>{t('repository.details.readmeTruncated')}</span>}</div>{/\.(md|markdown|mdx)$/i.test(readme.name) ? <article className="repository-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ href, children }) => href && /^https?:\/\//i.test(href) ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>, img: ({ alt }) => <span className="repository-readme-image">{alt ? t('repository.details.imageAlt', { alt }) : t('repository.details.image')}</span> }}>{readme.content}</ReactMarkdown></article> : <pre className="repository-readme-text">{readme.content}</pre>}</>)}
      </>}
    </div>
  </aside>
}

function FolderOpenIcon() { return <FolderGit2 size={14}/> }
