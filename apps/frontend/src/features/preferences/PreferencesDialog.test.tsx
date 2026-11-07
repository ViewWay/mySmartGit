import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PreferencesDialog } from './PreferencesDialog'

const noop = () => undefined

describe('PreferencesDialog', () => {
  it('renders the general preferences page with live preference controls', () => {
    const html = renderToStaticMarkup(<PreferencesDialog open page="general" onClose={noop} onPageChange={noop}/>)
    expect(html).toContain('aria-label="偏好设置"')
    expect(html).toContain('界面语言')
    expect(html).toContain('自动换行')
    expect(html).toContain('显示空白差异')
    expect(html).toContain('Diff 字号')
  })

  it('renders the update panel on the updates page', () => {
    const html = renderToStaticMarkup(<PreferencesDialog open page="updates" onClose={noop} onPageChange={noop}/>)
    expect(html).toContain('版本与更新')
    expect(html).toContain('检查更新')
  })

  it('renders nothing while closed', () => {
    expect(renderToStaticMarkup(<PreferencesDialog open={false} page="general" onClose={noop} onPageChange={noop}/>)).toBe('')
  })
})
