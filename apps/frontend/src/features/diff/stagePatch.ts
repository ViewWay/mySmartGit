import type { RepositoryDiffLine } from '../../repository'

/**
 * 局部暂存补丁构建：由选中行拼 unified diff。
 * 独立成纯函数模块（无组件导出），让 DiffPanel.tsx 保持纯组件导出以支持 Fast Refresh。
 */
export function buildStagePatch(filePath: string, rows: RepositoryDiffLine[], fileType?: string, operation: 'stage' | 'restore' | 'unstage' = 'stage', sourceRows?: RepositoryDiffLine[]) {
  if (sourceRows) {
    // A large unchanged interval may be omitted by Git. Preserve those gaps
    // as separate hunks rather than concatenating distant file coordinates.
    const segments: RepositoryDiffLine[][] = [[]]
    let previousOld: number | null = null
    let previousNew: number | null = null
    for (const row of sourceRows) {
      if ((row.old != null && previousOld != null && row.old > previousOld + 1)
        || (row.next != null && previousNew != null && row.next > previousNew + 1)) segments.push([])
      segments[segments.length - 1].push(row)
      if (row.old != null) previousOld = row.old
      if (row.next != null) previousNew = row.next
    }
    if (segments.length > 1) {
      const selectedRows = new Set(rows.filter((row) => row.kind !== 'same'))
      const patches: string[] = segments.flatMap((segment) => {
        const selected = segment.filter((row) => selectedRows.has(row))
        return selected.length ? [buildStagePatch(filePath, selected, undefined, operation, segment)] : []
      })
      return patches.map((patch, index) => index ? patch.slice(patch.indexOf('\n@@') + 1) : patch).join('')
    }
    const selected = new Set(rows.filter((row) => row.kind !== 'same'))
    const reverse = operation !== 'stage'
    const context = (row: RepositoryDiffLine): RepositoryDiffLine => ({
      ...row, kind: 'same',
      code: reverse ? row.newCode ?? row.code : row.oldCode ?? row.code,
      oldCode: reverse ? row.newCode ?? row.code : row.oldCode ?? row.code,
      newCode: reverse ? row.newCode ?? row.code : row.oldCode ?? row.code,
      oldNoNewline: reverse ? row.newNoNewline : row.oldNoNewline,
      newNoNewline: reverse ? row.newNoNewline : row.oldNoNewline,
    })
    const patchRows: RepositoryDiffLine[] = []
    for (let index = 0; index < sourceRows.length;) {
      if (sourceRows[index].kind === 'same') { patchRows.push(context(sourceRows[index++])); continue }
      const removed: RepositoryDiffLine[] = []
      const added: RepositoryDiffLine[] = []
      while (index < sourceRows.length && sourceRows[index].kind !== 'same') {
        const row = sourceRows[index++]
        ;(row.kind === 'del' ? removed : added).push(row)
      }
      for (let offset = 0; offset < Math.max(removed.length, added.length); offset++) {
        const oldRow = removed[offset]
        const newRow = added[offset]
        if (oldRow && selected.has(oldRow)) patchRows.push(oldRow)
        else if (oldRow && !reverse) patchRows.push(context(oldRow))
        if (newRow && selected.has(newRow)) patchRows.push(newRow)
        else if (newRow && reverse) patchRows.push(context(newRow))
      }
    }
    let lastOld = -1
    let lastNew = -1
    patchRows.forEach((row, index) => {
      if (row.kind !== 'add') lastOld = index
      if (row.kind !== 'del') lastNew = index
    })
    const normalized = patchRows.flatMap((row, index): RepositoryDiffLine[] => {
      const oldNoNewline = index === lastOld && Boolean(row.oldNoNewline)
      const newNoNewline = index === lastNew && Boolean(row.newNoNewline)
      // A formerly unterminated last line needs a newline when another selected
      // line follows it. Encode that boundary change instead of concatenating.
      if (row.kind === 'same' && oldNoNewline !== newNoNewline) return [
        { ...row, kind: 'del', oldNoNewline, newNoNewline: false },
        { ...row, kind: 'add', oldNoNewline: false, newNoNewline },
      ]
      return [{ ...row, oldNoNewline, newNoNewline }]
    })
    // Rebase both sides onto the actual apply target. Unselected additions or
    // deletions must not come out with their original line offsets.
    let oldLine = sourceRows.find((row) => row.old != null)?.old ?? 1
    let newLine = reverse ? sourceRows.find((row) => row.next != null)?.next ?? 1 : oldLine
    if (reverse) oldLine = newLine
    const rebased = normalized.map((row) => ({ ...row, old: row.kind === 'add' ? null : oldLine++, next: row.kind === 'del' ? null : newLine++ }))
    return buildStagePatch(filePath, rebased, fileType, operation)
  }
  const selected = rows.filter((row) => row.kind !== 'same')
  if (!selected.length) return ''
  const oldValues = rows.filter((row) => row.kind === 'del' || row.kind === 'same')
  const newValues = rows.filter((row) => row.kind === 'add' || row.kind === 'same')
  const first = rows[0] ?? selected[0]
  // A zero-length unified-diff range points at the line before the insertion/deletion.
  const oldCount = oldValues.length
  const newCount = newValues.length
  const firstOldLine = rows.find((row) => row.old != null)?.old
  const firstNewLine = rows.find((row) => row.next != null)?.next
  const oldStart = oldCount ? (firstOldLine ?? 1) : Math.max(0, (first.next ?? 1) - 1)
  const newStart = newCount ? (firstNewLine ?? 1) : Math.max(0, (first.old ?? 1) - 1)
  const body = rows.map((row) => {
    const code = row.kind === 'same'
      ? operation === 'stage' ? row.oldCode ?? row.code : row.newCode ?? row.code
      : row.kind === 'del' ? row.oldCode ?? row.code : row.newCode ?? row.code
    const noNewline = row.kind === 'del' ? row.oldNoNewline : row.kind === 'add' ? row.newNoNewline : operation === 'stage' ? row.oldNoNewline : row.newNoNewline
    return `${row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}${code}${noNewline ? '\n\\ No newline at end of file' : ''}`
  }).join('\n')
  const isNewFile = fileType === 'A' && oldCount === 0
  const isDeletedFile = fileType === 'D' && newCount === 0
  const header = isNewFile
    ? `new file mode 100644\n--- /dev/null\n+++ b/${filePath}`
    : isDeletedFile
      ? `deleted file mode 100644\n--- a/${filePath}\n+++ /dev/null`
      : `--- a/${filePath}\n+++ b/${filePath}`
  return `diff --git a/${filePath} b/${filePath}\n${header}\n@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${body}\n`
}

export function changeBlock(rows: RepositoryDiffLine[], index: number) {
  if (!rows[index] || rows[index].kind === 'same') return []
  let start = index
  let end = index
  while (start > 0 && rows[start - 1].kind !== 'same') start -= 1
  while (end + 1 < rows.length && rows[end + 1].kind !== 'same') end += 1
  // Keep a small amount of surrounding context so Git can anchor the patch
  // at the exact hunk instead of applying a context-free change elsewhere.
  const context = 3
  let contextStart = start
  let contextEnd = end
  while (contextStart > 0 && start - contextStart < context && rows[contextStart - 1].kind === 'same') contextStart -= 1
  while (contextEnd + 1 < rows.length && contextEnd - end < context && rows[contextEnd + 1].kind === 'same') contextEnd += 1
  return rows.slice(contextStart, contextEnd + 1)
}

export function changeLine(rows: RepositoryDiffLine[], index: number) {
  const changed = rows[index]
  if (!changed || changed.kind === 'same') return []
  let changeStart = index
  let changeEnd = index
  while (changeStart > 0 && rows[changeStart - 1].kind !== 'same') changeStart -= 1
  while (changeEnd + 1 < rows.length && rows[changeEnd + 1].kind !== 'same') changeEnd += 1

  const changedRows = rows.slice(changeStart, changeEnd + 1)
  const deletedRows = changedRows.filter((row) => row.kind === 'del')
  const addedRows = changedRows.filter((row) => row.kind === 'add')
  const matchingRows = changed.kind === 'del' ? deletedRows : addedRows
  const matchingIndex = matchingRows.indexOf(changed)
  const counterpart = changed.kind === 'del' ? addedRows[matchingIndex] : deletedRows[matchingIndex]
  const selected = new Set([changed, counterpart].filter((row): row is RepositoryDiffLine => Boolean(row)))

  // A multi-line change needs a precise row patch. Add context only when the
  // selected row already represents the complete contiguous change segment.
  if (selected.size !== changedRows.length) return changedRows.filter((row) => selected.has(row))

  const context = 3
  const before: RepositoryDiffLine[] = []
  for (let cursor = changeStart - 1; cursor >= 0 && before.length < context; cursor -= 1) {
    if (rows[cursor].kind !== 'same') break
    before.unshift(rows[cursor])
  }
  const selectedRows = changedRows.filter((row) => selected.has(row))
  const after: RepositoryDiffLine[] = []
  for (let cursor = changeEnd + 1; cursor < rows.length && after.length < context; cursor += 1) {
    if (rows[cursor].kind !== 'same') break
    after.push(rows[cursor])
  }
  return [...before, ...selectedRows, ...after]
}
