import type { RepositoryOperationState } from '../../repository'

/**
 * 'revert' 由后端 repository_operation 在检测到 .git/REVERT_HEAD 时下发（任务 #24）。
 * git-models 的 kind 联合扩展前，用本地超集保持编译通过；联合扩展后该超集自然收敛，
 * 本文件无需再改（见交付给组长的 packages/git-models 逐字片段）。
 */
export type PanelOperationKind = RepositoryOperationState['kind'] | 'revert'

/** 后端 kind 是运行时下发的字符串；集中一处收敛，避免散落的 as 断言。 */
export function asPanelKind(kind: RepositoryOperationState['kind']): PanelOperationKind {
  return kind as PanelOperationKind
}

export function continueActionLabel(kind: PanelOperationKind): string {
  if (kind === 'rebase') return '继续变基'
  if (kind === 'revert') return '继续还原'
  return '继续操作'
}

/** Git 支持 --skip 的操作类型；merge 冲突没有“跳过”语义。 */
export function canSkipOperation(kind: PanelOperationKind): boolean {
  return kind === 'rebase' || kind === 'cherry-pick' || kind === 'revert'
}

/** 有步骤序列可循的操作展示进度线路（rebase 逐步重放、多提交 revert 逐步还原）。 */
export function showsStepRoute(kind: PanelOperationKind): boolean {
  return kind === 'rebase' || kind === 'revert'
}

export function stepRouteLabel(kind: PanelOperationKind): string {
  return kind === 'rebase' ? '变基线路' : '还原序列'
}
