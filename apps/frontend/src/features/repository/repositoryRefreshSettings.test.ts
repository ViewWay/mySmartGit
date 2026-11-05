import { describe, expect, it } from 'vitest'
import {
  NAVIGATION_FETCH_INTERVAL_MS,
  normalizeRepositoryRefreshSettings,
  shouldFetchOnNavigation,
} from './repositoryRefreshSettings'
import { FORCE_PUSH_LEASE_NOTE, canConfirmForcePush } from './forcePushGuard'

describe('normalizeRepositoryRefreshSettings', () => {
  it('keeps local repository polling disabled when migrating existing settings', () => {
    expect(normalizeRepositoryRefreshSettings({ enabled: true, intervalMinutes: 10 })).toEqual({
      enabled: true,
      intervalMinutes: 10,
      localPollingEnabled: false,
      localPollingIntervalSeconds: 5,
    })
  })

  it('falls back to the default local polling interval when the stored value is invalid', () => {
    expect(normalizeRepositoryRefreshSettings({
      enabled: false,
      intervalMinutes: 5,
      localPollingEnabled: true,
      localPollingIntervalSeconds: 3,
    }).localPollingIntervalSeconds).toBe(5)
  })
})

describe('shouldFetchOnNavigation', () => {
  const now = 1_000_000

  it('blocks the background fetch on open/switch once auto fetch is disabled', () => {
    expect(shouldFetchOnNavigation({ enabled: false }, undefined, now)).toBe(false)
    expect(shouldFetchOnNavigation({ enabled: false }, now - 10 * 60 * 1000, now)).toBe(false)
  })

  it('allows the first navigation fetch when auto fetch is enabled', () => {
    expect(shouldFetchOnNavigation({ enabled: true }, undefined, now)).toBe(true)
  })

  it('keeps throttling repeated navigation fetches inside the interval window', () => {
    expect(shouldFetchOnNavigation({ enabled: true }, now - NAVIGATION_FETCH_INTERVAL_MS + 1, now)).toBe(false)
    expect(shouldFetchOnNavigation({ enabled: true }, now - NAVIGATION_FETCH_INTERVAL_MS, now)).toBe(true)
  })
})

describe('canConfirmForcePush', () => {
  it('only accepts the exact branch name typed by the user', () => {
    expect(canConfirmForcePush('feature/login', 'feature/login')).toBe(true)
    expect(canConfirmForcePush(' feature/login ', 'feature/login')).toBe(true)
    expect(canConfirmForcePush('', 'feature/login')).toBe(false)
    expect(canConfirmForcePush('   ', 'feature/login')).toBe(false)
    expect(canConfirmForcePush('feature', 'feature/login')).toBe(false)
    expect(canConfirmForcePush('FEATURE/LOGIN', 'feature/login')).toBe(false)
  })

  it('advertises the lease protection in the confirmation copy', () => {
    expect(FORCE_PUSH_LEASE_NOTE).toContain('force-with-lease')
  })
})
