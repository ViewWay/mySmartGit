import type { Language } from './index'

export function localeFor(language: Language) {
  return language === 'zh' ? 'zh-CN' : 'en-US'
}

export function formatDate(language: Language, value: string | number | Date, options?: Intl.DateTimeFormatOptions) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat(localeFor(language), options ?? { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function formatNumber(language: Language, value: number, options?: Intl.NumberFormatOptions) {
  return new Intl.NumberFormat(localeFor(language), options).format(value)
}

const relativeThresholds: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 31536000],
  ['month', 2592000],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
]

export function formatRelative(language: Language, value: string | number | Date, now = Date.now()) {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime()
  if (Number.isNaN(timestamp)) return String(value)
  const seconds = Math.round((timestamp - now) / 1000)
  const formatter = new Intl.RelativeTimeFormat(localeFor(language), { numeric: 'auto' })
  for (const [unit, size] of relativeThresholds) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit)
  }
  return formatter.format(seconds, 'second')
}
