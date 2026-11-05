export type RepositoryRefreshSettings = {
  enabled: boolean
  intervalMinutes: number
  localPollingEnabled: boolean
  localPollingIntervalSeconds: number
}

export const AUTO_FETCH_INTERVALS = [1, 5, 10, 15, 30]
export const LOCAL_POLLING_INTERVALS = [2, 5, 10, 30]

export const DEFAULT_REPOSITORY_REFRESH_SETTINGS: RepositoryRefreshSettings = {
  enabled: true,
  intervalMinutes: 5,
  localPollingEnabled: false,
  localPollingIntervalSeconds: 5,
}

export function normalizeRepositoryRefreshSettings(value: Partial<RepositoryRefreshSettings> | null | undefined): RepositoryRefreshSettings {
  const intervalMinutes = Number(value?.intervalMinutes)
  const localPollingIntervalSeconds = Number(value?.localPollingIntervalSeconds)
  return {
    enabled: value?.enabled !== false,
    intervalMinutes: AUTO_FETCH_INTERVALS.includes(intervalMinutes) ? intervalMinutes : DEFAULT_REPOSITORY_REFRESH_SETTINGS.intervalMinutes,
    localPollingEnabled: value?.localPollingEnabled === true,
    localPollingIntervalSeconds: LOCAL_POLLING_INTERVALS.includes(localPollingIntervalSeconds)
      ? localPollingIntervalSeconds
      : DEFAULT_REPOSITORY_REFRESH_SETTINGS.localPollingIntervalSeconds,
  }
}

export const NAVIGATION_FETCH_INTERVAL_MS = 60 * 1000

// 「自动 Fetch」必须同时约束定时抓取与打开/切换仓库时的后台抓取：
// 关闭后两者都不允许发起网络请求。抽成纯函数便于单测。
export function shouldFetchOnNavigation(
  settings: Pick<RepositoryRefreshSettings, 'enabled'>,
  lastFetchedAt: number | undefined,
  now: number,
  intervalMs: number = NAVIGATION_FETCH_INTERVAL_MS,
): boolean {
  if (!settings.enabled) return false
  return (lastFetchedAt ?? 0) + intervalMs <= now
}
