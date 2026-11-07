import type { ReflogEntry } from '../../repository'

type Translate = (key: string, params?: Record<string, string | number>) => string

const REFLOG_ACTION_KEYS: Record<string, string> = {
  commit: 'reflog.kind.commit',
  checkout: 'reflog.kind.checkout',
  reset: 'reflog.kind.reset',
  merge: 'reflog.kind.merge',
  rebase: 'reflog.kind.rebase',
  pull: 'reflog.kind.pull',
  revert: 'reflog.kind.revert',
  amend: 'reflog.kind.amend',
  other: 'reflog.kind.other',
}

export function reflogActionLabel(action: string, t: Translate): string {
  return REFLOG_ACTION_KEYS[action] ? t(REFLOG_ACTION_KEYS[action]) : action
}

/** 恢复动作的后果说明：供确认对话框统一展示，避免 UI 文案与后端语义漂移。 */
export function describeReflogRestore(entry: ReflogEntry, action: 'checkout' | 'branch' | 'reset', t: Translate): string {
  const entryLabel = `${entry.selector}（${entry.shortHash} ${entry.commitTitle || t('reflog.untitled')}）`
  switch (action) {
    case 'checkout':
      return t('reflog.restore.checkout', { entry: entryLabel })
    case 'branch':
      return t('reflog.restore.branch', { entry: entryLabel })
    case 'reset':
      return t('reflog.restore.reset', { entry: entryLabel })
  }
}

/** Reset 模式说明：文案与后端 git_recovery 的 soft/mixed/hard 语义一一对应。 */
const RESET_MODE_KEYS: Record<'soft' | 'mixed' | 'hard', string> = {
  soft: 'reset.mode.softHint',
  mixed: 'reset.mode.mixedHint',
  hard: 'reset.mode.hardHint',
}

export function resetModeDescription(mode: 'soft' | 'mixed' | 'hard', t: Translate): string {
  return t(RESET_MODE_KEYS[mode])
}

export function resetNeedsDangerAck(mode: 'soft' | 'mixed' | 'hard'): boolean {
  return mode === 'hard'
}
