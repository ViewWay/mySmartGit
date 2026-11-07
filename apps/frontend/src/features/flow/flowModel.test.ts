import { describe, expect, it } from 'vitest'
import type { GitflowBranches, GitflowConfig, GitflowFinishReport } from '../../repository'
import {
  canFinishGitflow,
  canTagGitflow,
  finishReportDetailLines,
  finishReportHeadline,
  finishReportStepCounts,
  finishReportTone,
  gitflowBranchName,
  gitflowDefaultBase,
  gitflowGroups,
  gitflowKindLabel,
  gitflowLeafName,
  gitflowTagName,
  stepStatusLabel,
  validateGitflowBranchName,
  validateGitflowConfig,
  validateGitflowLeafName,
  validateGitflowPrefix,
  validateGitflowTagName,
} from './flowModel'

import { zh } from '../../i18n/messages/zh'
const zhT = (key: string, params?: Record<string, string | number>) => {
  const template = (zh as Record<string, string>)[key] ?? key
  if (!params) return template
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => (params[name] === undefined ? match : String(params[name])))
}


const config: GitflowConfig = {
  mainBranch: 'main',
  developBranch: 'develop',
  featurePrefix: 'feature/',
  releasePrefix: 'release/',
  hotfixPrefix: 'hotfix/',
  supportPrefix: 'support/',
  tagPrefix: 'v',
}

const branches: GitflowBranches = {
  mainBranch: 'main',
  developBranch: 'develop',
  feature: ['login', 'search'],
  release: ['1.0.0'],
  hotfix: [],
  support: ['lts'],
}

const report = (overrides: Partial<GitflowFinishReport> = {}): GitflowFinishReport => ({
  kind: 'release',
  branch: 'release/1.0.0',
  completed: true,
  conflicts: false,
  steps: [
    { action: 'merge --no-ff release/1.0.0 -> main', status: 'completed' },
    { action: 'tag v1.0.0', status: 'completed', detail: '首个版本' },
  ],
  guidance: null,
  headBefore: 'a'.repeat(40),
  headAfter: 'b'.repeat(40),
  ...overrides,
})

describe('Gitflow 分支命名与校验', () => {
  it('短名可重复带前缀，拼出的完整名只保留一层', () => {
    expect(gitflowLeafName(config, 'feature', 'feature/login')).toBe('login')
    expect(gitflowBranchName(config, 'feature', 'feature/login')).toBe('feature/login')
    expect(gitflowBranchName(config, 'feature', 'login')).toBe('feature/login')
    expect(gitflowBranchName(config, 'release', '1.0.0')).toBe('release/1.0.0')
    expect(gitflowDefaultBase(config, 'feature')).toBe('develop')
    expect(gitflowDefaultBase(config, 'support')).toBe('main')
  })

  it('接受常见短名，拒绝选项注入、空白、换行与非法引用字符', () => {
    expect(validateGitflowLeafName(config, 'feature', 'login', zhT)).toBeNull()
    expect(validateGitflowLeafName(config, 'release', '1.0.0', zhT)).toBeNull()
    for (const name of ['-x', 'bad name', 'bad\nname', 'a..b', 'a~b', 'a.lock', 'a.', 'a@{b}', 'a//b', 'a?b']) {
      expect(validateGitflowLeafName(config, 'feature', name, zhT), name).not.toBeNull()
    }
    expect(validateGitflowLeafName(config, 'feature', '   ', zhT)).toContain('不能为空')
  })

  it('分支名与配置前缀复用同一套规则', () => {
    expect(validateGitflowBranchName('main', zhT)).toBeNull()
    expect(validateGitflowBranchName('-main', zhT)).toContain('不能以 - 开头')
    expect(validateGitflowBranchName('HEAD', zhT)).toContain('HEAD')
    expect(validateGitflowPrefix('feature/', false, zhT)).toBeNull()
    expect(validateGitflowPrefix('', false, zhT)).toContain('不能为空')
    expect(validateGitflowPrefix('', true, zhT)).toBeNull()
    expect(validateGitflowPrefix('-bad/', false, zhT)).toContain('不能以 - 开头')
  })

  it('配置校验返回全部错误：同名主干、空前缀、非法标签前缀', () => {
    expect(validateGitflowConfig(config, zhT)).toEqual([])
    expect(validateGitflowConfig({ ...config, developBranch: 'main' }, zhT)).toContain('主干分支与 develop 分支不能相同')
    expect(validateGitflowConfig({ ...config, featurePrefix: '' }, zhT).join(' ')).toContain('feature 前缀')
    expect(validateGitflowConfig({ ...config, tagPrefix: 'v 1' }, zhT).join(' ')).toContain('标签前缀')
  })

  it('标签名按 tagPrefix 拼接并校验', () => {
    expect(gitflowTagName(config, '1.0.0')).toBe('v1.0.0')
    expect(validateGitflowTagName(config, '1.0.0', zhT)).toBeNull()
    expect(validateGitflowTagName(config, '-1', zhT)).toContain('不能以 - 开头')
  })
})

describe('Gitflow 分组与操作限制', () => {
  it('按四类前缀分组并保留完整分支名', () => {
    const groups = gitflowGroups(branches, config, zhT)
    expect(groups.map((group) => group.kind)).toEqual(['feature', 'release', 'hotfix', 'support'])
    expect(groups[0].branches).toEqual([
      { name: 'login', full: 'feature/login' },
      { name: 'search', full: 'feature/search' },
    ])
    expect(groups[3].branches).toEqual([{ name: 'lts', full: 'support/lts' }])
    expect(gitflowKindLabel('hotfix', zhT)).toBe('热修复分支')
    expect(gitflowGroups(null, config, zhT)).toEqual([])
  })

  it('support 不可 finish，只有 release/hotfix 可打标签', () => {
    expect(canFinishGitflow('feature')).toBe(true)
    expect(canFinishGitflow('support')).toBe(false)
    expect(canTagGitflow('release')).toBe(true)
    expect(canTagGitflow('hotfix')).toBe(true)
    expect(canTagGitflow('feature')).toBe(false)
  })
})

describe('Gitflow 完成报告展示模型', () => {
  it('成功 / 冲突 / 失败三态标题', () => {
    expect(finishReportTone(report())).toBe('success')
    expect(finishReportHeadline(report(), zhT)).toBe('已完成 release/1.0.0')
    expect(finishReportHeadline(report({ completed: false, conflicts: true }), zhT)).toContain('冲突')
    expect(finishReportTone(report({ completed: false, conflicts: false }))).toBe('failed')
    expect(finishReportHeadline(report({ completed: false, conflicts: false }), zhT)).toContain('未完成')
  })

  it('步骤行带状态标签、细节与 guidance', () => {
    const lines = finishReportDetailLines(report({
      completed: false,
      conflicts: true,
      guidance: '合并状态已保留（MERGE_HEAD），可继续或中止',
      steps: [
        { action: 'merge --no-ff release/1.0.0 -> main', status: 'conflict', detail: 'CONFLICT (content)' },
        { action: 'delete release/1.0.0', status: 'skipped' },
      ],
    }), zhT)
    expect(lines[0]).toBe('冲突 · merge --no-ff release/1.0.0 -> main：CONFLICT (content)')
    expect(lines[1]).toBe('跳过 · delete release/1.0.0')
    expect(lines[2]).toContain('MERGE_HEAD')
    expect(stepStatusLabel('failed', zhT)).toBe('失败')
  })

  it('统计各状态步骤数', () => {
    expect(finishReportStepCounts(report({
      steps: [
        { action: 'a', status: 'completed' },
        { action: 'b', status: 'completed' },
        { action: 'c', status: 'failed' },
        { action: 'd', status: 'conflict' },
      ],
    }))).toEqual({ completed: 2, skipped: 0, failed: 1, conflict: 1 })
  })
})
