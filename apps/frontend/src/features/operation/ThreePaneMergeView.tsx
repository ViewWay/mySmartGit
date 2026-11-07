import { useI18n } from '../../i18n'
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { Info } from 'lucide-react'
import { Button } from '../../components/Button'
import type { ConflictFileContent } from '../../repository'
import type { ConflictBlock, ResolutionStrategy } from './conflictDraft'
import { blockSections, locateSectionRanges, paneLabels } from './threePane'

type ThreePaneMergeViewProps = {
  file: ConflictFileContent
  /** 当前草稿（不是磁盘内容）：块操作只在草稿上做，手改不会被覆盖。 */
  draft: string
  blocks: ConflictBlock[]
  activeBlock: number
  /** 基线栏（diff3 的共同祖先）是否展开；file.base 为 null 时该栏不渲染。 */
  showBase: boolean
  onActivateBlock: (index: number) => void
  /** 侧栏头部对"当前块"直接选边；手工组合在中间可编辑栏里完成。 */
  onAdoptActive: (strategy: ResolutionStrategy) => void
  /** 中间可编辑结果栏由调用方注入（复用既有 ConflictCodeEditor）。 */
  resultPane: ReactNode
}

type SideSegment =
  | { kind: 'plain'; key: string; text: string }
  | { kind: 'block'; key: string; index: number; text: string }

function buildSegments(sideText: string, ranges: Array<{ from: number; to: number } | null>): SideSegment[] {
  const segments: SideSegment[] = []
  let cursor = 0
  ranges.forEach((range, index) => {
    if (!range || range.from < cursor) return
    if (range.from > cursor) segments.push({ kind: 'plain', key: `plain-${cursor}`, text: sideText.slice(cursor, range.from) })
    segments.push({ kind: 'block', key: `block-${index}`, index, text: sideText.slice(range.from, range.to) })
    cursor = range.to
  })
  if (cursor < sideText.length) segments.push({ kind: 'plain', key: `plain-end`, text: sideText.slice(cursor) })
  return segments
}

type SidePaneProps = {
  side: 'current' | 'incoming'
  title: string
  bodyRef: React.RefObject<HTMLDivElement>
  segments: SideSegment[]
  activeBlock: number
  blockTotal: number
  emptyReason: string | null
  onActivateBlock: (index: number) => void
  onAdoptActive: (strategy: ResolutionStrategy) => void
}

function SidePane({ side, title, bodyRef, segments, activeBlock, blockTotal, emptyReason, onActivateBlock, onAdoptActive }: SidePaneProps) {
  const { t } = useI18n()
  return <div
    className={`tp-pane tp-pane-${side}`}
    role="region"
    aria-label={t('operation.merge.readonlyPaneAria', { title })}
    tabIndex={0}
  >
    <div className="tp-pane-head">
      <strong>{title}</strong>
      <Button variant="secondary" className="tp-adopt" onClick={() => onAdoptActive(side)} disabled={!blockTotal} title={blockTotal ? t('operation.merge.adoptTitle', { title }) : t('operation.merge.noConflictBlocks')}>{t('operation.merge.useCurrentBlock')}</Button>
    </div>
    <div className="tp-pane-body" ref={bodyRef}>
      {emptyReason && <div className="tp-pane-empty"><Info size={15}/><span>{emptyReason}</span></div>}
      {!emptyReason && segments.map((segment) => segment.kind === 'block'
        ? <button
            key={segment.key}
            type="button"
            className={`tp-side-block${segment.index === activeBlock ? ' tp-side-block-active' : ''}`}
            data-tp-block={segment.index}
            onClick={() => onActivateBlock(segment.index)}
            aria-label={t('operation.jumpBlock', { index: segment.index + 1, side: title })}
            aria-current={segment.index === activeBlock ? 'true' : undefined}
          >{segment.text}</button>
        : <span key={segment.key} className="tp-side-plain">{segment.text}</span>)}
    </div>
  </div>
}

export function ThreePaneMergeView({ file, draft, blocks, activeBlock, showBase, onActivateBlock, onAdoptActive, resultPane }: ThreePaneMergeViewProps) {
  const { t } = useI18n()
  const labels = paneLabels(file, t)
  const currentBodyRef = useRef<HTMLDivElement>(null)
  const incomingBodyRef = useRef<HTMLDivElement>(null)

  // 侧栏高亮以草稿里的块为准：块在草稿里被解决后消失，对应高亮同步消失。
  const currentSections = useMemo(() => blocks.map((block) => blockSections(draft, block).current), [blocks, draft])
  const incomingSections = useMemo(() => blocks.map((block) => blockSections(draft, block).incoming), [blocks, draft])
  const currentSegments = useMemo(() => (file.current ? buildSegments(file.current, locateSectionRanges(file.current, currentSections)) : []), [file.current, currentSections])
  const incomingSegments = useMemo(() => (file.incoming ? buildSegments(file.incoming, locateSectionRanges(file.incoming, incomingSections)) : []), [file.incoming, incomingSections])

  // 当前块变化时，两侧跟随滚动到同一块；nearest 不打断用户其他阅读位置。
  useEffect(() => {
    for (const body of [currentBodyRef.current, incomingBodyRef.current]) {
      if (!body) continue
      const target = body.querySelector(`[data-tp-block="${activeBlock}"]`)
      target?.scrollIntoView({ block: 'nearest' })
    }
  }, [activeBlock, draft])

  const emptyReason = (side: 'current' | 'incoming'): string | null => {
    if (file[side] != null) return null
    return side === 'current'
      ? t('operation.merge.currentMissingHint')
      : t('operation.merge.incomingMissingHint')
  }

  return <div className={`tp-merge-grid${showBase && file.base !== null ? ' tp-merge-with-base' : ''}`}>
    {showBase && file.base !== null && <div className="tp-pane tp-pane-base" role="region" aria-label={t('operation.baseReadOnly', { base: labels.base })} tabIndex={0}>
      <div className="tp-pane-head"><strong>{labels.base}</strong></div>
      <div className="tp-pane-body tp-pane-base-body">{file.base}</div>
    </div>}
    <SidePane
      side="current"
      title={labels.current}
      bodyRef={currentBodyRef}
      segments={currentSegments}
      activeBlock={activeBlock}
      blockTotal={blocks.length}
      emptyReason={emptyReason('current')}
      onActivateBlock={onActivateBlock}
      onAdoptActive={onAdoptActive}
    />
    <div className="tp-pane tp-pane-result" role="region" aria-label={t('operation.merge.editableResult')}>
      {resultPane}
    </div>
    <SidePane
      side="incoming"
      title={labels.incoming}
      bodyRef={incomingBodyRef}
      segments={incomingSegments}
      activeBlock={activeBlock}
      blockTotal={blocks.length}
      emptyReason={emptyReason('incoming')}
      onActivateBlock={onActivateBlock}
      onAdoptActive={onAdoptActive}
    />
  </div>
}
