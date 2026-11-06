import type { ImageFileDiff, MediaBlob } from '../../repository'

/**
 * 图片 / SVG 差异预览的纯逻辑层：阈值判定、对比模式、缩放、滑块、降级状态。
 * 与渲染分离，便于单测（项目现有测试用 renderToStaticMarkup，没有 jsdom 与 canvas）。
 */

/** 与后端 git_media.rs 的 extension_mime 白名单保持一致。 */
export const MEDIA_PREVIEW_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'cur', 'svg', 'tif', 'tiff', 'avif', 'heic', 'heif',
] as const

/** 后端单张图的整体读入上限（字节），与 Rust 的 MAX_PREVIEW_BYTES 对齐。 */
export const MEDIA_PREVIEW_MAX_BYTES = 4 * 1024 * 1024

export type ImageDiffMode = 'side' | 'overlay' | 'difference'

export const IMAGE_DIFF_MODES: ImageDiffMode[] = ['side', 'overlay', 'difference']

export const IMAGE_MODE_LABELS: Record<ImageDiffMode, string> = {
  side: '并排',
  overlay: '叠加',
  difference: '差值',
}

export const ZOOM_MIN = 0.1
export const ZOOM_MAX = 8
export const ZOOM_STEP = 0.25
export const SLIDER_MIN = 0
export const SLIDER_MAX = 100

function fileExtension(path: string) {
  const name = path.split(/[/\\]/).pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** 是否值得发起媒体预览请求；文本文件据此快速短路，避免多余 IPC。 */
export function isMediaPreviewPath(path: string): boolean {
  const extension = fileExtension(path)
  if (!extension) return false
  return (MEDIA_PREVIEW_EXTENSIONS as readonly string[]).includes(extension)
}

/** 只有拿到宿主注入的 loader 且文件是媒体候选时才走图片视图；否则 DiffPanel 行为完全不变。 */
export function shouldRenderMediaView(path: string | undefined, loaderProvided: boolean): boolean {
  return loaderProvided && !!path && isMediaPreviewPath(path)
}

export function normalizeImageDiffMode(value: unknown): ImageDiffMode {
  return IMAGE_DIFF_MODES.includes(value as ImageDiffMode) ? (value as ImageDiffMode) : 'side'
}

/** 持久化状态校验器：脏值回落到并排，绝不把未知字符串带进渲染分支。 */
export function isImageDiffMode(value: unknown): value is ImageDiffMode {
  return typeof value === 'string' && IMAGE_DIFF_MODES.includes(value as ImageDiffMode)
}

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value))
}

export function zoomBy(current: number, direction: 1 | -1, step = ZOOM_STEP): number {
  // 先量化再夹取，避免 1 + 0.25 * n 的浮点尾巴让显示出现 1.7500000000000002。
  const next = Math.round((clampZoom(current) + direction * step) * 100) / 100
  return clampZoom(next)
}

export function clampSlider(value: number): number {
  if (!Number.isFinite(value)) return 50
  return Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, value))
}

/** 叠加模式的裁剪：保留左侧图到 slider 百分比，右侧透出。 */
export function overlayClipPath(percentage: number): string {
  const value = clampSlider(percentage)
  return `inset(0 ${Math.round((100 - value) * 100) / 100}% 0 0)`
}

export type MediaStatus = 'idle' | 'loading' | 'ready' | 'too-large' | 'unsupported' | 'missing' | 'error'

/** 单侧格子能表达的状态（不含 loading / error，那两个属于整个视图）。 */
export type SideStatus = 'ready' | 'missing' | 'too-large' | 'unsupported'

/**
 * 单侧图的渲染决策。顺序很重要：
 * too-large 优先于 unsupported（大图也是「有元数据」的正常降级），
 * missing 优先于 error（新增/删除的一侧本就缺一侧）。
 * 这是唯一的判据来源：ImageDiffViewer 的两侧格子与整体状态都走它，不再各写一份。
 */
export function resolveSideStatus(blob: MediaBlob | null | undefined): SideStatus {
  if (!blob) return 'missing'
  if (blob.tooLarge) return 'too-large'
  if (!blob.previewable || !blob.dataBase64) return 'unsupported'
  return 'ready'
}

export function resolveBlobStatus(blob: MediaBlob | null | undefined, error?: string | null): MediaStatus {
  if (error) return 'error'
  return resolveSideStatus(blob)
}

/**
 * 差异视图的整体状态描述的是「视图能做什么」，不是「哪一侧缺」：
 * 只要有一侧能出图就是 ready（另一侧由各自的 cell 解释缺失原因）；
 * 两侧都没有 blob 才是 missing；都取不到可解码图时才谈 too-large / unsupported。
 */
export function resolveImageDiffStatus(pair: ImageFileDiff | null, loading = false, error?: string | null): MediaStatus {
  if (loading) return 'loading'
  if (error) return 'error'
  if (!pair) return 'idle'
  const sides = [resolveBlobStatus(pair.before), resolveBlobStatus(pair.after)]
  if (sides.every((side) => side === 'missing')) return pair.error ? 'error' : 'missing'
  const present = sides.filter((side) => side !== 'missing')
  if (present.includes('ready')) return 'ready'
  if (present.includes('too-large')) return 'too-large'
  if (present.includes('unsupported')) return 'unsupported'
  return 'error'
}

/** data URL：SVG 同样只用 `<img>` 加载——浏览器在 img 语境下把 SVG 当作「静态内容」，
 * 其中的脚本与外链都不会执行；前提是绝不把 SVG 内联进 DOM（不用 innerHTML）。 */
export function mediaDataUrl(blob: MediaBlob | null | undefined): string | null {
  if (!blob?.dataBase64) return null
  const mime = blob.mime || (blob.previewKind === 'svg' ? 'image/svg+xml' : 'application/octet-stream')
  return `data:${mime};base64,${blob.dataBase64}`
}

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes
  let index = -1
  do {
    value /= 1024
    index += 1
  } while (value >= 1024 && index < units.length - 1)
  const digits = value >= 100 ? 0 : 1
  return `${value.toFixed(digits)} ${units[index]}`
}

export function formatImageDimensions(blob: MediaBlob | null | undefined): string {
  if (!blob) return '无此侧'
  if (blob.width && blob.height) return `${blob.width} × ${blob.height}`
  return '尺寸未知'
}

/** 一行元数据：`PNG · 1024 × 768 · 256 KB`，无法预览时也保证有内容可解释。 */
export function describeBlob(blob: MediaBlob | null | undefined): string {
  if (!blob) return '无此侧'
  const parts = [(blob.extension || blob.mime).toUpperCase(), formatImageDimensions(blob), formatByteSize(blob.sizeBytes)]
  // 阈值文案直接引用与后端对齐的那个常量，避免「文档说 4 MiB、代码说别的」。
  if (blob.tooLarge) parts.push(`超过预览上限（${formatByteSize(MEDIA_PREVIEW_MAX_BYTES)}），仅显示元数据`)
  return parts.join(' · ')
}

export function describeImageDiff(pair: ImageFileDiff | null): string {
  if (!pair) return ''
  const sides = [pair.before, pair.after].filter(Boolean).length
  if (pair.identical) return '两侧内容一致（无像素差异）'
  if (sides === 1 && !pair.before) return '新增文件，无变更前'
  if (sides === 1 && !pair.after) return '删除文件，无变更后'
  return `${sides} 侧可比较`
}

export type FitBox = { width: number; height: number }

/** 适应视口的基准倍数：图片原始尺寸超过容器时按比例缩小，小图不放大。 */
export function fitScale(natural: FitBox | null, container: FitBox | null): number {
  if (!natural || !container || natural.width <= 0 || natural.height <= 0) return 1
  if (container.width <= 0 || container.height <= 0) return 1
  const ratio = Math.min(container.width / natural.width, container.height / natural.height)
  return Math.min(1, Math.max(0.05, ratio))
}

/** 最终展示尺寸 = 原始尺寸 × 适应比 × 用户缩放，并保证至少 1px。 */
export function displaySize(natural: FitBox, container: FitBox | null, zoom: number): FitBox {
  const base = fitScale(natural, container) * clampZoom(zoom)
  return {
    width: Math.max(1, Math.round(natural.width * base)),
    height: Math.max(1, Math.round(natural.height * base)),
  }
}

/** 只有两侧都就绪时叠加/差值才有意义，否则回落到并排或单侧。 */
export function canCompare(pair: ImageFileDiff | null, mode: ImageDiffMode): boolean {
  if (!pair) return false
  if (mode === 'side') return Boolean(pair.before || pair.after)
  return Boolean(pair.before && pair.after)
}

/** 棋盘格透明背景：位图与 SVG 都可能有透明通道，差值对比时必须能看见透明区。 */
export const CHECKERBOARD_STYLE = {
  backgroundImage:
    'linear-gradient(45deg, var(--surface-sunken) 25%, transparent 25%), linear-gradient(-45deg, var(--surface-sunken) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--surface-sunken) 75%), linear-gradient(-45deg, transparent 75%, var(--surface-sunken) 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
} as const

/** 一次性请求 id：同一文件的旧请求被新 id 取代后，响应直接丢弃并通知后端取消。 */
let requestSequence = 0

export function createMediaRequestId(path: string, reference: string): string {
  const seq = requestSequence += 1
  const safe = `${reference}:${path}`.replace(/[^A-Za-z0-9_.-]/g, '_').slice(-64)
  return `media-${Date.now().toString(36)}-${seq}-${safe}`
}

/** 迟到的响应必须被丢弃：比较当前请求 id 与响应携带的 id。 */
export function isStaleRequest(currentRequestId: string | null, respondingRequestId: string): boolean {
  return currentRequestId !== respondingRequestId
}

/**
 * 「这一次要不要向后端发媒体请求」的判据，抽出来才能被单测覆盖（组件里只有 effect 与 ref）。
 * targetKey 把「同一个文件 + 同一次重试 + 同一次刷新」钉成一个值；与进行中的 key 相同就是复用。
 */
export function mediaTargetKey(input: {
  loaderProvided: boolean
  path: string | null
  identity: string | null
  retry: number
  reloadKey?: string
  /** 用户点了「改用文本 Diff」：这时不再向后端要图。 */
  asText?: boolean
}): string | null {
  if (input.asText) return null
  if (!input.identity) return null
  // 复用同一个判定，别在两个地方各写一遍「要不要发媒体请求」。
  if (!shouldRenderMediaView(input.path ?? undefined, input.loaderProvided)) return null
  return `${input.identity}\u0000${input.retry}\u0000${input.reloadKey ?? ''}`
}

export type MediaRequestAction = 'load' | 'reuse' | 'reset'

export function planMediaRequest(targetKey: string | null, activeKey: string | null): MediaRequestAction {
  if (!targetKey) return 'reset'
  return targetKey === activeKey ? 'reuse' : 'load'
}
