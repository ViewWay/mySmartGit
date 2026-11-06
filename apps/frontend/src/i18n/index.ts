import { useMemo, useSyncExternalStore } from 'react'
import { formatDate, formatNumber, formatRelative, localeFor } from './format'
import { en } from './messages/en'
import { zh, type MessageKey } from './messages/zh'
import { pluralCategory } from './plural'

export type Language = 'zh' | 'en'
export type { MessageKey }
export { formatDate, formatNumber, formatRelative } from './format'

type Dictionary = Record<string, string>
type TranslateKey = MessageKey | (string & {})

const MESSAGES: Record<Language, Dictionary> = { zh, en }

const DEFAULT_LANGUAGE: Language = 'zh'
const STORAGE_KEY = 'branchline.language'
const listeners = new Set<() => void>()
let currentLanguage: Language = readStoredLanguage()

function normalizeLanguage(value: unknown): Language {
  return value === 'en' ? 'en' : 'zh'
}

function readStoredLanguage(): Language {
  try {
    if (typeof window === 'undefined') return DEFAULT_LANGUAGE
    return normalizeLanguage(window.localStorage.getItem(STORAGE_KEY))
  } catch {
    return DEFAULT_LANGUAGE
  }
}

function applyDocumentLanguage(language: Language) {
  try {
    if (typeof document !== 'undefined') document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
  } catch {
    // document may be unavailable in tests
  }
}

applyDocumentLanguage(currentLanguage)

export function getLanguage(): Language {
  return currentLanguage
}

export function setLanguage(language: Language) {
  const next = normalizeLanguage(language)
  if (next === currentLanguage) return
  currentLanguage = next
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // persistence is best-effort
  }
  applyDocumentLanguage(next)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function translate(language: Language, key: string, params?: Record<string, string | number>) {
  const template = MESSAGES[language][key] ?? MESSAGES[DEFAULT_LANGUAGE][key] ?? key
  if (!params) return template
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

export function hasMessage(key: string) {
  return key in MESSAGES.zh
}

export function tp(language: Language, key: string, count: number, params?: Record<string, string | number>) {
  return translate(language, `${key}.${pluralCategory(language, count)}`, { count, ...params })
}

export function useI18n() {
  const language = useSyncExternalStore(subscribe, getLanguage, () => DEFAULT_LANGUAGE)
  return useMemo(
    () => ({
      language,
      setLanguage,
      locale: localeFor(language),
      t: (key: TranslateKey, params?: Record<string, string | number>) => translate(language, key, params),
      tp: (key: string, count: number, params?: Record<string, string | number>) => tp(language, key, count, params),
      formatDate: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => formatDate(language, value, options),
      formatRelative: (value: string | number | Date, now?: number) => formatRelative(language, value, now),
      formatNumber: (value: number, options?: Intl.NumberFormatOptions) => formatNumber(language, value, options),
    }),
    [language],
  )
}
