import { describe, expect, it } from 'vitest'
import { buildMenuLabels, menuActionHandlers, menuRecentIndex } from './menuBridge'

const rustMenuItemIds = [
  'file.new-repository',
  'file.open-repository',
  'file.clone-repository',
  'file.close-repository',
  'app.check-updates',
  'app.preferences',
  'edit.find',
  'edit.find-next',
  'edit.find-previous',
  'edit.search-repository',
  'format.word-wrap',
  'format.diff-unified',
  'format.diff-split',
  'format.show-whitespace',
  'format.font-increase',
  'format.font-decrease',
  'format.font-reset',
  'view.history',
  'view.changes',
  'view.stash',
  'view.recovery',
  'view.search',
  'view.tree',
  'view.compare',
  'view.merge',
  'view.terminal',
  'view.sidebar',
  'view.inspector',
  'view.theme.light',
  'view.theme.dark',
  'view.language.zh',
  'view.language.en',
  'view.reload',
  'repo.fetch',
  'repo.pull',
  'repo.push',
  'repo.commit',
  'repo.undo-last-commit',
  'repo.create-branch',
  'repo.stash-all',
  'repo.remotes',
  'repo.tags',
  'repo.worktrees',
  'repo.submodules',
  'repo.lfs',
  'repo.gitflow',
  'action.merge',
  'action.rebase',
  'action.cherry-pick',
  'action.revert',
  'action.reset',
  'action.continue',
  'action.skip',
  'action.abort',
  'help.shortcuts',
  'help.docs',
  'help.report-issue',
  'help.check-updates',
] as const

describe('menuActionHandlers', () => {
  it('maps native menu ids to app handlers', () => {
    expect(menuActionHandlers['repo.fetch']).toBe('fetch')
    expect(menuActionHandlers['view.sidebar']).toBe('toggle-sidebar')
    expect(menuActionHandlers['format.word-wrap']).toBe('toggle-word-wrap')
  })

  it('covers every custom item in the Rust menu', () => {
    for (const id of rustMenuItemIds) {
      expect(menuActionHandlers[id], `missing handler for ${id}`).toBeTruthy()
    }
  })
})

describe('menuRecentIndex', () => {
  it('parses repository entries from the recent submenu', () => {
    expect(menuRecentIndex('file.recent.0')).toBe(0)
    expect(menuRecentIndex('file.recent.9')).toBe(9)
  })

  it('ignores non-repository ids', () => {
    expect(menuRecentIndex('file.recent')).toBeNull()
    expect(menuRecentIndex('file.recent.empty')).toBeNull()
    expect(menuRecentIndex('repo.fetch')).toBeNull()
  })
})

describe('buildMenuLabels', () => {
  it('returns only menu domain labels for the active language', () => {
    const zh = buildMenuLabels('zh')
    const en = buildMenuLabels('en')
    expect(zh['menu.file.new-repository']).toBe('新建仓库…')
    expect(en['menu.file.new-repository']).toBe('New Repository…')
    expect(Object.keys(zh).every((key) => key.startsWith('menu.'))).toBe(true)
  })
})
