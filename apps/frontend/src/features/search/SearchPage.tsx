import { useI18n } from '../../i18n'
import { useState } from 'react'
import { ScanText, ScrollText } from 'lucide-react'
import type { RepositorySnapshot } from '../../repository'
import { useSearchRunner } from './useSearchRunner'
import { DeepSearchPanel } from './DeepSearchPanel'
import { TextSearchPanel } from './TextSearchPanel'
import './search.css'

type SearchPageProps = {
  repository: RepositorySnapshot | null
  onSnapshot: (snapshot: RepositorySnapshot) => void
  onNotice: (message: string) => void
  /** 点击历史搜索结果后交给历史视图定位；没有接入时面板仍可独立使用。 */
  onSelectCommit?: (hash: string) => void
}

type SearchTab = 'history' | 'text'

/** 深度搜索入口：历史深度搜索（后端驱动）与仓库全文搜索/替换两个页签。 */
export function SearchPage({ repository, onSnapshot, onNotice, onSelectCommit }: SearchPageProps) {
  const { t } = useI18n()
  const [tab, setTab] = useState<SearchTab>('history')
  // runner 以仓库路径为界：切仓库时自动作废旧请求并通知后端中止（见 useSearchRunner）。
  const runner = useSearchRunner(repository?.path ?? null)

  return <section className="workspace-page search-page">
    <div className="workspace-page-heading">
      <div>
        <span className="eyebrow">{t('search.deepSearch')}</span>
        <h2>{t('search.page.title')}</h2>
        <p>{t('search.page.description')}</p>
      </div>
    </div>
    <div className="search-tabs">
      <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}><ScrollText size={14}/><span>{t('search.page.historyTab')}</span></button>
      <button className={tab === 'text' ? 'active' : ''} onClick={() => setTab('text')}><ScanText size={14}/><span>{t('search.page.textTab')}</span></button>
      <span className="tab-spacer"/>
      <small>{t('search.page.singleRunNote')}</small>
    </div>
    {!repository && <p className="search-empty">{t('search.page.pickRepository')}</p>}
    {repository && tab === 'history' && <DeepSearchPanel runner={runner} onSelectCommit={onSelectCommit ?? (() => {})} />}
    {repository && tab === 'text' && <TextSearchPanel runner={runner} repository={repository} onSnapshot={onSnapshot} onNotice={onNotice} />}
  </section>
}
