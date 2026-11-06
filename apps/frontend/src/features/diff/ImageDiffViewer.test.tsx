import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageFileDiff, MediaBlob, RepositoryFile } from '../../repository'
import { DiffPanel } from './DiffPanel'
import { ImageDiffViewer } from './ImageDiffViewer'

function blob(overrides: Partial<MediaBlob> = {}): MediaBlob {
  return {
    path: 'assets/logo.png',
    reference: 'HEAD',
    oid: 'a'.repeat(40),
    mime: 'image/png',
    extension: 'png',
    previewKind: 'image',
    sizeBytes: 2048,
    width: 120,
    height: 60,
    previewable: true,
    tooLarge: false,
    dataBase64: 'iVBORw0KGgo=',
    cached: false,
    ...overrides,
  }
}

function pair(overrides: Partial<ImageFileDiff> = {}): ImageFileDiff {
  return {
    path: 'assets/logo.png',
    fromReference: 'HEAD~1',
    toReference: 'HEAD',
    before: blob({ reference: 'HEAD~1', oid: 'b'.repeat(40) }),
    after: blob(),
    identical: false,
    error: null,
    ...overrides,
  }
}

/**
 * 渲染层测试：默认存储为空 → 落在「并排」模式，所以这里既锁住默认渲染，
 * 也锁住另外两种模式与各种降级路径的标记结构。
 * DiffPanel 会读 localStorage（沿用 features/diff 既有测试的 vi.stubGlobal 写法）。
 */
describe('image diff viewer markup', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => {} } })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders both decoded sides with data urls and the three modes', () => {
    const html = renderToStaticMarkup(<ImageDiffViewer path="assets/logo.png" pair={pair()}/>)
    expect(html).toContain('data:image/png;base64,iVBORw0KGgo=')
    expect((html.match(/<img /g) ?? []).length).toBe(2)
    for (const label of ['并排', '叠加', '差值']) expect(html).toContain(label)
    expect(html).toContain('变更前')
    expect(html).toContain('变更后')
    // 尺寸与字节数必须在元数据条里可见
    expect(html).toContain('120 × 60')
    expect(html).toContain('2.0 KB')
  })

  it('paints the transparent checkerboard behind both sides by default', () => {
    const html = renderToStaticMarkup(<ImageDiffViewer path="assets/logo.png" pair={pair()}/>)
    expect(html).toContain('linear-gradient(45deg, var(--surface-sunken)')
    expect(html).toContain('image-diff-transparent-backing')
    expect(html).toContain('background-size:16px 16px')
  })

  it('clips the after image by the slider position in overlay mode', () => {
    const html = renderToStaticMarkup(<ImageDiffViewer path="assets/logo.png" pair={pair()} mode="overlay"/>)
    expect(html).toContain('clip-path:inset(0 50% 0 0)')
    expect(html).toContain('type="range"')
    expect(html).toContain('叠加位置')
    expect(html).toContain('变更后（按滑块裁剪显示）')
    // 叠加是同一格子里两张图，不是并排两格
    expect((html.match(/image-diff-cell-label/g) ?? []).length).toBe(0)
  })

  it('honours an out-of-band slider value by clamping it in the markup', () => {
    const html = renderToStaticMarkup(<ImageDiffViewer path="assets/logo.png" pair={pair()} mode="overlay" slider={240}/>)
    expect(html).toContain('clip-path:inset(0 0% 0 0)')
    expect(html).toContain('value="100"')
  })

  it('mounts a canvas in difference mode and zooms the frame', () => {
    const html = renderToStaticMarkup(<ImageDiffViewer path="assets/logo.png" pair={pair()} mode="difference" zoom={2}/>)
    expect(html).toContain('<canvas')
    // 120×60 的自然尺寸 × 2 倍缩放
    expect(html).toContain('width:240px')
    expect(html).toContain('height:120px')
    expect(html).toContain('200%')
  })

  it('falls back to the side-by-side pane when a two-side mode cannot be honoured', () => {
    // 只有变更后一侧：叠加/差值都无从比较，必须回落到并排而不是画一个空格子。
    const html = renderToStaticMarkup(<ImageDiffViewer path="assets/logo.png" pair={pair({ before: null })} mode="overlay"/>)
    expect(html).not.toContain('<canvas')
    expect(html).not.toContain('clip-path')
    expect(html).toContain('image-diff-cell-label')
    expect(html).toContain('该版本没有此文件')
  })

  it('shows the readout and reset when zoom is not 1', () => {
    const html = renderToStaticMarkup(<ImageDiffViewer path="assets/logo.png" pair={pair()} zoom={0.5}/>)
    expect(html).toContain('50%')
    expect(html).toContain('恢复 100%')
  })

  it('explains the two sides that differ in size without stretching them', () => {
    const html = renderToStaticMarkup(<ImageDiffViewer
      path="assets/logo.png"
      pair={pair({ before: blob({ width: 100, height: 50 }), after: blob({ width: 200, height: 80 }) })}/>)
    // 框按较大的「变更后」对齐，较小的一侧 contain 居中，不拉伸。
    expect(html).toContain('width:200px')
    expect(html).toContain('height:80px')
    expect(html).toContain('object-fit:contain')
  })

  it('states the truth when neither side exists at this revision', () => {
    const html = renderToStaticMarkup(<ImageDiffViewer path="assets/x.png" pair={pair({ before: null, after: null })}/>)
    expect(html).toContain('该文件在该版本不存在')
  })

  it('shows a waiting message before the first pair arrives', () => {
    const html = renderToStaticMarkup(<ImageDiffViewer path="assets/x.png" pair={null}/>)
    expect(html).toContain('正在准备预览…')
    expect(html).not.toContain('<img ')
  })

  it('shows the loading message without touching the payload', () => {
    const html = renderToStaticMarkup(<ImageDiffViewer path="assets/x.png" pair={null} loading/>)
    expect(html).toContain('正在读取图片')
    expect(html).toContain('不整体进内存')
  })

  it('degrades gracefully for an oversized image instead of loading it', () => {
    const html = renderToStaticMarkup(<ImageDiffViewer
      path="assets/huge.png"
      pair={pair({ before: null, after: blob({ tooLarge: true, previewable: false, dataBase64: null, sizeBytes: 90 * 1024 * 1024 }) })}
      onOpenExternally={() => {}}/>)
    expect(html).toContain('图片过大，仅显示元数据')
    expect(html).toContain('超过预览上限')
    expect(html).toContain('4.0 MB')
    expect(html).toContain('用外部程序打开')
    expect(html).not.toContain('data:image/png;base64,')
    expect(html).not.toContain('<img ')
  })

  it('degrades per side when only one of them is oversized', () => {
    const html = renderToStaticMarkup(<ImageDiffViewer
      path="assets/huge.png"
      pair={pair({ after: blob({ tooLarge: true, previewable: false, dataBase64: null }) })}/>)
    expect(html).toContain('图片过大，仅显示元数据')
    // 可预览的一侧照常出图，不被另一侧拖累
    expect(html).toContain('data:image/png;base64,iVBORw0KGgo=')
    expect((html.match(/<img /g) ?? []).length).toBe(1)
  })

  it('explains an undecodable file and keeps the external open entry', () => {
    const html = renderToStaticMarkup(<ImageDiffViewer
      path="assets/odd.webp"
      pair={pair({ before: null, after: blob({ mime: 'image/webp', previewable: false }) })}
      onOpenExternally={() => {}}/>)
    expect(html).toContain('无法预览')
    expect(html).toContain('image/webp')
    expect(html).toContain('用外部程序打开')
  })

  it('surfaces a canvas decode failure without losing the retry entry', () => {
    // 两侧都在，差值模式才成立；这时解码失败要说清原因并留下重试与外部打开。
    const html = renderToStaticMarkup(<ImageDiffViewer
      path="assets/mark.svg"
      pair={pair({ before: blob({ previewKind: 'svg', mime: 'image/svg+xml', dataBase64: 'PHN2Zy8+' }), after: blob({ previewKind: 'svg', mime: 'image/svg+xml', dataBase64: 'PHN2Zy8+' }) })}
      mode="difference"
      differenceFailed="图片解码失败"
      onRetry={() => {}}
      onOpenExternally={() => {}}/>)
    expect(html).toContain('差值模式不可用')
    expect(html).toContain('图片解码失败')
    expect(html).toContain('重试')
    expect(html).toContain('用外部程序打开')
    expect(html).not.toContain('<canvas')
  })

  it('drops the difference mode entirely when only one side exists', () => {
    // 只剩一侧时不该再谈「差值不可用」，而是直接回落并排（上一个用例的反面）。
    const html = renderToStaticMarkup(<ImageDiffViewer
      path="assets/mark.svg"
      pair={pair({ before: null })}
      mode="difference"
      differenceFailed="图片解码失败"/>)
    expect(html).not.toContain('差值模式不可用')
    expect(html).toContain('image-diff-cell-label')
  })

  it('shows the backend error and offers a retry', () => {
    const html = renderToStaticMarkup(<ImageDiffViewer path="assets/x.png" pair={null} error="预览已取消" onRetry={() => {}}/>)
    expect(html).toContain('无法读取图片差异')
    expect(html).toContain('预览已取消')
    expect(html).toContain('重试')
  })

  it('renders the exit-to-text entry only when the host can honour it', () => {
    expect(renderToStaticMarkup(<ImageDiffViewer path="a.png" pair={pair()} onExitToText={() => {}}/>)).toContain('文本 Diff')
    expect(renderToStaticMarkup(<ImageDiffViewer path="a.png" pair={pair()}/>)).not.toContain('文本 Diff')
  })

  it('hides the before side and the mode switch in single variant', () => {
    const html = renderToStaticMarkup(<ImageDiffViewer variant="single" path="assets/logo.png" pair={pair({ before: null })}/>)
    expect(html).not.toContain('对比模式')
    expect(html).not.toContain('变更前')
    expect(html).toContain('文件内容')
    expect(html).toContain('data:image/png;base64,')
  })
})

describe('DiffPanel media seam', () => {
  const mediaFiles: RepositoryFile[] = [{ path: 'assets/logo.png', type: 'M', add: 0, del: 0, staged: true, unstaged: false }]
  const textFiles: RepositoryFile[] = [{ path: 'src/main.rs', type: 'M', add: 1, del: 1, staged: true, unstaged: false }]

  beforeEach(() => {
    // features/diff 的既有约定：DiffPanel 直接读 localStorage 取字号与视图偏好。
    vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => {} } })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function panelLoaders() {
    const calls: string[] = []
    const loadImageDiff = (path: string) => {
      calls.push(path)
      return Promise.resolve(pair())
    }
    return { calls, loadImageDiff }
  }

  it('stays on the text pane when the host injects no media loader', () => {
    const html = renderToStaticMarkup(<DiffPanel
      files={mediaFiles}
      wide={false}
      onWideChange={() => {}}
      fallbackChangeRows={[{ old: 1, next: null, kind: 'del', code: 'gone' }]}/>)
    expect(html).not.toContain('image-diff-panel')
    expect(html).toContain('class="code-diff')
  })

  it('switches to the image pane for a media file once a loader is provided', () => {
    const html = renderToStaticMarkup(<DiffPanel
      files={mediaFiles}
      wide={false}
      onWideChange={() => {}}
      loadImageDiff={() => Promise.resolve(pair())}
      onOpenFileExternally={() => {}}/>)
    expect(html).toContain('image-diff-panel')
    expect(html).not.toContain('class="code-diff')
    expect(html).toContain('文本 Diff')
    expect(html).toContain('外部打开')
  })

  it('keeps non-media files on the text pane even with the loader wired', () => {
    const html = renderToStaticMarkup(<DiffPanel
      files={textFiles}
      wide={false}
      onWideChange={() => {}}
      loadImageDiff={() => Promise.resolve(pair())}/>)
    expect(html).not.toContain('image-diff-panel')
    expect(html).toContain('class="code-diff')
  })

  it('renders the image pane without touching the loader during the first paint', () => {
    // 请求由 effect 驱动（静态渲染不跑 effect），这里锁住「首帧不偷发 IPC」这一事实；
    // 计划层的 reuse/reset 判定在 imageDiffModel.test.ts 里单独钉。
    const { calls, loadImageDiff } = panelLoaders()
    const html = renderToStaticMarkup(<DiffPanel
      files={mediaFiles}
      wide={false}
      onWideChange={() => {}}
      loadImageDiff={loadImageDiff}
      reloadKey="head-1"/>)
    expect(html).toContain('image-diff-panel')
    expect(calls).toEqual([])
  })
})
