import { describe, expect, it, vi } from 'vitest'
import type { RemoteOperationReport, RepositoryRemoteDetail, RepositorySnapshot, RepositoryTagDetail } from '../../repository'
import {
  CANCELLED_NOTICE,
  confirmationMessage,
  credentialNotice,
  fetchUrlText,
  filterTags,
  isSilentNoop,
  needsConfirmation,
  pushUrlText,
  splitUpstream,
  tagKindLabel,
  tagRiskText,
  upstreamCandidates,
} from './remotePanelState'
import { executeReportedAction } from './useReportedAction'

const report = (overrides: Partial<RemoteOperationReport> = {}): RemoteOperationReport => ({
  action: 'remove-remote',
  executed: false,
  requiresConfirmation: false,
  summary: '确认删除远程仓库：origin',
  warnings: [],
  affected: [],
  remotes: [],
  tags: [],
  ...overrides,
})

const remote = (overrides: Partial<RepositoryRemoteDetail> = {}): RepositoryRemoteDetail => ({
  name: 'origin',
  fetchUrls: ['https://[redacted]@example.com/team/repo.git'],
  pushUrls: [],
  fetchRefspecs: ['+refs/heads/*:refs/remotes/origin/*'],
  pushRefspecs: [],
  headBranch: null,
  cachedBranchCount: 1,
  trackingBranches: ['main'],
  credentialsRedacted: true,
  ...overrides,
})

const tag = (overrides: Partial<RepositoryTagDetail> = {}): RepositoryTagDetail => ({
  name: 'v1.0.0',
  kind: 'annotated',
  target: 'abc1234',
  tagObject: 'def5678',
  tagger: 'Branchline',
  taggerEmail: 'bl@example.com',
  date: '2026-11-01 10:00:00 +0800',
  subject: '首发',
  signed: false,
  onBranch: true,
  ...overrides,
})

describe('远程操作预览与确认判定', () => {
  it('把 executed=false + requiresConfirmation=true 视为等待二次确认', () => {
    expect(needsConfirmation(report({ executed: false, requiresConfirmation: true }))).toBe(true)
    expect(needsConfirmation(report({ executed: true, requiresConfirmation: false }))).toBe(false)
    expect(needsConfirmation(report({ executed: true, requiresConfirmation: true }))).toBe(false)
    expect(needsConfirmation(report({ executed: false, requiresConfirmation: false }))).toBe(false)
  })

  it('区分「等待确认」和「既没执行也没要求确认」的异常状态', () => {
    expect(isSilentNoop(report({ executed: false, requiresConfirmation: false }))).toBe(true)
    expect(isSilentNoop(report({ executed: false, requiresConfirmation: true }))).toBe(false)
    expect(isSilentNoop(report({ executed: true }))).toBe(false)
  })

  it('确认文案必须带摘要、逐条警告和受影响对象', () => {
    const message = confirmationMessage(report({
      summary: '将把远程「origin」重命名为「upstream」',
      warnings: ['缓存引用会整体改名', '跟踪分支上游会一起改'],
      affected: ['main', 'dev'],
    }))
    expect(message).toContain('将把远程「origin」重命名为「upstream」')
    expect(message).toContain('· 缓存引用会整体改名')
    expect(message).toContain('main、dev')
  })

  it('受影响对象过多时只展示前 12 项并标注「等」', () => {
    const message = confirmationMessage(report({ affected: Array.from({ length: 20 }, (_, index) => `tag-${index}`) }))
    expect(message).toContain('tag-11')
    expect(message).not.toContain('tag-19')
    expect(message).toContain('等')
  })

  it('push 地址为空时如实说明沿用 fetch，而不是伪造一条地址', () => {
    expect(pushUrlText(remote({ pushUrls: [] }))).toBe('沿用 fetch：https://[redacted]@example.com/team/repo.git')
    expect(pushUrlText(remote({ pushUrls: ['ssh://[redacted]@push.example.com/t.git'] }))).toBe('ssh://[redacted]@push.example.com/t.git')
    expect(fetchUrlText(remote({ fetchUrls: [] }))).toBe('未配置 fetch 地址')
  })

  it('凭据被脱敏时给出解释，普通地址不打扰用户', () => {
    expect(credentialNotice(remote())).toContain('[redacted]')
    expect(credentialNotice(remote({ credentialsRedacted: false }))).toBeNull()
  })
})

describe('上游跟踪候选与解析', () => {
  it('排除 <远程>/HEAD 与无远程前缀的引用并排序', () => {
    expect(upstreamCandidates(['origin/main', 'origin/HEAD', 'upstream/dev', 'loose'])).toEqual(['origin/main', 'upstream/dev'])
  })

  it('拆分 origin/main，拒绝选项式与畸形输入', () => {
    expect(splitUpstream('origin/main')).toEqual({ remote: 'origin', branch: 'main' })
    expect(splitUpstream('origin/feature/nested')).toEqual({ remote: 'origin', branch: 'feature/nested' })
    expect(splitUpstream('-x/y')).toBeNull()
    expect(splitUpstream('main')).toBeNull()
    expect(splitUpstream('origin/')).toBeNull()
    expect(splitUpstream(null)).toBeNull()
  })
})

describe('标签明细展示', () => {
  it('标注注释与轻量标签', () => {
    expect(tagKindLabel('annotated')).toBe('注释标签')
    expect(tagKindLabel('lightweight')).toBe('轻量标签')
  })

  it('风险提示按 签名 > 孤立提交 > 轻量 的优先级给出', () => {
    expect(tagRiskText(tag({ signed: true, onBranch: false, kind: 'annotated' }))).toContain('签名')
    expect(tagRiskText(tag({ signed: false, onBranch: false }))).toContain('GC')
    expect(tagRiskText(tag({ kind: 'lightweight' }))).toContain('轻量')
    expect(tagRiskText(tag())).toBeNull()
  })

  it('按名称或说明过滤，空查询返回全部', () => {
    const tags = [tag({ name: 'v1.0.0', subject: '首发' }), tag({ name: 'rc-1', subject: '回归' })]
    expect(filterTags(tags, '')).toHaveLength(2)
    expect(filterTags(tags, 'V1') .map((item) => item.name)).toEqual(['v1.0.0'])
    expect(filterTags(tags, '回归').map((item) => item.name)).toEqual(['rc-1'])
    expect(filterTags(tags, '不存在')).toHaveLength(0)
  })
})

describe('破坏性操作的二次确认执行器', () => {
  const snapshot = { path: '/repo' } as RepositorySnapshot

  it('用户取消时不发起第二次调用，仓库视为未改动', async () => {
    const action = vi.fn(async (confirm: boolean) => report({ executed: confirm, requiresConfirmation: !confirm, summary: confirm ? '已删除' : '将删除' }))
    const applySnapshot = vi.fn()
    const result = await executeReportedAction({
      action: action as never,
      confirm: async () => false,
      title: '删除远程',
      done: '已删除远程',
      applySnapshot,
      applyReport: () => {},
    })
    expect(action).toHaveBeenCalledTimes(1)
    expect(action).toHaveBeenCalledWith(false)
    expect(result.cancelled).toBe(true)
    expect(result.report).toBeNull()
    expect(result.notices).toEqual([CANCELLED_NOTICE])
    expect(applySnapshot).not.toHaveBeenCalled()
  })

  it('用户确认后以 confirm=true 再调用一次并回填快照', async () => {
    const action = vi.fn(async (confirm: boolean) => (confirm
      ? report({ executed: true, requiresConfirmation: false, summary: '已删除远程仓库：origin', snapshot, remotes: [remote({ name: 'upstream' })] })
      : report({ executed: false, requiresConfirmation: true, summary: '确认删除远程仓库：origin', warnings: ['会失去上游跟踪'] })))
    const applySnapshot = vi.fn()
    const applyReport = vi.fn()
    const confirmSpy = vi.fn(async () => true)
    const result = await executeReportedAction({
      action: action as never,
      confirm: confirmSpy as never,
      title: '删除远程',
      done: '已删除远程',
      applySnapshot,
      applyReport,
    })
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(action).toHaveBeenNthCalledWith(1, false)
    expect(action).toHaveBeenNthCalledWith(2, true)
    expect(result.report?.executed).toBe(true)
    expect(result.notices[0]).toBe('已删除远程')
    expect(applySnapshot).toHaveBeenCalledWith(snapshot)
    expect(applyReport).toHaveBeenCalled()
  })

  it('确认框文案直接取自预览的警告，而不是前端自行编造影响', async () => {
    let seen = ''
    await executeReportedAction({
      action: async (confirm: boolean) => report({
        executed: confirm,
        requiresConfirmation: !confirm,
        warnings: confirm ? [] : ['将删除 3 个缓存远程引用'],
        affected: confirm ? [] : ['main'],
      }),
      confirm: async (options) => {
        seen = typeof options === 'string' ? options : options.message
        return true
      },
      title: '删除远程',
      done: '已删除远程',
      applySnapshot: () => {},
      applyReport: () => {},
    })
    expect(seen).toContain('将删除 3 个缓存远程引用')
    expect(seen).toContain('受影响：main')
  })

  it('预览阶段没有快照可回填，执行后才带快照', async () => {
    const result = await executeReportedAction({
      action: async () => report({ executed: true, summary: '已添加远程', snapshot }),
      confirm: async () => true,
      title: '添加远程',
      done: '已添加远程',
      applySnapshot: () => {},
      applyReport: () => {},
    })
    expect(result.report?.snapshot).toBe(snapshot)
  })

  it('后端返回「没执行也没要求确认」时报错而不是播报成功', async () => {
    const result = await executeReportedAction({
      action: async () => report({ executed: false, requiresConfirmation: false, summary: '未知状态' }),
      confirm: async () => true,
      title: '重命名分支',
      done: '已重命名分支',
      applySnapshot: () => {},
      applyReport: () => {},
    })
    expect(result.notices).toEqual(['重命名分支未执行：未知状态'])
    expect(result.notices).not.toContain('已重命名分支')
  })

  it('执行结果带警告时把首条警告一并播报，避免用户以为完全干净', async () => {
    const result = await executeReportedAction({
      action: async () => report({ executed: true, warnings: ['远端标签未被同步删除'] }),
      confirm: async () => true,
      title: '删除标签',
      done: '已删除本地标签：v1',
      applySnapshot: () => {},
      applyReport: () => {},
    })
    expect(result.notices).toEqual(['已删除本地标签：v1（远端标签未被同步删除）'])
  })
})
