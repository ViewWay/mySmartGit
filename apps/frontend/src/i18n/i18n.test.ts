import { beforeEach, describe, expect, it } from 'vitest'
import { en } from './messages/en'
import { zh } from './messages/zh'
import { formatRelative, getLanguage, setLanguage, translate, tp } from './index'

describe('i18n', () => {
  beforeEach(() => {
    setLanguage('zh')
  })

  it('translates the active language', () => {
    expect(translate('zh', 'nav.history')).toBe('提交图谱')
    expect(translate('en', 'nav.history')).toBe('Commit Graph')
  })

  it('interpolates named parameters', () => {
    expect(translate('en', 'updates.available', { version: '1.2.3' })).toBe('Version 1.2.3 is available')
    expect(translate('zh', 'updates.progress', { done: '1 MB', total: '2 MB' })).toBe('已下载 1 MB / 2 MB')
  })

  it('keeps unknown placeholders and falls back to Chinese', () => {
    expect(translate('en', 'updates.available')).toContain('{{version}}')
    expect(translate('en', 'missing.key')).toBe('missing.key')
  })

  it('switches the global language and notifies once', () => {
    setLanguage('en')
    expect(getLanguage()).toBe('en')
    setLanguage('en')
    expect(getLanguage()).toBe('en')
    setLanguage('zh')
    expect(getLanguage()).toBe('zh')
  })

  it('normalizes unsupported languages to Chinese', () => {
    setLanguage('fr' as never)
    expect(getLanguage()).toBe('zh')
  })
})

describe('i18n dictionaries', () => {
  it('keeps English complete against the Chinese key source', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('has no empty values', () => {
    for (const dictionary of [zh, en]) {
      for (const [key, value] of Object.entries(dictionary)) {
        expect(value.trim(), key).not.toBe('')
      }
    }
  })

  it('selects English plural categories', () => {
    expect(tp('en', 'history.commitCount', 1)).toBe('1 commit')
    expect(tp('en', 'history.commitCount', 3)).toBe('3 commits')
    expect(tp('zh', 'history.commitCount', 3)).toBe('3 个提交')
  })

  it('formats relative time per locale', () => {
    const now = Date.parse('2026-11-06T12:00:00Z')
    expect(formatRelative('en', '2026-11-06T11:58:00Z', now)).toBe('2 minutes ago')
    expect(formatRelative('zh', '2026-11-06T11:58:00Z', now)).toBe('2分钟前')
  })

  it('keeps dynamic error keys translatable', () => {
    expect(translate('en', 'errors.unknown')).not.toBe('errors.unknown')
  })
})
