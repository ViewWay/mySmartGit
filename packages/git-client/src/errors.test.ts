import { describe, expect, it } from 'vitest'
import { BranchlineCommandError } from './errors'

describe('BranchlineCommandError', () => {
  it('passes through existing errors', () => {
    const error = new BranchlineCommandError('git.fetch.failed', { branch: 'main' }, 'fatal')
    expect(BranchlineCommandError.from(error)).toBe(error)
  })

  it('normalizes structured Tauri rejections', () => {
    const error = BranchlineCommandError.from({ code: 'git.push.rejected', params: { branch: 'main' }, detail: 'non-fast-forward' })
    expect(error.code).toBe('git.push.rejected')
    expect(error.params.branch).toBe('main')
    expect(error.detail).toBe('non-fast-forward')
  })

  it('stringifies structured parameter values', () => {
    const error = BranchlineCommandError.from({ code: 'git.fetch.failed', params: { count: 3 } })
    expect(error.params.count).toBe('3')
  })

  it('falls back to unknown with raw detail', () => {
    const error = BranchlineCommandError.from(new Error('boom'))
    expect(error.code).toBe('errors.unknown')
    expect(error.detail).toBe('boom')
  })

  it('keeps raw string rejections as detail', () => {
    const error = BranchlineCommandError.from('fatal: bad revision')
    expect(error.code).toBe('errors.unknown')
    expect(error.detail).toBe('fatal: bad revision')
  })
})
