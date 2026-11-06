import type { RepositorySubmodule, SubmoduleOperationReport } from '../../repository'

/**
 * 添加 Submodule 表单的纯逻辑（W2-10）。
 *
 * 这里的规则是 apps/desktop/src/git_submodule.rs 校验逻辑的**镜像**：
 * 前端先挡掉明显填错的值，后端仍然独立复算一遍 —— 前端校验不是安全边界，
 * 只是省一次往返并给出字段级提示。两边规则不一致时，以拒绝为准的那一侧赢。
 */

/** 允许的传输协议；`ext::` / `fd::` 这类能在本机执行的传输不在其中。 */
export const ALLOWED_SUBMODULE_SCHEMES = ['https://', 'http://', 'ssh://', 'git://', 'file://'] as const

const MAX_URL_LENGTH = 2_000
const MAX_PATH_LENGTH = 500
const MAX_NAME_LENGTH = 100

export type SubmoduleAddDraft = {
  url: string
  path: string
  name: string
  branch: string
}

export type SubmoduleAddErrors = Partial<Record<keyof SubmoduleAddDraft, string>>

/** 与后端一致的「含控制字符或空白」判定。 */
function hasIllegalCharacter(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f\s]/.test(value)
}

/** scp 形式 `[user@]host:path`：主机段不含 `/`，冒号后为路径。 */
function scpParts(value: string): { host: string; path: string } | null {
  const index = value.indexOf(':')
  if (index <= 0) return null
  const host = value.slice(0, index)
  const path = value.slice(index + 1)
  if (!host || host.includes('/') || !path) return null
  return { host, path }
}

/** 绝对路径判定：POSIX 以 / 开头；Windows 带盘符。 */
function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

export function hasEmbeddedCredentials(rawUrl: string): boolean {
  const url = rawUrl.trim()
  const schemeAt = url.indexOf('://')
  if (schemeAt >= 0) {
    const rest = url.slice(schemeAt + 3)
    const authorityEnd = rest.search(/[/?#]/)
    return (authorityEnd < 0 ? rest : rest.slice(0, authorityEnd)).includes('@')
  }
  const scp = scpParts(url)
  if (!scp) return false
  const at = scp.host.lastIndexOf('@')
  if (at < 0) return false
  // 裸 `git@host:` 是 SSH 常规写法，用户名本身不是秘密；只有带 `:` 的才算口令。
  return scp.host.slice(0, at).includes(':')
}

/** 地址校验：返回 null 表示通过，否则是可直接展示的中文原因。 */
export function validateSubmoduleUrl(rawUrl: string): string | null {
  const url = rawUrl.trim()
  if (!url) return 'Submodule 地址不能为空'
  if (url.length > MAX_URL_LENGTH) return `Submodule 地址过长（上限 ${MAX_URL_LENGTH} 字符）`
  if (url.startsWith('-')) return 'Submodule 地址不能以 - 开头，否则会被 Git 当成命令选项'
  if (hasIllegalCharacter(url)) return 'Submodule 地址不能包含空白或控制字符'
  const scheme = ALLOWED_SUBMODULE_SCHEMES.find((prefix) => url.startsWith(prefix))
  if (scheme) {
    return url.slice(scheme.length).replace(/^\/+/, '') ? null : 'Submodule 地址缺少主机与路径'
  }
  const schemeAt = url.indexOf('://')
  if (schemeAt > 0) return 'Submodule 地址协议不受支持，仅允许 https/http/ssh/git/file'
  if (isAbsolutePath(url)) return null
  const scp = scpParts(url)
  if (scp) {
    const at = scp.host.lastIndexOf('@')
    const userinfo = at >= 0 ? scp.host.slice(0, at) : ''
    const hostname = at >= 0 ? scp.host.slice(at + 1) : scp.host
    if (userinfo.includes(':')) return 'scp 形式地址不允许在用户名中携带口令，请改用 https 或凭据管理器'
    // `deploy@buildbox:/srv/repo.git` 是合法的 scp 写法（远端绝对路径），不能按本地路径误伤；
    // 真正的歧义由下面的主机名完整性规则挡住。
    if (hostname.includes('.') || hostname === 'localhost' || at >= 0) return null
    return '看起来像 git@host:path，但主机名不完整（需要带点的主机名或显式 user@host）'
  }
  return 'Submodule 地址需要是 https/http/ssh/git/file URL、git@host:path 形式或本地绝对路径'
}

/** 路径校验：必须是父仓库内的相对路径，且不占用 .git / .gitmodules。 */
export function validateSubmodulePath(rawPath: string): string | null {
  const path = rawPath.trim().replace(/\\/g, '/')
  if (!path) return null // 留空表示「按地址自动命名」，由后端推断
  if (path.startsWith('/')) return 'Submodule 路径必须是父仓库内的相对路径'
  if (path.endsWith('/')) return 'Submodule 路径不能以 / 结尾，请直接写目录名'
  if (path.includes('//')) return 'Submodule 路径不能包含连续斜杠'
  if (path.length > MAX_PATH_LENGTH) return `Submodule 路径过长（上限 ${MAX_PATH_LENGTH} 字符）`
  if (path.startsWith('-')) return 'Submodule 路径不能以 - 开头，否则会被 Git 当成命令选项'
  const segments = path.split('/').filter(Boolean)
  if (!segments.length) return 'Submodule 路径无效'
  if (segments.some((segment) => segment === '..')) return 'Submodule 路径不能包含 ..，否则会把内容写到仓库外'
  if (segments.some((segment) => segment.toLowerCase() === '.git')) return 'Submodule 路径不能占用 .git 目录'
  if (segments.some((segment) => segment.toLowerCase() === '.gitmodules')) return 'Submodule 路径不能占用 .gitmodules 配置文件'
  if (segments.some((segment) => /[<>:"|?*]/.test(segment) || hasIllegalCharacter(segment))) {
    return 'Submodule 路径包含非法字符（Windows 保留字符或控制字符）'
  }
  if (segments.some((segment) => /[. ]$/.test(segment))) return 'Submodule 路径段不能以 . 或空格结尾'
  return null
}

/** 段名校验：它同时是 `.gitmodules` 的 config 段名与 `.git/modules/<name>` 目录名。 */
export function validateSubmoduleName(rawName: string): string | null {
  const name = rawName.trim()
  if (!name) return null // 留空表示与路径同名，由后端补默认值
  if (name.length > MAX_NAME_LENGTH) return `Submodule 名称过长（上限 ${MAX_NAME_LENGTH} 字符）`
  if (name.startsWith('-')) return 'Submodule 名称不能以 - 开头，否则会被 Git 当成命令选项'
  if (/[/\\]/.test(name) || name.includes('..') || /\s/.test(name)) return 'Submodule 名称不能包含路径分隔符、.. 或空白'
  if (/[[\]"'~^:?*{]/.test(name) || name.startsWith('.') || name.endsWith('.') || name.endsWith('.lock')) {
    return 'Submodule 名称不能包含 config 特殊字符'
  }
  return null
}

export function validateSubmoduleBranch(rawBranch: string): string | null {
  const branch = rawBranch.trim()
  if (!branch) return null // 留空表示跟随父仓库记录的提交
  if (branch.startsWith('-')) return '跟踪分支不能以 - 开头，否则会被 Git 当成命令选项'
  if (hasIllegalCharacter(branch)) return '跟踪分支不能包含空白或控制字符'
  // Git 的分支规则细节（连续点、@{、末尾斜杠等）由后端 check-ref-format 裁决，这里只挡明显错误。
  if (/^[./]/.test(branch) || branch.includes('..') || branch.includes('@{') || /[/~^.]$/.test(branch) || branch.includes('//')) {
    return '跟踪分支名称不符合 Git 规则'
  }
  return null
}

/** 地址推断默认目录名，与后端 derived_path_from_url 一致。 */
export function deriveSubmodulePath(rawUrl: string): string {
  const url = rawUrl.trim().replace(/\/+$/, '')
  if (!url) return ''
  const schemeAt = url.indexOf('://')
  let relevant = url
  if (schemeAt >= 0) {
    const rest = url.slice(schemeAt + 3)
    const slash = rest.indexOf('/')
    if (slash < 0) return '' // https://host 没有路径段，不能拿主机名当目录
    relevant = rest.slice(slash + 1)
  }
  const tail = relevant.split(/[/]/).filter(Boolean).pop() ?? ''
  const last = tail.split(':').pop() ?? ''
  const stem = last.endsWith('.git') ? last.slice(0, -4) : last
  return stem === '.' || stem === '..' ? '' : stem
}

export type PathConflict = { kind: 'submodule' | 'nested'; message: string }

/**
 * 与现有 Submodule 列表的冲突预检。
 * 后端还会查索引与工作区，这里只覆盖「快照里已经看得见」的那部分，
 * 目的是让用户在点提交之前就得到字段级提示。
 */
export function findPathConflict(path: string, submodules: RepositorySubmodule[]): PathConflict | null {
  const normalized = path.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!normalized) return null
  const existing = submodules.map((item) => item.path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
  const hit = existing.find((item) => item.toLowerCase() === normalized.toLowerCase())
  if (hit) return { kind: 'submodule', message: `该路径已登记为 Submodule：${hit}` }
  const parent = existing.find((item) => normalized.toLowerCase().startsWith(`${item.toLowerCase()}/`))
  if (parent) return { kind: 'nested', message: `该路径位于已有 Submodule ${parent} 内部，Git 会拒绝嵌套工作区` }
  const child = existing.find((item) => item.toLowerCase().startsWith(`${normalized.toLowerCase()}/`))
  if (child) return { kind: 'nested', message: `该路径已是父目录的 Submodule ${child} 所在层级，请换个目录名` }
  return null
}

export function credentialNotice(rawUrl: string): string | null {
  const url = rawUrl.trim()
  if (!url) return null
  if (hasEmbeddedCredentials(url)) {
    return '地址内嵌凭据：Git 会把它明文写进 .gitmodules 并随提交公开，建议改用凭据管理器、SSH 或 token 助手'
  }
  if (url.startsWith('http://')) return '使用 http:// 明文传输，建议改用 https://'
  return null
}

/** 字段级校验汇总；返回空对象表示可以提交。 */
export function validateSubmoduleDraft(draft: SubmoduleAddDraft, submodules: RepositorySubmodule[]): SubmoduleAddErrors {
  const errors: SubmoduleAddErrors = {}
  const url = validateSubmoduleUrl(draft.url)
  if (url) errors.url = url
  const path = validateSubmodulePath(draft.path)
  if (path) errors.path = path
  const name = validateSubmoduleName(draft.name)
  if (name) errors.name = name
  const branch = validateSubmoduleBranch(draft.branch)
  if (branch) errors.branch = branch
  if (!errors.path) {
    const effectivePath = draft.path.trim() || deriveSubmodulePath(draft.url)
    if (!effectivePath && !errors.url) errors.url = '无法从地址推断目录名，请手动指定 Submodule 路径'
    else if (effectivePath) {
      const conflict = findPathConflict(effectivePath, submodules)
      if (conflict) errors.path = conflict.message
    }
  }
  return errors
}

export function canSubmitSubmoduleDraft(draft: SubmoduleAddDraft, submodules: RepositorySubmodule[]): boolean {
  return Object.keys(validateSubmoduleDraft(draft, submodules)).length === 0
}

/** 后端预览 → 用户确认 → 执行，与远程管理同一套约定。 */
export function needsSubmoduleConfirmation(report: SubmoduleOperationReport): boolean {
  return report.executed === false && report.requiresConfirmation === true
}

export function submoduleConfirmationText(report: SubmoduleOperationReport): string {
  const lines = [report.summary, ...(report.warnings ?? []).map((warning) => `· ${warning}`)]
  const affected = (report.affected ?? []).slice(0, 8)
  if (affected.length) lines.push(`受影响：${affected.join('、')}`)
  return lines.join('\n')
}

/** 克隆对话框的浅克隆深度：空表示不限制。 */
export function parseCloneDepth(raw: string): { depth: number | null; error: string | null } {
  const trimmed = raw.trim()
  if (!trimmed) return { depth: null, error: null }
  const depth = Number(trimmed)
  if (!Number.isInteger(depth) || depth <= 0) return { depth: null, error: '浅克隆深度需要是正整数' }
  if (depth > 10_000) return { depth: null, error: '浅克隆深度上限为 10000' }
  return { depth, error: null }
}
