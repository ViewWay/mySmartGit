import { describe, expect, it } from 'vitest'
import type { ImageFileDiff, MediaBlob } from '../../repository'
import {
  IMAGE_DIFF_MODES,
  MEDIA_PREVIEW_MAX_BYTES,
  ZOOM_MAX,
  ZOOM_MIN,
  canCompare,
  clampSlider,
  clampZoom,
  createMediaRequestId,
  describeBlob,
  describeImageDiff,
  displaySize,
  fitScale,
  formatByteSize,
  formatImageDimensions,
  isImageDiffMode,
  isMediaPreviewPath,
  isStaleRequest,
  mediaDataUrl,
  mediaTargetKey,
  overlayClipPath,
  planMediaRequest,
  resolveBlobStatus,
  resolveImageDiffStatus,
  resolveSideStatus,
  shouldRenderMediaView,
  zoomBy,
} from './imageDiffModel'

function blob(overrides: Partial<MediaBlob> = {}): MediaBlob {
  return {
    path: 'a.png',
    reference: 'HEAD',
    oid: 'x'.repeat(40),
    mime: 'image/png',
    extension: 'png',
    previewKind: 'image',
    sizeBytes: 1024,
    width: 8,
    height: 4,
    previewable: true,
    tooLarge: false,
    dataBase64: 'iVBORw0KGgo=',
    cached: false,
    ...overrides,
  }
}

function pair(overrides: Partial<ImageFileDiff> = {}): ImageFileDiff {
  return {
    path: 'a.png',
    fromReference: 'HEAD~1',
    toReference: 'HEAD',
    before: blob(),
    after: blob({ reference: 'HEAD' }),
    identical: false,
    error: null,
    ...overrides,
  }
}

describe('media path gate', () => {
  it('accepts the same extension whitelist as the backend', () => {
    for (const path of ['a.png', 'b.jpeg', 'c.SVG', 'dir/deep-logo.jpg', '中文 目录/我的 logo.PNG', 'x.webp', 'y.ico']) {
      expect(isMediaPreviewPath(path), path).toBe(true)
    }
  })

  it('rejects text and extension-less files so no useless IPC happens', () => {
    for (const path of ['main.rs', 'index.tsx', 'notes.txt', 'Makefile', 'archive.tar.gz.bak', '.gitignore', '']) {
      expect(isMediaPreviewPath(path), path).toBe(false)
    }
  })

  it('only switches to the media view when the host injected a loader', () => {
    expect(shouldRenderMediaView('a.png', false)).toBe(false)
    expect(shouldRenderMediaView('a.png', true)).toBe(true)
    expect(shouldRenderMediaView('main.rs', true)).toBe(false)
    expect(shouldRenderMediaView(undefined, true)).toBe(false)
  })

  it('keeps the frontend threshold aligned with the Rust MAX_PREVIEW_BYTES', () => {
    expect(MEDIA_PREVIEW_MAX_BYTES).toBe(4 * 1024 * 1024)
  })
})

describe('mode state', () => {
  it('exposes exactly the three comparison modes with labels', () => {
    expect(IMAGE_DIFF_MODES).toEqual(['side', 'overlay', 'difference'])
    expect(isImageDiffMode('overlay')).toBe(true)
    expect(isImageDiffMode('difference')).toBe(true)
    expect(isImageDiffMode('nonsense')).toBe(false)
    expect(isImageDiffMode(undefined)).toBe(false)
  })

  it('only allows two-side modes when both sides exist', () => {
    expect(canCompare(pair(), 'overlay')).toBe(true)
    expect(canCompare(pair({ before: null }), 'overlay')).toBe(false)
    expect(canCompare(pair({ before: null }), 'side')).toBe(true)
    expect(canCompare(null, 'difference')).toBe(false)
  })
})

describe('zoom and slider clamping', () => {
  it('clamps zoom into the allowed band and stays finite', () => {
    expect(clampZoom(0)).toBe(ZOOM_MIN)
    expect(clampZoom(999)).toBe(ZOOM_MAX)
    expect(clampZoom(Number.NaN)).toBe(1)
    expect(clampZoom(1.5)).toBe(1.5)
  })

  it('steps zoom without floating point drift', () => {
    let zoom = 1
    const seen: number[] = []
    for (let i = 0; i < 4; i += 1) {
      zoom = zoomBy(zoom, 1)
      seen.push(zoom)
    }
    expect(seen).toEqual([1.25, 1.5, 1.75, 2])
    expect(zoomBy(1, -1)).toBe(0.75)
    expect(zoomBy(ZOOM_MIN, -1)).toBe(ZOOM_MIN)
    expect(zoomBy(ZOOM_MAX, 1)).toBe(ZOOM_MAX)
  })

  it('clamps the overlay slider and derives a clip path', () => {
    expect(clampSlider(-20)).toBe(0)
    expect(clampSlider(140)).toBe(100)
    expect(clampSlider(Number.NaN)).toBe(50)
    expect(overlayClipPath(30)).toBe('inset(0 70% 0 0)')
    expect(overlayClipPath(100)).toBe('inset(0 0% 0 0)')
    expect(overlayClipPath(0)).toBe('inset(0 100% 0 0)')
  })
})

describe('size formatting and metadata', () => {
  it('formats bytes across units and guards nonsense input', () => {
    expect(formatByteSize(0)).toBe('0 B')
    expect(formatByteSize(999)).toBe('999 B')
    expect(formatByteSize(1024)).toBe('1.0 KB')
    expect(formatByteSize(1536)).toBe('1.5 KB')
    expect(formatByteSize(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatByteSize(3 * 1024 * 1024 * 1024)).toBe('3.0 GB')
    expect(formatByteSize(-1)).toBe('—')
    expect(formatByteSize(Number.NaN)).toBe('—')
  })

  it('describes dimensions honestly when the header could not be parsed', () => {
    expect(formatImageDimensions(blob({ width: null, height: null }))).toBe('尺寸未知')
    expect(formatImageDimensions(null)).toBe('无此侧')
    expect(formatImageDimensions(blob({ width: 640, height: 480 }))).toBe('640 × 480')
  })

  it('includes the degrade reason in the metadata line', () => {
    expect(describeBlob(blob({ tooLarge: true, previewable: false, dataBase64: null }))).toContain('超过预览上限')
    expect(describeBlob(blob({ width: null, height: null }))).toContain('尺寸未知')
    expect(describeBlob(null)).toBe('无此侧')
  })

  it('summarizes added / removed / identical sides', () => {
    expect(describeImageDiff(pair({ before: null }))).toBe('新增文件，无变更前')
    expect(describeImageDiff(pair({ after: null }))).toBe('删除文件，无变更后')
    expect(describeImageDiff(pair({ identical: true }))).toBe('两侧内容一致（无像素差异）')
    expect(describeImageDiff(null)).toBe('')
  })
})

describe('degradation status', () => {
  it('maps a single side honestly', () => {
    expect(resolveBlobStatus(blob())).toBe('ready')
    expect(resolveBlobStatus(null)).toBe('missing')
    expect(resolveBlobStatus(blob({ tooLarge: true, previewable: false, dataBase64: null }))).toBe('too-large')
    expect(resolveBlobStatus(blob({ previewKind: 'other', previewable: false }))).toBe('unsupported')
    expect(resolveBlobStatus(blob({ dataBase64: null }))).toBe('unsupported')
    expect(resolveBlobStatus(blob(), 'boom')).toBe('error')
  })

  it('reports ready when at least one side can render, even if the other is missing', () => {
    expect(resolveImageDiffStatus(pair({ before: null }))).toBe('ready')
    expect(resolveImageDiffStatus(pair({ after: null }))).toBe('ready')
    expect(resolveImageDiffStatus(pair({ before: null, after: null }))).toBe('missing')
    expect(resolveImageDiffStatus(pair({ before: blob({ tooLarge: true, previewable: false, dataBase64: null }), after: null }))).toBe('too-large')
    expect(resolveImageDiffStatus(null)).toBe('idle')
    expect(resolveImageDiffStatus(pair(), true)).toBe('loading')
    expect(resolveImageDiffStatus(pair(), false, '读取失败')).toBe('error')
    expect(resolveImageDiffStatus(pair({ before: null, after: null, error: '两侧都不存在该文件' }))).toBe('error')
  })
})

describe('data url and fit math', () => {
  it('builds a mime-typed data url and refuses when there is no payload', () => {
    expect(mediaDataUrl(blob())).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(mediaDataUrl(blob({ dataBase64: null }))).toBeNull()
    expect(mediaDataUrl(null)).toBeNull()
    // SVG 也走 img + data URL：浏览器不会执行其中的脚本。
    expect(mediaDataUrl(blob({ mime: 'image/svg+xml', previewKind: 'svg' }))).toBe('data:image/svg+xml;base64,iVBORw0KGgo=')
  })

  it('shrinks oversized images to the viewport but never upscales', () => {
    expect(fitScale({ width: 2000, height: 1000 }, { width: 800, height: 600 })).toBeCloseTo(0.4, 6)
    expect(fitScale({ width: 10, height: 10 }, { width: 800, height: 600 })).toBe(1)
    expect(fitScale(null, { width: 800, height: 600 })).toBe(1)
    expect(fitScale({ width: 0, height: 5 }, { width: 800, height: 600 })).toBe(1)
    expect(fitScale({ width: 100, height: 100 }, null)).toBe(1)
  })

  it('combines fit and user zoom into an integer display size', () => {
    expect(displaySize({ width: 2000, height: 1000 }, { width: 800, height: 600 }, 1)).toEqual({ width: 800, height: 400 })
    expect(displaySize({ width: 2000, height: 1000 }, { width: 800, height: 600 }, 2)).toEqual({ width: 1600, height: 800 })
    expect(displaySize({ width: 4, height: 2 }, null, ZOOM_MIN)).toEqual({ width: 1, height: 1 })
  })
})

describe('request identity', () => {
  it('creates unique ids and detects stale responses', () => {
    const first = createMediaRequestId('a.png', 'HEAD')
    const second = createMediaRequestId('a.png', 'HEAD')
    expect(first).not.toBe(second)
    expect(first.startsWith('media-')).toBe(true)
    expect(isStaleRequest(second, first)).toBe(true)
    expect(isStaleRequest(second, second)).toBe(false)
    // id 只保留安全字符，避免把路径里的分隔符带进命令参数。
    expect(createMediaRequestId('中文 目录/我的 logo.png', 'refs/heads/feat-x')).toMatch(/^media-[a-z0-9]+-\d+-/)
  })
})

describe('media request plan', () => {
  const base = {
    loaderProvided: true,
    path: 'assets/logo.png',
    identity: 'HEAD\u00000\u0000assets/logo.png',
    retry: 0,
    reloadKey: 'head-1',
  }

  it('pins one request to identity + retry + reload', () => {
    expect(mediaTargetKey(base)).toBe(mediaTargetKey(base))
    expect(mediaTargetKey({ ...base, retry: 1 })).not.toBe(mediaTargetKey(base))
    expect(mediaTargetKey({ ...base, reloadKey: 'head-2' })).not.toBe(mediaTargetKey(base))
    expect(mediaTargetKey({ ...base, identity: null })).toBeNull()
    expect(mediaTargetKey({ ...base, path: null })).toBeNull()
    expect(mediaTargetKey({ ...base, loaderProvided: false })).toBeNull()
    expect(mediaTargetKey({ ...base, path: 'src/main.rs' })).toBeNull()
    // 「改用文本 Diff」时不再向后端要图
    expect(mediaTargetKey({ ...base, asText: true })).toBeNull()
  })

  it('reuses an in-flight request instead of firing another IPC', () => {
    const key = mediaTargetKey(base) as string
    expect(planMediaRequest(key, null)).toBe('load')
    expect(planMediaRequest(key, key)).toBe('reuse')
    expect(planMediaRequest(key, 'other-key')).toBe('load')
    expect(planMediaRequest(null, key)).toBe('reset')
    expect(planMediaRequest(null, null)).toBe('reset')
  })
})

describe('side status has a single source of truth', () => {
  it('mirrors the blob flags for the per-side cells', () => {
    expect(resolveSideStatus(blob())).toBe('ready')
    expect(resolveSideStatus(null)).toBe('missing')
    expect(resolveSideStatus(undefined)).toBe('missing')
    expect(resolveSideStatus(blob({ tooLarge: true, previewable: false, dataBase64: null }))).toBe('too-large')
    expect(resolveSideStatus(blob({ previewable: false }))).toBe('unsupported')
    // 后端说可预览却没给字节，也不能当 ready：这是降级路径的最后一道闸。
    expect(resolveSideStatus(blob({ dataBase64: null }))).toBe('unsupported')
    expect(resolveBlobStatus(blob())).toBe('ready')
    expect(resolveBlobStatus(blob(), '后端失败')).toBe('error')
  })

  it('quotes the shared threshold in the degrade copy', () => {
    const line = describeBlob(blob({ tooLarge: true, previewable: false, dataBase64: null, sizeBytes: 90 * 1024 * 1024 }))
    expect(line).toContain('超过预览上限')
    expect(line).toContain(formatByteSize(MEDIA_PREVIEW_MAX_BYTES))
    expect(line).toContain('4.0 MB')
  })
})
