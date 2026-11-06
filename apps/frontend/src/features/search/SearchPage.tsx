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
  const [tab, setTab] = useState<SearchTab>('history')
  // runner 以仓库路径为界：切仓库时自动作废旧请求并通知后端中止（见 useSearchRunner）。
  const runner = useSearchRunner(repository?.path ?? null)

  return <section className="workspace-page search-page">
    <div className="workspace-page-heading">
      <div>
        <span className="eyebrow">深度搜索</span>
        <h2>全量历史搜索与仓库内容替换</h2>
        <p>历史搜索由后端驱动，直接扫描仓库全部提交，不受提交图谱已加载条数的限制；差异内容搜索区分 pickaxe（-S，出现次数增减）与逐行正则（-G）两种语义。全文搜索走 git grep，替换默认只预览，确认后才写盘，并且整体备份、可撤销。</p>
      </div>
    </div>
    <div className="search-tabs">
      <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}><ScrollText size={14}/><span>历史深度搜索</span></button>
      <button className={tab === 'text' ? 'active' : ''} onClick={() => setTab('text')}><ScanText size={14}/><span>全文搜索与替换</span></button>
      <span className="tab-spacer"/>
      <small>搜索是重查询：同一仓库同一类型只跑一个，发起新搜索或切换仓库会中止旧任务。</small>
    </div>
    {!repository && <p className="search-empty">请先在左侧选择仓库。</p>}
    {repository && tab === 'history' && <DeepSearchPanel runner={runner} onSelectCommit={onSelectCommit ?? (() => {})} />}
    {repository && tab === 'text' && <TextSearchPanel runner={runner} repository={repository} onSnapshot={onSnapshot} onNotice={onNotice} />}
  </section>
}
