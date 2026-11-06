import { translate, type Language } from '../i18n'
import { zh } from '../i18n/messages/zh'

export const menuActionHandlers = {
  'file.new-repository': 'new-repository',
  'file.open-repository': 'open-repository',
  'file.clone-repository': 'clone-repository',
  'file.close-repository': 'close-repository',
  'app.check-updates': 'check-updates',
  'app.preferences': 'preferences',
  'edit.find': 'find',
  'edit.find-next': 'find-next',
  'edit.find-previous': 'find-previous',
  'edit.search-repository': 'search-repository',
  'format.word-wrap': 'toggle-word-wrap',
  'format.diff-unified': 'diff-unified',
  'format.diff-split': 'diff-split',
  'format.show-whitespace': 'toggle-show-whitespace',
  'format.font-increase': 'font-increase',
  'format.font-decrease': 'font-decrease',
  'format.font-reset': 'font-reset',
  'view.history': 'view-history',
  'view.changes': 'view-changes',
  'view.stash': 'view-stash',
  'view.recovery': 'view-recovery',
  'view.search': 'view-search',
  'view.tree': 'view-tree',
  'view.compare': 'view-compare',
  'view.merge': 'view-merge',
  'view.terminal': 'view-terminal',
  'view.sidebar': 'toggle-sidebar',
  'view.inspector': 'toggle-inspector',
  'view.theme.light': 'theme-light',
  'view.theme.dark': 'theme-dark',
  'view.language.zh': 'language-zh',
  'view.language.en': 'language-en',
  'view.reload': 'reload',
  'repo.fetch': 'fetch',
  'repo.pull': 'pull',
  'repo.push': 'push',
  'repo.commit': 'commit',
  'repo.undo-last-commit': 'undo-last-commit',
  'repo.create-branch': 'create-branch',
  'repo.stash-all': 'stash-all',
  'repo.remotes': 'show-remotes',
  'repo.tags': 'show-tags',
  'repo.worktrees': 'show-worktrees',
  'repo.submodules': 'show-submodules',
  'repo.lfs': 'show-lfs',
  'repo.gitflow': 'show-gitflow',
  'action.merge': 'merge',
  'action.rebase': 'rebase',
  'action.cherry-pick': 'cherry-pick',
  'action.revert': 'revert',
  'action.reset': 'reset',
  'action.continue': 'continue-operation',
  'action.skip': 'skip-operation',
  'action.abort': 'abort-operation',
  'help.shortcuts': 'show-shortcuts',
  'help.docs': 'open-docs',
  'help.report-issue': 'report-issue',
  'help.check-updates': 'check-updates',
} as const

export type MenuHandler = (typeof menuActionHandlers)[keyof typeof menuActionHandlers]

const RECENT_PREFIX = 'file.recent.'

export function menuRecentIndex(id: string): number | null {
  if (!id.startsWith(RECENT_PREFIX)) return null
  const raw = id.slice(RECENT_PREFIX.length)
  if (!/^\d+$/.test(raw)) return null
  const index = Number(raw)
  return Number.isSafeInteger(index) ? index : null
}

export function buildMenuLabels(language: Language): Record<string, string> {
  const labels: Record<string, string> = {}
  for (const key of Object.keys(zh)) {
    if (key.startsWith('menu.')) labels[key] = translate(language, key)
  }
  return labels
}
