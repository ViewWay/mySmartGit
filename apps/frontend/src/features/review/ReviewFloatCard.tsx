// ReviewFloatCard：把载体无关的 ReviewThreadPanel 浮在锚点行旁。
// portal 到 .app-shell（复用 ContextMenu 的挂载模式），position: fixed，
// 锚定 anchorRect（viewport 坐标）下方，越界自动翻转到上方或收拢进视口。
// anchorRect 为 null（锚行滚走/换文件）时不渲染。
import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ReviewThreadPanel, type ReviewThreadPanelProps } from './ReviewThreadPanel'

const CARD_WIDTH = 340
const PAD = 8
const GAP = 6

export type ReviewFloatCardProps = ReviewThreadPanelProps & {
  /** 锚点行的 viewport 矩形；null 时收起浮层。 */
  anchorRect: DOMRect | null
}

export function ReviewFloatCard({ anchorRect, ...panelProps }: ReviewFloatCardProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null)

  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card || !anchorRect) {
      setPos(null)
      return
    }
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const width = card.offsetWidth || CARD_WIDTH
    const height = card.offsetHeight
    const left = Math.max(PAD, Math.min(anchorRect.left, viewportWidth - width - PAD))
    let top = anchorRect.bottom + GAP
    if (top + height > viewportHeight - PAD) {
      const above = anchorRect.top - height - GAP
      top = above >= PAD ? above : Math.max(PAD, viewportHeight - height - PAD)
    }
    setPos({ left, top, maxHeight: Math.max(120, viewportHeight - PAD * 2) })
  }, [anchorRect, panelProps.threads, panelProps.composeLine, panelProps.composeRange, panelProps.error])

  if (!anchorRect) return null
  const portalTarget = document.querySelector('.app-shell') ?? document.body
  return createPortal(
    <div
      ref={cardRef}
      className="review-float-card"
      style={{
        left: pos?.left ?? anchorRect.left,
        top: pos?.top ?? anchorRect.bottom + GAP,
        width: CARD_WIDTH,
        maxHeight: pos?.maxHeight,
      }}
    >
      <ReviewThreadPanel {...panelProps}/>
    </div>,
    portalTarget,
  )
}