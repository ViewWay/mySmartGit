import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GitCommitHorizontal, History, Rows3, X } from 'lucide-react'
import { Button } from '../../components/Button'
import {
  cancelRepositoryHistoryStream,
  loadFileBlame,
  loadFileCommitDiff,
  loadRepositoryFileHistoryNextPage,
  loadRepositoryLineHistoryNextPage,
  startRepositoryFileHistoryStream,
  startRepositoryLineHistoryStream,
  type BlameLine,
  type FileHistoryEntry,
} from '../../repository'
import { HISTORY_PAGE_SIZE, mergeHistoryEntries } from './historyDepth'
import { DiffPanel } from '../diff/DiffPanel'
import { formatLocalDateTime } from '../../dateTime'
import { useI18n } from '../../i18n'

type HistoryStreamInfo = { sessionId: string; hasMore: boolean }

type HistoryDrawerProps = {
  repositoryPath?: string
  filePath: string | null
  initialTab?: 'history' | 'blame' | 'line'
  lineNumber?: number
  revision?: string
  onClose: () => void
}

function formatBlameTime(value: string, locale: string) {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp)) return value
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp * 1000))
}

export function HistoryDrawer({ repositoryPath, filePath, initialTab = 'history', lineNumber, revision, onClose }: HistoryDrawerProps) {
  const { t, locale } = useI18n()
  const [tab, setTab] = useState<'history' | 'blame' | 'line'>('history')
  const [history, setHistory] = useState<FileHistoryEntry[]>([])
  const [lineHistory, setLineHistory] = useState<FileHistoryEntry[]>([])
  const [blame, setBlame] = useState<BlameLine[]>([])
  const [loading, setLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [blameError, setBlameError] = useState<string | null>(null)
  const [lineHistoryError, setLineHistoryError] = useState<string | null>(null)
  const [selectedHash, setSelectedHash] = useState<string | null>(null)
  const [selectedBlame, setSelectedBlame] = useState<BlameLine | null>(null)
  const [activeLineNumber, setActiveLineNumber] = useState<number | undefined>(lineNumber)
  const [blameLineLoading, setBlameLineLoading] = useState(false)
  const [wideDiff, setWideDiff] = useState(false)
  const [fileStream, setFileStream] = useState<HistoryStreamInfo | null>(null)
  const [lineStream, setLineStream] = useState<HistoryStreamInfo | null>(null)
  const [fileMoreLoading, setFileMoreLoading] = useState(false)
  const [lineMoreLoading, setLineMoreLoading] = useState(false)

  // 关闭抽屉/切换文件时取消在跑的历史流：不留僵尸会话，过期响应直接丢弃。
  const fileSessionId = fileStream?.sessionId
  const lineSessionId = lineStream?.sessionId
  useEffect(() => () => {
    if (fileSessionId) void cancelRepositoryHistoryStream(fileSessionId)
    if (lineSessionId) void cancelRepositoryHistoryStream(lineSessionId)
  }, [fileSessionId, lineSessionId])

  useEffect(() => {
    setTab(initialTab)
    setActiveLineNumber(lineNumber)
    setSelectedBlame(null)
  }, [filePath, initialTab, lineNumber])

  useEffect(() => {
    if (!repositoryPath || !filePath) return
    let cancelled = false
    setLoading(true)
    setHistory([])
    setLineHistory([])
    setBlame([])
    setSelectedHash(null)
    setFileStream(null)
    setLineStream(null)
    setHistoryError(null)
    setBlameError(null)
    setLineHistoryError(null)
    const startFile = startRepositoryFileHistoryStream(repositoryPath, filePath, HISTORY_PAGE_SIZE)
    const startLine = lineNumber ? startRepositoryLineHistoryStream(repositoryPath, filePath, lineNumber, revision, HISTORY_PAGE_SIZE) : Promise.resolve(null)
    Promise.allSettled([
      startFile,
      loadFileBlame(repositoryPath, filePath, revision),
      startLine,
    ]).then(([historyResult, blameResult, lineHistoryResult]) => {
      if (cancelled) {
        // 迟到的流会话也必须取消，绝不让旧任务的流继续占资源。
        if (historyResult.status === 'fulfilled' && historyResult.value) void cancelRepositoryHistoryStream(historyResult.value.sessionId)
        if (lineHistoryResult.status === 'fulfilled' && lineHistoryResult.value) void cancelRepositoryHistoryStream(lineHistoryResult.value.sessionId)
        return
      }
      let fileEntries: FileHistoryEntry[] = []
      let lineEntries: FileHistoryEntry[] = []
      if (historyResult.status === 'fulfilled' && historyResult.value) {
        const page = historyResult.value
        fileEntries = page.entries
        setHistory(fileEntries)
        setFileStream({ sessionId: page.sessionId, hasMore: page.hasMore })
        if (page.truncated && page.notice) setHistoryError(page.notice)
      }
      else if (historyResult.status === 'rejected') setHistoryError(String(historyResult.reason))
      if (blameResult.status === 'fulfilled') setBlame(blameResult.value)
      else setBlameError(String(blameResult.reason))
      if (lineHistoryResult.status === 'fulfilled' && lineHistoryResult.value) {
        const page = lineHistoryResult.value
        lineEntries = page.entries
        setLineHistory(lineEntries)
        setLineStream({ sessionId: page.sessionId, hasMore: page.hasMore })
        if (page.truncated && page.notice) setLineHistoryError(page.notice)
      }
      else if (lineHistoryResult.status === 'rejected') setLineHistoryError(String(lineHistoryResult.reason))
      setSelectedHash((initialTab === 'line' ? lineEntries[0] : fileEntries[0])?.hash ?? fileEntries[0]?.hash ?? null)
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [filePath, initialTab, lineNumber, repositoryPath, revision])

  const loadMoreFileHistory = useCallback(() => {
    if (!fileStream || fileMoreLoading) return
    setFileMoreLoading(true)
    loadRepositoryFileHistoryNextPage(fileStream.sessionId, HISTORY_PAGE_SIZE)
      .then((page) => {
        setHistory((current) => mergeHistoryEntries(current, page))
        setFileStream({ sessionId: page.sessionId, hasMore: page.hasMore })
        if (page.truncated && page.notice) setHistoryError(page.notice)
      })
      .catch((error) => setHistoryError(error instanceof Error ? error.message : String(error)))
      .finally(() => setFileMoreLoading(false))
  }, [fileMoreLoading, fileStream])

  const loadMoreLineHistory = useCallback(() => {
    if (!lineStream || lineMoreLoading) return
    setLineMoreLoading(true)
    loadRepositoryLineHistoryNextPage(lineStream.sessionId, HISTORY_PAGE_SIZE)
      .then((page) => {
        setLineHistory((current) => mergeHistoryEntries(current, page))
        setLineStream({ sessionId: page.sessionId, hasMore: page.hasMore })
        if (page.truncated && page.notice) setLineHistoryError(page.notice)
      })
      .catch((error) => setLineHistoryError(error instanceof Error ? error.message : String(error)))
      .finally(() => setLineMoreLoading(false))
  }, [lineMoreLoading, lineStream])

  useEffect(() => {
    if (!repositoryPath || !filePath || !selectedBlame) return
    let cancelled = false
    setBlameLineLoading(true)
    setLineHistory([])
    setLineStream(null)
    setLineHistoryError(null)
    startRepositoryLineHistoryStream(repositoryPath, filePath, selectedBlame.line, revision, HISTORY_PAGE_SIZE)
      .then((page) => {
        if (cancelled) {
          void cancelRepositoryHistoryStream(page.sessionId)
          return
        }
        const entries = page.entries
        setLineHistory(entries)
        setLineStream({ sessionId: page.sessionId, hasMore: page.hasMore })
        if (page.truncated && page.notice) setLineHistoryError(page.notice)
        setSelectedHash(entries.find((entry) => entry.hash === selectedBlame.hash)?.hash ?? entries[0]?.hash ?? null)
      })
      .catch((error) => { if (!cancelled) setLineHistoryError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (!cancelled) setBlameLineLoading(false) })
    return () => { cancelled = true }
  }, [filePath, repositoryPath, revision, selectedBlame])

  const activeHistory = tab === 'line' ? lineHistory : history
  const selectedEntry = useMemo(() => activeHistory.find((entry) => entry.hash === selectedHash) ?? activeHistory[0], [activeHistory, selectedHash])
  const selectedBlameEntry = useMemo(() => selectedBlame
    ? lineHistory.find((entry) => entry.hash === selectedBlame.hash) ?? history.find((entry) => entry.hash === selectedBlame.hash) ?? lineHistory[0]
    : undefined, [history, lineHistory, selectedBlame])
  const displayedEntry = tab === 'blame' ? selectedBlameEntry : selectedEntry
  const selectedFile = useMemo(() => filePath ? [{ path: filePath, type: 'M', add: 0, del: 0 }] : [], [filePath])
  const loadSelectedDiff = useCallback((path: string, _index: number | undefined, showWhitespace: boolean) => {
    if (!repositoryPath || !displayedEntry) return Promise.resolve([])
    return loadFileCommitDiff(repositoryPath, displayedEntry.hash, path, showWhitespace)
  }, [displayedEntry?.hash, repositoryPath])

  if (!filePath) return null
  const fileName = filePath.split(/[\\/]/).pop() || filePath
  return <div className="drawer-backdrop" onClick={onClose}><aside className="history-drawer" onClick={(event) => event.stopPropagation()}>
    <div className="drawer-heading"><div className="history-drawer-title"><span className="eyebrow">{tab === 'line' ? t('history.drawer.lineHistoryAt', { line: activeLineNumber ?? 0 }) : t('history.drawer.fileTracking')}</span><h2 title={filePath}>{fileName}</h2><span className="history-file-path" title={filePath}>{filePath}{tab === 'line' && activeLineNumber ? ` · ${t('history.drawer.lineBreadcrumb', { line: activeLineNumber ?? 0 })}${revision ? ` · ${revision.slice(0, 12)}` : ''}` : ''}</span></div><Button variant="icon" onClick={onClose} title={t('common.close')}><X size={18}/></Button></div>
    <div className="history-tabs"><button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}><History size={14}/>{t('history.drawer.fileHistory')} <span>{history.length}</span></button><button className={tab === 'blame' ? 'active' : ''} onClick={() => setTab('blame')}><Rows3 size={14}/>{t('history.drawer.blame')} <span>{blame.length}</span></button>{activeLineNumber && <button className={tab === 'line' ? 'active' : ''} onClick={() => setTab('line')}><GitCommitHorizontal size={14}/>{t('history.drawer.lineHistoryAt', { line: activeLineNumber ?? 0 })} <span>{lineHistory.length}</span></button>}</div>
    {loading && <div className="history-empty">{t('history.drawer.loading')}</div>}
    {!loading && (tab === 'history' || tab === 'line') && <div className="file-history-workspace">
      <div className="file-history-list">
        {tab === 'line' && blameLineLoading && <div className="history-empty">{t('history.drawer.loadingLine', { line: activeLineNumber ?? 0 })}</div>}
        {!(tab === 'line' && blameLineLoading) && (tab === 'line' ? lineHistoryError : historyError) && <div className="history-empty error">{tab === 'line' ? lineHistoryError : historyError}</div>}
        {!(tab === 'line' && blameLineLoading) && !(tab === 'line' ? lineHistoryError : historyError) && activeHistory.map((entry) => <button className={`file-history-row ${selectedEntry?.hash === entry.hash ? 'active' : ''}`} key={entry.hash} onClick={() => { setSelectedHash(entry.hash); setWideDiff(false) }}><span className="history-node"><GitCommitHorizontal size={12}/></span><div><strong title={entry.title}>{entry.title}</strong><span title={`${entry.author} · ${formatLocalDateTime(entry.commitTime || entry.time)}`}>{entry.author} · {formatLocalDateTime(entry.commitTime || entry.time, false)}</span></div><code title={entry.hash}>{entry.shortHash}</code></button>)}
        {!(tab === 'line' && blameLineLoading) && !(tab === 'line' ? lineHistoryError : historyError) && !activeHistory.length && <div className="history-empty">{tab === 'line' ? t('history.drawer.lineNoTrackable', { line: activeLineNumber ?? 0 }) : t('history.drawer.emptyHistory')}</div>}
        {(() => {
          const isLineTab = tab === 'line'
          const hasMore = isLineTab ? lineStream?.hasMore : fileStream?.hasMore
          const loadingMore = isLineTab ? lineMoreLoading : fileMoreLoading
          if (!hasMore || !activeHistory.length) return null
          return <button className="history-load-more" disabled={loadingMore} onClick={isLineTab ? loadMoreLineHistory : loadMoreFileHistory}>{loadingMore ? t('history.drawer.continuing') : t('history.drawer.loadMore')}</button>
        })()}
      </div>
      {selectedEntry ? <section className="file-history-detail">
        <div className="file-history-commit"><div><strong>{selectedEntry.title}</strong><code>{selectedEntry.hash}</code></div><dl><div><dt>{t('history.drawer.author')}</dt><dd>{selectedEntry.author} &lt;{selectedEntry.email}&gt;</dd></div><div><dt>{t('history.drawer.committer')}</dt><dd>{selectedEntry.committer} &lt;{selectedEntry.committerEmail}&gt;</dd></div><div><dt>{t('history.drawer.commitTime')}</dt><dd>{formatLocalDateTime(selectedEntry.commitTime || selectedEntry.time)}</dd></div><div><dt>{t('history.drawer.parent')}</dt><dd>{selectedEntry.parents.length ? selectedEntry.parents.join(', ') : '根提交'}</dd></div></dl><pre>{selectedEntry.message}</pre></div>
        <div className="file-history-diff"><DiffPanel key={selectedEntry.hash} files={selectedFile} wide={wideDiff} onWideChange={setWideDiff} hideFileList loadRows={loadSelectedDiff}/></div>
      </section> : <div className="history-empty">{t('history.drawer.selectCommit')}</div>}
    </div>}
    {!loading && tab === 'blame' && <div className="blame-workspace">
      <div className="blame-list">
        {blameError && <div className="history-empty error">{blameError}</div>}
        {!blameError && blame.map((line) => <button className={`blame-row ${selectedBlame?.line === line.line ? 'selected' : ''}`} key={`${line.hash}-${line.line}`} onClick={() => { setSelectedBlame(line); setActiveLineNumber(line.line); setWideDiff(false) }} title={t('history.drawer.blameRowTitle', { line: line.line })}><span className="blame-line-number">{line.line}</span><code className="blame-hash" title={line.hash}>{line.shortHash}</code><span className="blame-author" title={line.email}>{line.author}</span><time>{formatBlameTime(line.time, locale)}</time><code className="blame-content">{line.content || ' '}</code></button>)}
        {!blameError && !blame.length && <div className="history-empty">{t('history.drawer.emptyBlame')}</div>}
      </div>
      {selectedBlame ? <section className="file-history-detail blame-detail">
        {blameLineLoading && !selectedBlameEntry ? <div className="history-empty">{t('history.drawer.loadingLineMessage', { line: selectedBlame.line })}</div> : selectedBlameEntry ? <>
          <div className="file-history-commit"><div><strong>{selectedBlameEntry.title}</strong><code>{selectedBlameEntry.hash}</code></div><dl><div><dt>{t('history.drawer.author')}</dt><dd>{selectedBlameEntry.author} &lt;{selectedBlameEntry.email}&gt;</dd></div><div><dt>{t('history.drawer.committer')}</dt><dd>{selectedBlameEntry.committer} &lt;{selectedBlameEntry.committerEmail}&gt;</dd></div><div><dt>{t('history.drawer.commitTime')}</dt><dd>{formatLocalDateTime(selectedBlameEntry.commitTime || selectedBlameEntry.time)}</dd></div><div><dt>{t('history.drawer.parent')}</dt><dd>{selectedBlameEntry.parents.length ? selectedBlameEntry.parents.join(', ') : '根提交'}</dd></div></dl><pre>{selectedBlameEntry.message}</pre><button className="line-history-button" disabled={blameLineLoading || !lineHistory.length} onClick={() => { setSelectedHash(lineHistory.find((entry) => entry.hash === selectedBlame.hash)?.hash ?? lineHistory[0]?.hash ?? null); setTab('line'); setWideDiff(false) }}><History size={14}/>{t('history.drawer.viewLineHistory', { line: selectedBlame.line })} <span>{lineHistory.length}</span></button></div>
          <div className="file-history-diff"><DiffPanel key={selectedBlameEntry.hash} files={selectedFile} wide={wideDiff} onWideChange={setWideDiff} hideFileList loadRows={loadSelectedDiff}/></div>
        </> : <div className="history-empty error">{lineHistoryError ?? t('history.drawer.blameUncommitted')}</div>}
      </section> : <div className="history-empty blame-detail-empty"><Rows3 size={28}/><strong>{t('history.drawer.selectLine')}</strong><span>{t('history.drawer.selectLineHint')}</span></div>}
    </div>}
  </aside></div>
}
