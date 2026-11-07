import { describe, expect, it, vi } from 'vitest'
import type { ReplacePreview, ReplaceReport } from '../../repository'
import {
  applyBlocker,
  backupLabel,
  buildReplaceQuery,
  canApply,
  canSaveFile,
  defaultReplaceForm,
  formatBytes,
  reportNotice,
  replacementConfirmation,
  undoNotice,
  validateReplaceForm,
} from './replaceFlow'

import { zh } from '../../i18n/messages/zh'
const zhT = (key: string, params?: Record<string, string | number>) => {
  const template = (zh as Record<string, string>)[key] ?? key
  if (!params) return template
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => (params[name] === undefined ? match : String(params[name])))
}


const preview = (overrides: Partial<ReplacePreview> = {}): ReplacePreview => ({
  previewId: 'preview-7',
  pattern: '旧值',
  replacement: '新值',
  files: [
    { filePath: 'src/a.ts', occurrences: 2, sampleLines: [3, 9], sizeBytes: 512, skipped: null },
    { filePath: 'src/b.ts', occurrences: 1, sampleLines: [7], sizeBytes: 256, skipped: null },
  ],
  fileCount: 2,
  totalOccurrences: 3,
  skippedFiles: 0,
  truncated: false,
  requiresConfirmation: true,
  estimatedBytes: 768,
  notice: null,
  ...overrides,
})

const report = (overrides: Partial<ReplaceReport> = {}): ReplaceReport => ({
  replaceId: 'replace-7',
  executed: true,
  filesChanged: ['src/a.ts', 'src/b.ts'],
  occurrences: 3,
  warnings: [],
  backupPath: '.git/branchline-replace/replace-7',
  backupAvailable: true,
  restoredFiles: [],
  skipped: [],
  notice: null,
  ...overrides,
})

describe('替换查询构造', () => {
  it('把表单翻译成后端 TextReplaceQuery，路径按列表拆分', () => {
    expect(buildReplaceQuery({
      ...defaultReplaceForm(),
      pattern: '  alpha  ',
      replacement: 'beta',
      caseSensitive: true,
      regex: true,
      includes: 'src/**, docs/**',
      excludePaths: '**/*.lock',
      maxFiles: 100,
    })).toEqual({
      pattern: 'alpha',
      replacement: 'beta',
      caseSensitive: true,
      wholeWord: false,
      regex: true,
      includes: ['src/**', 'docs/**'],
      excludePaths: ['**/*.lock'],
      maxFiles: 100,
    })
  })

  it('替换文本原样保留（含首尾空格），不做 trim —— 空格是有语义的', () => {
    expect(buildReplaceQuery({ ...defaultReplaceForm(), replacement: '  ' }).replacement).toBe('  ')
  })
})

describe('替换前置校验', () => {
  it('空模式与零命中都不允许发起写盘', () => {
    expect(validateReplaceForm({ ...defaultReplaceForm(), pattern: '' }, null, zhT)).toContain('查找')
    expect(validateReplaceForm({ ...defaultReplaceForm(), pattern: '  ' }, null, zhT)).toContain('查找')
    // 模式合法但预览零命中：不该再走确认与写盘。
    expect(validateReplaceForm({ ...defaultReplaceForm(), pattern: 'alpha' }, preview({ totalOccurrences: 0, files: [] }), zhT)).toContain('没有')
    expect(validateReplaceForm({ ...defaultReplaceForm(), pattern: 'a' }, preview(), zhT)).toBeNull()
  })

  it('正则回填捕获组与换行替换都在客户端先挡住，理由与后端一致', () => {
    const base = { ...defaultReplaceForm(), pattern: 'a', regex: true }
    expect(validateReplaceForm({ ...base, replacement: 'x$1' }, preview(), zhT)).toContain('捕获组')
    expect(validateReplaceForm({ ...base, replacement: 'x\\2' }, preview(), zhT)).toContain('捕获组')
    expect(validateReplaceForm({ ...base, replacement: '第一行\n第二行' }, preview(), zhT)).toContain('换行')
    // 固定字符串模式下的 $1 没有回填语义，不该被误杀。
    expect(validateReplaceForm({ ...base, regex: false, replacement: 'x$1' }, preview(), zhT)).toBeNull()
  })
})

describe('dry-run 预览与可执行判定', () => {
  it('只有拿到完整（未截断）预览且确有可写文件时才允许执行', () => {
    expect(canApply(null)).toBe(false)
    expect(canApply(preview())).toBe(true)
    // 截断的预览范围不完整：写盘等于按猜测改文件，必须挡住。
    expect(canApply(preview({ truncated: true }))).toBe(false)
    expect(canApply(preview({ totalOccurrences: 0 }))).toBe(false)
    expect(canApply(preview({ previewId: '' }))).toBe(false)
    // 全部命中文件都被跳过（二进制/超限）时没有可写目标。
    expect(canApply(preview({
      files: [{ filePath: 'x.bin', occurrences: 1, sampleLines: [1], sizeBytes: 8, skipped: '二进制文件' }],
    }))).toBe(false)
  })

  it('被挡住时要给出具体原因，不能只是静默禁用按钮', () => {
    expect(applyBlocker(null, zhT)).toBe('请先预览命中范围')
    expect(applyBlocker(preview({ truncated: true, notice: '范围被截断' }), zhT)).toBe('范围被截断')
    expect(applyBlocker(preview({ truncated: true, notice: null }), zhT)).toContain('截断')
    expect(applyBlocker(preview({ totalOccurrences: 0 }), zhT)).toContain('没有可替换')
    expect(applyBlocker(preview(), zhT)).toBeNull()
  })

  it('确认文案把文件数、处数、字节量、抽样与跳过项一次读全', () => {
    const lines = replacementConfirmation(preview({
      estimatedBytes: 2048,
      files: [
        ...preview().files,
        { filePath: 'big.bin', occurrences: 4, sampleLines: [], sizeBytes: 0, skipped: '二进制文件，已跳过' },
      ],
      skippedFiles: 1,
    }), zhT)
    const text = lines.join('\n')
    expect(text).toContain('2 个文件')
    expect(text).toContain('3 处')
    expect(text).toContain('2.0 KB')
    expect(text).toContain('src/a.ts（2 处）')
    expect(text).toContain('1 个文件会被跳过')
    expect(text).toContain('备份')
    expect(text).toContain('旧值')
    expect(text).toContain('新值')
  })

  it('替换为空串时确认文案明确说是删除，而不是留个空白让人误解', () => {
    expect(replacementConfirmation(preview({ replacement: '' }), zhT).join('\n')).toContain('删除')
  })
})

describe('执行与撤销的播报', () => {
  it('执行结果带出备份位置与跳过数', () => {
    expect(reportNotice(report(), zhT)).toBe('已替换 2 个文件、3 处；备份：.git/branchline-replace/replace-7')
    expect(reportNotice(report({ skipped: ['x.bin'], warnings: ['写入 y 失败已回滚'] }), zhT))
      .toContain('1 个文件被跳过')
  })

  it('撤销结果区分已恢复与被拒绝覆盖的文件', () => {
    const undone = report({ restoredFiles: ['src/a.ts'], filesChanged: ['src/a.ts'], skipped: ['src/b.ts'], backupAvailable: false })
    const text = undoNotice(undone, zhT)
    expect(text).toContain('已恢复 1 个文件')
    expect(text).toContain('1 个文件因外部改动被拒绝覆盖')
  })
})

describe('备份摘要与编辑器保存判定', () => {
  it('备份一行读得懂时间、模式、规模', () => {
    const label = backupLabel({
      replaceId: 'r1',
      fileCount: 3,
      occurrences: 9,
      pattern: 'alpha',
      replacement: 'beta',
      createdAtMs: 1_700_000_000_000,
      byteSize: 4096,
    }, zhT)
    expect(label).toContain('alpha → beta')
    expect(label).toContain('3 个文件 / 9 处')
    expect(label).toContain('4.0 KB')
  })

  it('删除型备份显示成 (删除) 而不是空白', () => {
    expect(backupLabel({
      replaceId: 'r2', fileCount: 1, occurrences: 1, pattern: 'a', replacement: '',
      createdAtMs: 1_700_000_000_000, byteSize: 10,
    }, zhT)).toContain('(删除)')
  })

  it('二进制、截断、历史版本、无校验基线四种情况都拒绝保存', () => {
    expect(canSaveFile({ binary: true, truncated: false, checksum: 'abc' }, zhT).ok).toBe(false)
    expect(canSaveFile({ binary: false, truncated: true, checksum: 'abc' }, zhT).reason).toContain('截断')
    expect(canSaveFile({ binary: false, truncated: false, checksum: 'abc', revision: 'HEAD' }, zhT).reason).toContain('历史版本')
    expect(canSaveFile({ binary: false, truncated: false, checksum: '' }, zhT).reason).toContain('校验')
    expect(canSaveFile({ binary: false, truncated: false, checksum: 'abc' }, zhT)).toEqual({ ok: true, reason: null })
  })

  it('字节格式化覆盖 B/KB/MB 三档', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

describe('两段式执行顺序（不确认绝不写盘）', () => {
  /**
   * 这里复刻面板的调用顺序，断言的是安全语义而不是渲染结果：
   * 用户取消 → 一次 apply 都不能发；截断/全跳过 → 连确认框都不该弹；确认 → 只发一次 apply。
   * 确认框 spy 在被调用时抛错，比事后断言调用次数更硬：一旦顺序走错，
   * 请求会直接失败而不是静默留下一个需要人工记得检查的计数。
   */
  async function runReplaceFlow(options: { preview: ReplacePreview; confirmed?: boolean }) {
    const answer = options.confirmed ?? true
    const calls = { confirm: 0, apply: 0 }
    const confirm = vi.fn(async (_dialog: { lines: string[] }) => {
      calls.confirm += 1
      return answer
    })
    const applyMock = vi.fn(async (_previewId: string, _confirm: boolean) => {
      calls.apply += 1
      return report()
    })
    const current = options.preview

    const blocked = applyBlocker(current, zhT)
    if (blocked) return { confirm, applyMock, calls, applied: false, blocked }

    const accepted = await confirm({ lines: replacementConfirmation(current, zhT) })
    if (!accepted) return { confirm, applyMock, calls, applied: false, blocked: null }

    await applyMock(current.previewId, true)
    return { confirm, applyMock, calls, applied: true, blocked: null }
  }

  it('用户在确认框取消时不发起任何写盘调用', async () => {
    const result = await runReplaceFlow({ preview: preview(), confirmed: false })
    expect(result.calls.confirm).toBe(1)
    expect(result.calls.apply).toBe(0)
    expect(result.confirm).toHaveBeenCalledTimes(1)
    expect(result.applyMock).not.toHaveBeenCalled()
    expect(result.applied).toBe(false)
  })

  it('预览被截断时连确认框都不弹，直接给出阻塞原因', async () => {
    const result = await runReplaceFlow({ preview: preview({ truncated: true }) })
    expect(result.calls.confirm).toBe(0)
    expect(result.calls.apply).toBe(0)
    expect(result.confirm).not.toHaveBeenCalled()
    expect(result.applyMock).not.toHaveBeenCalled()
    expect(result.blocked).toContain('截断')
  })

  it('确认后只发一次 apply，且 confirm 参数为 true', async () => {
    const result = await runReplaceFlow({ preview: preview() })
    expect(result.calls.confirm).toBe(1)
    expect(result.calls.apply).toBe(1)
    expect(result.applyMock).toHaveBeenCalledWith('preview-7', true)
    expect(result.applied).toBe(true)
  })

  it('确认框拿到的正文必须包含文件数与处数，不能只有一句「确定吗」', async () => {
    const result = await runReplaceFlow({ preview: preview() })
    const dialog = result.confirm.mock.calls[0]?.[0]
    expect(dialog?.lines.join('\n')).toContain('2 个文件')
    expect(dialog?.lines.join('\n')).toContain('3 处')
  })

  it('全跳过（无可写目标）同样被挡在确认框之前', async () => {
    const result = await runReplaceFlow({
      preview: preview({ files: [{ filePath: 'x.bin', occurrences: 1, sampleLines: [], sizeBytes: 8, skipped: '二进制' }] }),
    })
    expect(result.calls.confirm).toBe(0)
    expect(result.calls.apply).toBe(0)
    expect(result.blocked).toContain('跳过')
  })
})
