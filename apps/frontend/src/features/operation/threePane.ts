import { resolveConflictBlockInText, parseConflictBlocks, type ConflictBlock, type ResolutionStrategy } from './conflictDraft'

/**
 * 三栏合并视图的纯逻辑：栏目标签、块侧内容切片、侧栏定位、批量选边。
 * 全部只作用于内存草稿字符串——绝不读磁盘，用户未保存的手改不会被覆盖。
 */

export type PaneLabels = {
  current: string
  incoming: string
  base: string
}

/**
 * 三栏栏头标签。rebase 语义下 current/incoming 的含义会翻转（"变基目标" vs "当前分支"），
 * 后端已用 currentLabel / incomingLabel 下发，这里只消费、不硬编码"本地/远端"；
 * 老数据缺字段时回退到与操作方向无关的中性措辞。
 */
export function paneLabels(file: { currentLabel?: string; incomingLabel?: string } | null | undefined): PaneLabels {
  return {
    current: file?.currentLabel?.trim() || '当前一侧（current）',
    incoming: file?.incomingLabel?.trim() || '传入一侧（incoming）',
    base: '共同祖先（基线）',
  }
}

function endOfLine(value: string, position: number): number {
  const newline = value.indexOf('\n', position)
  return newline < 0 ? value.length : newline + 1
}

export type BlockSideSections = {
  /** 当前侧内容（不含 `<<<<<<<` 标记行与基线段）。 */
  current: string
  /** 传入侧内容（不含 `=======` / `>>>>>>>` 标记行与基线段）。 */
  incoming: string
  /** 基线段内容（diff3 / zdiff3 才有）；两栏样式时为 null。 */
  base: string | null
}

/**
 * 从草稿里切出某个冲突块的两侧（以及基线）原文。
 * 兼容 diff3（基线在当前侧后）与 zdiff3（基线在传入侧后）：基线段绝不能混进侧内容。
 */
export function blockSections(value: string, block: ConflictBlock): BlockSideSections {
  const currentFrom = endOfLine(value, block.offset)
  const hasBase = block.baseStart !== null
  const diff3 = hasBase && (block.baseStart as number) < block.separatorStart
  const currentEnd = diff3 ? (block.baseStart as number) : block.separatorStart
  // 两栏冲突（无基线）时传入侧延伸到 `>>>>>>>` 行首；zdiff3 时在尾部基线处截止。
  const incomingTo = hasBase && !diff3 ? (block.baseStart as number) : block.incomingEnd
  const base = block.baseStart === null
    ? null
    : value.slice(endOfLine(value, block.baseStart), diff3 ? block.separatorStart : block.incomingEnd)
  return {
    current: value.slice(currentFrom, currentEnd),
    incoming: value.slice(block.separatorEnd, incomingTo),
    base,
  }
}

export type SideRange = { from: number; to: number }

/**
 * 把各冲突块的侧内容在"整侧文件原文"里定位出来（三栏侧高亮用）。
 * Git 按文件顺序输出冲突块，所以从上一个命中位置向后单调查找即可；
 * 手工编辑导致某个块在侧文件里找不到时返回 null，该块不高亮，其余块不受影响。
 */
export function locateSectionRanges(sideText: string, sections: Array<string | null>): Array<SideRange | null> {
  let cursor = 0
  return sections.map((section) => {
    if (!section) return null
    const index = sideText.indexOf(section, cursor)
    if (index < 0) return null
    cursor = index + section.length
    return { from: index, to: cursor }
  })
}

/**
 * 批量处理：把草稿里剩余所有冲突块统一选边。
 * 逐块套用既有单块解法（同样只在草稿上做），一次返回最终文本，
 * 由调用方作为单条"batch"历史条目入栈——整体可一次撤销。
 */
export function resolveAllBlocks(value: string, strategy: ResolutionStrategy): { text: string; resolved: number } {
  let text = value
  let resolved = 0
  for (;;) {
    const outcome = resolveConflictBlockInText(text, 0, strategy)
    if (!outcome) break
    text = outcome.text
    resolved += 1
  }
  return { text, resolved }
}

/** 恢复冲突状态用的原文校验：解析后再数一遍，保证与 parseConflictBlocks 口径一致。 */
export function conflictBlockCount(value: string): number {
  return parseConflictBlocks(value).length
}
