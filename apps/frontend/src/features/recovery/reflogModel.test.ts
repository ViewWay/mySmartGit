import { describe, expect, it } from 'vitest'
import type { ReflogEntry } from '@branchline/git-models'
import { describeReflogRestore, reflogActionLabel, RESET_MODE_DESCRIPTIONS, resetNeedsDangerAck } from './reflogModel'

const entry = (overrides: Partial<ReflogEntry> = {}): ReflogEntry => ({
  selector: 'HEAD@{2}',
  datedSelector: 'HEAD@{2026-11-01T10:00:00+08:00}',
  entryTime: '2026-11-01T10:00:00+08:00',
  action: 'commit',
  subject: 'commit (amend): 补充功能',
  commitHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  shortHash: 'aaaaaaa',
  oldHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  commitTitle: '补充功能',
  author: 'Tester',
  commitTime: '2026-11-01T10:00:00+08:00',
  isHead: false,
  ...overrides,
})

describe('reflogModel', () => {
  it('为已知动作提供中文标签并回退原始动作名', () => {
    expect(reflogActionLabel('reset')).toBe('回退（Reset）')
    expect(reflogActionLabel('checkout')).toBe('检出')
    expect(reflogActionLabel('unknown-action')).toBe('unknown-action')
  })

  it('恢复后果说明覆盖三种动作且 hard 语义明确提及丢失', () => {
    expect(describeReflogRestore(entry(), 'checkout')).toContain('分离 HEAD')
    expect(describeReflogRestore(entry(), 'branch')).toContain('新建分支')
    const resetText = describeReflogRestore(entry(), 'reset')
    expect(resetText).toContain('hard')
    expect(resetText).toContain('Reflog')
  })

  it('仅 hard 模式需要危险确认，且三种模式说明齐全', () => {
    expect(resetNeedsDangerAck('hard')).toBe(true)
    expect(resetNeedsDangerAck('mixed')).toBe(false)
    expect(resetNeedsDangerAck('soft')).toBe(false)
    expect(Object.keys(RESET_MODE_DESCRIPTIONS)).toEqual(['soft', 'mixed', 'hard'])
  })
})
