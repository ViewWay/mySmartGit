import { useSyncExternalStore } from 'react'

export type ThemePreference = 'light' | 'dark'
export type DiffLayout = 'unified' | 'split'

export interface Preferences {
  theme: ThemePreference
  diffLayout: DiffLayout
  wordWrap: boolean
  showWhitespace: boolean
  diffFontSize: number
}

const STORAGE_KEY = 'branchline.preferences.v1'
const MIN_FONT_SIZE = 9
const MAX_FONT_SIZE = 24
const DEFAULTS: Preferences = { theme: 'light', diffLayout: 'unified', wordWrap: false, showWhitespace: false, diffFontSize: 12 }
const listeners = new Set<() => void>()
let current = read()

function storage() {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function readLegacy(): Partial<Preferences> {
  const store = storage()
  if (!store) return {}
  const result: Partial<Preferences> = {}
  try {
    const theme = store.getItem('branchline.theme.v1')
    if (theme === 'light' || theme === 'dark') result.theme = theme
    const view = store.getItem('branchline.diffView.v1')
    if (view) {
      const parsed: unknown = JSON.parse(view)
      if (parsed === 'unified' || parsed === 'split') result.diffLayout = parsed
    }
    const fontSize = Number(store.getItem('branchline.diffFontSize.v1'))
    if (Number.isFinite(fontSize) && fontSize > 0) result.diffFontSize = fontSize
  } catch {
    return result
  }
  return result
}

function normalize(value: Partial<Preferences>): Preferences {
  return {
    theme: value.theme === 'dark' ? 'dark' : 'light',
    diffLayout: value.diffLayout === 'split' ? 'split' : 'unified',
    wordWrap: value.wordWrap === true,
    showWhitespace: value.showWhitespace === true,
    diffFontSize: Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(value.diffFontSize ?? DEFAULTS.diffFontSize))),
  }
}

function read(): Preferences {
  const store = storage()
  if (!store) return DEFAULTS
  const raw = store.getItem(STORAGE_KEY)
  if (!raw) return normalize(readLegacy())
  try {
    return normalize(JSON.parse(raw) as Partial<Preferences>)
  } catch {
    return DEFAULTS
  }
}

export function getPreferences() {
  return current
}

export function setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]) {
  const next = normalize({ ...current, [key]: value })
  if (JSON.stringify(next) === JSON.stringify(current)) return
  current = next
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // persistence is best-effort
  }
  for (const listener of listeners) listener()
}

export function subscribePreferences(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePreferences() {
  return useSyncExternalStore(subscribePreferences, getPreferences, () => DEFAULTS)
}
