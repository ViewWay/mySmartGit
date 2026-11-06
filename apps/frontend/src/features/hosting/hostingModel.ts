import type {
  CreatePullRequestInput,
  HostingCiStatus,
  HostingProvider,
  HostingPullRequest,
  HostingSettings,
} from '../../repository'

/**
 * PR/MR 面板的纯逻辑：提供商文案、CI 状态映射、表单校验、默认分支推断。
 *
 * 组件只负责装配；这里不依赖 React，也不依赖 App 全局状态，便于 vitest 覆盖边界。
 * 校验规则与后端 git_hosting.rs 保持一致：主机名拒绝协议 / 路径 / 凭据，
 * 令牌拒绝空白与控制字符，分支名拒绝 Git 不允许的字符与源/目标相同。
 */

export const HOSTING_PROVIDERS: readonly HostingProvider[] = ['github', 'gitlab']

export const HOSTING_PROVIDER_LABELS: Record<HostingProvider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
}

export const HOSTING_DEFAULT_HOSTS: Record<HostingProvider, string> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
}

export type HostingCiTone = 'success' | 'failure' | 'pending' | 'unknown'

export type CreatePullRequestForm = {
  title: string
  body: string
  sourceBranch: string
  targetBranch: string
  draft: boolean
}

const CI_LABELS: Record<HostingCiStatus, string> = {
  success: 'CI 通过',
  failure: 'CI 失败',
  pending: 'CI 进行中',
  unknown: 'CI 未知',
}

const CI_TONES: Record<HostingCiStatus, HostingCiTone> = {
  success: 'success',
  failure: 'failure',
  pending: 'pending',
  unknown: 'unknown',
}

export function isHostingProvider(value: string): value is HostingProvider {
  return value === 'github' || value === 'gitlab'
}

export function hostingProviderLabel(provider: string): string {
  return provider === 'gitlab' ? 'GitLab' : 'GitHub'
}

export function hostingDefaultHost(provider: HostingProvider): string {
  return HOSTING_DEFAULT_HOSTS[provider]
}

/** 未知值一律按 unknown 处理，避免后端新增状态导致样式错位。 */
export function hostingCiTone(status: string): HostingCiTone {
  return CI_TONES[status as HostingCiStatus] ?? 'unknown'
}

export function hostingCiLabel(status: string): string {
  return CI_LABELS[status as HostingCiStatus] ?? CI_LABELS.unknown
}

/** 设置页摘要：令牌只显示「已配置 / 未配置」，不回显内容。 */
export function hostingSettingsSummary(settings: HostingSettings | null): string {
  if (!settings) return '正在读取托管设置…'
  const label = hostingProviderLabel(settings.provider)
  const host = settings.host?.trim() || hostingDefaultHost(settings.provider)
  return settings.tokenConfigured
    ? `${label}（${host}）已保存访问令牌`
    : `${label}（${host}）尚未保存访问令牌`
}

function isControl(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value)
}

function isControlOrSpace(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0020\u007f]/.test(value)
}

/** 空字符串表示「保留已保存的令牌」，返回 null 表示通过。 */
export function validateHostingToken(token: string): string | null {
  const value = token.trim()
  if (!value) return null
  if ([...value].length > 4096) return '访问令牌过长'
  if (isControlOrSpace(value)) return '访问令牌不能包含空白或控制字符'
  return null
}

/** 空字符串表示使用提供商默认主机，返回 null 表示通过。 */
export function validateHostingHost(host: string, provider: HostingProvider): string | null {
  const value = host.trim().toLowerCase()
  if (!value) return null
  if (value.length > 259) return '主机名过长'
  if (isControlOrSpace(value)) return '主机名不能包含空白或控制字符'
  for (const rejected of ['://', '/', '\\', '@', '?', '#']) {
    if (value.includes(rejected)) {
      return `主机名必须是裸主机名，${hostingProviderLabel(provider)} 默认是 ${hostingDefaultHost(provider)}`
    }
  }
  const [hostname, port] = splitHostPort(value)
  if (!hostname) return '主机名不能为空'
  const labels = hostname.split('.')
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
      return '主机名格式无效'
    }
  }
  if (port !== null) {
    if (!/^\d+$/.test(port)) return '主机端口格式无效'
    const numeric = Number(port)
    if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) return '主机端口格式无效'
  }
  return null
}

function splitHostPort(value: string): [string, string | null] {
  const index = value.lastIndexOf(':')
  if (index < 0) return [value, null]
  return [value.slice(0, index), value.slice(index + 1)]
}

function validateBranchName(branch: string, label: string): string | null {
  const value = branch.trim()
  if (!value) return `${label}不能为空`
  if ([...value].length > 255) return `${label}过长`
  if (isControlOrSpace(value)) return `${label}不能包含空白或控制字符`
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/')) return `${label}格式无效`
  if (value.endsWith('.') || value.endsWith('.lock')) return `${label}格式无效`
  if (
    value.includes('..') ||
    value.includes('//') ||
    [...value].some((character) => '\\~^:?*['.includes(character))
  ) {
    return `${label}包含 Git 不允许的字符`
  }
  return null
}

/** 返回 null 表示通过；否则是给用户看的第一条错误。 */
export function validateCreatePullRequestForm(
  form: CreatePullRequestForm,
  provider: HostingProvider,
): string | null {
  const noun = provider === 'gitlab' ? 'MR' : 'PR'
  const title = form.title.trim()
  if (!title) return `${noun} 标题不能为空`
  if ([...title].length > 256) return `${noun} 标题过长（上限 256 字符）`
  if (isControl(title)) return `${noun} 标题不能包含换行或控制字符`
  if ([...form.body].length > 64 * 1024) return `${noun} 描述过长`
  if (form.body.includes('\0')) return `${noun} 描述不能包含 NUL`
  const source = validateBranchName(form.sourceBranch, '源分支')
  if (source) return source
  const target = validateBranchName(form.targetBranch, '目标分支')
  if (target) return target
  if (form.sourceBranch.trim() === form.targetBranch.trim()) {
    return '源分支与目标分支不能相同'
  }
  return null
}

/** 创建请求体：去掉首尾空白；GitLab 不使用 GitHub 风格的 draft 字段。 */
export function buildCreatePullRequestInput(
  form: CreatePullRequestForm,
  provider: HostingProvider,
): CreatePullRequestInput {
  return {
    title: form.title.trim(),
    body: form.body,
    sourceBranch: form.sourceBranch.trim(),
    targetBranch: form.targetBranch.trim(),
    draft: provider === 'github' ? form.draft : false,
  }
}

/** 列表状态文案：draft 优先于平台原始 state。 */
export function pullRequestStateLabel(pr: HostingPullRequest): string {
  if (pr.draft) return '草稿'
  if (pr.state === 'open' || pr.state === 'opened') return '开放'
  return pr.state
}

export function pullRequestBranchLabel(pr: HostingPullRequest): string {
  return `${pr.sourceBranch} → ${pr.targetBranch}`
}

/** 列表项摘要：状态 · 分支 · 作者。 */
export function summarizePullRequest(pr: HostingPullRequest): string {
  return `${pullRequestStateLabel(pr)} · ${pullRequestBranchLabel(pr)} · ${pr.author}`
}

/**
 * 从开放 PR/MR 的目标分支推断默认分支（取出现次数最多者）。
 * 没有任何数据时回退 main。
 */
export function inferDefaultBranch(pullRequests: HostingPullRequest[]): string {
  const counts = new Map<string, number>()
  for (const pr of pullRequests) {
    const branch = pr.targetBranch.trim()
    if (!branch) continue
    counts.set(branch, (counts.get(branch) ?? 0) + 1)
  }
  let best = 'main'
  let bestCount = 0
  for (const [branch, count] of counts) {
    if (count > bestCount) {
      best = branch
      bestCount = count
    }
  }
  return best
}
