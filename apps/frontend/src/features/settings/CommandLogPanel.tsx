import { useI18n } from '../../i18n'
import { useCallback, useEffect, useState } from 'react'
import { Check, ChevronDown, Clipboard, RefreshCw, TerminalSquare, Trash2, X } from 'lucide-react'
import { clearCommandLogs, loadCommandLogs, type CommandLogEntry } from '../../repository'
import { Button } from '../../components/Button'

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function output(entry: CommandLogEntry, noOutputLabel: string) {
  return [entry.stdout && `stdout\n${entry.stdout}`, entry.stderr && `stderr\n${entry.stderr}`].filter(Boolean).join('\n\n') || noOutputLabel
}

export function CommandLogPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n()
  const [entries, setEntries] = useState<CommandLogEntry[]>([])
  const [expanded, setExpanded] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [failedOnly, setFailedOnly] = useState(false)
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setEntries((await loadCommandLogs()).slice().reverse())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void refresh()
    const timer = window.setInterval(() => void refresh(), 1500)
    return () => window.clearInterval(timer)
  }, [open, refresh])

  if (!open) return null
  const visibleEntries = failedOnly ? entries.filter((entry) => !entry.success) : entries
  const clear = async () => {
    await clearCommandLogs()
    setEntries([])
    setExpanded(null)
  }
  return <div className="command-log-backdrop" onPointerDown={onClose}>
    <section className="command-log-panel" role="dialog" aria-modal="true" aria-label={t('cmdlog.title')} onPointerDown={(event) => event.stopPropagation()}>
      <header className="command-log-heading"><span className="command-log-icon"><TerminalSquare size={18}/></span><div><h2>{t('cmdlog.title')}</h2><p>{t('cmdlog.subtitle')}</p></div><Button variant="icon" onClick={onClose} title={t('common.close')}><X size={17}/></Button></header>
      <div className="command-log-toolbar"><button className={failedOnly ? 'active' : ''} onClick={() => setFailedOnly((value) => !value)}>{t('cmdlog.failedOnly')}</button><span>{visibleEntries.length} {t('cmdlog.entriesUnit')}</span><div/><Button variant="icon" onClick={() => void refresh()} disabled={loading} title={t('cmdlog.refresh')}><RefreshCw size={14} className={loading ? 'spin' : ''}/></Button><Button variant="icon" onClick={() => void clear()} disabled={!entries.length} title={t('cmdlog.clear')}><Trash2 size={14}/></Button></div>
      <div className="command-log-list">{visibleEntries.length ? visibleEntries.map((entry) => <article className={`command-log-entry ${entry.success ? 'success' : 'failed'} ${expanded === entry.id ? 'expanded' : ''}`} key={entry.id}><button className="command-log-summary" onClick={() => setExpanded((current) => current === entry.id ? null : entry.id)}><span className="command-log-status">{entry.success ? <Check size={13}/> : <X size={13}/>}</span><div><strong>{entry.command}</strong><small>{formatTime(entry.startedAt)} · {entry.durationMs} ms · {entry.exitCode === undefined ? t('cmdlog.noExitCode') : t('cmdlog.exitPrefix', { code: entry.exitCode })}</small></div><ChevronDown size={15}/></button>{expanded === entry.id && <div className="command-log-detail"><div><span>{t('cmdlog.workdir')}</span><code>{entry.workingDirectory || t('cmdlog.globalGitConfig')}</code></div><pre>{output(entry, t('cmdlog.noOutput'))}</pre><Button variant="secondary" size="compact" onClick={() => navigator.clipboard?.writeText(`${entry.command}\n\n${output(entry, t('cmdlog.noOutput'))}`).catch(() => undefined)}><Clipboard size={13}/>{t('cmdlog.copyCommand')}</Button></div>}</article>) : <div className="command-log-empty"><TerminalSquare size={25}/><strong>{failedOnly ? t('cmdlog.noFailed') : t('cmdlog.empty')}</strong><span>{t('cmdlog.emptyHint')}</span></div>}</div>
    </section>
  </div>
}
