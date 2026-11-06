import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiffPanel } from './DiffPanel'
import { setPreference } from '../../preferences'
import type { RepositoryDiffLine } from '../../repository'

// SSR normally uses the default snapshot. Supply the real current preference store
// so these render tests can exercise the menu-owned word-wrap setting.
vi.mock('../../preferences', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../preferences')>()
  return { ...actual, usePreferences: actual.getPreferences }
})

afterEach(() => setPreference('wordWrap', false))

afterEach(() => vi.unstubAllGlobals())

describe('wrapped diff geometry', () => {
  const files = [{ path: 'file.txt', type: 'M', add: 1, del: 1, staged: false }]
  const rows: RepositoryDiffLine[] = [
    { old: 1, next: 1, kind: 'same', code: 'context' },
    { old: 2, next: null, kind: 'del', code: 'old\nsecond\nthird' },
    { old: null, next: 2, kind: 'add', code: 'new' },
  ]
  function render(view: string, wrappedRows = rows, fontSize = 12, scope = 'file') {
    vi.stubGlobal('window', { localStorage: {
      getItem: (key: string) => key === 'branchline.diffView.v1' ? JSON.stringify(view) : key === 'branchline.diffScope.v1' ? JSON.stringify(scope) : null,
      setItem: () => {},
    } })
    return renderToStaticMarkup(<DiffPanel files={files} wide={false} onWideChange={() => {}} defaultFontSize={fontSize} allowStage onStagePatch={() => {}} onRestorePatch={() => {}} fallbackChangeRows={wrappedRows} />)
  }

  it('uses padded visual heights and weighted action/overview positions in unified mode', () => {
    setPreference('wordWrap', true)
    const html = render('unified')
    expect(html).toMatch(/class="diff-panel [^"]*word-wrap/)
    expect(html).toContain('data-diff-row-index="1" style="height:60px"')
    expect(html).toContain('aria-orientation="vertical" style="top:42px"')
    expect(html).toContain('class="diff-block-range" aria-hidden="true" style="top:0;height:84px"')
    expect(html).toContain('min(19.4%,')
    expect(html).toContain('height:48.4%')
  })

  it('shares the larger side height with both split panes and the middle action lane', () => {
    setPreference('wordWrap', true)
    const html = render('split')
    expect(html.match(/data-diff-row-index="1" style="height:60px"/g)).toHaveLength(2)
    expect(html).toContain('class="split-action-row" style="height:60px"')
    expect(html).toContain('aria-orientation="vertical" style="top:30px"')
    expect(html).toContain('min(24%,')
    expect(html).toContain('height:60%')
  })

  it('keeps no-wrap rows compact and preserves custom font-size props', () => {
    const compact = render('split')
    expect(compact).not.toContain('word-wrap')
    expect(compact.match(/data-diff-row-index="1" style="height:24px"/g)).toHaveLength(2)
    setPreference('wordWrap', true)
    const larger = render('split', rows, 16)
    expect(larger.match(/data-diff-row-index="1" style="height:78px"/g)).toHaveLength(2)
    expect(larger).toContain('--diff-font-size:16px')
  })

  it('keeps omitted context rows at their special compact height when wrapping', () => {
    setPreference('wordWrap', true)
    const context: RepositoryDiffLine[] = Array.from({ length: 30 }, (_, index) => ({ old: index + 1, next: index + 1, kind: 'same', code: 'context' }))
    const html = render('unified', [...context, { old: null, next: 31, kind: 'add', code: 'a\nb' }], 16, 'changes')
    expect(html).toMatch(/class="hunk diff-omitted" style="height:24px"/)
    expect(html).toMatch(/data-diff-row-index="\d+" style="height:54px"/)
  })

  it('uses the sum of offscreen heights for virtual padding in every split lane', () => {
    setPreference('wordWrap', true)
    const many: RepositoryDiffLine[] = Array.from({ length: 400 }, (_, index) => ({ old: null, next: index + 1, kind: 'add', code: 'a\nb\nc' }))
    const html = render('split', many)
    const left = html.slice(html.indexOf('aria-label="旧版本代码"'), html.indexOf('aria-label="差异操作"'))
    const rendered = left.match(/data-diff-row-index=/g)?.length ?? 0
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThan(400)
    const remainingHeight = (400 - rendered) * 60 + 16
    expect(html.match(new RegExp('padding-bottom:' + remainingHeight + 'px', 'g'))).toHaveLength(3)
    expect(left).toContain('style="height:60px"')
  })
})

describe('diff patch actions', () => {
  for (const view of ['unified', 'split']) {
    it('keeps the file header outside the code scroll pane in ' + view, () => {
      vi.stubGlobal('window', { localStorage: { getItem: (key: string) => key === 'branchline.diffView.v1' ? JSON.stringify(view) : null } })
      const html = renderToStaticMarkup(<DiffPanel files={[{ path: 'file.txt', type: 'M', add: 1, del: 0, staged: false }]} wide={false} onWideChange={() => {}} fallbackChangeRows={[{ old: null, next: 1, kind: 'add', code: 'new' }]} />)
      const paneClass = view === 'unified' ? 'unified-diff-pane' : 'split-diff-panes'
      expect(html).toMatch(new RegExp('class="file-header"[\\s\\S]*?</span></div>(?:<div class="hunk">[^<]*</div>)?<div class="' + paneClass + '"'))
      expect(html.slice(html.indexOf('class="' + paneClass + '"'))).not.toContain('class="file-header"')
    })

    it('centers block actions across multiple compact code rows in ' + view, () => {
      vi.stubGlobal('window', { localStorage: { getItem: (key: string) => key === 'branchline.diffView.v1' ? JSON.stringify(view) : null } })
      const html = renderToStaticMarkup(<DiffPanel files={[{ path: 'file.txt', type: 'M', add: 3, del: 0, staged: false }]} wide={false} onWideChange={() => {}} allowStage onStagePatch={() => {}} onRestorePatch={() => {}} fallbackChangeRows={[1, 2, 3].map((next) => ({ old: null, next, kind: 'add', code: 'new ' + next }))} />)
      expect(html.match(/class="diff-block-actions"/g)).toHaveLength(1)
      expect(html).toContain('aria-orientation="vertical" style="top:12px"')
      expect(html).toContain('class="diff-block-range"')
      expect(html.indexOf('aria-label="还原此修改块"')).toBeLessThan(html.indexOf('aria-label="暂存此修改块"'))
      if (view === 'unified') {
        const middleRow = html.slice(html.indexOf('data-diff-row-index="1"'), html.indexOf('data-diff-row-index="2"'))
        expect(middleRow).toContain('class="diff-block-actions"')
        expect(middleRow).toContain('height:24px')
      } else {
        const gutter = html.slice(html.indexOf('aria-label="差异操作"'), html.indexOf('aria-label="新版本代码"'))
        expect(gutter).toMatch(/split-action-row[^>]*><\/div><div[^>]*>.*diff-block-actions/)
      }
    })

    it('keeps both block actions directly available for single-line blocks in ' + view, () => {
      vi.stubGlobal('window', { localStorage: { getItem: (key: string) => key === 'branchline.diffView.v1' ? JSON.stringify(view) : null } })
      const html = renderToStaticMarkup(<DiffPanel files={[{ path: 'file.txt', type: 'M', add: 2, del: 0, staged: false }]} wide={false} onWideChange={() => {}} allowStage onStagePatch={() => {}} onRestorePatch={() => {}} fallbackChangeRows={[{ old: null, next: 1, kind: 'add', code: 'first' }, { old: 1, next: 2, kind: 'same', code: 'context' }, { old: null, next: 3, kind: 'add', code: 'last' }]} />)
      expect(html.match(/aria-label="修改块操作"/g)).toHaveLength(2)
      expect(html).not.toContain('aria-haspopup="menu"')
      expect(html.match(/aria-label="暂存此修改块"/g)).toHaveLength(2)
      expect(html.match(/aria-label="还原此修改块"/g)).toHaveLength(2)
      expect(html).toContain('aria-orientation="vertical" style="top:20px"')
      expect(html).toContain('padding-bottom:16px')
      expect(html).toContain('height:24px')
    })

    it('shows unstage actions for staged rows and blocks in ' + view, () => {
      vi.stubGlobal('window', { localStorage: { getItem: (key: string) => key === 'branchline.diffView.v1' ? JSON.stringify(view) : null } })
      const html = renderToStaticMarkup(<DiffPanel files={[{ path: 'file.txt', type: 'M', add: 1, del: 1, staged: true }]} wide={false} onWideChange={() => {}} actionScope="staged" onUnstagePatch={() => {}} fallbackChangeRows={[1, 2, 3].map((next) => ({ old: null, next, kind: 'add', code: 'new ' + next }))} />)
      expect(html).toContain('aria-label="取消暂存此修改块"')
      expect(html.match(/aria-label="取消暂存此行"/g)).toHaveLength(3)
      expect(html).not.toContain('aria-label="还原此修改块"')
      expect(html).not.toContain('aria-label="暂存此修改块"')
    })
  }

  it('disables patch actions during mutation or reload', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => null } })
    const html = renderToStaticMarkup(<DiffPanel files={[{ path: 'file.txt', type: 'M', add: 1, del: 1, staged: false }]} wide={false} onWideChange={() => {}} allowStage actionsBusy onStagePatch={() => {}} onRestorePatch={() => {}} fallbackChangeRows={[{ old: null, next: 1, kind: 'add', code: 'new' }]} />)
    expect(html).toMatch(/disabled="" class="diff-stage-action"/)
    expect(html).toMatch(/disabled="" class="diff-restore-action"/)
    expect(html).toMatch(/disabled="" class="change-sign line-action-add"/)
  })
})
