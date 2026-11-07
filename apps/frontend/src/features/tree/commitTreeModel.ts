import type { CommitTree, CommitTreeEntry, CommitTreeNode } from '../../repository'

/**
 * 提交文件树的纯逻辑：组树、展开态、懒加载合并、按路径定位、窗口化（虚拟化）。
 * 与渲染分离，便于单测；样式与交互风格对齐 features/repository/RepositoryStructureTree.tsx，
 * 但不复用也不修改那个组件（它属于别的轨道，且数据源是 worktree/submodule 而非 ref 树）。
 */

export type CommitTreeNodeRecord = {
  name: string
  path: string
  kind: string
  mode: string
  oid: string
  sizeBytes: number | null
  children: CommitTreeNodeRecord[]
}

export type CommitTreeRow = {
  key: string
  depth: number
  name: string
  path: string
  kind: string
  oid: string
  sizeBytes: number | null
  hasChildren: boolean
  expanded: boolean
  /** 当前已在此索引里的子项数：为 0 且是目录，说明还需要向后端取。 */
  childCount: number
  /** 目录已展开但子项仍在取。 */
  loadingChildren: boolean
  /** 展开后确实一条子项都没有（空目录）。 */
  emptyChildren: boolean
}

export type CommitTreeIndex = {
  reference: string
  roots: CommitTreeNodeRecord[]
  /** 后端条目过多，只给了根层：必须走懒加载。 */
  partial: boolean
  nodeCount: number
  /** 已加载目录的子项缓存，键为目录路径（根用 ''）。 */
  childrenByPath: Record<string, CommitTreeNodeRecord[]>
  loadingDirectories: string[]
}

export const TREE_ROOT_KEY = ''
/** 超过这个数量就不整树渲染，靠窗口化 + 懒加载兜住。 */
export const MAX_VISIBLE_ROWS_GUARD = 5_000

function toRecord(node: CommitTreeNode): CommitTreeNodeRecord {
  return {
    name: node.name,
    path: node.path,
    kind: node.kind,
    mode: node.mode,
    oid: node.oid,
    sizeBytes: node.sizeBytes ?? null,
    children: (node.children ?? []).map(toRecord),
  }
}

export function entriesToRecords(entries: CommitTreeEntry[]): CommitTreeNodeRecord[] {
  return entries.map((entry) => ({
    name: entry.name,
    path: entry.path,
    kind: entry.kind,
    mode: entry.mode,
    oid: entry.oid,
    sizeBytes: entry.sizeBytes ?? null,
    // 懒加载回来的子项：目录展开时按 childCount 再判断要不要继续向后端取。
    children: [],
  }))
}

export function createCommitTreeIndex(tree: CommitTree): CommitTreeIndex {
  return {
    reference: tree.reference,
    roots: (tree.roots ?? []).map(toRecord),
    partial: Boolean(tree.partial),
    nodeCount: tree.nodeCount ?? 0,
    childrenByPath: {},
    loadingDirectories: [],
  }
}

/** 某个目录当前可用的子项：优先懒加载缓存，其次成树时带来的 children。 */
export function childrenOf(index: CommitTreeIndex, node: CommitTreeNodeRecord): CommitTreeNodeRecord[] {
  const cached = index.childrenByPath[node.path]
  if (cached) return cached
  return node.children
}

export function isDirectory(node: CommitTreeNodeRecord): boolean {
  return node.kind === 'tree' || node.kind === 'commit'
}

/** 子模组（gitlink，kind = commit）没有可浏览的内容，不再展开。 */
export function isExpandable(node: CommitTreeNodeRecord): boolean {
  return node.kind === 'tree'
}

/**
 * 深度优先摊平成可视行。折叠的目录只出一行；展开但未加载的目录带 loadingChildren。
 * `match` 提供时：命中节点及其所有祖先可见，命中节点的后代全部可见（文件管理器惯例）。
 */
export function flattenTreeRows(
  index: CommitTreeIndex,
  expanded: Record<string, boolean>,
  match?: (node: CommitTreeNodeRecord) => boolean,
): CommitTreeRow[] {
  const rows: CommitTreeRow[] = []
  const matchedMemo = new Map<string, boolean>()
  const nodeMatches = (node: CommitTreeNodeRecord) => Boolean(match?.(node))
  const selfOrDescendantMatches = (node: CommitTreeNodeRecord): boolean => {
    if (!match) return true
    const memo = matchedMemo.get(node.path)
    if (memo !== undefined) return memo
    if (match(node)) {
      matchedMemo.set(node.path, true)
      return true
    }
    const hit = childrenOf(index, node).some(selfOrDescendantMatches)
    matchedMemo.set(node.path, hit)
    return hit
  }
  const walk = (nodes: CommitTreeNodeRecord[], depth: number, forceOpen: boolean) => {
    for (const node of nodes) {
      if (rows.length >= MAX_VISIBLE_ROWS_GUARD) return
      const expandable = isExpandable(node)
      const opened = expandable && (forceOpen || Boolean(expanded[node.path]))
      const visible = !match || forceOpen || selfOrDescendantMatches(node)
      if (visible) {
        const children = expandable ? childrenOf(index, node) : []
        rows.push({
          key: node.path,
          depth,
          name: node.name,
          path: node.path,
          kind: node.kind,
          oid: node.oid,
          sizeBytes: node.sizeBytes,
          hasChildren: expandable,
          childCount: children.length,
          expanded: opened,
          loadingChildren: opened && children.length === 0 && index.loadingDirectories.includes(node.path),
          emptyChildren: opened && children.length === 0 && !index.loadingDirectories.includes(node.path),
        })
      }
      if (opened) {
        walk(childrenOf(index, node), depth + 1, Boolean(match && nodeMatches(node)))
      }
    }
  }
  walk(index.roots, 0, false)
  return rows
}

export function toggleExpanded(expanded: Record<string, boolean>, path: string): Record<string, boolean> {
  return { ...expanded, [path]: !expanded[path] }
}

/** 懒加载结果合并进索引；未加载的目录保持 lazy 标记，展开时再取。 */
export function withLoadedChildren(index: CommitTreeIndex, directoryPath: string, entries: CommitTreeEntry[]): CommitTreeIndex {
  const nextIndex: CommitTreeIndex = {
    ...index,
    childrenByPath: { ...index.childrenByPath, [directoryPath]: entriesToRecords(entries) },
    loadingDirectories: index.loadingDirectories.filter((item) => item !== directoryPath),
  }
  return nextIndex
}

export function withDirectoryLoading(index: CommitTreeIndex, directoryPath: string): CommitTreeIndex {
  if (index.loadingDirectories.includes(directoryPath)) return index
  return { ...index, loadingDirectories: [...index.loadingDirectories, directoryPath] }
}

/**
 * 读取失败时必须把「加载中」摘掉：否则那一行会永远挂着「读取中…」，
 * 而 needsChildrenFetch 又因为 childrenByPath 里没有它而拒绝重试。
 */
export function withoutDirectoryLoading(index: CommitTreeIndex, directoryPath: string): CommitTreeIndex {
  if (!index.loadingDirectories.includes(directoryPath)) return index
  return { ...index, loadingDirectories: index.loadingDirectories.filter((item) => item !== directoryPath) }
}

/** 子模组指针（gitlink）不是 blob，向后端要预览只会得到「不存在」，前端先挡掉。 */
export function isPreviewableRow(row: { kind: string } | null | undefined): boolean {
  return Boolean(row) && row!.kind !== 'tree' && row!.kind !== 'commit'
}

/**
 * 该目录是否需要向后端取子项。
 * 判据是「行自描述」：懒加载回来的节点不在 index.roots 里，不能靠树查找，
 * 所以用 childCount === 0 判断（git 不保存空目录，没有子项就是还没取）。
 */
export function needsChildrenFetch(
  index: CommitTreeIndex,
  target: { path: string; kind: string; childCount: number },
): boolean {
  if (target.kind !== 'tree') return false
  if (index.childrenByPath[target.path]) return false
  return target.childCount === 0
}

export function findNodeByPath(nodes: CommitTreeNodeRecord[], path: string): CommitTreeNodeRecord | null {
  for (const node of nodes) {
    if (node.path === path) return node
    if (node.kind === 'tree') {
      const hit = findNodeByPath(node.children, path)
      if (hit) return hit
    }
  }
  return null
}

/** 展开某文件所需的全部祖先目录路径（定位到选中项用）。 */
export function ancestorPaths(path: string): string[] {
  const segments = path.split('/').filter(Boolean)
  const result: string[] = []
  segments.slice(0, -1).forEach((segment) => {
    result.push(result.length ? `${result[result.length - 1]}/${segment}` : segment)
  })
  return result
}

export function directoryOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? TREE_ROOT_KEY : path.slice(0, index)
}

export type TreeWindow = { start: number; end: number; topSpacer: number; bottomSpacer: number }

/**
 * 窗口化：只渲染视口内的行（含 overscan）。这是「大目录不一次渲染几万节点」的最后一道闸，
 * 前面还有后端的 partial + 懒加载。
 */
export function computeTreeWindow(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = 6,
): TreeWindow {
  if (rowCount <= 0 || rowHeight <= 0 || !Number.isFinite(scrollTop) || !Number.isFinite(viewportHeight)) {
    return { start: 0, end: 0, topSpacer: 0, bottomSpacer: 0 }
  }
  const safeOverscan = Math.max(0, Math.floor(overscan))
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight)
  const start = Math.max(0, first - safeOverscan)
  const visibleCount = Math.ceil(Math.max(0, viewportHeight) / rowHeight)
  const end = Math.min(rowCount, start + visibleCount + safeOverscan * 2)
  return {
    start,
    end,
    topSpacer: start * rowHeight,
    bottomSpacer: Math.max(0, (rowCount - end) * rowHeight),
  }
}

/** 简易名称过滤：大小写不敏感的子串匹配，命中的目录会连带其已加载内容展开显示。 */
export function createNameMatcher(query: string): ((node: CommitTreeNodeRecord) => boolean) | undefined {
  const needle = query.trim().toLowerCase()
  if (!needle) return undefined
  return (node) => node.name.toLowerCase().includes(needle)
}

export type TreeNavigationKey = 'ArrowDown' | 'ArrowUp' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'

export type TreeContextAction = 'copyPath' | 'copyName' | 'openExternal' | 'viewHistory'

/** 右键菜单的动作集：复制始终可用；外部打开/看历史只对文件行有意义（目录、子模组排除）。 */
export function buildTreeContextActions(
  row: { kind: string },
  options: { canOpenExternally: boolean; canViewHistory: boolean },
): TreeContextAction[] {
  const actions: TreeContextAction[] = ['copyPath', 'copyName']
  const isFile = isPreviewableRow(row)
  if (isFile && options.canOpenExternally) actions.push('openExternal')
  if (isFile && options.canViewHistory) actions.push('viewHistory')
  return actions
}

export type TreeNavigation = {
  /** 新的选中行下标；null 表示行列表为空、无处可去。 */
  index: number | null
  /** 需要切换展开态的目录路径（仅 ArrowRight 展开折叠目录 / ArrowLeft 折叠展开目录时给出）。 */
  togglePath: string | null
}

/**
 * 文件树键盘导航的纯逻辑（与渲染无关，组件只消费结果）：
 * ↑↓ 在可视行间移动并夹在首尾；→ 展开折叠的目录或前进；← 折叠目录或跳到父目录；Home/End 跳首尾。
 */
export function navigateTreeRows(rows: CommitTreeRow[], currentIndex: number, key: TreeNavigationKey): TreeNavigation {
  const none: TreeNavigation = { index: null, togglePath: null }
  if (!rows.length) return none
  const clamped = Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < rows.length ? currentIndex : null
  const move = (index: number): TreeNavigation => ({ index, togglePath: null })
  if (key === 'Home') return move(0)
  if (key === 'End') return move(rows.length - 1)
  if (key === 'ArrowDown') return move(clamped === null ? 0 : Math.min(rows.length - 1, clamped + 1))
  if (key === 'ArrowUp') return move(clamped === null ? rows.length - 1 : Math.max(0, clamped - 1))
  if (key === 'ArrowRight') {
    if (clamped !== null) {
      const row = rows[clamped]
      if (row.hasChildren && !row.expanded) return { index: clamped, togglePath: row.path }
    }
    return move(Math.min(rows.length - 1, (clamped ?? -1) + 1))
  }
  // ArrowLeft
  if (clamped !== null) {
    const row = rows[clamped]
    if (row.hasChildren && row.expanded) return { index: clamped, togglePath: row.path }
    for (let index = clamped - 1; index >= 0; index -= 1) {
      if (rows[index].depth < row.depth) return move(index)
    }
  }
  return move(clamped ?? 0)
}
