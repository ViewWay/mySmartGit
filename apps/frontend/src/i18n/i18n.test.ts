import { beforeEach, describe, expect, it } from 'vitest'
import { getLanguage, setLanguage, translate } from './index'

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
