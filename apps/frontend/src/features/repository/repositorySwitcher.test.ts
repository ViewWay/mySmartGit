import { describe, expect, it } from 'vitest'
import { buildRepositorySwitchTargets, filterRepositoryTargets, quickAccessRepositoryTargets } from './repositorySwitcher'
import { zh } from '../../i18n/messages/zh'
const zhT = (key: string, params?: Record<string, string | number>) => {
  const template = (zh as Record<string, string>)[key] ?? key
  if (!params) return template
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => (params[name] === undefined ? match : String(params[name])))
}

const repository = {
  name: 'Branchline',
  path: 'E:\\code\\Branchline',
  branch: 'master',
  worktrees: [
    { path: 'E:\\code\\Branchline', branch: 'master' },
    { path: 'E:\\code\\Branchline-feature', branch: 'feat/search' },
  ],
  submodules: [
    { path: 'vendor/ui-kit', status: '已初始化' },
  ],
}

const recent = [
  { name: 'mono-web', path: 'E:\\FONE\\mono-web', branch: 'master', openedAt: 3 },
  { name: 'Branchline', path: 'e:/code/Branchline/', branch: 'master', openedAt: 2 },
  { name: 'tools', path: 'E:\\code\\tools', branch: 'main', openedAt: 1 },
]

describe('repository switch targets', () => {
  it('deduplicates normalized paths while preserving structure priority and pin state', () => {
    const targets = buildRepositorySwitchTargets(repository, recent, [
      { name: 'Feature', path: 'e:/code/Branchline-feature/' },
    ], zhT)

    expect(targets.filter((target) => target.path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() === 'e:\\code\\branchline')).toHaveLength(1)
    expect(targets.find((target) => target.path.includes('Branchline-feature'))).toMatchObject({ source: 'worktree', pinned: true })
  })

  it('matches repository names and paths with separator-insensitive tokens', () => {
    const targets = buildRepositorySwitchTargets(repository, recent, [], zhT)
    expect(filterRepositoryTargets(targets, 'mono web').map(({ path }) => path)).toEqual(['E:\\FONE\\mono-web'])
    expect(filterRepositoryTargets(targets, 'vendor ui').map(({ source }) => source)).toEqual(['submodule'])
  })

  it('places submodules before worktrees in the current repository group', () => {
    const targets = buildRepositorySwitchTargets(repository, [], [], zhT)
    expect(targets.filter((target) => ['submodule', 'worktree'].includes(target.source)).map((target) => target.source)).toEqual(['submodule', 'worktree'])
  })

  it('uses pinned repositories first and otherwise falls back to three recent entries', () => {
    const pinnedTargets = buildRepositorySwitchTargets(repository, recent, [
      { name: 'tools', path: 'E:\\code\\tools' },
    ], zhT)
    expect(quickAccessRepositoryTargets(pinnedTargets).map(({ path }) => path)).toEqual(['E:\\code\\tools'])

    const recentTargets = buildRepositorySwitchTargets(repository, recent, [], zhT)
    expect(quickAccessRepositoryTargets(recentTargets).map(({ path }) => path)).toEqual([
      'E:\\FONE\\mono-web',
      'E:\\code\\tools',
    ])
  })
})
