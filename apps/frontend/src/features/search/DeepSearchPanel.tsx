import { useI18n } from '../../i18n'
import { useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2, Search, ShieldAlert } from 'lucide-react'
import { Button } from '../../components/Button'
import type { CommitSearchTarget } from '../../repository'
import {
  COMMIT_PAGE_SIZE,
  commitTargetHint,
  commitTargetLabel,
  buildCommitSearchQuery,
  currentPage,
  defaultCommitSearchForm,
  goLastPage,
  goNextPage,
  goPrevPage,
  matchPosition,
  rangeLabel,
  regexSwitchLabel,
  resultBanner,
  totalLabel,
  totalPages,
  validatePattern,
  type CommitSearchForm,
} from './searchModel'
import type { useSearchRunner } from './useSearchRunner'

type Runner = ReturnType<typeof useSearchRunner>

type DeepSearchPanelProps = {
  runner: Runner
  /** 点击结果时交回给历史视图：由 App.tsx 决定是切分支还是只定位。 */
  onSelectCommit: (hash: string) => void
}

const TARGETS: CommitSearchTarget[] = ['commitMessage', 'commitAuthor', 'commitHash', 'diffPickaxe', 'diffRegex']

/** 历史深度搜索面板：后端驱动、全量历史、分页 + 「第 N/M 个」。 */
export function DeepSearchPanel({ runner, onSelectCommit }: DeepSearchPanelProps) {
  const { t } = useI18n()
  const [form, setForm] = useState<CommitSearchForm>(defaultCommitSearchForm)
  const [submitted, setSubmitted] = useState<CommitSearchForm | null>(null)
  const [invalid, setInvalid] = useState<string | null>(null)
  const page = runner.commitPage
  const banner = page ? resultBanner(page, t) : null

  const patch = (changes: Partial<CommitSearchForm>) => setForm((current) => ({ ...current, ...changes }))

  const submit = async (offset = 0) => {
    const invalid = validatePattern(form.pattern, t)
    setInvalid(invalid)
    if (invalid) return
    setSubmitted(form)
    await runner.runCommitSearch(buildCommitSearchQuery(form, offset))
  }

  const cursor = page
    ? { offset: page.offset, pageSize: page.pageSize || COMMIT_PAGE_SIZE, total: page.total }
    : null
  const pages = cursor ? totalPages(cursor) : 0

  return <section className="search-panel">
    <div className="search-form">
      <label className="search-field search-field-grow">
        <span>{t('search.keyword')}</span>
        <input
          value={form.pattern}
          placeholder={form.target === 'commitHash' ? t('search.hashPlaceholder') : t('search.historyPlaceholder')}
          onChange={(event) => patch({ pattern: event.target.value })}
          onKeyDown={(event) => { if (event.key === 'Enter') void submit(0) }}
        />
      </label>
      <label className="search-field">
        <span>{t('search.searchScope')}</span>
        <select value={form.target} onChange={(event) => patch({ target: event.target.value as CommitSearchTarget })}>
          {TARGETS.map((target) => <option key={target} value={target}>{commitTargetLabel(target, t)}</option>)}
        </select>
      </label>
      <Button variant="primary" disabled={runner.busy || !form.pattern.trim()} onClick={() => void submit(0)}>
        {runner.busy ? <Loader2 size={14} className="spin" /> : <Search size={14} />}{t('search.deepSearch')}
      </Button>
      {runner.busy && <Button variant="secondary" onClick={() => void runner.stop()}>{t('search.abort')}</Button>}
    </div>

    <p className="search-target-hint">{commitTargetHint(form.target, t)}</p>

    <div className="search-options">
      <label><input type="checkbox" checked={form.caseSensitive} onChange={(event) => patch({ caseSensitive: event.target.checked })}/><span>{t('search.caseSensitive')}</span></label>
      <label><input type="checkbox" checked={form.wholeWord} onChange={(event) => patch({ wholeWord: event.target.checked })}/><span>{t('search.wholeWord')}</span></label>
      <label><input type="checkbox" checked={form.regex} onChange={(event) => patch({ regex: event.target.checked })}/><span>{regexSwitchLabel(form.target, t)}</span></label>
    </div>

    <details className="search-scope">
      <summary>{t('search.limitBranchesAndPaths')}</summary>
      <div className="search-form search-form-stacked">
        <label className="search-field">
          <span>{t('search.branchScopePlaceholder')}</span>
          <input value={form.revisions} placeholder="main, release/2.x..HEAD" onChange={(event) => patch({ revisions: event.target.value })}/>
        </label>
        <label className="search-field">
          <span>{t('search.searchIncludePaths')}</span>
          <textarea rows={2} value={form.paths} placeholder={'apps/desktop/**\nREADME.md'} onChange={(event) => patch({ paths: event.target.value })}/>
        </label>
        <label className="search-field">
          <span>{t('search.excludePaths')}</span>
          <textarea rows={2} value={form.excludePaths} placeholder="node_modules/**" onChange={(event) => patch({ excludePaths: event.target.value })}/>
        </label>
        <label className="search-field">
          <span>{t('search.scanLimit')}</span>
          <input
            type="number"
            min={1}
            value={form.maxCommits ?? ''}
            onChange={(event) => patch({ maxCommits: event.target.value ? Number(event.target.value) : null })}
          />
        </label>
      </div>
    </details>

    {!submitted && !form.pattern.trim() && <p className="search-empty">{t('search.deepIdleHint')}</p>}
    {invalid && <p className="search-error">{invalid}</p>}
    {runner.error && <p className="search-error">{runner.error}</p>}

    {page && cursor && <div className="search-results">
      <header className="search-results-header">
        <span>{submitted?.pattern ?? page.pattern}｜{commitTargetLabel(page.target, t)}｜{totalLabel(page, t)}</span>
        <span className="search-pager">
          <Button size="compact" variant="icon" disabled={cursor.offset <= 0} onClick={() => void runner.loadCommitPage(page.searchId, goPrevPage(cursor), cursor.pageSize)}><ChevronLeft size={14}/></Button>
          <span>{pages ? `${currentPage(cursor)} / ${pages}` : '0 / 0'}</span>
          <span>{rangeLabel(cursor, page.items.length, t)}</span>
          <Button size="compact" variant="icon" disabled={!page.hasMore} onClick={() => void runner.loadCommitPage(page.searchId, goNextPage(cursor), cursor.pageSize)}><ChevronRight size={14}/></Button>
          <Button size="compact" variant="secondary" disabled={pages <= 1} onClick={() => void runner.loadCommitPage(page.searchId, goLastPage(cursor), cursor.pageSize)}>{t('search.lastPage')}</Button>
        </span>
      </header>

      {banner && <p className="search-banner"><ShieldAlert size={13}/>{banner}</p>}

      {page.items.length === 0 && !banner && <p className="search-empty">{t('search.noCommitHits')}</p>}
      <ul className="search-list">
        {page.items.map((item, index) => {
          const position = matchPosition(page.total, page.offset, index)
          return <li key={item.hash}>
            <button className="search-item" onClick={() => onSelectCommit(item.hash)}>
              <span className="search-item-index">{position ? `第 ${position.current}/${position.total} 个` : ''}</span>
              <code>{item.shortHash}</code>
              <span className="search-item-title">{item.title}</span>
              <span className="search-item-meta">{item.author}·{item.date}</span>
              {item.refs.length > 0 && <span className="search-item-refs">{item.refs.join(' ')}</span>}
            </button>
          </li>
        })}
      </ul>
    </div>}
  </section>
}
