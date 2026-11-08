import { useMemo, useState } from 'react'
import { ArrowLeft, ChevronRight, Clock3, CloudDownload, Code2, FolderGit2, FolderOpen, FolderSearch, GitBranch, Moon, Plus, RefreshCw, Search, Star, Sun, Trash2, X } from 'lucide-react'
import { Button } from '../../components/Button'
import { loadRepositoryDetails, openRepositoryInVscode, pickRepositoryDirectory, type RepositoryDetails } from '../../repository'
import { useI18n } from '../../i18n'
import { AddRepositoryDialog } from './AddRepositoryDialog'
import { RepositoryDetailsPanel } from './RepositoryDetailsPanel'
import { ScanRepositoriesDialog } from './ScanRepositoriesDialog'
import { repositoryCatalog } from './repositoryCatalog'
import { repositoryCacheKey, sameRepositoryPath } from './repositoryPaths'
import type { RecentRepository } from './repositoryPersistence'
import type { FavoriteRepository } from './repositorySwitcher'

export function RepositoryManagerPage({ recent, favorites, current, opening, theme, onToggleTheme, onBack, onOpen, onRegister, onToggleFavorite, onForget, onNotice }: {
  recent: RecentRepository[]
  favorites: FavoriteRepository[]
  current: Pick<RecentRepository, 'name' | 'path' | 'branch'> | null
  opening: boolean
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  onBack: () => void
  onOpen: (path: string) => void
  onRegister: (repository: RepositoryDetails) => void
  onToggleFavorite: (repository: FavoriteRepository) => void
  onForget: (path: string) => void
  onNotice: (message: string) => void
}) {
  const { t, formatDate } = useI18n()
  const [query, setQuery] = useState('')
  const [selectedPath, setSelectedPath] = useState(current?.path ?? recent[0]?.path ?? favorites[0]?.path ?? '')
  const [adding, setAdding] = useState(false)
  const [dialog, setDialog] = useState<'clone' | 'init' | 'scan' | null>(null)
  const catalog = useMemo(() => repositoryCatalog(recent, favorites, current), [recent, favorites, current])
  const registeredKeys = useMemo(() => new Set(catalog.map((item) => repositoryCacheKey(item.path))), [catalog])
  const filtered = catalog.filter((item) => `${item.name}\n${item.path}`.replace(/\\/g, '/').toLocaleLowerCase().includes(query.trim().replace(/\\/g, '/').toLocaleLowerCase()))
  const selected = filtered.find((item) => sameRepositoryPath(item.path, selectedPath)) ?? filtered[0]
  const groups = [
    { label: t('repository.manager.groupCurrent'), icon: FolderGit2, entries: filtered.filter((item) => item.current) },
    { label: t('repository.manager.groupFavorites'), icon: Star, entries: filtered.filter((item) => item.favorite && !item.current) },
    { label: t('repository.manager.groupRecent'), icon: Clock3, entries: filtered.filter((item) => !item.favorite && !item.current).sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0)) },
  ]
  const register = (repository: RepositoryDetails) => {
    onRegister(repository)
    setQuery('')
    setSelectedPath(repository.path)
    setDialog(null)
  }
  const browse = async () => {
    if (adding) return
    setAdding(true)
    try {
      const path = await pickRepositoryDirectory(t('repository.manager.pickLocalTitle'))
      if (path) register(await loadRepositoryDetails(path))
    } catch (error) { onNotice(String(error)) }
    finally { setAdding(false) }
  }
  const openVscode = async (path: string) => {
    try { await openRepositoryInVscode(path) }
    catch (error) { onNotice(String(error)) }
  }
  const initialParent = (selected?.path ?? current?.path ?? '').replace(/[\\/][^\\/]+[\\/]*$/, '')
  const hasRepositories = catalog.length > 0

  return <section className="repository-manager" aria-label={t('nav.repositories')}>
    {hasRepositories && <header className="repository-manager-heading">
      <div className="repository-manager-title">{current && <Button variant="icon" title={t('repository.manager.backToWorkspace')} onClick={onBack}><ArrowLeft size={18}/></Button>}<FolderGit2 size={23}/><div><h1>{t('nav.repositories')}</h1><p>{t('repository.manager.subtitle')}</p></div></div>
      <div className="repository-manager-toolbar">{hasRepositories && <><Button variant="primary" onClick={() => void browse()} disabled={adding || opening}>{adding ? <RefreshCw size={15} className="spin"/> : <FolderOpen size={15}/>}{t('repository.manager.pickLocal')}</Button><Button onClick={() => setDialog('scan')} disabled={adding || opening}><FolderSearch size={15}/>{t('repository.manager.scan')}</Button><Button onClick={() => setDialog('clone')} disabled={adding || opening}><CloudDownload size={15}/>{t('repository.add.clone')}</Button><Button onClick={() => setDialog('init')} disabled={adding || opening}><Plus size={15}/>{t('repository.add.initTitle')}</Button></>}<Button variant="icon" title={theme === 'dark' ? t('shell.themeToLight') : t('shell.themeToDark')} onClick={onToggleTheme}>{theme === 'dark' ? <Sun size={17}/> : <Moon size={17}/>}</Button></div>
    </header>}
    {hasRepositories ? <div className="repository-manager-body">
      <div className="repository-catalog">
        <div className="repository-catalog-search"><Search size={15}/><input aria-label={t('repository.manager.searchRepositories')} placeholder={t('repository.manager.searchPlaceholder')} value={query} onChange={(event) => setQuery(event.target.value)}/>{query && <Button variant="icon" title={t('repository.manager.clearSearch')} onClick={() => setQuery('')}><X size={13}/></Button>}<span>{filtered.length}</span></div>
        <div className="repository-catalog-list">
          {groups.filter(({ entries }) => entries.length > 0 || (query && filtered.length === 0)).map(({ label, icon: Icon, entries }) => <section className="repository-catalog-group" key={label} aria-label={label}><h2><Icon size={13}/>{label}<small>{entries.length}</small></h2>{entries.map((item) => <div className={`repository-catalog-row ${selected && sameRepositoryPath(item.path, selected.path) ? 'selected' : ''}`} key={repositoryCacheKey(item.path)}>
            <button className="repository-catalog-select" aria-pressed={Boolean(selected && sameRepositoryPath(item.path, selected.path))} onClick={() => setSelectedPath(item.path)} onDoubleClick={() => { if (!opening) onOpen(item.path) }}><span className="repository-catalog-icon"><FolderGit2 size={18}/></span><span><strong><span className="repository-catalog-name" title={item.name}>{item.name}</span>{item.current && <small>{t('repository.manager.inUse')}</small>}</strong><span className="repository-catalog-path" title={item.path}>{item.path}</span><span className="repository-catalog-meta">{item.branch && <span><GitBranch size={11}/><span className="repository-catalog-branch" title={item.branch}>{item.branch}</span></span>}{item.openedAt && <time dateTime={new Date(item.openedAt).toISOString()}>{formatDate(item.openedAt, { year: 'numeric', month: 'short', day: 'numeric' })}</time>}</span></span></button>
            <div className="repository-catalog-actions"><Button variant="icon" title={t(item.favorite ? 'repository.manager.unfavorite' : 'repository.manager.favorite', { name: item.name })} aria-pressed={item.favorite} onClick={() => onToggleFavorite(item)}><Star size={14} fill={item.favorite ? 'currentColor' : 'none'}/></Button><Button variant="icon" title={t('repository.manager.openInVscode', { name: item.name })} onClick={() => void openVscode(item.path)}><Code2 size={14}/></Button><Button variant="icon" title={t('repository.manager.forgetTitle', { name: item.name })} onClick={() => { onForget(item.path); onNotice(t('repository.manager.forgotten')) }}><Trash2 size={14}/></Button><Button variant="icon" title={t('repository.manager.openTitle', { name: item.name })} disabled={opening} onClick={() => onOpen(item.path)}><ChevronRight size={15}/></Button></div>
          </div>)}{entries.length === 0 && <p className="repository-group-empty">{label === t('repository.manager.groupCurrent') ? t('repository.manager.emptyCurrent') : label === t('repository.manager.groupFavorites') ? t('repository.manager.emptyFavorites') : t('repository.manager.emptyRecent')}</p>}</section>)}
          {query && filtered.length === 0 && <p className="repository-search-empty">{t('repository.manager.noSearchMatch')}</p>}
        </div>
        <footer className="repository-catalog-footer">{t('repository.manager.removeKeepsFiles')}</footer>
      </div>
      {selected ? <RepositoryDetailsPanel key={repositoryCacheKey(selected.path)} item={selected} opening={opening} onOpen={(path) => selected.current ? onBack() : onOpen(path)} onVscode={(path) => void openVscode(path)} onToggleFavorite={onToggleFavorite}/> : <div className="repository-manager-empty"><span><FolderGit2 size={38}/></span><h2>{query ? t('repository.manager.noSearchMatchTitle') : t('repository.manager.emptyTitle')}</h2><p>{query ? t('repository.manager.noSearchMatchHint') : t('repository.manager.emptyHint')}</p>{!query && <Button onClick={() => void browse()} disabled={adding}><FolderOpen size={15}/>{t('repository.manager.addFirst')}</Button>}</div>}
      </div> : <div className="repository-manager-welcome">
      <Button className="repository-welcome-theme" variant="icon" title={theme === 'dark' ? t('shell.themeToLight') : t('shell.themeToDark')} onClick={onToggleTheme}>{theme === 'dark' ? <Sun size={17}/> : <Moon size={17}/>}</Button>
      <div className="repository-welcome-hero">
        <div className="repository-welcome-brand"><img src="/app-icon.svg" alt="Branchline"/><span>BRANCHLINE</span></div>
        <p className="repository-welcome-kicker">{t('repository.manager.welcomeKicker')}</p>
        <h2>{t('repository.manager.welcomeTitle')}</h2>
        <p className="repository-welcome-copy">{t('repository.manager.welcomeCopy')}</p>
      </div>
      <div className="repository-start-actions" aria-label={t('repository.manager.startAria')}>
        <button className="repository-start-action primary" onClick={() => void browse()} disabled={adding || opening}>
          <span className="repository-start-icon"><FolderOpen size={20}/></span><span><strong>{t('repository.manager.openLocal')}</strong><small>{t('repository.manager.openLocalHint')}</small></span><ChevronRight size={17}/>
        </button>
        <button className="repository-start-action" onClick={() => setDialog('clone')} disabled={adding || opening}>
          <span className="repository-start-icon"><CloudDownload size={20}/></span><span><strong>{t('repository.manager.cloneRemote')}</strong><small>{t('repository.manager.cloneRemoteHint')}</small></span><ChevronRight size={17}/>
        </button>
        <button className="repository-start-action" onClick={() => setDialog('scan')} disabled={adding || opening}>
          <span className="repository-start-icon"><FolderSearch size={20}/></span><span><strong>{t('repository.manager.scan')}</strong><small>{t('repository.manager.scanHint')}</small></span><ChevronRight size={17}/>
        </button>
        <button className="repository-start-action" onClick={() => setDialog('init')} disabled={adding || opening}>
          <span className="repository-start-icon"><Plus size={20}/></span><span><strong>{t('repository.manager.initNew')}</strong><small>{t('repository.manager.initNewHint')}</small></span><ChevronRight size={17}/>
        </button>
      </div>
      <div className="repository-welcome-hint"><span>{t('repository.manager.favoriteHint')}</span><kbd>Ctrl P</kbd><span>{t('repository.manager.searchRepositories')}</span></div>
    </div>}
    {(dialog === 'clone' || dialog === 'init') && <AddRepositoryDialog mode={dialog} initialParent={initialParent} onClose={() => setDialog(null)} onCreated={register}/>}
    {dialog === 'scan' && <ScanRepositoriesDialog registeredKeys={registeredKeys} onClose={() => setDialog(null)} onRegister={register} onNotice={onNotice}/>}
  </section>
}
