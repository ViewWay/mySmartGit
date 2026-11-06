import { describe, expect, it } from 'vitest'
import type { SubmoduleCommitEntry, SubmodulePointerDiff } from '../../repository'
import {
  cappedCommits,
  commitLineText,
  describePointerDiff,
  pointerChangeKind,
  pointerChangeLabel,
  pointerChangeTone,
  pointerHashPair,
} from './submoduleDiffPresentation'

const commit = (shortHash: string, title: string): SubmoduleCommitEntry => ({
  hash: `${shortHash}0000000000000000000000000000000000000`,
  shortHash,
  title,
  author: '分支线测试',
  email: 'test@example.com',
  commitTime: '2026-02-10T09:00:00+08:00',
})

const diff = (overrides: Partial<SubmodulePointerDiff> = {}): SubmodulePointerDiff => ({
  path: 'vendor/lib',
  name: 'vendor/lib',
  url: 'https://host.example/team/lib.git',
  absolutePath: '/repo/vendor/lib',
  headCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  stagedCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  currentCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  previousCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  targetCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  changed: false,
  pointerStaged: false,
  pointerUnstaged: false,
  uninitialized: false,
  detached: false,
  addedCommits: [],
  addedCount: 0,
  removedCount: 0,
  fastForward: true,
  filesChanged: 0,
  additions: 0,
  deletions: 0,
  dirtyFiles: 0,
  summary: 'vendor/lib：指针未变化（aaaaaaaa）',
  warnings: [],
  ...overrides,
})

describe('指针状态判定', () => {
  it('区分未变化 / 已暂存 / 未暂存 / 两者都有', () => {
    expect(pointerChangeKind(diff())).toBe('unchanged')
    expect(pointerChangeKind(diff({ changed: true, pointerStaged: true }))).toBe('staged')
    expect(pointerChangeKind(diff({ changed: true, pointerUnstaged: true }))).toBe('unstaged')
    expect(pointerChangeKind(diff({ changed: true, pointerStaged: true, pointerUnstaged: true }))).toBe('both')
  })

  it('未初始化与读不出提交时不谎报为未变化', () => {
    expect(pointerChangeKind(diff({ uninitialized: true, targetCommit: '' }))).toBe('uninitialized')
    expect(pointerChangeKind(diff({ previousCommit: '' }))).toBe('unknown')
    expect(pointerChangeLabel('uninitialized')).toBe('子模块未初始化')
    expect(pointerChangeTone('unchanged')).toBe('neutral')
    expect(pointerChangeTone('staged')).toBe('danger')
    expect(pointerChangeTone('unknown')).toBe('warning')
  })

  it('短哈希对缺失一侧时用占位符', () => {
    expect(pointerHashPair(diff())).toEqual({ from: 'aaaaaaaa', to: 'aaaaaaaa' })
    expect(pointerHashPair(diff({ previousCommit: '' }))).toEqual({ from: '—', to: 'aaaaaaaa' })
    expect(pointerHashPair(diff({ uninitialized: true, targetCommit: '' }))).toEqual({ from: 'aaaaaaaa', to: '—' })
  })
})

describe('差异文案', () => {
  it('非快进与丢失提交必须写进说明', () => {
    const lines = describePointerDiff(diff({
      changed: true,
      pointerUnstaged: true,
      targetCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      fastForward: false,
      removedCount: 2,
      dirtyFiles: 3,
      detached: true,
    }))
    expect(lines[0]).toContain('指针未变化') // 后端 summary 原样保留，不由前端改写
    expect(lines.some((line) => line.includes('非快进'))).toBe(true)
    expect(lines.some((line) => line.includes('丢掉 2 个提交'))).toBe(true)
    expect(lines.some((line) => line.includes('3 个未提交改动'))).toBe(true)
    expect(lines.some((line) => line.includes('分离 HEAD'))).toBe(true)
  })

  it('快进且干净时只有一句摘要', () => {
    expect(describePointerDiff(diff())).toHaveLength(1)
    expect(describePointerDiff(diff({ uninitialized: true }))).toHaveLength(1)
  })

  it('提交列表限量但不谎报总数', () => {
    const many = Array.from({ length: 40 }, (_, index) => commit(`c${index}`, `提交 ${index}`))
    const capped = cappedCommits(many, 30)
    expect(capped.shown).toHaveLength(30)
    expect(capped.hidden).toBe(10)
    expect(cappedCommits([], 30)).toEqual({ shown: [], hidden: 0 })
  })

  it('提交行文本带短哈希、标题、作者与时间', () => {
    expect(commitLineText(commit('abc1234', '修掉一个 bug'))).toBe('abc1234 修掉一个 bug · 分支线测试 · 2026-02-10T09:00:00+08:00')
  })
})
