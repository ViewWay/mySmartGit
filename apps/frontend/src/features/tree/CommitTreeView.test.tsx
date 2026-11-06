import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { MediaBlob, RevisionFilePreview } from '../../repository'
import { CommitTreePreview, CommitTreeRowList, CommitTreeSummary, TREE_ROW_HEIGHT } from './CommitTreeView'
import type { CommitTreeRow } from './commitTreeModel'

function row(overrides: Partial<CommitTreeRow> = {}): CommitTreeRow {
  return {
    key: 'apps',
    depth: 0,
    name: 'apps',
    path: 'apps',
    kind: 'tree',
    oid: 'a'.repeat(40),
    sizeBytes: null,
    hasChildren: true,
    expanded: false,
    childCount: 0,
    loadingChildren: false,
    emptyChildren: false,
    ...overrides,
  }
}

function media(overrides: Partial<MediaBlob> = {}): MediaBlob {
  return {
    path: '图片 资产/我的 logo.png',
    reference: 'HEAD',
    oid: 'm'.repeat(40),
    mime: 'image/png',
    extension: 'png',
    previewKind: 'image',
    sizeBytes: 4096,
    width: 20,
    height: 10,
    previewable: true,
    tooLarge: false,
    dataBase64: 'iVBORw0KGgo=',
    cached: false,
    ...overrides,
  }
}

function preview(overrides: Partial<RevisionFilePreview> = {}): RevisionFilePreview {
  return {
    path: '图片 资产/我的 logo.png',
    reference: 'HEAD',
    oid: 'm'.repeat(40),
    sizeBytes: 4096,
    kind: 'image',
    text: null,
    truncated: false,
    media: media(),
    error: null,
    ...overrides,
  }
}

describe('commit tree summary', () => {
  it('honest copy for a bounded scan that had to degrade', () => {
    const html = renderToStaticMarkup(<CommitTreeSummary loading={false} loaded nodeCount={9} partial visibleRows={4}/>)
    expect(html).toContain('已扫描 ≥ 9 个条目')
    expect(html).toContain('超出一次成树上限，已切换懒加载')
    expect(html).toContain('可视 4')
  })

  it('exact copy when the whole tree was built', () => {
    const html = renderToStaticMarkup(<CommitTreeSummary loading={false} loaded nodeCount={8} partial={false} visibleRows={8}/>)
    expect(html).toContain('已扫描 8 个条目')
    expect(html).toContain('已完整成树')
    expect(html).not.toContain('≥')
  })

  it('shows the waiting states without a fake count', () => {
    expect(renderToStaticMarkup(<CommitTreeSummary loading loaded={false} nodeCount={0} partial={false} visibleRows={0}/>)).toContain('正在读取文件树…')
    expect(renderToStaticMarkup(<CommitTreeSummary loading={false} loaded={false} nodeCount={0} partial={false} visibleRows={0}/>)).toContain('尚未读取')
  })
})

describe('commit tree row list', () => {
  const listProps = { selected: null, error: null, loading: false, hasIndex: true, query: '', label: '提交 HEAD 的文件树', onActivate: () => {} }

  it('renders one flat row per visible node with tree semantics', () => {
    const html = renderToStaticMarkup(<CommitTreeRowList {...listProps} rows={[
      row({ name: '图片 资产', path: '图片 资产', key: '图片 资产', expanded: true }),
      row({ name: '我的 logo.png', path: '图片 资产/我的 logo.png', key: 'logo', kind: 'blob', oid: 'l'.repeat(40), sizeBytes: 1536, hasChildren: false, depth: 1, expanded: false }),
      row({ name: 'vendor', path: 'vendor', key: 'vendor', kind: 'commit', hasChildren: false }),
    ]}/>)
    expect(html).toContain('role="tree"')
    expect(html).toContain('aria-label="提交 HEAD 的文件树"')
    expect((html.match(/role="treeitem"/g) ?? []).length).toBe(3)
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('图片 资产/我的 logo.png')
    // 深度决定缩进：一层 12px
    expect(html).toContain('padding-left:20px')
    expect(html).toContain('1.5 KB')
    // 目录有可点击的展开按钮，文件与子模组只有占位（子模组不该给展开箭头）
    expect((html.match(/tree-expander"/g) ?? []).length).toBe(3)
    expect(html).toContain('aria-label="收起 图片 资产"')
    expect((html.match(/<button/g) ?? []).length).toBe(1)
  })

  it('marks the selected row and keeps non-media rows selectable', () => {
    const html = renderToStaticMarkup(<CommitTreeRowList {...listProps} selected="vendor" rows={[
      row({ name: 'vendor', path: 'vendor', kind: 'commit', hasChildren: false }),
    ]}/>)
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('commit-tree-row active')
  })

  it('shows lazy-loading placeholders instead of an empty directory', () => {
    const html = renderToStaticMarkup(<CommitTreeRowList {...listProps} rows={[
      row({ name: 'bulk', path: 'bulk', expanded: true, loadingChildren: true }),
      row({ name: 'empty', path: 'empty', key: 'empty', expanded: true, emptyChildren: true }),
    ]}/>)
    expect(html).toContain('读取中…')
    expect(html).toContain('空目录')
  })

  it('renders only the visible window for a huge directory', () => {
    const rows = Array.from({ length: 200 }, (_, index) => row({
      key: `f${index}`,
      name: `f${index}.txt`,
      path: `bulk/f${index}.txt`,
      kind: 'blob',
      hasChildren: false,
      sizeBytes: 1,
    }))
    const html = renderToStaticMarkup(<CommitTreeRowList {...listProps} rows={rows}/>)
    const rendered = (html.match(/role="treeitem"/g) ?? []).length
    // 默认视口 480px / 行高 22px + overscan 6：只画得出三十几行
    expect(rendered).toBeLessThan(40)
    expect(rendered).toBeGreaterThan(20)
    expect(html).toContain(`窗口化渲染：当前只画 ${rendered} / 200 行`)
    expect(html).toContain(`height:${(200 - rendered) * TREE_ROW_HEIGHT}px`)
    // 未渲染的部分用占位高度撑住滚动条，不是「少了一截」
    expect(html).not.toContain('f199.txt')
  })

  it('renders every row when the list is short', () => {
    const rows = Array.from({ length: 3 }, (_, index) => row({ key: `s${index}`, name: `s${index}.txt`, path: `s${index}.txt`, kind: 'blob', hasChildren: false }))
    const html = renderToStaticMarkup(<CommitTreeRowList {...listProps} rows={rows}/>)
    expect((html.match(/role="treeitem"/g) ?? []).length).toBe(3)
    expect(html).not.toContain('窗口化渲染')
  })

  it('separates empty, filtered-empty, loading and error states', () => {
    expect(renderToStaticMarkup(<CommitTreeRowList {...listProps} rows={[]}/>)).toContain('该版本没有已跟踪的文件。')
    expect(renderToStaticMarkup(<CommitTreeRowList {...listProps} rows={[]} query="logo"/>)).toContain('没有匹配「logo」的节点。')
    expect(renderToStaticMarkup(<CommitTreeRowList {...listProps} rows={[]} loading hasIndex={false}/>)).toContain('正在读取文件树…')
    expect(renderToStaticMarkup(<CommitTreeRowList {...listProps} rows={[]} error="无效的引用：nope"/>)).toContain('无效的引用：nope')
    expect(renderToStaticMarkup(<CommitTreeRowList {...listProps} rows={[]} hasIndex={false}/>)).not.toContain('该版本没有已跟踪的文件。')
  })
})

describe('commit tree preview', () => {
  const previewProps = { selected: null, kind: null, preview: null, loading: false, error: null }

  it('explains that nothing is selected yet', () => {
    const html = renderToStaticMarkup(<CommitTreePreview {...previewProps}/>)
    expect(html).toContain('点击左侧任意文件查看该版本下的内容')
    expect(html).not.toContain('外部打开')
  })

  it('renders the text of a revision with size and truncation', () => {
    const html = renderToStaticMarkup(<CommitTreePreview
      selected="apps/desktop/src/main.rs"
      kind="blob"
      preview={preview({ path: 'apps/desktop/src/main.rs', kind: 'text', text: 'fn main() {}\n', sizeBytes: 13, truncated: true, media: null })}
      onOpenExternally={() => {}}/>)
    expect(html).toContain('<pre>fn main() {}')
    expect(html).toContain('13 B')
    expect(html).toContain('已截断')
    expect(html).toContain('外部打开')
  })

  it('hands an image over to the single-side image viewer', () => {
    const html = renderToStaticMarkup(<CommitTreePreview
      selected="图片 资产/我的 logo.png"
      kind="blob"
      preview={preview()}
      onOpenExternally={() => {}}/>)
    expect(html).toContain('image-diff-panel')
    expect(html).toContain('文件内容')
    expect(html).toContain('data:image/png;base64,iVBORw0KGgo=')
    // 单侧预览不该出现「变更前」
    expect(html).not.toContain('变更前')
  })

  it('degrades for binary and oversized payloads', () => {
    const binary = renderToStaticMarkup(<CommitTreePreview
      selected="blob.bin"
      kind="blob"
      preview={preview({ path: 'blob.bin', kind: 'binary', media: null, text: null, error: '二进制文件，不提供文本预览' })}
      onOpenExternally={() => {}}/>)
    expect(binary).toContain('二进制文件，不提供文本预览')
    expect(binary).toContain('外部打开')
    const oversized = renderToStaticMarkup(<CommitTreePreview
      selected="huge.png"
      kind="blob"
      preview={preview({ path: 'huge.png', kind: 'too_large', sizeBytes: 90 * 1024 * 1024, media: null, text: null, truncated: true })}
      onOpenExternally={() => {}}/>)
    expect(oversized).toContain('文件超过预览上限')
    expect(oversized).toContain('外部打开')
  })

  it('refuses to preview a directory or a submodule pointer', () => {
    const directory = renderToStaticMarkup(<CommitTreePreview selected="apps" kind="tree" preview={null} loading={false} error={null} onOpenExternally={() => {}}/>)
    expect(directory).toContain('目录没有内容可预览')
    expect(directory).toContain('目录不可预览')
    expect(directory).not.toContain('外部打开')
    const gitlink = renderToStaticMarkup(<CommitTreePreview selected="vendor" kind="commit" preview={null} loading={false} error={null} onOpenExternally={() => {}}/>)
    expect(gitlink).toContain('子模组指针')
    expect(gitlink).toContain('指向另一个仓库的提交')
    expect(gitlink).not.toContain('外部打开')
  })

  it('shows loading and error without leaving the pane blank', () => {
    const loading = renderToStaticMarkup(<CommitTreePreview selected="a.txt" kind="blob" preview={null} loading error={null}/>)
    expect(loading).toContain('正在读取内容…')
    const failed = renderToStaticMarkup(<CommitTreePreview selected="a.txt" kind="blob" preview={null} loading={false} error="HEAD:a.txt 在该引用下不存在"/>)
    expect(failed).toContain('在该引用下不存在')
  })

  it('lets the image viewer explain an oversized image instead of a generic note', () => {
    // 后端在 too_large 时仍会带回 media（有元数据、无载荷），这时只该有一条解释，
    // 由 ImageDiffViewer 给出：它连「为什么只读了文件头」和外部打开入口一起给。
    const html = renderToStaticMarkup(<CommitTreePreview
      selected="huge.png"
      kind="blob"
      preview={preview({ kind: 'too_large', sizeBytes: 90 * 1024 * 1024, truncated: true, media: media({ tooLarge: true, previewable: false, dataBase64: null, sizeBytes: 90 * 1024 * 1024 }) })}
      onOpenExternally={() => {}}/>)
    expect(html).toContain('image-diff-panel')
    expect(html).toContain('图片过大，仅显示元数据')
    expect(html).toContain('4.0 MB')
    expect(html).not.toContain('不适合内联展示')
    expect(html).not.toContain('<img ')
  })
})
