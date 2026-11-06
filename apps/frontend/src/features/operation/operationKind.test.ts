import { describe, expect, it } from 'vitest'
import { asPanelKind, canSkipOperation, continueActionLabel, showsStepRoute, stepRouteLabel } from './operationKind'

import { zh } from '../../i18n/messages/zh'
const zhT = (key: string, params?: Record<string, string | number>) => (zh as Record<string, string>)[key] ?? key


describe('operationKind 对 revert 冲突态的按钮与文案映射', () => {
  it('后端下发的 revert kind 被安全收敛为面板 kind', () => {
    expect(asPanelKind('revert' as never)).toBe('revert')
    expect(asPanelKind('merge')).toBe('merge')
  })

  it('revert 的继续按钮有专属文案且不禁用（只有 conflict 无继续语义）', () => {
    expect(continueActionLabel('revert', zhT)).toBe('继续还原')
    expect(continueActionLabel('rebase', zhT)).toBe('继续变基')
    expect(continueActionLabel('merge', zhT)).toBe('继续操作')
    expect(continueActionLabel('cherry-pick', zhT)).toBe('继续操作')
  })

  it('revert 可跳过（git revert --skip），merge 与普通冲突不可', () => {
    expect(canSkipOperation('revert')).toBe(true)
    expect(canSkipOperation('rebase')).toBe(true)
    expect(canSkipOperation('cherry-pick')).toBe(true)
    expect(canSkipOperation('merge')).toBe(false)
    expect(canSkipOperation('conflict')).toBe(false)
  })

  it('revert 复用步骤线路 UI 并显示“还原序列”', () => {
    expect(showsStepRoute('revert')).toBe(true)
    expect(showsStepRoute('rebase')).toBe(true)
    expect(showsStepRoute('merge')).toBe(false)
    expect(stepRouteLabel('revert', zhT)).toBe('还原序列')
    expect(stepRouteLabel('rebase', zhT)).toBe('变基线路')
  })
})
