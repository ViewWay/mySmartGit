import type { HistoryEditActionInput, HistoryEditActionKind, HistoryEditEntry } from '../../repository'

type Translate = (key: string, params?: Record<string, string | number>) => string

// 纯逻辑层：与后端 validate_plan 同规则，保证「前端所见 = 后端所得」。
// 拖拽/按钮重排、动作映射、校验与 todo 预览全部在这里，组件只做渲染。

export const HISTORY_EDIT_ACTIONS: HistoryEditActionKind[] = ['pick', 'reword', 'drop', 'fixup', 'squash', 'edit']

const ACTION_KEYS: Record<HistoryEditActionKind, string> = {
  pick: 'historyEdit.actionPick',
  reword: 'historyEdit.actionReword',
  drop: 'historyEdit.actionDrop',
  fixup: 'historyEdit.actionFixup',
  squash: 'historyEdit.actionSquash',
  edit: 'historyEdit.actionEdit',
}

export function historyEditActionLabel(kind: HistoryEditActionKind, t: Translate): string {
  return t(ACTION_KEYS[kind])
}

/** 动作行的本地状态：条目 + 动作 + 消息草稿。 */
export type HistoryEditRow = {
  entry: HistoryEditEntry
  action: HistoryEditActionKind
  message: string
}

/** 由序列条目生成初始行（全部 pick，reword 预填原消息）。 */
export function createRows(entries: HistoryEditEntry[]): HistoryEditRow[] {
  return entries.map((entry) => ({ entry, action: 'pick' as HistoryEditActionKind, message: entry.message }))
}

/** 上移/下移一行；越界返回原数组（引用不变，方便 React memo）。 */
export function moveRow(rows: HistoryEditRow[], index: number, delta: -1 | 1): HistoryEditRow[] {
  const target = index + delta
  if (index < 0 || target < 0 || target >= rows.length) return rows
  const next = [...rows]
  const [row] = next.splice(index, 1)
  next.splice(target, 0, row)
  return next
}

export function setRowAction(rows: HistoryEditRow[], index: number, action: HistoryEditActionKind): HistoryEditRow[] {
  return rows.map((row, i) => (i === index ? { ...row, action } : row))
}

export function setRowMessage(rows: HistoryEditRow[], index: number, message: string): HistoryEditRow[] {
  return rows.map((row, i) => (i === index ? { ...row, message } : row))
}

/** 行是否需要消息输入框。 */
export function requiresMessage(row: HistoryEditRow): boolean {
  return row.action === 'reword'
}

/** 校验错误列表（行号从 1 起，供 UI 定位）。与后端 validate_plan 规则对齐：
 *  - squash/fixup 之前必须已有保留提交（被 drop 的前任不算）；
 *  - reword 消息非空；
 *  - 空序列直接报错。 */
export function validateRows(rows: HistoryEditRow[], t: Translate): string[] {
  const errors: string[] = []
  if (rows.length === 0) return [t('historyEdit.empty')]
  let hasPrevKept = false
  rows.forEach((row, index) => {
    const at = t('historyEdit.rowAt', { index: index + 1, hash: row.entry.shortHash, title: row.entry.title })
    if ((row.action === 'squash' || row.action === 'fixup') && !hasPrevKept) {
      errors.push(t('historyEdit.errFixupSquashNeedsPrev', { at, action: row.action === 'squash' ? 'squash' : 'fixup' }))
    }
    if (row.action === 'reword' && row.message.trim() === '') {
      errors.push(t('historyEdit.errRewordNeedsMessage', { at }))
    }
    if (row.action === 'squash' && !row.message.trim() && !hasPrevKept) {
      errors.push(t('historyEdit.errSquashNeedsMessage', { at }))
    }
    if (row.action !== 'drop') hasPrevKept = true
  })
  return errors
}

export type HistoryEditSummary = {
  total: number
  dropped: number
  folded: number
  reworded: number
  edited: number
  /** 预期结果历史相对基点的提交数。 */
  resultCount: number
  changed: boolean
}

/** 汇总统计：与后端 PlanData 计数语义一致。 */
export function summarizeRows(rows: HistoryEditRow[]): HistoryEditSummary {
  let dropped = 0
  let folded = 0
  let reworded = 0
  let edited = 0
  for (const row of rows) {
    if (row.action === 'drop') dropped += 1
    if (row.action === 'fixup' || row.action === 'squash') folded += 1
    if (row.action === 'reword') reworded += 1
    if (row.action === 'edit') edited += 1
  }
  const kept = rows.length - dropped
  return {
    total: rows.length,
    dropped,
    folded,
    reworded,
    edited,
    resultCount: kept - folded,
    changed: rows.some((row) => row.action !== 'pick'),
  }
}

/** 行序变化检测（重排也算变化）：与原序列哈希顺序比对。 */
export function hasReordered(original: HistoryEditEntry[], rows: HistoryEditRow[]): boolean {
  return original.some((entry, index) => entry.hash !== rows[index]?.entry.hash)
}

export function summarizeWithReorder(original: HistoryEditEntry[], rows: HistoryEditRow[]): HistoryEditSummary {
  const summary = summarizeRows(rows)
  return { ...summary, changed: summary.changed || hasReordered(original, rows) }
}

/** 生成发给后端的动作数组（数组顺序 = 新历史顺序；消息仅 reword/squash 携带）。 */
export function buildActionPayload(rows: HistoryEditRow[]): HistoryEditActionInput[] {
  return rows.map((row) => ({
    hash: row.entry.hash,
    action: row.action,
    message: row.action === 'reword' ? row.message : row.action === 'squash' && row.message.trim() ? row.message : null,
  }))
}

/** todo 预览行：向用户解释每一步将写入 git-rebase-todo 的内容。
 * 与后端 materialize_todo 的编译规则一致（fixup/squash 编译为 pick + 折叠 exec）。 */
export function renderTodoPreview(rows: HistoryEditRow[], t: Translate): string[] {
  const lines: string[] = []
  for (const row of rows) {
    switch (row.action) {
      case 'drop':
        lines.push(`# drop ${row.entry.shortHash} ${row.entry.title}${t('historyEdit.dropComment')}`)
        break
      case 'pick':
        lines.push(`pick ${row.entry.hash} # ${row.entry.title}`)
        break
      case 'edit':
        lines.push(`edit ${row.entry.hash} # ${row.entry.title}${t('historyEdit.editPauseNote')}`)
        break
      case 'reword':
        lines.push(`pick ${row.entry.hash} # ${row.entry.title}`)
        lines.push(t('historyEdit.execReword'))
        break
      case 'fixup':
        lines.push(`pick ${row.entry.hash} # ${row.entry.title}`)
        lines.push(t('historyEdit.execFixup'))
        break
      case 'squash':
        lines.push(`pick ${row.entry.hash} # ${row.entry.title}`)
        lines.push(row.message.trim() ? t('historyEdit.execSquashMsg') : t('historyEdit.execSquash'))
        break
    }
  }
  return lines
}

/** 批量 cherry-pick 的「先旧后新」排序：作者时间升序，其次保持点选顺序；去重。
 * 与后端排序语义一致（后端还会看提交者时间作为第二键，前端在此只做输入序整理）。 */
export function orderCommitsOldFirst(commits: Array<{ fullHash: string; authorTime?: string }>): string[] {
  const seen = new Set<string>()
  const indexed: Array<{ time: number; index: number; hash: string }> = []
  commits.forEach((commit, index) => {
    if (!commit.fullHash || seen.has(commit.fullHash)) return
    seen.add(commit.fullHash)
    const parsed = commit.authorTime ? Date.parse(commit.authorTime) : Number.NaN
    indexed.push({ time: Number.isNaN(parsed) ? 0 : parsed, index, hash: commit.fullHash })
  })
  indexed.sort((a, b) => a.time - b.time || a.index - b.index)
  return indexed.map((item) => item.hash)
}
