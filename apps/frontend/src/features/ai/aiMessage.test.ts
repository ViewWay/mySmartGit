import { describe, expect, it } from 'vitest'
import {
  AI_SUBJECT_DEFAULT_CHARS,
  AI_SUBJECT_MAX_CHARS,
  AI_SUBJECT_MIN_CHARS,
  applyGeneratedDraft,
  composeGeneratedMessage,
  describeAiError,
  generatedMessageNotice,
  normalizeAiOptions,
} from './aiMessage'

describe('normalize AI options', () => {
  it('falls back to the saved/default options when nothing is provided', () => {
    expect(normalizeAiOptions()).toEqual({
      language: 'zh',
      style: 'conventional',
      includeBody: true,
      maxSubjectChars: AI_SUBJECT_DEFAULT_CHARS,
    })
  })

  it('honors per-generation overrides and falls back for unknown values', () => {
    expect(normalizeAiOptions(
      { language: 'en', style: 'plain', includeBody: false, maxSubjectChars: 50 },
      { language: 'zh', style: 'conventional', includeBody: true, maxSubjectChars: 72 },
    )).toEqual({ language: 'en', style: 'plain', includeBody: false, maxSubjectChars: 50 })
    expect(normalizeAiOptions(
      { language: 'fr' as never, style: 'fancy' as never },
      { language: 'en', style: 'plain' },
    )).toMatchObject({ language: 'en', style: 'plain' })
  })

  it('clamps the subject limit to the backend range', () => {
    expect(normalizeAiOptions({ maxSubjectChars: 1 }).maxSubjectChars).toBe(AI_SUBJECT_MIN_CHARS)
    expect(normalizeAiOptions({ maxSubjectChars: 9_999 }).maxSubjectChars).toBe(AI_SUBJECT_MAX_CHARS)
    expect(normalizeAiOptions({ maxSubjectChars: Number.NaN }).maxSubjectChars).toBe(AI_SUBJECT_DEFAULT_CHARS)
    expect(normalizeAiOptions({ maxSubjectChars: 71.6 }).maxSubjectChars).toBe(72)
  })
})

describe('compose generated message', () => {
  it('joins subject and body with a blank line', () => {
    expect(composeGeneratedMessage({ subject: 'feat: x', body: '- a\n- b' })).toBe('feat: x\n\n- a\n- b')
  })

  it('omits the blank line when there is no body', () => {
    expect(composeGeneratedMessage({ subject: 'fix: y', body: null })).toBe('fix: y')
    expect(composeGeneratedMessage({ subject: 'fix: y', body: '   ' })).toBe('fix: y')
  })
})

describe('apply generated draft', () => {
  it('applies directly when the commit box is empty', () => {
    expect(applyGeneratedDraft({ currentMessage: '', generated: 'feat: new' })).toEqual({
      applied: true,
      requiresConfirmation: false,
      message: 'feat: new',
    })
    expect(applyGeneratedDraft({ currentMessage: '  \n', generated: 'feat: new' }).applied).toBe(true)
  })

  it('never overwrites a non-empty draft without confirmation', () => {
    const decision = applyGeneratedDraft({ currentMessage: 'fix: 我的草稿', generated: 'feat: ai' })
    expect(decision.applied).toBe(false)
    expect(decision.requiresConfirmation).toBe(true)
    expect(decision.message).toBe('fix: 我的草稿')
  })

  it('overwrites a non-empty draft once the user confirms', () => {
    expect(applyGeneratedDraft({ currentMessage: 'fix: 我的草稿', generated: 'feat: ai', confirmed: true })).toEqual({
      applied: true,
      requiresConfirmation: false,
      message: 'feat: ai',
    })
  })

  it('does nothing for an empty generated message', () => {
    expect(applyGeneratedDraft({ currentMessage: 'keep', generated: '  ' })).toEqual({
      applied: false,
      requiresConfirmation: false,
      message: 'keep',
    })
  })
})

describe('AI message notices and errors', () => {
  it('prefers the backend note and falls back to the truncated flag', () => {
    expect(generatedMessageNotice({ note: '暂存区为空，已使用工作区未暂存改动生成', truncated: false }))
      .toBe('暂存区为空，已使用工作区未暂存改动生成')
    expect(generatedMessageNotice({ note: null, truncated: true })).toBe('生成内容已截断，请检查后再使用')
    expect(generatedMessageNotice({ note: '', truncated: false })).toBeNull()
  })

  it('normalizes errors without leaking implementation details', () => {
    expect(describeAiError(new Error('尚未配置 AI API Key'))).toBe('尚未配置 AI API Key')
    expect(describeAiError('  boom  ')).toBe('boom')
    expect(describeAiError(undefined)).toBe('AI 生成失败，请稍后重试')
    expect(describeAiError({})).toBe('AI 生成失败，请稍后重试')
  })
})
