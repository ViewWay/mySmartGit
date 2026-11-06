export type UpdatePhase = 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'installing' | 'ready' | 'error'

export function isTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function formatBytes(bytes?: number | null) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export function downloadPercent(downloaded: number, total?: number | null) {
  if (!total || total <= 0) return null
  return Math.min(100, Math.max(0, Math.round((downloaded / total) * 100)))
}

export function releaseNotes(body?: string | null) {
  return (body ?? '').trim()
}

export function releaseDate(value?: string | null, locale = 'zh-CN') {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' })
}
