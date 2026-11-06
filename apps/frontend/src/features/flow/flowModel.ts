import type {
  GitflowBranches,
  GitflowConfig,
  GitflowFinishReport,
  GitflowKind,
  GitflowStepStatus,
} from '../../repository'

/**
 * Gitflow 面板的纯逻辑：名称 / 前缀校验、分组映射、完成报告展示模型。
 *
 * 组件只负责装配；这里不依赖 React，也不依赖 App 全局状态。
 * 校验规则与后端 git_flow.rs 对齐：拒绝空串、`-` 开头（选项注入）、空白与
 * 换行 / NUL / 控制字符，再按 Git 引用命名规则拒绝 `..`、`@{`、`~^:?*[\` 等。
 * 最终仍由后端 `git check-ref-format` 裁决。
 */

export const GITFLOW_KINDS: GitflowKind[] = ['feature', 'release', 'hotfix', 'support']

const KIND_LABELS: Record<GitflowKind, string> = {
  feature: '功能分支',
  release: '发布分支',
  hotfix: '热修复分支',
  support: '维护分支',
}

const KIND_NOTES: Record<GitflowKind, string> = {
  feature: '从 develop 切出，完成后 --no-ff 合并回 develop 并删除',
  release: '从 main 切出，完成后合并到 main 与 develop，可打标签并删除',
  hotfix: '从 main 切出，完成后合并到 main 与 develop，可打标签并删除',
  support: '长期维护分支，不执行完成操作；需要时手动归档',
}

const STEP_LABELS: Record<GitflowStepStatus, string> = {
  completed: '完成',
  skipped: '跳过',
  failed: '失败',
  conflict: '冲突',
}

export type GitflowGroup = {
  kind: GitflowKind
  label: string
  note: string
  branches: { name: string; full: string }[]
}

export function gitflowKindLabel(kind: GitflowKind): string {
  return KIND_LABELS[kind]
}

export function gitflowKindNote(kind: GitflowKind): string {
  return KIND_NOTES[kind]
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
export function validateGitflowBranchName(raw: string): string | null {
  const name = raw.trim()
  if (!name) return '分支名不能为空'
  if ([...name].length > 200) return '分支名过长（上限 200 字符）'
  if (name.startsWith('-')) return '分支名不能以 - 开头，否则会被 Git 当成命令选项'
  if (name === 'HEAD') return '分支名不能是 HEAD'
  if (hasForbiddenReferenceCharacter(name)) return '分支名不能包含空白、..、@{、// 或 ~ ^ : ? * [ \\ 等特殊字符'
  if (name.endsWith('.') || name.endsWith('/') || name.endsWith('.lock')) return '分支名不能以 . 或 / 结尾，也不能以 .lock 结尾'
  return null
}

/** 允许空前缀用于标签；分支前缀为空会让所有分支落进同一组，故不允许。 */
export function validateGitflowPrefix(raw: string, allowEmpty = false): string | null {
  const prefix = raw.trim()
  if (!prefix) return allowEmpty ? null : '前缀不能为空'
  if ([...prefix].length > 100) return '前缀过长（上限 100 字符）'
  if (prefix.startsWith('-')) return '前缀不能以 - 开头，否则会被 Git 当成命令选项'
  if (hasForbiddenReferenceCharacter(prefix)) return '前缀不能包含空白、..、@{、// 或 ~ ^ : ? * [ \\ 等特殊字符'
  return null
}

/** 短名校验：先检查用户输入本身，再检查拼上前缀后的完整分支名。 */
export function validateGitflowLeafName(
  config: GitflowConfig,
  kind: GitflowKind,
  raw: string,
): string | null {
  const leaf = gitflowLeafName(config, kind, raw)
  if (!leaf) return '分支名不能为空'
  if (leaf.startsWith('-')) return '分支名不能以 - 开头，否则会被 Git 当成命令选项'
  if (hasForbiddenReferenceCharacter(leaf)) return '分支名不能包含空白、..、@{、// 或 ~ ^ : ? * [ \\ 等特殊字符'
  return validateGitflowBranchName(gitflowBranchName(config, kind, raw))
}

export function validateGitflowTagName(config: GitflowConfig, raw: string): string | null {
  const name = raw.trim()
  if (name.startsWith('-')) return '标签名不能以 - 开头，否则会被 Git 当成命令选项'
  const tag = `${config.tagPrefix}${name}`.trim()
  if (!tag) return '标签名不能为空'
  return validateGitflowBranchName(tag)
}

/** 返回全部错误，组件可逐条展示；空数组表示配置可保存。 */
export function validateGitflowConfig(config: GitflowConfig): string[] {
  const errors: string[] = []
  const main = validateGitflowBranchName(config.mainBranch)
  if (main) errors.push(`主干分支：${main}`)
  const develop = validateGitflowBranchName(config.developBranch)
  if (develop) errors.push(`develop 分支：${develop}`)
  if (!main && !develop && config.mainBranch.trim() === config.developBranch.trim()) {
    errors.push('主干分支与 develop 分支不能相同')
  }
  for (const [label, prefix] of [
    ['feature 前缀', config.featurePrefix],
    ['release 前缀', config.releasePrefix],
    ['hotfix 前缀', config.hotfixPrefix],
    ['support 前缀', config.supportPrefix],
  ] as const) {
    const error = validateGitflowPrefix(prefix)
    if (error) errors.push(`${label}：${error}`)
  }
  const tagPrefix = validateGitflowPrefix(config.tagPrefix, true)
  if (tagPrefix) errors.push(`标签前缀：${tagPrefix}`)
  return errors
}

export function gitflowGroups(branches: GitflowBranches | null, config: GitflowConfig): GitflowGroup[] {
  if (!branches) return []
  return GITFLOW_KINDS.map((kind) => ({
    kind,
    label: gitflowKindLabel(kind),
    note: gitflowKindNote(kind),
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

export function stepStatusLabel(status: GitflowStepStatus): string {
  return STEP_LABELS[status] ?? status
}

export type FinishReportTone = 'success' | 'conflict' | 'failed'

export function finishReportTone(report: GitflowFinishReport): FinishReportTone {
  if (report.completed) return 'success'
  return report.conflicts ? 'conflict' : 'failed'
}

export function finishReportHeadline(report: GitflowFinishReport): string {
  switch (finishReportTone(report)) {
    case 'success':
      return `已完成 ${report.branch}`
    case 'conflict':
      return `${report.branch} 存在合并冲突`
    default:
      return `${report.branch} 未完成`
  }
}

/** 报告展示行：每个步骤 + guidance；冲突时明确提示合并状态仍保留。 */
export function finishReportDetailLines(report: GitflowFinishReport): string[] {
  const lines = report.steps.map((step) => {
    const suffix = step.detail ? `：${step.detail}` : ''
    return `${stepStatusLabel(step.status)} · ${step.action}${suffix}`
  })
  if (report.guidance) lines.push(report.guidance)
  return lines
}

export function finishReportStepCounts(report: GitflowFinishReport): Record<GitflowStepStatus, number> {
  const counts: Record<GitflowStepStatus, number> = { completed: 0, skipped: 0, failed: 0, conflict: 0 }
  for (const step of report.steps) counts[step.status] += 1
  return counts
}
