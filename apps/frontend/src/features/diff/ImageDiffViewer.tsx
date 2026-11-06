import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Columns2, Contrast, ExternalLink, ImageOff, Layers, Maximize, Minus, Plus, RotateCcw, TriangleAlert } from 'lucide-react'
import { Button } from '../../components/Button'
import { usePersistentState } from '../../persistentState'
import type { ImageFileDiff, MediaBlob } from '../../repository'
import {
  CHECKERBOARD_STYLE,
  IMAGE_DIFF_MODES,
  IMAGE_MODE_LABELS,
  canCompare,
  clampSlider,
  clampZoom,
  describeBlob,
  describeImageDiff,
  displaySize,
  isImageDiffMode,
  mediaDataUrl,
  overlayClipPath,
  resolveImageDiffStatus,
  resolveSideStatus,
  zoomBy,
  type FitBox,
  type ImageDiffMode,
  type SideStatus,
} from './imageDiffModel'
import './imageDiff.css'

export type ImageDiffViewerProps = {
  /** 文件路径，仅用于文案与 aria。 */
  path: string
  pair: ImageFileDiff | null
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  /** 「用外部程序打开」入口；宿主未提供该能力时按钮自动隐藏。 */
  onOpenExternally?: () => void
  onExitToText?: () => void
  /**
   * 'diff'（默认）：变更前/变更后对比，三种模式可用。
   * 'single'：只看一侧（提交树里点文件用），只显示变更后侧，模式收敛为并排。
   */
  variant?: 'diff' | 'single'
  /**
   * 以下都是可选的受控覆盖：不传时组件自己管状态（现有调用点一律不传，行为不变）。
   * 存在的意义是让「渲染层」能被静态渲染测试直接钉住某个模式/缩放/降级态，
   * 而不需要引入 jsdom 去模拟点击。
   */
  mode?: ImageDiffMode
  zoom?: number
  slider?: number
  checkerboard?: boolean
  differenceFailed?: string | null
}

function sideLabel(blob: MediaBlob | null | undefined, fallback: string) {
  return blob ? `${fallback} · ${blob.reference}` : fallback
}

/**
 * 图片 / SVG 差异预览：并排、叠加（滑块）、差值三种模式。
 * 任何不可预览的情形都走优雅降级：给出原因、给出元数据、给出外部打开入口。
 */
export function ImageDiffViewer({ path, pair, loading = false, error = null, onRetry, onOpenExternally, onExitToText, variant = 'diff', mode: controlledMode, zoom: controlledZoom, slider: controlledSlider, checkerboard: controlledCheckerboard, differenceFailed: controlledDifferenceFailed }: ImageDiffViewerProps) {
  const [storedMode, setMode] = usePersistentState<ImageDiffMode>('branchline.imageDiffMode.v1', 'side', isImageDiffMode)
  const single = variant === 'single'
  const requestedMode: ImageDiffMode = single ? 'side' : (controlledMode ?? storedMode)
  const [innerZoom, setZoom] = useState(1)
  const [innerSlider, setSlider] = useState(50)
  const [innerCheckerboard, setCheckerboard] = useState(true)
  const [innerDifferenceFailed, setDifferenceFailed] = useState<string | null>(null)
  const zoom = controlledZoom ?? innerZoom
  const slider = controlledSlider ?? innerSlider
  const checkerboard = controlledCheckerboard ?? innerCheckerboard
  const [fitToWindow, setFitToWindow] = useState(true)
  const [container, setContainer] = useState<FitBox | null>(null)
  const [intrinsic, setIntrinsic] = useState<FitBox | null>(null)
  const differenceFailed = controlledDifferenceFailed ?? innerDifferenceFailed
  const viewportRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const beforeUrl = mediaDataUrl(pair?.before)
  const afterUrl = mediaDataUrl(pair?.after)

  useEffect(() => {
    const node = viewportRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box) setContainer({ width: box.width, height: box.height })
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // 换文件或换模式后重置视图参数，避免带着上一次的缩放看新图。
  useEffect(() => {
    setZoom(1)
    setSlider(50)
    setDifferenceFailed(null)
    setIntrinsic(null)
  }, [path, pair?.before?.oid, pair?.after?.oid])

  const natural = useMemo<FitBox | null>(() => {
    // 后端能从文件头解析出尺寸时优先使用；解析不出（或 SVG 只有 viewBox）时用 img 的 naturalWidth。
    const blobs: (MediaBlob | null | undefined)[] = [pair?.after, pair?.before]
    for (const blob of blobs) {
      if (blob?.width && blob.height) return { width: blob.width, height: blob.height }
    }
    return intrinsic
  }, [pair?.after, pair?.before, intrinsic])

  const box = useMemo<FitBox>(() => {
    if (!natural) return { width: 320, height: 200 }
    // 两侧尺寸不一致时按较大者对齐，另一侧等比居中，避免拉伸。
    const widths = [pair?.before?.width, pair?.after?.width].filter((value): value is number => typeof value === 'number')
    const heights = [pair?.before?.height, pair?.after?.height].filter((value): value is number => typeof value === 'number')
    const widest = widths.length ? Math.max(...widths) : natural.width
    const tallest = heights.length ? Math.max(...heights) : natural.height
    return fitToWindow ? displaySize({ width: widest, height: tallest }, container, zoom) : { width: Math.round(widest * clampZoom(zoom)), height: Math.round(tallest * clampZoom(zoom)) }
  }, [container, fitToWindow, natural, pair?.after?.width, pair?.after?.height, pair?.before?.width, pair?.before?.height, zoom])

  const status = resolveImageDiffStatus(pair, loading, error)
  const comparable = canCompare(pair, requestedMode)
  /**
   * 叠加与差值都必须有两侧才有意义：只剩一侧时回落到并排，
   * 而不是给用户一个空白的视口（这是「优雅降级」里最容易漏的一条）。
   */
  const mode: ImageDiffMode = requestedMode === 'side' || !comparable ? 'side' : requestedMode

  const handleImageLoad = useCallback((event: { currentTarget: HTMLImageElement }) => {
    const { naturalWidth, naturalHeight } = event.currentTarget
    if (naturalWidth > 0 && naturalHeight > 0) {
      setIntrinsic((current) => (current && current.width === naturalWidth && current.height === naturalHeight
        ? current
        : { width: naturalWidth, height: naturalHeight }))
    }
  }, [])

  // 差值模式：canvas 的 difference 合成，纯前端，不引入任何图像库。
  useEffect(() => {
    if (mode !== 'difference') return
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context || !beforeUrl || !afterUrl) return
    let cancelled = false
    const load = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => {
      if (typeof Image === 'undefined') {
        reject(new Error('当前环境不支持图片解码'))
        return
      }
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('图片解码失败'))
      image.src = url
    })
    Promise.all([load(beforeUrl), load(afterUrl)]).then(([before, after]) => {
      if (cancelled) return
      const width = Math.max(1, Math.round(box.width))
      const height = Math.max(1, Math.round(box.height))
      canvas.width = width
      canvas.height = height
      const paint = (image: HTMLImageElement) => {
        // contain 对齐：不拉伸，两侧尺寸不一致时居中留白。
        const ratio = Math.min(width / image.naturalWidth, height / image.naturalHeight)
        const drawWidth = image.naturalWidth * ratio
        const drawHeight = image.naturalHeight * ratio
        context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight)
      }
      context.clearRect(0, 0, width, height)
      context.globalCompositeOperation = 'source-over'
      paint(after)
      context.globalCompositeOperation = 'difference'
      paint(before)
      context.globalCompositeOperation = 'source-over'
      setDifferenceFailed(null)
    }).catch((reason: Error) => {
      if (!cancelled) setDifferenceFailed(reason.message)
    })
    return () => { cancelled = true }
  }, [afterUrl, beforeUrl, box.height, box.width, mode])

  const frameStyle = { width: `${box.width}px`, height: `${box.height}px` }

  return <section className="image-diff-panel" aria-label={`图片差异预览 ${path}`}>
    <div className="image-diff-toolbar">
      {!single && <div className="segmented icon-segmented" role="group" aria-label="对比模式">
        {IMAGE_DIFF_MODES.map((candidate) => <button
          key={candidate}
          type="button"
          className={mode === candidate ? 'active' : ''}
          aria-pressed={mode === candidate}
          title={`${IMAGE_MODE_LABELS[candidate]}对比${candidate !== 'side' && !comparable ? '（需要两侧都有图）' : ''}`}
          onClick={() => setMode(candidate)}
        >
          {candidate === 'side' ? <Columns2 size={14}/> : candidate === 'overlay' ? <Layers size={14}/> : <Contrast size={14}/>}
          <span>{IMAGE_MODE_LABELS[candidate]}</span>
        </button>)}
      </div>}
      <div className="segmented icon-segmented" role="group" aria-label="缩放">
        <button type="button" onClick={() => setZoom((value) => zoomBy(value, -1))} title="缩小" aria-label="缩小"><Minus size={14}/></button>
        <button type="button" className="image-diff-zoom-readout" onClick={() => setZoom(1)} title="恢复 100%">{Math.round(clampZoom(zoom) * 100)}%</button>
        <button type="button" onClick={() => setZoom((value) => zoomBy(value, 1))} title="放大" aria-label="放大"><Plus size={14}/></button>
      </div>
      <Button size="compact" variant={fitToWindow ? 'primary' : 'secondary'} active={fitToWindow} onClick={() => setFitToWindow((value) => !value)} title="适应窗口"><Maximize size={13}/><span>适应窗口</span></Button>
      <Button size="compact" variant={checkerboard ? 'primary' : 'secondary'} active={checkerboard} onClick={() => setCheckerboard((value) => !value)} title="棋盘格透明背景">透明底</Button>
      {!single && typeof pair === 'object' && pair !== null && <span className="image-diff-meta-hint">{describeImageDiff(pair)}</span>}
      <span className="image-diff-spacer"/>
      {onExitToText && <Button size="compact" onClick={onExitToText} title="改用文本 Diff 查看"><RotateCcw size={13}/><span>文本 Diff</span></Button>}
      {onOpenExternally && <Button size="compact" onClick={onOpenExternally} title="用系统默认程序打开"><ExternalLink size={13}/><span>外部打开</span></Button>}
    </div>

    <div className="image-diff-meta">
      <dl>
        {!single && <><dt>变更前</dt><dd>{describeBlob(pair?.before ?? null)}</dd></>}
        <dt>{single ? '文件' : '变更后'}</dt><dd>{describeBlob(pair?.after ?? null)}</dd>
      </dl>
      <span className="image-diff-hint">{status === 'too-large' ? '图片超过预览上限，仅读取元数据；不会整体载入内存。' : ''}</span>
    </div>

    <div ref={viewportRef} className={`image-diff-viewport ${checkerboard ? 'image-diff-transparent-backing' : ''}`}>
      {status === 'idle' && <div className="image-diff-message"><strong>正在准备预览…</strong><span>读取变更前 / 变更后两个版本后即可对比。</span></div>}
      {status === 'loading' && <div className="image-diff-message"><strong>正在读取图片…</strong><span>超大文件只会读取元数据，不整体进内存。</span></div>}
      {status === 'error' && <Degradation title="无法读取图片差异" detail={error ?? pair?.error ?? '后端返回失败。'} onRetry={onRetry} onOpenExternally={onOpenExternally}/>}
      {status === 'missing' && <Degradation title="该文件在该版本不存在" detail="两侧都取不到 blob：可能是重命名、子模组指针变更或路径不在该 ref 下。" onOpenExternally={onOpenExternally}/>}
      {status === 'unsupported' && <Degradation title="无法预览该文件" detail={`MIME 推断为 ${pair?.after?.mime ?? pair?.before?.mime ?? '未知'}，不是可解码的图片或 SVG。可以用外部程序打开。`} onOpenExternally={onOpenExternally}/>}
      {status === 'too-large' && <Degradation title="图片过大，仅显示元数据" detail={`${describeBlob(pair?.after ?? pair?.before)}。为避免把整张图读进内存，只取了文件头。`} onOpenExternally={onOpenExternally}/>}
      {mode === 'difference' && differenceFailed && <Degradation title="差值模式不可用" detail={`${differenceFailed}；SVG 只有 viewBox 而无显式尺寸时可能无法解码为位图。`} onRetry={onRetry} onOpenExternally={onOpenExternally}/>}

      {(status === 'ready' || status === 'missing') && mode === 'side' && <div className="image-diff-side-by-side">
        {!single && <ImageSide label={sideLabel(pair?.before, '变更前')} url={beforeUrl} blob={pair?.before} frameStyle={frameStyle} checkerboard={checkerboard} onLoad={handleImageLoad}/>}
        <ImageSide label={single ? '文件内容' : sideLabel(pair?.after, '变更后')} url={afterUrl} blob={pair?.after} frameStyle={frameStyle} checkerboard={checkerboard} onLoad={handleImageLoad}/>
      </div>}

      {status === 'ready' && mode === 'overlay' && comparable && <div className="image-diff-cell">
        <div className="image-diff-frame" style={{ ...frameStyle, ...(checkerboard ? CHECKERBOARD_STYLE : {}) }}>
          <img className="image-diff-image" style={{ ...frameStyle, objectFit: 'contain' }} src={beforeUrl ?? undefined} alt="变更前" onLoad={handleImageLoad}/>
          <img className="image-diff-image image-diff-image--clipped" style={{ ...frameStyle, objectFit: 'contain', clipPath: overlayClipPath(slider) }} src={afterUrl ?? undefined} alt="变更后（按滑块裁剪显示）" onLoad={handleImageLoad}/>
        </div>
      </div>}

      {status === 'ready' && mode === 'difference' && comparable && !differenceFailed && <canvas ref={canvasRef} className="image-diff-canvas" style={{ ...frameStyle, ...(checkerboard ? CHECKERBOARD_STYLE : {}) }}/>}
    </div>

    {status === 'ready' && mode === 'overlay' && comparable && <div className="image-diff-slider-row">
      <span>叠加位置</span>
      <input type="range" min={0} max={100} step={1} value={clampSlider(slider)} onChange={(event) => setSlider(Number(event.target.value))} aria-label="叠加对比滑块"/>
      <span className="image-diff-zoom-readout">{Math.round(clampSlider(slider))}%</span>
    </div>}
  </section>
}

function ImageSide({ label, url, blob, frameStyle, checkerboard, onLoad }: {
  label: string
  url: string | null
  blob: MediaBlob | null | undefined
  frameStyle: CSSProperties
  checkerboard: boolean
  onLoad: (event: { currentTarget: HTMLImageElement }) => void
}) {
  const status = resolveSideStatus(blob)
  return <div className="image-diff-cell">
    <span className="image-diff-cell-label">{label}</span>
    {status === 'ready' && <div className="image-diff-frame" style={{ ...frameStyle, ...(checkerboard ? CHECKERBOARD_STYLE : {}) }}>
      <img className="image-diff-image" style={{ ...frameStyle, objectFit: 'contain' }} src={url ?? undefined} alt={label} onLoad={onLoad}/>
    </div>}
    {status !== 'ready' && <div className="image-diff-message"><strong>{STATUS_TEXT[status].title}</strong><span>{STATUS_TEXT[status].detail(describeBlob(blob))}</span></div>}
  </div>
}

const STATUS_TEXT: Record<SideStatus, { title: string; detail: (meta: string) => string }> = {
  ready: { title: '', detail: () => '' },
  missing: { title: '该版本没有此文件', detail: () => '新增或删除的一侧，无法成图对比。' },
  'too-large': { title: '图片过大，仅显示元数据', detail: (meta) => `${meta} 为避免整体载入，只读取了文件头。` },
  unsupported: { title: '无法预览', detail: (meta) => `${meta} 不是可解码的图片或 SVG。` },
}

function Degradation({ title, detail, onRetry, onOpenExternally }: { title: string; detail: string; onRetry?: () => void; onOpenExternally?: () => void }) {
  return <div className="image-diff-message">
    <strong><ImageOff size={13}/> {title}</strong>
    <span>{detail}</span>
    {(onRetry || onOpenExternally) && <span className="image-diff-message-actions">
      {onRetry && <Button size="compact" onClick={onRetry}><TriangleAlert size={13}/><span>重试</span></Button>}
      {onOpenExternally && <Button size="compact" onClick={onOpenExternally}><ExternalLink size={13}/><span>用外部程序打开</span></Button>}
    </span>}
  </div>
}
