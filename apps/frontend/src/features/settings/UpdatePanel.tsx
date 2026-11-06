import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Download, RefreshCw, RotateCcw, ShieldCheck, X } from 'lucide-react'
import type { Update } from '@tauri-apps/plugin-updater'
import { Button } from '../../components/Button'
import { useI18n } from '../../i18n'
import { downloadPercent, formatBytes, isTauriRuntime, releaseDate, releaseNotes, type UpdatePhase } from './updateModel'

type AvailableUpdate = { version: string; date?: string; body?: string }

function errorText(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * 版本与更新面板：只负责触发官方 updater 插件，不自行拼接下载地址。
 * 签名公钥与发布通道来自 tauri.conf.json；浏览器预览会明确提示不可用。
 */
export function UpdatePanel() {
  const { t, locale } = useI18n()
  const [version, setVersion] = useState('—')
  const [phase, setPhase] = useState<UpdatePhase>('idle')
  const [available, setAvailable] = useState<AvailableUpdate | null>(null)
  const [downloaded, setDownloaded] = useState(0)
  const [total, setTotal] = useState<number | null>(null)
  const [error, setError] = useState('')
  const pending = useRef<Update | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    if (isTauriRuntime()) {
      void import('@tauri-apps/api/app')
        .then(({ getVersion }) => getVersion())
        .then((value) => {
          if (alive.current) setVersion(value)
        })
        .catch(() => {
          if (alive.current) setVersion('—')
        })
    }
    return () => {
      alive.current = false
      const current = pending.current
      pending.current = null
      if (current) void current.close().catch(() => undefined)
    }
  }, [])

  const closePending = useCallback(async () => {
    const current = pending.current
    pending.current = null
    if (current) await current.close().catch(() => undefined)
  }, [])

  const checkForUpdates = useCallback(async () => {
    if (!isTauriRuntime()) {
      setPhase('error')
      setError(t('updates.browser'))
      return
    }
    setPhase('checking')
    setError('')
    setAvailable(null)
    setDownloaded(0)
    setTotal(null)
    await closePending()
    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const update = await check()
      if (!alive.current) {
        if (update) await update.close().catch(() => undefined)
        return
      }
      if (!update) {
        setPhase('latest')
        return
      }
      pending.current = update
      setAvailable({ version: update.version, date: update.date, body: update.body })
      setPhase('available')
    } catch (reason) {
      if (!alive.current) return
      setPhase('error')
      setError(t('updates.error', { message: errorText(reason) }))
    }
  }, [closePending, t])

  const installUpdate = useCallback(async () => {
    const update = pending.current
    if (!update) return
    setPhase('downloading')
    setError('')
    setDownloaded(0)
    setTotal(null)
    try {
      await update.download((event) => {
        if (!alive.current) return
        if (event.event === 'Started') setTotal(event.data.contentLength ?? null)
        else if (event.event === 'Progress') setDownloaded((value) => value + event.data.chunkLength)
      })
      if (!alive.current) return
      setPhase('installing')
      await update.install()
      if (!alive.current) return
      setPhase('ready')
    } catch (reason) {
      if (!alive.current) return
      setPhase('error')
      setError(t('updates.error', { message: errorText(reason) }))
    }
  }, [t])

  const relaunch = useCallback(async () => {
    try {
      const { relaunch: restart } = await import('@tauri-apps/plugin-process')
      await restart()
    } catch (reason) {
      setPhase('error')
      setError(t('updates.error', { message: errorText(reason) }))
    }
  }, [t])

  const percent = downloadPercent(downloaded, total)
  const busy = phase === 'checking' || phase === 'downloading' || phase === 'installing'
  const released = releaseDate(available?.date, locale)
  const notes = releaseNotes(available?.body)
  const phaseLabel = phase === 'available' && available
    ? t('updates.available', { version: available.version })
    : t(phase === 'error' ? 'updates.errorTitle' : `updates.${phase}`)

  return (
    <section className="structure-panel workspace-page update-panel">
      <div className="workspace-page-heading">
        <div>
          <span className="eyebrow">{t('updates.eyebrow')}</span>
          <h2>{t('updates.title')}</h2>
          <p>{t('updates.current')}：v{version}</p>
        </div>
        <div className="structure-actions">
          <Button variant="secondary" disabled={busy} onClick={() => void checkForUpdates()}>
            <RefreshCw size={14} className={phase === 'checking' ? 'spin' : ''} />
            {phase === 'checking' ? t('updates.checking') : phase === 'error' ? t('updates.retry') : t('updates.check')}
          </Button>
        </div>
      </div>

      {phase === 'error' && (
        <div className="update-alert" role="alert">
          <AlertTriangle size={15} />
          <span>{error || t('updates.error', { message: '—' })}</span>
        </div>
      )}

      <div className="update-grid">
        <article className="structure-detail-card update-card">
          <div className="update-card-heading">
            <ShieldCheck size={16} />
            <h3>{phaseLabel}</h3>
            {phase === 'latest' || phase === 'ready' ? <CheckCircle2 size={16} className="update-ok" /> : null}
          </div>

          {available ? (
            <div className="update-release">
              <strong>{available.version}</strong>
              {released ? <span>{t('updates.releasedAt', { date: released })}</span> : null}
              {notes ? (
                <div className="update-notes">
                  <h4>{t('updates.notes')}</h4>
                  <pre>{notes}</pre>
                </div>
              ) : null}
            </div>
          ) : null}

          {(phase === 'downloading' || phase === 'installing' || phase === 'ready') && (
            <div className="update-progress">
              <div className="update-progress-track">
                <span style={{ width: `${percent ?? (phase === 'ready' ? 100 : 8)}%` }} />
              </div>
              <span>
                {percent === null
                  ? t('updates.downloading')
                  : t('updates.progress', { done: formatBytes(downloaded), total: total ? formatBytes(total) : '—' })}
              </span>
            </div>
          )}

          <div className="update-actions">
            {phase === 'available' && (
              <Button variant="primary" onClick={() => void installUpdate()}>
                <Download size={14} />
                {t('updates.download')}
              </Button>
            )}
            {phase === 'ready' && (
              <Button variant="primary" onClick={() => void relaunch()}>
                <RotateCcw size={14} />
                {t('updates.relaunch')}
              </Button>
            )}
          </div>

          <p className="update-hint">{phase === 'ready' ? t('updates.readyHint') : t('updates.signature')}</p>
        </article>

        <article className="structure-detail-card update-card">
          <h3>{t('updates.channel')}</h3>
          <p className="update-hint">https://github.com/ViewWay/mySmartGit/releases</p>
          <p className="update-hint">{t('updates.channelHint')}</p>
          {!isTauriRuntime() && <p className="update-hint">{t('updates.browserDetail')}</p>}
        </article>
      </div>
    </section>
  )
}

export function UpdateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n()
  if (!open) return null
  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <section
        className="update-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('updates.title')}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="update-dialog-bar">
          <strong>{t('updates.title')}</strong>
          <Button variant="icon" onClick={onClose} title={t('common.close')}>
            <X size={16} />
          </Button>
        </div>
        <UpdatePanel />
      </section>
    </div>
  )
}
