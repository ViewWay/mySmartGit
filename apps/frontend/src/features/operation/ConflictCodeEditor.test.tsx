import { describe, expect, it } from 'vitest'
import { buildConflictActions } from './ConflictCodeEditor'

describe('buildConflictActions', () => {
  it('uses the provided localized labels', () => {
    expect(
      buildConflictActions({ current: 'Use current', incoming: 'Use incoming', both: 'Keep both' }),
    ).toEqual([
      ['current', 'Use current'],
      ['incoming', 'Use incoming'],
      ['both', 'Keep both'],
    ])
  })
})
