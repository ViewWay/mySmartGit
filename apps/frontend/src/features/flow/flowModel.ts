import type {
  GitflowBranches,
  GitflowConfig,
  GitflowFinishReport,
  GitflowKind,
  GitflowStepStatus,
} from '../../repository'

type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * Gitflow 面板的纯逻辑：名称 / 前缀校验、分组映射、完成报告展示模型。
 *
 * 组件只负责装配；这里不依赖 React，也不依赖 App 全局状态。
 * 校验规则与后端 git_flow.rs 对齐：拒绝空串、`-` 开头（选项注入）、空白与
 * 换行 / NUL / 控制字符，再按 Git 引用命名规则拒绝 `..`、`@{`、`~^:?*[\` 等。
 * 最终仍由后端 `git check-ref-format` 裁决。
 */

export const GITFLOW_KINDS: GitflowKind[] = ['feature', 'release', 'hotfix', 'support']

const KIND_KEYS: Record<GitflowKind, string> = {
  feature: 'flow.branchFeature',
  release: 'flow.branchRelease',
  hotfix: 'flow.branchHotfix',
  support: 'flow.branchSupport',
}

const KIND_NOTE_KEYS: Record<GitflowKind, string> = {
  feature: 'flow.branchFeatureHint',
  release: 'flow.branchReleaseHint',
  hotfix: 'flow.branchReleaseHint',
  support: 'flow.branchSupportHint',
}

const STEP_KEYS: Record<GitflowStepStatus, string> = {
  completed: 'flow.finish',
  skipped: 'flow.skip',
  failed: 'flow.failed',
  conflict: 'flow.conflict',
}

export type GitflowGroup = {
  kind: GitflowKind
  label: string
  note: string
  branches: { name: string; full: string }[]
}

export function gitflowKindLabel(kind: GitflowKind, t: Translate): string {
  return t(KIND_KEYS[kind])
}

export function gitflowKindNote(kind: GitflowKind, t: Translate): string {
  return t(KIND_NOTE_KEYS[kind])
}

export function gitflowPrefix(config: GitflowConfig, kind: GitflowKind): string {
  switch (kind) {
    case 'feature':
      return config.featurePrefix
    case 'release':
      return config.releasePrefix
    case 'hotfix':
      return config.hotfixPrefix
    default:
      return config.supportPrefix
  }
}

/** feature 从 develop 起；release / hotfix / support 从 main 起。 */
export function gitflowDefaultBase(config: GitflowConfig, kind: GitflowKind): string {
  return kind === 'feature' ? config.developBranch : config.mainBranch
}

/** 去掉用户可能重复输入的自身前缀：`feature/login` 与 `login` 等价。 */
export function gitflowLeafName(config: GitflowConfig, kind: GitflowKind, raw: string): string {
  const name = raw.trim()
  const prefix = gitflowPrefix(config, kind)
  return prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name
}

export function gitflowBranchName(config: GitflowConfig, kind: GitflowKind, raw: string): string {
  return `${gitflowPrefix(config, kind)}${gitflowLeafName(config, kind, raw)}`
}

function hasForbiddenReferenceCharacter(value: string): boolean {
  return /[\s~^:?*\[\]\\]/.test(value) || value.includes('..') || value.includes('@{') || value.includes('//')
}

/** 任意分支名（配置里的 main / develop 与拼接后的完整分支名）。 */
export function validateGitflowBranchName(raw: string, t: Translate): string | null {
  const name = raw.trim()
  if (!name) return t('flow.nameRequired')
  if ([...name].length > 200) return t('flow.nameTooLong')
  if (name.startsWith('-')) return t('flow.nameOptionLike')
  if (name === 'HEAD') return t('flow.nameHead')
  if (hasForbiddenReferenceCharacter(name)) return t('flow.nameSpecialChars')
  if (name.endsWith('.') || name.endsWith('/') || name.endsWith('.lock')) return t('flow.nameBadSuffix')
  return null
}

/** 允许空前缀用于标签；分支前缀为空会让所有分支落进同一组，故不允许。 */
export function validateGitflowPrefix(raw: string, allowEmpty: boolean, t: Translate): string | null {
  const prefix = raw.trim()
  if (!prefix) return allowEmpty ? null : t('flow.prefixRequired')
  if ([...prefix].length > 100) return t('flow.prefixTooLong')
  if (prefix.startsWith('-')) return t('flow.prefixOptionLike')
  if (hasForbiddenReferenceCharacter(prefix)) return t('flow.prefixSpecialChars')
  return null
}

/** 短名校验：先检查用户输入本身，再检查拼上前缀后的完整分支名。 */
export function validateGitflowLeafName(
  config: GitflowConfig,
  kind: GitflowKind,
  raw: string,
  t: Translate,
): string | null {
  const leaf = gitflowLeafName(config, kind, raw)
  if (!leaf) return t('flow.nameRequired')
  if (leaf.startsWith('-')) return t('flow.nameOptionLike')
  if (hasForbiddenReferenceCharacter(leaf)) return t('flow.nameSpecialChars')
  return validateGitflowBranchName(gitflowBranchName(config, kind, raw), t)
}

export function validateGitflowTagName(config: GitflowConfig, raw: string, t: Translate): string | null {
  const name = raw.trim()
  if (name.startsWith('-')) return t('flow.tagNameOptionLike')
  const tag = `${config.tagPrefix}${name}`.trim()
  if (!tag) return t('flow.tagNameRequired')
  return validateGitflowBranchName(tag, t)
}

/** 返回全部错误，组件可逐条展示；空数组表示配置可保存。 */
export function validateGitflowConfig(config: GitflowConfig, t: Translate): string[] {
  const errors: string[] = []
  const main = validateGitflowBranchName(config.mainBranch, t)
  if (main) errors.push(t('flow.mainBranchError', { error: main }))
  const develop = validateGitflowBranchName(config.developBranch, t)
  if (develop) errors.push(t('flow.developBranchError', { error: develop }))
  if (!main && !develop && config.mainBranch.trim() === config.developBranch.trim()) {
    errors.push(t('flow.mainEqualsDevelop'))
  }
  for (const [label, prefix] of [
    [t('flow.prefixFeature'), config.featurePrefix],
    [t('flow.prefixRelease'), config.releasePrefix],
    [t('flow.prefixHotfix'), config.hotfixPrefix],
    [t('flow.prefixSupport'), config.supportPrefix],
  ] as const) {
    const error = validateGitflowPrefix(prefix, false, t)
    if (error) errors.push(`${label}：${error}`)
  }
  const tagPrefix = validateGitflowPrefix(config.tagPrefix, true, t)
  if (tagPrefix) errors.push(t('flow.tagPrefixWith', { prefix: tagPrefix }))
  return errors
}

export function gitflowGroups(branches: GitflowBranches | null, config: GitflowConfig, t: Translate): GitflowGroup[] {
  if (!branches) return []
  return GITFLOW_KINDS.map((kind) => ({
    kind,
    label: gitflowKindLabel(kind, t),
    note: gitflowKindNote(kind, t),
    branches: branches[kind].map((name) => ({
      name,
      full: `${gitflowPrefix(config, kind)}${name}`,
    })),
  }))
}

export function canFinishGitflow(kind: GitflowKind): boolean {
  return kind !== 'support'
}

export function canTagGitflow(kind: GitflowKind): boolean {
  return kind === 'release' || kind === 'hotfix'
}

export function gitflowTagName(config: GitflowConfig, name: string): string {
  return `${config.tagPrefix}${name.trim()}`
}

export function stepStatusLabel(status: GitflowStepStatus, t: Translate): string {
  return t(STEP_KEYS[status])
}

export type FinishReportTone = 'success' | 'conflict' | 'failed'

export function finishReportTone(report: GitflowFinishReport): FinishReportTone {
  if (report.completed) return 'success'
  return report.conflicts ? 'conflict' : 'failed'
}

export function finishReportHeadline(report: GitflowFinishReport, t: Translate): string {
  switch (finishReportTone(report)) {
    case 'success':
      return t('flow.finishedBranch', { branch: report.branch })
    case 'conflict':
      return t('flow.conflictedBranch', { branch: report.branch })
    default:
      return t('flow.unfinishedBranch', { branch: report.branch })
  }
}

/** 报告展示行：每个步骤 + guidance；冲突时明确提示合并状态仍保留。 */
export function finishReportDetailLines(report: GitflowFinishReport, t: Translate): string[] {
  const lines = report.steps.map((step) => {
    const suffix = step.detail ? `：${step.detail}` : ''
    return `${stepStatusLabel(step.status, t)} · ${step.action}${suffix}`
  })
  if (report.guidance) lines.push(report.guidance)
  return lines
}

export function finishReportStepCounts(report: GitflowFinishReport): Record<GitflowStepStatus, number> {
  const counts: Record<GitflowStepStatus, number> = { completed: 0, skipped: 0, failed: 0, conflict: 0 }
  for (const step of report.steps) counts[step.status] += 1
  return counts
}
