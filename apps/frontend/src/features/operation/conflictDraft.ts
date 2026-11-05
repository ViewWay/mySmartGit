export type ResolutionStrategy = 'current' | 'incoming' | 'both'

/**
 * 这里用结构化的最小类型（而不是 import ConflictFileContent），
 * 让纯文本处理逻辑可以脱离 Tauri 注入链单独测试；
 * 真实的 ConflictFileContent 结构上满足这些字段。
 */
export type ConflictSideState = {
  binary: boolean
  gitlink: boolean
  current: string | null
  incoming: string | null
  currentAvailable?: boolean
  incomingAvailable?: boolean
}

export type ConflictBlock = {
  index: number
  /** 冲突块起始（`<<<<<<<` 行行首）在文本里的字符偏移。 */
  offset: number
  /** 当前侧内容的结束偏移（等于分隔符行行首）。 */
  currentEnd: number
  /** 基线段（diff3/zdiff3 的 `|||||||`）区间；没有基线段时为 null。 */
  baseStart: number | null
  baseEnd: number | null
  separatorStart: number
  separatorEnd: number
  incomingEnd: number
  /** 冲突块结束（`>>>>>>>` 行行尾）在文本里的字符偏移。 */
  endOffset: number
}

export type BlockResolution = {
  text: string
  /** 解决后该块结果在新文本里的区间，用来延续"已解决"高亮与滚动锚点。 */
  span: { from: number; to: number }
  /** 解决后剩余的冲突块数量。 */
  remaining: number
}

type BlockLocation = {
  startLine: number
  baseLine: number | null
  separatorLine: number
  endLine: number
}

function isStartMarker(line: string): boolean {
  return line.startsWith('<<<<<<<')
}

function isBaseMarker(line: string): boolean {
  return line === '|||||||' || line.startsWith('||||||| ')
}

function isSeparator(line: string): boolean {
  return line.startsWith('=======')
}

function isEndMarker(line: string): boolean {
  return line.startsWith('>>>>>>>')
}

/**
 * 按行定位冲突块，兼容两种冲突样式：
 * - diff3：`<<<<<<< / 当前侧 / ||||||| 基线 / ======= / 对方侧 / >>>>>>>`
 * - zdiff3：`<<<<<<< / 当前侧 / ======= / 对方侧 / ||||||| 基线 / >>>>>>>`
 * 基线段必须被识别出来，否则它会被当成"当前侧"的内容写进结果里。
 */
function locateBlocks(lines: string[]): BlockLocation[] {
  const blocks: BlockLocation[] = []
  let cursor = 0
  while (cursor < lines.length) {
    if (!isStartMarker(lines[cursor])) {
      cursor += 1
      continue
    }
    let separator = -1
    let base: number | null = null
    for (let index = cursor + 1; index < lines.length; index += 1) {
      if (isSeparator(lines[index])) {
        separator = index
        break
      }
      if (base === null && isBaseMarker(lines[index])) base = index
      if (isEndMarker(lines[index])) break
    }
    if (separator < 0) break
    let end = -1
    let trailingBase: number | null = null
    for (let index = separator + 1; index < lines.length; index += 1) {
      if (isEndMarker(lines[index])) {
        end = index
        break
      }
      if (trailingBase === null && isBaseMarker(lines[index])) trailingBase = index
    }
    if (end < 0) break
    // 基线段总是延伸到本段结尾：diff3 在当前侧，zdiff3 在对方侧。
    blocks.push({ startLine: cursor, baseLine: base ?? trailingBase, separatorLine: separator, endLine: end })
    cursor = end + 1
  }
  return blocks
}

function lineStart(lines: string[], line: number): number {
  let offset = 0
  for (let index = 0; index < line; index += 1) offset += lines[index].length + 1
  return offset
}

export function parseConflictBlocks(value: string): ConflictBlock[] {
  const lines = value.split('\n')
  return locateBlocks(lines).map((location, index) => {
    const offset = lineStart(lines, location.startLine)
    const separatorStart = lineStart(lines, location.separatorLine)
    const baseStart = location.baseLine === null ? null : lineStart(lines, location.baseLine)
    const baseEnd =
      location.baseLine === null
        ? null
        : location.baseLine < location.separatorLine
          ? separatorStart
          : lineStart(lines, location.endLine)
    return {
      index,
      offset,
      currentEnd: separatorStart,
      baseStart,
      baseEnd,
      separatorStart,
      separatorEnd: separatorStart + lines[location.separatorLine].length + 1,
      incomingEnd: lineStart(lines, location.endLine),
      endOffset: lineStart(lines, location.endLine) + lines[location.endLine].length,
    }
  })
}

/**
 * 与后端 `has_conflict_markers` 保持同一口径（只看成对冲突标记），
 * 否则前端提示会说"还有标记"而后端已经落暂存。
 * 基线标记 `|||||||` 一定伴随 `<<<<<<<`/`=======` 出现，不必单独判。
 */
export function hasConflictMarkers(value: string): boolean {
  const lines = value.split('\n')
  return lines.some((line) => isStartMarker(line) || isSeparator(line) || isEndMarker(line))
}

function sectionLines(lines: string[], from: number, to: number): string[] {
  // 去掉基线段：基线标记行到本段结尾都属于 merge base，不是任何一侧的改动。
  const baseIndex = lines.slice(from, to).findIndex(isBaseMarker)
  return baseIndex < 0 ? lines.slice(from, to) : lines.slice(from, from + baseIndex)
}

/**
 * 在给定草稿文本上解决第 blockIndex 个冲突块。
 * 只作用于传入的文本，不读磁盘——手工编辑的草稿不会被磁盘版本覆盖掉。
 * 找不到目标块时返回 null，由调用方给出提示。
 */
export function resolveConflictBlockInText(
  value: string,
  blockIndex: number,
  strategy: ResolutionStrategy,
): BlockResolution | null {
  const lines = value.split('\n')
  const locations = locateBlocks(lines)
  const location = locations[blockIndex]
  if (!location) return null
  const current = sectionLines(lines, location.startLine + 1, location.separatorLine)
  const incoming = sectionLines(lines, location.separatorLine + 1, location.endLine)
  const replacement = strategy === 'current' ? current : strategy === 'incoming' ? incoming : [...current, ...incoming]
  const next = [...lines.slice(0, location.startLine), ...replacement, ...lines.slice(location.endLine + 1)]
  const text = next.join('\n')
  // 块之前的文本一字未动，所以旧文本里算出的块首偏移在新文本里依然有效。
  const spanStart = lineStart(lines, location.startLine)
  const inserted = replacement.join('\n')
  return {
    text,
    span: { from: spanStart, to: Math.min(spanStart + inserted.length, text.length) },
    remaining: locations.length - 1,
  }
}

export function normalizeConflictDraft(result: string | null | undefined): string {
  return (result ?? '').replace(/\r\n/g, '\n')
}

/** 草稿是否与磁盘上的冲突文件一致：不一致说明有未保存的手动编辑。 */
export function isDraftDirty(draft: string, file: { result: string } | null): boolean {
  return draft !== normalizeConflictDraft(file?.result)
}

/**
 * 某一侧能否被"采用"。
 * 二进制与 gitlink 的侧内容读不出文本（`current`/`incoming` 为 null），
 * 但整侧采用在它们上本来就是有效操作，不能因此把按钮判死。
 */
export function isSideAvailable(file: ConflictSideState, side: 'current' | 'incoming'): boolean {
  const explicit = side === 'current' ? file.currentAvailable : file.incomingAvailable
  if (typeof explicit === 'boolean') return explicit
  if (file.gitlink || file.binary) return true
  return file[side] != null
}
