import type { LfsFile, LfsFilesPage, LfsOperationReport, LfsStatus } from '../../repository'

type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * Git LFS 面板的纯逻辑：模式校验、状态分类、大小与完成文案。
 *
 * 组件只负责装配；这里不依赖 React，也不依赖 App 全局状态，便于 vitest 覆盖边界。
 * 校验规则与后端 git_lfs.rs 保持一致：拒绝空串、`-` 开头（选项注入）、`#` 开头
 * （.gitattributes 注释）以及换行 / NUL / 其他控制字符。
 */

export const LFS_DEFAULT_LIMIT = 500
export const LFS_MAX_LIMIT = 2_000

export const LFS_ACTIONS = ['fetch', 'pull', 'prune'] as const
export type LfsAction = (typeof LFS_ACTIONS)[number]

const ACTION_KEYS: Record<LfsAction, string> = {
  fetch: 'lfs.fetchCache',
  pull: 'lfs.pullCheckout',
  prune: 'lfs.pruneCache',
}

export function lfsActionLabel(action: LfsAction, t: Translate): string {
  return t(ACTION_KEYS[action])
}

export type LfsStatusTone = 'ready' | 'attention' | 'unavailable'

/** 返回 null 表示通过；否则是给用户看的错误文案。 */
export function validateLfsPattern(raw: string, t: Translate): string | null {
  const pattern = raw.trim()
  if (!pattern) return t('lfs.patternRequired')
  if ([...pattern].length > 500) return t('lfs.patternTooLong')
  if (pattern.startsWith('-')) return t('lfs.patternOptionLike')
  if (pattern.startsWith('#')) return t('lfs.patternCommentLike')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(pattern)) return t('lfs.patternControlChars')
  return null
}

/** 三态：未安装 / 已安装但仓库未启用 / 已就绪。 */
export function lfsStatusTone(status: LfsStatus | null): LfsStatusTone {
  if (!status?.available) return 'unavailable'
  if (!status.installedLocally) return 'attention'
  return 'ready'
}

export function lfsStatusLabel(status: LfsStatus | null, t: Translate): string {
  switch (lfsStatusTone(status)) {
    case 'unavailable':
      return t('lfs.notInstalled')
    case 'attention':
      return t('lfs.notEnabled')
    default:
      return t('lfs.ready')
  }
}

export function lfsStatusDescription(status: LfsStatus | null, t: Translate): string {
  if (!status) return t('lfs.loading')
  if (status.notice) return status.notice
  const version = status.version ? `git-lfs ${status.version}` : 'git-lfs'
  return t('lfs.statusSummary', { version, patterns: status.patterns.length, tracked: status.trackedFileCount })
}

/** 人类可读大小；未知大小（0）显示占位符而不是伪造 0 B。 */
export function formatLfsBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : value
  return `${Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(1)} ${units[unit]}`
}

export function shortLfsOid(oid: string): string {
  return oid.slice(0, 10)
}

export function lfsDownloadLabel(file: LfsFile, t: Translate): string {
  return file.downloaded ? t('lfs.downloaded') : t('lfs.notDownloaded')
}

export function lfsFilesSummary(page: LfsFilesPage | null, t: Translate): string {
  if (!page) return t('lfs.notRead')
  const count = page.files.length
  if (!count) return t('lfs.noFiles')
  return page.truncated
    ? `显示前 ${count} 个 LFS 文件；结果已截断，请缩小范围或查看命令行完整列表`
    : `共 ${count} 个 LFS 文件`
}

/** prune 会删本地缓存；pull 会改写工作区。两者都要二次确认，fetch 不需要。 */
export function lfsActionRequiresConfirmation(action: LfsAction): boolean {
  return action === 'pull' || action === 'prune'
}

export function lfsActionConfirmation(action: LfsAction, repositoryPath: string, t: Translate): {
  title: string
  message: string
  confirmLabel: string
  variant: 'danger' | 'primary'
} {
  if (action === 'prune') {
    return {
      title: t('lfs.pruneConfirmTitle'),
      message: t('lfs.pruneBody', { path: repositoryPath }),
      confirmLabel: t('lfs.pruneConfirm'),
      variant: 'danger',
    }
  }
  return {
    title: t('lfs.pullConfirmTitle'),
    message: t('lfs.pullBody', { path: repositoryPath }),
    confirmLabel: t('lfs.pullConfirm'),
    variant: 'primary',
  }
}

export function lfsOperationNotice(report: LfsOperationReport, t: Translate): string {
  return report.output ? `${report.summary}：${report.output}` : report.summary
}
