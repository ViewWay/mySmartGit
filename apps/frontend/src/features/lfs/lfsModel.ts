import type { LfsFile, LfsFilesPage, LfsOperationReport, LfsStatus } from '../../repository'

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

const ACTION_LABELS: Record<LfsAction, string> = {
  fetch: '抓取到缓存',
  pull: '拉取并检出',
  prune: '清理缓存',
}

export type LfsStatusTone = 'ready' | 'attention' | 'unavailable'

export function lfsActionLabel(action: LfsAction): string {
  return ACTION_LABELS[action]
}

/** 返回 null 表示通过；否则是给用户看的错误文案。 */
export function validateLfsPattern(raw: string): string | null {
  const pattern = raw.trim()
  if (!pattern) return '跟踪模式不能为空'
  if ([...pattern].length > 500) return '跟踪模式过长（上限 500 字符）'
  if (pattern.startsWith('-')) return '跟踪模式不能以 - 开头，否则会被 git-lfs 当成命令选项'
  if (pattern.startsWith('#')) return '跟踪模式不能以 # 开头（会被 .gitattributes 当成注释）'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(pattern)) return '跟踪模式不能包含换行、NUL 或其他控制字符'
  return null
}

/** 三态：未安装 / 已安装但仓库未启用 / 已就绪。 */
export function lfsStatusTone(status: LfsStatus | null): LfsStatusTone {
  if (!status?.available) return 'unavailable'
  if (!status.installedLocally) return 'attention'
  return 'ready'
}

export function lfsStatusLabel(status: LfsStatus | null): string {
  switch (lfsStatusTone(status)) {
    case 'unavailable':
      return '未安装 git-lfs'
    case 'attention':
      return '本仓库未启用 LFS'
    default:
      return 'LFS 已就绪'
  }
}

export function lfsStatusDescription(status: LfsStatus | null): string {
  if (!status) return '正在读取 LFS 状态…'
  if (status.notice) return status.notice
  const version = status.version ? `git-lfs ${status.version}` : 'git-lfs'
  return `${version}；已声明 ${status.patterns.length} 个模式，跟踪 ${status.trackedFileCount} 个文件`
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

export function lfsDownloadLabel(file: LfsFile): '已下载' | '未下载' {
  return file.downloaded ? '已下载' : '未下载'
}

export function lfsFilesSummary(page: LfsFilesPage | null): string {
  if (!page) return '尚未读取 LFS 文件'
  const count = page.files.length
  if (!count) return '当前引用没有 LFS 文件'
  return page.truncated
    ? `显示前 ${count} 个 LFS 文件；结果已截断，请缩小范围或查看命令行完整列表`
    : `共 ${count} 个 LFS 文件`
}

/** prune 会删本地缓存；pull 会改写工作区。两者都要二次确认，fetch 不需要。 */
export function lfsActionRequiresConfirmation(action: LfsAction): boolean {
  return action === 'pull' || action === 'prune'
}

export function lfsActionConfirmation(action: LfsAction, repositoryPath: string): {
  title: string
  message: string
  confirmLabel: string
  variant: 'danger' | 'primary'
} {
  if (action === 'prune') {
    return {
      title: '确认清理 LFS 缓存',
      message: `将删除 ${repositoryPath} 中不再被引用的 LFS 本地缓存对象。需要时可以从远端重新下载，但会消耗网络与时间。`,
      confirmLabel: '确认清理',
      variant: 'danger',
    }
  }
  return {
    title: '确认拉取 LFS 对象',
    message: `将抓取并检出 ${repositoryPath} 当前引用需要的 LFS 对象，可能覆盖工作区中的 LFS 文件。`,
    confirmLabel: '确认拉取',
    variant: 'primary',
  }
}

export function lfsOperationNotice(report: LfsOperationReport): string {
  return report.output ? `${report.summary}：${report.output}` : report.summary
}
