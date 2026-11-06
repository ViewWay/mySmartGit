import { describe, expect, it } from 'vitest'
import { downloadPercent, formatBytes, releaseDate, releaseNotes } from './updateModel'

describe('updateModel', () => {
  it('formats byte counts', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(15 * 1024 * 1024)).toBe('15 MB')
    expect(formatBytes(undefined)).toBe('—')
    expect(formatBytes(-1)).toBe('—')
  })

  it('computes bounded download percentages', () => {
    expect(downloadPercent(50, 200)).toBe(25)
    expect(downloadPercent(400, 200)).toBe(100)
    expect(downloadPercent(10, 0)).toBeNull()
    expect(downloadPercent(10, null)).toBeNull()
  })

  it('normalizes optional release metadata', () => {
    expect(releaseNotes('  fixes  ')).toBe('fixes')
    expect(releaseNotes(null)).toBe('')
    expect(releaseDate('2026-11-06T10:00:00Z')).toMatch(/2026/)
    expect(releaseDate('not-a-date')).toBe('not-a-date')
    expect(releaseDate(null)).toBeNull()
  })
})
