import { describe, expect, it } from 'vitest'
import type { HostingPullRequest, HostingSettings } from '../../repository'
import {
  buildCreatePullRequestInput,
  hostingCiLabel,
  hostingCiTone,
  hostingDefaultHost,
  hostingProviderLabel,
  hostingSettingsSummary,
  inferDefaultBranch,
  isHostingProvider,
  pullRequestBranchLabel,
  pullRequestStateLabel,
  summarizePullRequest,
  validateCreatePullRequestForm,
  validateHostingHost,
  validateHostingToken,
  type CreatePullRequestForm,
} from './hostingModel'

const pr = (overrides: Partial<HostingPullRequest> = {}): HostingPullRequest => ({
  number: 12,
  title: 'Add hosting panel',
  author: 'octocat',
  state: 'open',
  draft: false,
  sourceBranch: 'feature/hosting',
  targetBranch: 'main',
  webUrl: 'https://github.com/acme/widgets/pull/12',
  updatedAt: '2026-01-02T03:04:05Z',
  ciStatus: 'unknown',
  ...overrides,
})

const form = (overrides: Partial<CreatePullRequestForm> = {}): CreatePullRequestForm => ({
  title: 'Add hosting panel',
  body: 'Body text',
  sourceBranch: 'feature/hosting',
  targetBranch: 'main',
  draft: false,
  ...overrides,
})

describe('托管平台文案', () => {
  it('识别提供商并给出默认主机', () => {
    expect(isHostingProvider('github')).toBe(true)
    expect(isHostingProvider('gitlab')).toBe(true)
    expect(isHostingProvider('bitbucket')).toBe(false)
    expect(hostingProviderLabel('github')).toBe('GitHub')
    expect(hostingProviderLabel('gitlab')).toBe('GitLab')
    expect(hostingDefaultHost('github')).toBe('github.com')
    expect(hostingDefaultHost('gitlab')).toBe('gitlab.com')
  })

  it('汇总设置时绝不回显令牌', () => {
    const settings = (overrides: Partial<HostingSettings> = {}): HostingSettings => ({
      provider: 'github',
      host: null,
      tokenConfigured: false,
      ...overrides,
    })
    expect(hostingSettingsSummary(null)).toContain('正在读取')
    expect(hostingSettingsSummary(settings())).toContain('尚未保存')
    expect(hostingSettingsSummary(settings({ tokenConfigured: true }))).toContain('已保存访问令牌')
    expect(
      hostingSettingsSummary(settings({ provider: 'gitlab', host: 'gitlab.example.com' })),
    ).toContain('gitlab.example.com')
  })
})

describe('CI 状态映射', () => {
  it('把四种状态映射为样式与中文文案', () => {
    for (const status of ['success', 'failure', 'pending', 'unknown'] as const) {
      expect(hostingCiTone(status)).toBe(status)
      expect(hostingCiLabel(status)).toContain('CI')
    }
    expect(hostingCiLabel('success')).toBe('CI 通过')
    expect(hostingCiLabel('failure')).toBe('CI 失败')
    expect(hostingCiLabel('pending')).toBe('CI 进行中')
    expect(hostingCiLabel('unknown')).toBe('CI 未知')
    expect(hostingCiTone('something-new')).toBe('unknown')
    expect(hostingCiLabel('something-new')).toBe('CI 未知')
  })
})

describe('设置表单校验', () => {
  it('令牌留空表示保留，拒绝空白与控制字符', () => {
    expect(validateHostingToken('')).toBeNull()
    expect(validateHostingToken('   ')).toBeNull()
    expect(validateHostingToken('ghp_abcdef123456')).toBeNull()
    expect(validateHostingToken('token with space')).toContain('空白')
    expect(validateHostingToken('token\ninjected')).toContain('空白')
    expect(validateHostingToken('a'.repeat(4097))).toContain('过长')
  })

  it('主机名允许留空与端口，拒绝协议、路径与凭据', () => {
    expect(validateHostingHost('', 'github')).toBeNull()
    expect(validateHostingHost(' GitHub.COM ', 'github')).toBeNull()
    expect(validateHostingHost('gitlab.example.com:8443', 'gitlab')).toBeNull()
    for (const rejected of [
      'https://github.com',
      'github.com/owner',
      'user@github.com',
      'github.com?x=1',
      'bad host',
      'host_name.example.com',
      '-bad.example.com',
      'github.com:abc',
      'github.com:0',
      'github.com:70000',
    ]) {
      expect(validateHostingHost(rejected, 'github'), rejected).not.toBeNull()
    }
  })
})

describe('PR/MR 展示模型', () => {
  it('草稿优先于原始 state，并拼出摘要', () => {
    expect(pullRequestStateLabel(pr())).toBe('开放')
    expect(pullRequestStateLabel(pr({ state: 'opened' }))).toBe('开放')
    expect(pullRequestStateLabel(pr({ draft: true }))).toBe('草稿')
    expect(pullRequestStateLabel(pr({ state: 'closed' }))).toBe('closed')
    expect(pullRequestBranchLabel(pr())).toBe('feature/hosting → main')
    expect(summarizePullRequest(pr())).toBe('开放 · feature/hosting → main · octocat')
  })

  it('按目标分支出现次数推断默认分支，空列表回退 main', () => {
    expect(inferDefaultBranch([])).toBe('main')
    expect(
      inferDefaultBranch([
        pr({ number: 1, targetBranch: 'develop' }),
        pr({ number: 2, targetBranch: 'develop' }),
        pr({ number: 3, targetBranch: 'main' }),
      ]),
    ).toBe('develop')
    expect(
      inferDefaultBranch([
        pr({ number: 1, targetBranch: 'release' }),
        pr({ number: 2, targetBranch: 'main' }),
      ]),
    ).toBe('release')
    expect(inferDefaultBranch([pr({ targetBranch: '   ' })])).toBe('main')
  })
})

describe('创建 PR/MR 校验与请求体', () => {
  it('接受合法表单并按平台构造请求体', () => {
    expect(validateCreatePullRequestForm(form(), 'github')).toBeNull()
    const github = buildCreatePullRequestInput(
      form({ title: '  Add hosting  ', sourceBranch: ' feature/hosting ' }),
      'github',
    )
    expect(github).toEqual({
      title: 'Add hosting',
      body: 'Body text',
      sourceBranch: 'feature/hosting',
      targetBranch: 'main',
      draft: false,
    })
    expect(buildCreatePullRequestInput(form({ draft: true }), 'github').draft).toBe(true)
    // GitLab 的 Draft 由后端加标题前缀，前端不复用 GitHub 的 draft 字段。
    expect(buildCreatePullRequestInput(form({ draft: true }), 'gitlab').draft).toBe(false)
  })

  it('拒绝空标题、换行标题、空分支与相同分支', () => {
    expect(validateCreatePullRequestForm(form({ title: '   ' }), 'github')).toContain('不能为空')
    expect(validateCreatePullRequestForm(form({ title: 'a'.repeat(257) }), 'github')).toContain(
      '过长',
    )
    expect(validateCreatePullRequestForm(form({ title: 'bad\nInjected' }), 'github')).toContain(
      '控制字符',
    )
    expect(validateCreatePullRequestForm(form({ sourceBranch: '' }), 'github')).toContain(
      '源分支不能为空',
    )
    expect(validateCreatePullRequestForm(form({ targetBranch: '  ' }), 'github')).toContain(
      '目标分支不能为空',
    )
    expect(validateCreatePullRequestForm(form({ targetBranch: 'feature/hosting' }), 'github')).toContain(
      '不能相同',
    )
    expect(validateCreatePullRequestForm(form({ sourceBranch: 'bad branch' }), 'gitlab')).toContain(
      '空白',
    )
    expect(validateCreatePullRequestForm(form({ sourceBranch: 'feature..x' }), 'github')).toContain(
      '不允许',
    )
    expect(validateCreatePullRequestForm(form({ sourceBranch: '-feature' }), 'github')).toContain(
      '格式无效',
    )
    expect(validateCreatePullRequestForm(form({ body: 'a\0b' }), 'github')).toContain('NUL')
  })

  it('GitLab 使用 MR 文案', () => {
    expect(validateCreatePullRequestForm(form({ title: '' }), 'gitlab')).toContain('MR 标题')
  })
})
