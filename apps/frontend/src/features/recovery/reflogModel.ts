import type { ReflogEntry } from '@branchline/git-models'

export const REFLOG_ACTION_LABELS: Record<string, string> = {
  commit: '提交',
  checkout: '检出',
  reset: '回退（Reset）',
  merge: '合并',
  rebase: '变基',
  pull: '拉取',
  revert: '还原',
  amend: '修订',
  other: '其他',
}

export function reflogActionLabel(action: string): string {
  return REFLOG_ACTION_LABELS[action] ?? action
}

/** 恢复动作的后果说明：供确认对话框统一展示，避免 UI 文案与后端语义漂移。 */
export function describeReflogRestore(entry: ReflogEntry, action: 'checkout' | 'branch' | 'reset'): string {
  const entryLabel = `${entry.selector}（${entry.shortHash} ${entry.commitTitle || '无标题'}）`
  switch (action) {
    case 'checkout':
      return `将检出 ${entryLabel} 并进入分离 HEAD。当前分支不会移动；工作区必须干净。`
    case 'branch':
      return `将在 ${entryLabel} 上新建分支，当前分支与工作区不受影响。`
    case 'reset':
      return `将把当前分支移动到 ${entryLabel}。选择 hard 模式时，之后的提交、暂存与工作区修改都会被丢弃；旧提交只能通过 Reflog / Bisect 面板找回。`
  }
}

/** Reset 模式说明：文案与后端 git_recovery 的 soft/mixed/hard 语义一一对应。 */
export const RESET_MODE_DESCRIPTIONS: Record<'soft' | 'mixed' | 'hard', string> = {
  soft: 'soft：只移动分支指针，暂存区与工作区全部保留。',
  mixed: 'mixed：移动分支指针并重置暂存区，工作区修改保留。',
  hard: 'hard：分支指针、暂存区、工作区全部回退，未提交修改将丢失（危险）。',
}

export function resetNeedsDangerAck(mode: 'soft' | 'mixed' | 'hard'): boolean {
  return mode === 'hard'
}
