import { describe, expect, it } from 'vitest'
import type { CommitTree, CommitTreeEntry } from '../../repository'
import {
  MAX_VISIBLE_ROWS_GUARD,
  ancestorPaths,
  childrenOf,
  computeTreeWindow,
  createCommitTreeIndex,
  createNameMatcher,
  directoryOf,
  entriesToRecords,
  flattenTreeRows,
  isDirectory,
  isExpandable,
  isPreviewableRow,
  needsChildrenFetch,
  toggleExpanded,
  withDirectoryLoading,
  withLoadedChildren,
  withoutDirectoryLoading,
  type CommitTreeIndex,
  type CommitTreeNodeRecord,
} from './commitTreeModel'

function record(overrides: Partial<CommitTreeNodeRecord> = {}): CommitTreeNodeRecord {
  return {
    name: 'file.txt',
    path: 'file.txt',
    kind: 'blob',
    mode: '100644',
    oid: 'o'.repeat(40),
    sizeBytes: 12,
    children: [],
    ...overrides,
  }
}

function commitTree(roots: CommitTree['roots'], partial = false): CommitTree {
  return {
    reference: 'abc123',
    oid: 't'.repeat(40),
    nodeCount: 8,
    partial,
    maxEntries: 5000,
    roots,
  }
}

function nestedIndex(): CommitTreeIndex {
  return createCommitTreeIndex(commitTree([
    { name: 'apps', path: 'apps', kind: 'tree', mode: '040000', oid: 'a'.repeat(40), sizeBytes: null, children: [
      { name: 'desktop', path: 'apps/desktop', kind: 'tree', mode: '040000', oid: 'd'.repeat(40), sizeBytes: null, children: [
        { name: 'main.rs', path: 'apps/desktop/src/main.rs', kind: 'blob', mode: '100644', oid: 'm'.repeat(40), sizeBytes: 30, children: [] },
      ] },
    ] },
    { name: '图片 资产', path: '图片 资产', kind: 'tree', mode: '040000', oid: 'p'.repeat(40), sizeBytes: null, children: [
      { name: 'logo.png', path: '图片 资产/logo.png', kind: 'blob', mode: '100644', oid: 'l'.repeat(40), sizeBytes: 1024, children: [] },
    ] },
    { name: 'README.md', path: 'README.md', kind: 'blob', mode: '100644', oid: 'r'.repeat(40), sizeBytes: 5, children: [] },
    { name: 'vendor', path: 'vendor', kind: 'commit', mode: '160000', oid: 'v'.repeat(40), sizeBytes: null, children: [] },
  ]))
}

describe('index construction', () => {
  it('keeps partial flag and node count from the backend', () => {
    const index = createCommitTreeIndex(commitTree([
      { name: 'apps', path: 'apps', kind: 'tree', mode: '040000', oid: '', sizeBytes: null, children: [] },
    ], true))
    expect(index.partial).toBe(true)
    expect(index.nodeCount).toBe(8)
    expect(index.roots[0].children).toEqual([])
    expect(index.childrenByPath).toEqual({})
  })

  it('turns lazy children entries into records with paths intact', () => {
    const entries: CommitTreeEntry[] = [
      { name: '图标', path: '图片 资产/图标', kind: 'tree', mode: '040000', oid: 'x', sizeBytes: null, hasChildren: true },
      { name: '我的 logo.png', path: '图片 资产/图标/我的 logo.png', kind: 'blob', mode: '100644', oid: 'y', sizeBytes: 66, hasChildren: false },
    ]
    const records = entriesToRecords(entries)
    expect(records.map((item) => item.path)).toEqual(['图片 资产/图标', '图片 资产/图标/我的 logo.png'])
    expect(records[0].children).toEqual([])
    expect(records[1].sizeBytes).toBe(66)
  })

  it('classifies kinds: only real trees expand, gitlink does not', () => {
    expect(isDirectory(record({ kind: 'tree' }))).toBe(true)
    expect(isDirectory(record({ kind: 'commit' }))).toBe(true)
    expect(isDirectory(record({ kind: 'blob' }))).toBe(false)
    expect(isExpandable(record({ kind: 'tree' }))).toBe(true)
    expect(isExpandable(record({ kind: 'commit' }))).toBe(false)
    expect(isExpandable(record())).toBe(false)
  })
})

describe('flattening', () => {
  it('shows only the root layer when nothing is expanded', () => {
    const rows = flattenTreeRows(nestedIndex(), {})
    expect(rows.map((row) => row.path)).toEqual(['apps', '图片 资产', 'README.md', 'vendor'])
    expect(rows.every((row) => row.depth === 0)).toBe(true)
    expect(rows.find((row) => row.path === 'README.md')?.hasChildren).toBe(false)
    expect(rows.find((row) => row.path === 'apps')?.hasChildren).toBe(true)
    // 子模组（gitlink）不该给展开箭头
    expect(rows.find((row) => row.path === 'vendor')?.hasChildren).toBe(false)
  })

  it('walks into expanded directories with increasing depth', () => {
    const rows = flattenTreeRows(nestedIndex(), { apps: true, 'apps/desktop': true })
    expect(rows.map((row) => `${row.depth}:${row.path}`)).toEqual([
      '0:apps',
      '1:apps/desktop',
      '2:apps/desktop/src/main.rs',
      '0:图片 资产',
      '0:README.md',
      '0:vendor',
    ])
  })

  it('marks a lazily expanded directory as loading, then as populated', () => {
    const index = createCommitTreeIndex(commitTree([
      { name: 'bulk', path: 'bulk', kind: 'tree', mode: '040000', oid: 'b'.repeat(40), sizeBytes: null, children: [] },
    ], true))
    const pending = withDirectoryLoading(index, 'bulk')
    expect(flattenTreeRows(pending, { bulk: true })).toEqual([
      expect.objectContaining({ path: 'bulk', loadingChildren: true, emptyChildren: false, childCount: 0 }),
    ])
    const loaded = withLoadedChildren(pending, 'bulk', [
      { name: 'f1.txt', path: 'bulk/f1.txt', kind: 'blob', mode: '100644', oid: '1', sizeBytes: 1, hasChildren: false },
    ])
    const rows = flattenTreeRows(loaded, { bulk: true })
    expect(rows.map((row) => row.path)).toEqual(['bulk', 'bulk/f1.txt'])
    expect(rows[0].loadingChildren).toBe(false)
    expect(loaded.loadingDirectories).toEqual([])
    // 展开了但确实没有子项 → 空目录提示
    const emptied = withLoadedChildren(index, 'bulk', [])
    expect(flattenTreeRows(emptied, { bulk: true })[0].emptyChildren).toBe(true)
  })

  it('caps the flattened row count so a huge directory cannot be rendered whole', () => {
    const roots = Array.from({ length: MAX_VISIBLE_ROWS_GUARD + 500 }, (_, i) => ({
      name: `f${i}.txt`,
      path: `bulk/f${i}.txt`,
      kind: 'blob',
      mode: '100644',
      oid: `o${i}`,
      sizeBytes: 1,
      hasChildren: false,
    })) satisfies CommitTreeEntry[]
    const index = withLoadedChildren(createCommitTreeIndex(commitTree([
      { name: 'bulk', path: 'bulk', kind: 'tree', mode: '040000', oid: '', sizeBytes: null, children: [] },
    ], true)), 'bulk', roots)
    const rows = flattenTreeRows(index, { bulk: true })
    expect(rows.length).toBeLessThanOrEqual(MAX_VISIBLE_ROWS_GUARD)
  })

  it('reveals ancestors of a match and everything under a matching directory', () => {
    const index = nestedIndex()
    const matcher = createNameMatcher('main')
    const rows = flattenTreeRows(index, { apps: true, 'apps/desktop': true }, matcher ?? undefined)
    expect(rows.map((row) => row.path)).toEqual(['apps', 'apps/desktop', 'apps/desktop/src/main.rs'])
    expect(rows[0].depth).toBe(0)
  })

  it('hides non-matching branches entirely', () => {
    const matcher = createNameMatcher('logo')
    const rows = flattenTreeRows(nestedIndex(), { apps: true, '图片 资产': true }, matcher ?? undefined)
    expect(rows.map((row) => row.path)).toEqual(['图片 资产', '图片 资产/logo.png'])
  })

  it('treats a blank query as no filter', () => {
    expect(createNameMatcher('   ')).toBeUndefined()
    expect(createNameMatcher('README')?.(record({ name: 'README.md' }))).toBe(true)
    expect(createNameMatcher('README')?.(record({ name: 'other.md' }))).toBe(false)
  })
})

describe('lazy load decisions', () => {
  it('asks the backend only for directories without loaded content', () => {
    const index = nestedIndex()
    // 一次性成树时 apps 已有 children，不该再取。
    expect(needsChildrenFetch(index, { path: 'apps', kind: 'tree', childCount: childrenOf(index, index.roots[0]).length })).toBe(false)
    expect(needsChildrenFetch(index, { path: '图片 资产', kind: 'tree', childCount: 0 })).toBe(true)
    expect(needsChildrenFetch(index, { path: 'README.md', kind: 'blob', childCount: 0 })).toBe(false)
    const loaded = withLoadedChildren(index, '图片 资产', [])
    expect(needsChildrenFetch(loaded, { path: '图片 资产', kind: 'tree', childCount: 0 })).toBe(false)
  })

  it('does not duplicate in-flight directories', () => {
    const index = nestedIndex()
    const once = withDirectoryLoading(index, 'apps')
    const twice = withDirectoryLoading(once, 'apps')
    expect(twice.loadingDirectories).toEqual(['apps'])
    expect(twice).toBe(once)
  })

  it('clears the in-flight flag when the read fails, so the row can be retried', () => {
    const index = createCommitTreeIndex(commitTree([
      { name: 'bulk', path: 'bulk', kind: 'tree', mode: '040000', oid: '', sizeBytes: null, children: [] },
    ], true))
    const pending = withDirectoryLoading(index, 'bulk')
    expect(flattenTreeRows(pending, { bulk: true })[0].loadingChildren).toBe(true)
    const failed = withoutDirectoryLoading(pending, 'bulk')
    expect(failed.loadingDirectories).toEqual([])
    const row = flattenTreeRows(failed, { bulk: true })[0]
    expect(row.loadingChildren).toBe(false)
    // 摘掉标记后 needsChildrenFetch 必须重新允许发起请求（否则一次失败就永久转圈）
    expect(needsChildrenFetch(failed, { path: 'bulk', kind: 'tree', childCount: 0 })).toBe(true)
    // 不在集合里时返回同一对象，不制造无意义的新状态
    expect(withoutDirectoryLoading(failed, 'bulk')).toBe(failed)
  })

  it('leaves the previous index untouched (pure updates)', () => {
    const index = nestedIndex()
    withLoadedChildren(index, 'apps', [])
    expect(index.childrenByPath).toEqual({})
  })

  it('keeps directories and submodule pointers out of the preview path', () => {
    expect(isPreviewableRow({ kind: 'blob' })).toBe(true)
    expect(isPreviewableRow({ kind: 'symlink' })).toBe(true)
    expect(isPreviewableRow({ kind: 'tree' })).toBe(false)
    // gitlink 指向的是另一个仓库的提交，向后端要 blob 只会得到「不存在」
    expect(isPreviewableRow({ kind: 'commit' })).toBe(false)
    expect(isPreviewableRow(null)).toBe(false)
    expect(isPreviewableRow(undefined)).toBe(false)
  })
})

describe('path helpers', () => {
  it('lists ancestors for auto-expanding a selection', () => {
    expect(ancestorPaths('apps/desktop/src/main.rs')).toEqual(['apps', 'apps/desktop', 'apps/desktop/src'])
    expect(ancestorPaths('README.md')).toEqual([])
    expect(ancestorPaths('图片 资产/图标/我的 logo.svg')).toEqual(['图片 资产', '图片 资产/图标'])
  })

  it('derives the containing directory (root is the empty key)', () => {
    expect(directoryOf('apps/desktop/main.rs')).toBe('apps/desktop')
    expect(directoryOf('README.md')).toBe('')
  })

  it('toggles expansion without mutating the previous map', () => {
    const base = { apps: true }
    const opened = toggleExpanded(base, '图片 资产')
    expect(opened).toEqual({ apps: true, '图片 资产': true })
    expect(toggleExpanded(opened, 'apps')).toEqual({ apps: false, '图片 资产': true })
    expect(base).toEqual({ apps: true })
  })
})

describe('windowing', () => {
  it('renders only the visible slice plus overscan', () => {
    const window = computeTreeWindow(10_000, 0, 440, 22)
    expect(window.start).toBe(0)
    expect(window.end).toBe(20 + 12)
    expect(window.topSpacer).toBe(0)
    expect(window.bottomSpacer).toBe((10_000 - 32) * 22)
  })

  it('slides the window with the scroll offset', () => {
    const middle = computeTreeWindow(10_000, 22 * 5_000, 440, 22, 2)
    expect(middle.start).toBe(4_998)
    expect(middle.end - middle.start).toBe(24)
    expect(middle.topSpacer).toBe(4_998 * 22)
    const tail = computeTreeWindow(10_000, 22 * 9_990, 440, 22, 0)
    expect(tail.end).toBe(10_000)
    expect(tail.bottomSpacer).toBe(0)
  })

  it('degrades safely on empty or nonsense input', () => {
    expect(computeTreeWindow(0, 0, 400, 22)).toEqual({ start: 0, end: 0, topSpacer: 0, bottomSpacer: 0 })
    expect(computeTreeWindow(100, 0, 400, 0)).toEqual({ start: 0, end: 0, topSpacer: 0, bottomSpacer: 0 })
    expect(computeTreeWindow(100, Number.NaN, 400, 22)).toEqual({ start: 0, end: 0, topSpacer: 0, bottomSpacer: 0 })
    expect(computeTreeWindow(100, -500, 400, 22).start).toBe(0)
  })

  it('keeps the window inside the row count', () => {
    const small = computeTreeWindow(3, 0, 1_000_000, 22)
    expect(small.end).toBeLessThanOrEqual(3)
    expect(small.bottomSpacer).toBe(0)
  })
})
