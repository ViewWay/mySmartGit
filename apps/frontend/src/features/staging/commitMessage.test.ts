import { describe, expect, it } from 'vitest'
import { commitButtonState, draftAfterAction, initialCommitMessage } from './commitMessage'

describe('initial commit message', () => {
  it('uses the generated merge message and removes Git comment lines', () => {
    expect(initialCommitMessage('template message', {
      kind: 'merge',
      message: "Merge branch 'feature/demo'\n\n# Conflicts:\n#\tREADME.md",
    })).toBe("Merge branch 'feature/demo'\n")
  })

  it('keeps the configured template outside a merge operation', () => {
    expect(initialCommitMessage('template message', {
      kind: 'cherry-pick',
      message: 'picked commit message',
    })).toBe('template message')
    expect(initialCommitMessage('template message')).toBe('template message')
  })
})

describe('draft after a write action', () => {
  it('keeps the user draft when the action fails', () => {
    expect(draftAfterAction({
      succeeded: false,
      currentDraft: 'fix: 我刚写的提交信息',
      templateContent: 'feat: 模板内容',
    })).toBe('fix: 我刚写的提交信息')
  })

  it('reapplies the template only when the action succeeds', () => {
    expect(draftAfterAction({
      succeeded: true,
      currentDraft: 'fix: 已被提交的草稿',
      templateContent: '# 注释行应被剔除\nfeat: 模板内容',
    })).toBe('feat: 模板内容')
  })
})

describe('commit button state', () => {
  it('allows an amend with zero staged files (pure message rewrite)', () => {
    const state = commitButtonState({ stagedCount: 0, busy: false, amend: true })
    expect(state.disabled).toBe(false)
    expect(state.label).toBe('修订提交信息')
  })

  it('stays disabled without staged files when not amending', () => {
    expect(commitButtonState({ stagedCount: 0, busy: false, amend: false }).disabled).toBe(true)
  })

  it('stays disabled while busy even when amending', () => {
    expect(commitButtonState({ stagedCount: 0, busy: true, amend: true }).disabled).toBe(true)
  })

  it('keeps the staged-file count in the label for normal commits', () => {
    const state = commitButtonState({ stagedCount: 3, busy: false, amend: false })
    expect(state.disabled).toBe(false)
    expect(state.label).toBe('提交 3 个文件')
  })
})
