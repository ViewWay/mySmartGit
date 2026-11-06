import { describe, expect, it } from 'vitest'
import type { CommitSearchPage, TextSearchPage } from '../../repository'
import {
  COMMIT_PAGE_SIZE,
  MAX_PATTERN_CHARS,
  TEXT_PAGE_SIZE,
  buildCommitSearchQuery,
  buildTextSearchQuery,
  clampOffset,
  createSearchGate,
  currentPage,
  defaultCommitSearchForm,
  defaultTextSearchForm,
  goLastPage,
  goNextPage,
  goPrevPage,
  commitTargetHint,
  commitTargetLabel,
  isDiffTarget,
  matchPosition,
  parseList,
  rangeLabel,
  resultBanner,
  totalLabel,
  totalPages,
  validatePattern,
} from './searchModel'

import { zh } from '../../i18n/messages/zh'
const zhT = (key: string, params?: Record<string, string | number>) => {
  const template = (zh as Record<string, string>)[key] ?? key
  if (!params) return template
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => (params[name] === undefined ? match : String(params[name])))
}


const commitPage = (overrides: Partial<CommitSearchPage> = {}): CommitSearchPage => ({
  searchId: 'search-1',
  target: 'commitMessage',
  pattern: 'hotfix',
  total: 0,
  offset: 0,
  pageSize: COMMIT_PAGE_SIZE,
  hasMore: false,
  truncated: false,
  cancelled: false,
  items: [],
  notice: null,
  ...overrides,
})

const textPage = (overrides: Partial<TextSearchPage> = {}): TextSearchPage => ({
  searchId: 'search-2',
  pattern: 'alpha',
  revision: null,
  total: 0,
  matchedFiles: 0,
  offset: 0,
  pageSize: TEXT_PAGE_SIZE,
  hasMore: false,
  truncated: false,
  cancelled: false,
  items: [],
  notice: null,
  ...overrides,
})

describe('查询构造', () => {
  it('把表单里的多行/逗号输入拆成数组，并裁掉空白', () => {
    expect(parseList('src/**\ndocs/*.md, README.md , \n')).toEqual(['src/**', 'docs/*.md', 'README.md'])
    expect(parseList(null)).toEqual([])
    expect(parseList('')).toEqual([])
  })

  it('提交搜索查询逐字对齐后端 CommitSearchQuery 的 camelCase 字段', () => {
    const query = buildCommitSearchQuery({
      ...defaultCommitSearchForm(),
      pattern: '  hotfix  ',
      target: 'diffPickaxe',
      caseSensitive: true,
      wholeWord: true,
      regex: true,
      revisions: 'main\nfeature/x',
      paths: 'src/**',
      excludePaths: 'docs/**,vendor/**',
      maxCommits: 5000,
    }, 300)

    expect(query).toEqual({
      pattern: 'hotfix',
      target: 'diffPickaxe',
      caseSensitive: true,
      wholeWord: true,
      regex: true,
      revisions: ['main', 'feature/x'],
      paths: ['src/**'],
      excludePaths: ['docs/**', 'vendor/**'],
      maxCommits: 5000,
      pageSize: COMMIT_PAGE_SIZE,
      offset: 300,
    })
  })

  it('未填的可选范围留成空数组，让后端走 --all 而不是传个空串过去', () => {
    const query = buildCommitSearchQuery(defaultCommitSearchForm(), 0, zhT)
    expect(query.revisions).toEqual([])
    expect(query.paths).toEqual([])
    expect(query.excludePaths).toEqual([])
    expect(query.offset).toBe(0)
    expect(query.maxCommits).toBeNull()
  })

  it('全文搜索的空 revision 归一成 null（表示工作区），不能留成空串让后端误解成一个引用', () => {
    expect(buildTextSearchQuery({ ...defaultTextSearchForm(), revision: '   ' }, 0, zhT).revision).toBeNull()
    expect(buildTextSearchQuery({ ...defaultTextSearchForm(), revision: ' v1.2.0 ' }, 0, zhT).revision).toBe('v1.2.0')
  })

  it('差异搜索目标与 pickaxe/-G 的语义说明必须都在，否则界面无法解释两者差别', () => {
    expect(isDiffTarget('diffPickaxe')).toBe(true)
    expect(isDiffTarget('diffRegex')).toBe(true)
    expect(isDiffTarget('commitMessage')).toBe(false)
    // pickaxe 的「出现次数变化」与 -G 的「逐行匹配」是两种语义，说明文案不可缺省。
    expect(commitTargetHint('diffPickaxe', zhT)).toContain('次数')
    expect(commitTargetHint('diffRegex', zhT)).toContain('逐行')
    expect(['commitMessage', 'commitAuthor', 'commitHash', 'diffPickaxe', 'diffRegex'].map((target) => commitTargetHint(target as 'diffPickaxe', zhT))).toHaveLength(5)
  })
})

describe('输入校验', () => {
  it('空白与超长内容在发起前就被挡住', () => {
    expect(validatePattern('', zhT)).toBe('请输入搜索内容')
    expect(validatePattern('   ', zhT)).toBe('请输入搜索内容')
    expect(validatePattern('x'.repeat(MAX_PATTERN_CHARS + 1), zhT)).toContain(MAX_PATTERN_CHARS.toString())
    expect(validatePattern('换行\n内容', zhT)).toContain('换行')
    expect(validatePattern('hotfix', zhT)).toBeNull()
  })
})

describe('分页状态', () => {
  const cursor = { offset: 200, pageSize: 100, total: 1234 }

  it('页码一律由 offset 推导，两者不会各自漂移', () => {
    expect(currentPage(cursor)).toBe(3)
    expect(currentPage({ ...cursor, offset: 0 })).toBe(1)
    expect(currentPage({ ...cursor, offset: 1200 })).toBe(13)
    expect(totalPages(cursor)).toBe(13)
    expect(totalPages({ ...cursor, total: 1200 })).toBe(12)
    expect(totalPages({ ...cursor, total: 0 })).toBe(0)
  })

  it('翻页游标不越界：末页停在最后一个合法 offset，首页不往负数走', () => {
    expect(goNextPage(cursor)).toBe(300)
    expect(goNextPage({ offset: 1200, pageSize: 100, total: 1234 })).toBe(1200)
    expect(goPrevPage(cursor)).toBe(100)
    expect(goPrevPage({ offset: 0, pageSize: 100, total: 1234 })).toBe(0)
    expect(goLastPage(cursor)).toBe(1200)
    expect(goLastPage({ offset: 0, pageSize: 100, total: 1200 })).toBe(1100)
    expect(goLastPage({ offset: 0, pageSize: 100, total: 0 })).toBe(0)
  })

  it('越界 offset 收敛回末页，空结果的 offset 归零', () => {
    expect(clampOffset(9999, 1234, 100)).toBe(1200)
    expect(clampOffset(-50, 1234, 100)).toBe(0)
    expect(clampOffset(500, 0, 100)).toBe(0)
    expect(clampOffset(100, 1234, 0)).toBe(0)
  })

  it('结果区间与「第 N/M 个」文案按全局序号计算', () => {
    expect(rangeLabel(cursor, 100, zhT)).toBe('显示 201-300 / 共 1234 条')
    expect(rangeLabel({ offset: 0, pageSize: 100, total: 0 }, 0, zhT)).toBe('没有命中')
    expect(matchPosition(1234, 200, 0)).toEqual({ current: 201, total: 1234 })
    expect(matchPosition(1234, 1200, 33)).toEqual({ current: 1234, total: 1234 })
    expect(matchPosition(10, 20, 0)).toBeNull()
    expect(matchPosition(0, 0, 0)).toBeNull()
  })

  it('整页遍历覆盖 0..total 且不产生重复偏移量', () => {
    const seen: number[] = []
    let offset = 0
    while (offset < 1234) {
      seen.push(offset)
      const next = goNextPage({ offset, pageSize: 100, total: 1234 })
      if (next === offset) break
      offset = next
    }
    expect(seen).toHaveLength(13)
    expect(new Set(seen).size).toBe(13)
    expect(seen[seen.length - 1]).toBe(1200)
  })
})

describe('有界结果的展示', () => {
  it('截断时必须给出不可忽略的横幅，且不能把已索引条数说成全部命中', () => {
    const capped = textPage({ total: 2000, truncated: true, notice: '命中超过 2000 行上限，结果已截断' })
    expect(resultBanner(capped, zhT)).toContain('截断')
    expect(totalLabel(capped, zhT)).toBe('已索引 2000 条（超出上限，已截断）')
    // 后端漏发 notice 时也要有兜底文案，不能返回 null 让 UI 安静下来。
    expect(resultBanner({ ...capped, notice: null }, zhT)).toContain('截断')
  })

  it('取消的结果与完整结果分别有自己的展示口径', () => {
    expect(resultBanner(commitPage({ cancelled: true, notice: null }), zhT)).toContain('取消')
    expect(resultBanner(commitPage({ total: 3 }), zhT)).toBeNull()
    expect(totalLabel(commitPage({ total: 3 }), zhT)).toBe('共 3 条')
    // 只有 notice（例如「本次搜索不含二进制文件」）时也要透出来，不能被当成错误。
    expect(resultBanner(commitPage({ notice: '提示内容' }), zhT)).toBe('提示内容')
  })
})

describe('请求代际闸门', () => {
  it('慢的旧请求不能覆盖快的新请求', () => {
    const gate = createSearchGate()
    const first = gate.begin()
    const second = gate.begin()
    expect(gate.isCurrent(first)).toBe(false)
    expect(gate.isCurrent(second)).toBe(true)
  })

  it('切换仓库/关闭面板时作废当前代，后续响应全部丢弃', () => {
    const gate = createSearchGate()
    const current = gate.begin()
    gate.invalidate()
    expect(gate.isCurrent(current)).toBe(false)
    expect(gate.current()).toBe(current + 1)
  })

  it('begin 单调递增，重复调用不会退回到旧代', () => {
    const gate = createSearchGate()
    const tokens = Array.from({ length: 5 }, () => gate.begin())
    expect(tokens).toEqual([1, 2, 3, 4, 5])
    expect(gate.isCurrent(tokens[0])).toBe(false)
    expect(gate.isCurrent(tokens[4])).toBe(true)
  })
})
