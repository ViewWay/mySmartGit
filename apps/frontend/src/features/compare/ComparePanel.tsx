import { useI18n } from '../../i18n'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Check, ChevronDown, GitBranch, GitCompareArrows, Play, RefreshCw, Search } from 'lucide-react'
import { compareRepositoryRefs, loadRepositoryCompareFileDiff, type RepositoryComparison, type RepositorySnapshot } from '../../repository'
import { DiffPanel } from '../diff/DiffPanel'
import { Button } from '../../components/Button'

type ReferenceSelectProps = {
  label: string
  value: string
  references: string[]
  localBranches: string[]
  remoteBranches: string[]
  onChange: (reference: string) => void
}

function ReferenceSelect({ label, value, references, localBranches, remoteBranches, onChange }: ReferenceSelectProps) {
  const [open, setOpen] = useState(false)
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleReferences = references.filter((reference) => reference.toLocaleLowerCase().includes(normalizedQuery))
  const canUseQuery = Boolean(query.trim()) && !references.some((reference) => reference.toLocaleLowerCase() === normalizedQuery)

  useEffect(() => {
    if (!open) return
    const closeWhenOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeWhenOutside)
    window.addEventListener('keydown', closeOnEscape)
    requestAnimationFrame(() => searchRef.current?.focus())
    return () => {
      document.removeEventListener('pointerdown', closeWhenOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const choose = (reference: string) => {
    onChange(reference)
    setOpen(false)
    setQuery('')
  }
  const referenceKind = (reference: string) => {
    if (localBranches.includes(reference)) return t('repository.compare.local')
    if (remoteBranches.includes(reference)) return t('repository.compare.remote')
    return t('repository.compare.commit')
  }

  return <div className="reference-field">
    <span>{label}</span>
    <div className={`reference-select ${open ? 'open' : ''}`} ref={rootRef}>
      <button type="button" className="reference-select-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <GitBranch size={15}/><strong>{value || t('repository.compare.pickPlaceholder')}</strong><ChevronDown size={14}/>
      </button>
      {open && <div className="reference-select-popover">
        <div className="reference-select-search"><Search size={14}/><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && canUseQuery) choose(query.trim()) }} placeholder={t('repository.compare.searchPlaceholder')} spellCheck={false}/></div>
        <div className="reference-select-options" role="listbox" aria-label={label}>
          {visibleReferences.map((reference) => <button type="button" role="option" aria-selected={reference === value} className={`reference-select-option ${reference === value ? 'selected' : ''}`} key={reference} onClick={() => choose(reference)}>
            <span className="reference-option-icon"><GitBranch size={14}/></span><span className="reference-option-name">{reference}</span><small>{referenceKind(reference)}</small>{reference === value && <Check size={14}/>}</button>)}
          {canUseQuery && <button type="button" className="reference-select-option custom-reference" onClick={() => choose(query.trim())}><span className="reference-option-icon"><GitCompareArrows size={14}/></span><span className="reference-option-name">{t('repository.compare.useRawPrefix')}{query.trim()}{t('repository.compare.useRawSuffix')}</span><small>{t('repository.compare.rawReference')}</small></button>}
          {!visibleReferences.length && !canUseQuery && <div className="reference-select-empty">{t('repository.compare.noMatchingBranches')}</div>}
        </div>
      </div>}
    </div>
  </div>
}

export function ComparePanel({ repository, initialBase, initialTarget, onNotice }: { repository: RepositorySnapshot | null; initialBase?: string; initialTarget?: string; onNotice: (message: string) => void }) {
  const { t } = useI18n()
  const refs = useMemo(() => repository ? Array.from(new Set([repository.branch, ...repository.branches, ...repository.remoteBranches, initialBase, initialTarget].filter((value): value is string => Boolean(value)))) : [], [initialBase, initialTarget, repository])
  const [base, setBase] = useState('')
  const [target, setTarget] = useState('')
  const [comparison, setComparison] = useState<RepositoryComparison | null>(null)
  const [loading, setLoading] = useState(false)
  const [wide, setWide] = useState(false)

  useEffect(() => {
    if (!repository) return
    const nextBase = initialBase ?? repository.branch
    const nextTarget = initialTarget ?? refs.find((reference) => reference !== nextBase) ?? repository.branch
    setBase(nextBase)
    setTarget(nextTarget)
    setComparison(null)
    if (!initialBase) return
    setLoading(true)
    compareRepositoryRefs(repository.path, nextBase, nextTarget)
      .then(setComparison)
      .catch((error) => onNotice(error instanceof Error ? error.message : String(error)))
      .finally(() => setLoading(false))
  }, [initialBase, initialTarget, repository?.path])

  const compare = async () => {
    if (!repository) return onNotice(t('repository.compare.requiresRepository'))
    if (!base || !target) return onNotice(t('repository.compare.pickTwoReferences'))
    setLoading(true)
    try {
      setComparison(await compareRepositoryRefs(repository.path, base, target))
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }
  const loadRows = useCallback((filePath: string, _index: number | undefined, showWhitespace: boolean) => {
    if (!repository || !comparison) return Promise.resolve([])
    return loadRepositoryCompareFileDiff(repository.path, comparison.base, comparison.target, filePath, showWhitespace)
  }, [comparison, repository?.path])

  if (!repository) return <section className="workspace-empty"><GitCompareArrows size={34}/><strong>{t('repository.compare.title')}</strong><span>{t('repository.compare.openHint')}</span></section>
  return <section className="compare-panel workspace-page">
    <div className="workspace-page-heading"><div><span className="eyebrow">{t('repository.compare.tabTitle')}</span><h2>{t('repository.compare.subtitle')}</h2><p>{t('repository.compare.description')}</p></div><Button variant="secondary" onClick={() => void compare()} disabled={loading}><Play size={14}/>{loading ? t('repository.compare.comparing') : t('repository.compare.start')}</Button></div>
    <div className="compare-controls">
      <ReferenceSelect label={t('repository.compare.base')} value={base} references={refs} localBranches={repository.branches} remoteBranches={repository.remoteBranches} onChange={(reference) => { setBase(reference); setComparison(null) }}/>
      <ArrowRight size={18}/>
      <ReferenceSelect label={t('repository.compare.target')} value={target} references={refs} localBranches={repository.branches} remoteBranches={repository.remoteBranches} onChange={(reference) => { setTarget(reference); setComparison(null) }}/>
      <Button variant="icon" className="compare-swap" title={t('repository.compare.swap')} onClick={() => { setBase(target); setTarget(base); setComparison(null) }}><RefreshCw size={15}/></Button>
    </div>
    {!comparison && <div className="workspace-hint"><GitCompareArrows size={28}/><strong>{t('repository.compare.selectFirst')}</strong><span>{t('repository.compare.selectHint')}</span></div>}
    {comparison && <div className="comparison-result">
      <div className="comparison-summary"><div><strong>{comparison.files.length}</strong><span>{t('repository.compare.changedFiles')}</span></div><div><strong>{comparison.ahead}</strong><span>{t('repository.compare.ahead')}</span></div><div><strong>{comparison.behind}</strong><span>{t('repository.compare.behind')}</span></div><code>{comparison.base} → {comparison.target}</code></div>
      {comparison.files.length > 0
        ? <DiffPanel files={comparison.files} repositoryPath={repository.path} wide={wide} onWideChange={setWide} loadRows={loadRows} defaultFontSize={13} fontSizeStorageKey="branchline.compareDiffFontSize.v1"/>
        : <div className="comparison-empty"><GitCompareArrows size={30}/><strong>{t('repository.compare.noFileDiff')}</strong><span>{comparison.ahead === 0 && comparison.behind === 0 ? t('repository.compare.sameSnapshot') : t('repository.compare.sameFilesDifferentHistory')}</span></div>}
    </div>}
  </section>
}
