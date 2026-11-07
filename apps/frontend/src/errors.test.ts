import { describe, expect, it } from 'vitest'
import { BranchlineCommandError } from '@branchline/git-client'
import { errorPresentation } from './errors'

const t = (key: string, params?: Record<string, string | number>) => {
  if (key === 'errors.git.fetch.failed') return `拉取失败：${params?.branch}`
  if (key === 'errors.unknown') return '发生未知错误'
  return key
}

describe('errorPresentation', () => {
  it('translates known codes with parameters', () => {
    const result = errorPresentation(new BranchlineCommandError('git.fetch.failed', { branch: 'main' }), t)
    expect(result.message).toBe('拉取失败：main')
  })

  it('falls back to unknown and keeps technical detail', () => {
    const result = errorPresentation(new BranchlineCommandError('missing.code', {}, 'fatal: bad revision'), t)
    expect(result.message).toBe('发生未知错误')
    expect(result.detail).toBe('fatal: bad revision')
  })

  it('accepts raw errors', () => {
    const result = errorPresentation(new Error('boom'), t)
    expect(result.message).toBe('发生未知错误')
    expect(result.detail).toBe('boom')
  })
})
