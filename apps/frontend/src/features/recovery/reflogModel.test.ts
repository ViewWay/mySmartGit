import { describe, expect, it } from 'vitest'
import type { ReflogEntry } from '../../repository'
import { describeReflogRestore, reflogActionLabel, resetModeDescription, resetNeedsDangerAck } from './reflogModel'

import { zh } from '../../i18n/messages/zh'
const zhT = (key: string, params?: Record<string, string | number>) => {
  const template = (zh as Record<string, string>)[key] ?? key
  if (!params) return template
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => (params[name] === undefined ? match : String(params[name])))
}


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
    expect(reflogActionLabel('reset', zhT)).toBe('回退（Reset）')
    expect(reflogActionLabel('checkout', zhT)).toBe('检出')
    expect(reflogActionLabel('unknown-action', zhT)).toBe('unknown-action')
  })

  it('恢复后果说明覆盖三种动作且 hard 语义明确提及丢失', () => {
    expect(describeReflogRestore(entry(), 'checkout', zhT)).toContain('分离 HEAD')
    expect(describeReflogRestore(entry(), 'branch', zhT)).toContain('新建分支')
    const resetText = describeReflogRestore(entry(), 'reset', zhT)
    expect(resetText).toContain('hard')
    expect(resetText).toContain('Reflog')
  })

  it('仅 hard 模式需要危险确认，且三种模式说明齐全', () => {
    expect(resetNeedsDangerAck('hard')).toBe(true)
    expect(resetNeedsDangerAck('mixed')).toBe(false)
    expect(resetNeedsDangerAck('soft')).toBe(false)
    expect((['soft', 'mixed', 'hard'] as const).map((mode) => resetModeDescription(mode, zhT))).toHaveLength(3)
  })
})
