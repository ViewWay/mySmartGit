import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('preferences', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => null,
        setItem: () => {},
      },
    })
  })

  it('defaults to light unified layout without word wrap', async () => {
    const { getPreferences } = await import('./preferences')
    expect(getPreferences()).toEqual({
      theme: 'light',
      diffLayout: 'unified',
      wordWrap: false,
      showWhitespace: false,
      diffFontSize: 12,
    })
  })

  it('updates and notifies subscribers', async () => {
    const { getPreferences, setPreference, subscribePreferences } = await import('./preferences')
    const listener = vi.fn()
    const unsubscribe = subscribePreferences(listener)
    setPreference('wordWrap', true)
    expect(getPreferences().wordWrap).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('clamps the diff font size', async () => {
    const { getPreferences, setPreference } = await import('./preferences')
    setPreference('diffFontSize', 99)
    expect(getPreferences().diffFontSize).toBe(24)
    setPreference('diffFontSize', 1)
    expect(getPreferences().diffFontSize).toBe(9)
  })

  it('migrates legacy storage keys', async () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => {
          if (key === 'branchline.theme.v1') return 'dark'
          if (key === 'branchline.diffView.v1') return JSON.stringify('split')
          if (key === 'branchline.diffFontSize.v1') return '14'
          return null
        },
        setItem: () => {},
      },
    })
    const { getPreferences } = await import('./preferences')
    expect(getPreferences()).toMatchObject({ theme: 'dark', diffLayout: 'split', diffFontSize: 14 })
  })
})
