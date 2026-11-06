import type { RepositorySubmodule, SubmoduleOperationReport } from '../../repository'

type Translate = (key: string, params?: Record<string, string | number>) => string

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

/** 地址校验：返回 null 表示通过，否则是可直接展示的原因。 */
export function validateSubmoduleUrl(rawUrl: string, t: Translate): string | null {
  const url = rawUrl.trim()
  if (!url) return t('repository.submoduleForm.urlRequired')
  if (url.length > MAX_URL_LENGTH) return t('repository.submoduleForm.urlTooLong', { count: MAX_URL_LENGTH })
  if (url.startsWith('-')) return t('repository.submoduleForm.urlOptionLike')
  if (hasIllegalCharacter(url)) return t('repository.submoduleForm.urlIllegalCharacter')
  const scheme = ALLOWED_SUBMODULE_SCHEMES.find((prefix) => url.startsWith(prefix))
  if (scheme) {
    return url.slice(scheme.length).replace(/^\/+/, '') ? null : t('repository.submoduleForm.urlMissingHostPath')
  }
  const schemeAt = url.indexOf('://')
  if (schemeAt > 0) return t('repository.submoduleForm.urlUnsupportedScheme')
  if (isAbsolutePath(url)) return null
  const scp = scpParts(url)
  if (scp) {
    const at = scp.host.lastIndexOf('@')
    const userinfo = at >= 0 ? scp.host.slice(0, at) : ''
    const hostname = at >= 0 ? scp.host.slice(at + 1) : scp.host
    if (userinfo.includes(':')) return t('repository.submoduleForm.scpPassword')
    // `deploy@buildbox:/srv/repo.git` 是合法的 scp 写法（远端绝对路径），不能按本地路径误伤；
    // 真正的歧义由下面的主机名完整性规则挡住。
    if (hostname.includes('.') || hostname === 'localhost' || at >= 0) return null
    return t('repository.submoduleForm.scpIncompleteHost')
  }
  return t('repository.submoduleForm.urlFormat')
}

/** 路径校验：必须是父仓库内的相对路径，且不占用 .git / .gitmodules。 */
export function validateSubmodulePath(rawPath: string, t: Translate): string | null {
  const path = rawPath.trim().replace(/\\/g, '/')
  if (!path) return null // 留空表示「按地址自动命名」，由后端推断
  if (path.startsWith('/')) return t('repository.submoduleForm.pathRelative')
  if (path.endsWith('/')) return t('repository.submoduleForm.pathTrailingSlash')
  if (path.includes('//')) return t('repository.submoduleForm.pathDoubleSlash')
  if (path.length > MAX_PATH_LENGTH) return t('repository.submoduleForm.pathTooLong', { count: MAX_PATH_LENGTH })
  if (path.startsWith('-')) return t('repository.submoduleForm.pathOptionLike')
  const segments = path.split('/').filter(Boolean)
  if (!segments.length) return t('repository.submoduleForm.pathInvalid')
  if (segments.some((segment) => segment === '..')) return t('repository.submoduleForm.pathParentSegment')
  if (segments.some((segment) => segment.toLowerCase() === '.git')) return t('repository.submoduleForm.pathGitDir')
  if (segments.some((segment) => segment.toLowerCase() === '.gitmodules')) return t('repository.submoduleForm.pathGitmodulesFile')
  if (segments.some((segment) => /[<>:"|?*]/.test(segment) || hasIllegalCharacter(segment))) {
    return t('repository.submoduleForm.pathIllegalCharacter')
  }
  if (segments.some((segment) => /[. ]$/.test(segment))) return t('repository.submoduleForm.pathTrailingDotOrSpace')
  return null
}

/** 段名校验：它同时是 `.gitmodules` 的 config 段名与 `.git/modules/<name>` 目录名。 */
export function validateSubmoduleName(rawName: string, t: Translate): string | null {
  const name = rawName.trim()
  if (!name) return null // 留空表示与路径同名，由后端补默认值
  if (name.length > MAX_NAME_LENGTH) return t('repository.submoduleForm.nameTooLong', { count: MAX_NAME_LENGTH })
  if (name.startsWith('-')) return t('repository.submoduleForm.nameOptionLike')
  if (/[/\\]/.test(name) || name.includes('..') || /\s/.test(name)) return t('repository.submoduleForm.nameSeparators')
  if (/[[\]"'~^:?*{]/.test(name) || name.startsWith('.') || name.endsWith('.') || name.endsWith('.lock')) {
    return t('repository.submoduleForm.nameConfigCharacters')
  }
  return null
}

export function validateSubmoduleBranch(rawBranch: string, t: Translate): string | null {
  const branch = rawBranch.trim()
  if (!branch) return null // 留空表示跟随父仓库记录的提交
  if (branch.startsWith('-')) return t('repository.submoduleForm.branchOptionLike')
  if (hasIllegalCharacter(branch)) return t('repository.submoduleForm.branchIllegalCharacter')
  // Git 的分支规则细节（连续点、@{、末尾斜杠等）由后端 check-ref-format 裁决，这里只挡明显错误。
  if (/^[./]/.test(branch) || branch.includes('..') || branch.includes('@{') || /[/~^.]$/.test(branch) || branch.includes('//')) {
    return t('repository.submoduleForm.branchFormat')
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
export function findPathConflict(path: string, submodules: RepositorySubmodule[], t: Translate): PathConflict | null {
  const normalized = path.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!normalized) return null
  const existing = submodules.map((item) => item.path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
  const hit = existing.find((item) => item.toLowerCase() === normalized.toLowerCase())
  if (hit) return { kind: 'submodule', message: t('repository.submoduleForm.conflictRegistered', { path: hit }) }
  const parent = existing.find((item) => normalized.toLowerCase().startsWith(`${item.toLowerCase()}/`))
  if (parent) return { kind: 'nested', message: t('repository.submoduleForm.conflictInsideParent', { path: parent }) }
  const child = existing.find((item) => item.toLowerCase().startsWith(`${normalized.toLowerCase()}/`))
  if (child) return { kind: 'nested', message: t('repository.submoduleForm.conflictContainsChild', { path: child }) }
  return null
}

export function credentialNotice(rawUrl: string, t: Translate): string | null {
  const url = rawUrl.trim()
  if (!url) return null
  if (hasEmbeddedCredentials(url)) {
    return t('repository.submoduleForm.embeddedCredentials')
  }
  if (url.startsWith('http://')) return t('repository.submoduleForm.plaintextHttp')
  return null
}

/** 字段级校验汇总；返回空对象表示可以提交。 */
export function validateSubmoduleDraft(draft: SubmoduleAddDraft, submodules: RepositorySubmodule[], t: Translate): SubmoduleAddErrors {
  const errors: SubmoduleAddErrors = {}
  const url = validateSubmoduleUrl(draft.url, t)
  if (url) errors.url = url
  const path = validateSubmodulePath(draft.path, t)
  if (path) errors.path = path
  const name = validateSubmoduleName(draft.name, t)
  if (name) errors.name = name
  const branch = validateSubmoduleBranch(draft.branch, t)
  if (branch) errors.branch = branch
  if (!errors.path) {
    const effectivePath = draft.path.trim() || deriveSubmodulePath(draft.url)
    if (!effectivePath && !errors.url) errors.url = t('repository.submoduleForm.cannotDerivePath')
    else if (effectivePath) {
      const conflict = findPathConflict(effectivePath, submodules, t)
      if (conflict) errors.path = conflict.message
    }
  }
  return errors
}

export function canSubmitSubmoduleDraft(draft: SubmoduleAddDraft, submodules: RepositorySubmodule[], t: Translate): boolean {
  return Object.keys(validateSubmoduleDraft(draft, submodules, t)).length === 0
}

/** 后端预览 → 用户确认 → 执行，与远程管理同一套约定。 */
export function needsSubmoduleConfirmation(report: SubmoduleOperationReport): boolean {
  return report.executed === false && report.requiresConfirmation === true
}

export function submoduleConfirmationText(report: SubmoduleOperationReport, t: Translate): string {
  const lines = [report.summary, ...(report.warnings ?? []).map((warning) => `· ${warning}`)]
  const affected = (report.affected ?? []).slice(0, 8)
  if (affected.length) lines.push(t('repository.submoduleForm.affected', { paths: affected.join('、') }))
  return lines.join('\n')
}

/** 克隆对话框的浅克隆深度：空表示不限制。 */
export function parseCloneDepth(raw: string, t: Translate): { depth: number | null; error: string | null } {
  const trimmed = raw.trim()
  if (!trimmed) return { depth: null, error: null }
  const depth = Number(trimmed)
  if (!Number.isInteger(depth) || depth <= 0) return { depth: null, error: t('repository.submoduleForm.depthPositiveInteger') }
  if (depth > 10_000) return { depth: null, error: t('repository.submoduleForm.depthLimit') }
  return { depth, error: null }
}
