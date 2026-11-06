import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { scanSource } from './i18n-scan.mjs'

describe('scanSource', () => {
  it('counts Chinese literals and JSX text but skips comments and imports', () => {
    const source = `
      // 注释不计入
      import { t } from './i18n'
      const ok = t('common.save')
      export const A = () => <button title="中文标题">中文文本</button>
      const raw = '硬编码'
    `
    assert.equal(scanSource(source, 'A.tsx'), 3)
  })

  it('honors i18n-allow', () => {
    assert.equal(scanSource(`export const x = '中文' // i18n-allow`, 'A.ts'), 0)
  })

  it('ignores technical identifiers without Chinese', () => {
    assert.equal(scanSource(`export const x = 'plain'`, 'A.ts'), 0)
  })
})
