import { describe, expect, it } from 'vitest'
import type { LfsFilesPage, LfsOperationReport, LfsStatus } from '../../repository'
import {
  formatLfsBytes,
  lfsActionConfirmation,
  lfsActionLabel,
  lfsActionRequiresConfirmation,
  lfsDownloadLabel,
  lfsFilesSummary,
  lfsOperationNotice,
  lfsStatusDescription,
  lfsStatusLabel,
  lfsStatusTone,
  shortLfsOid,
  validateLfsPattern,
} from './lfsModel'

import { zh } from '../../i18n/messages/zh'
const zhT = (key: string, params?: Record<string, string | number>) => {
  const template = (zh as Record<string, string>)[key] ?? key
  if (!params) return template
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => (params[name] === undefined ? match : String(params[name])))
}


const status = (overrides: Partial<LfsStatus> = {}): LfsStatus => ({
  available: true,
  version: '3.8.1',
  installedLocally: true,
  patterns: ['*.psd'],
  trackedFileCount: 2,
  notice: null,
  ...overrides,
})

const page = (overrides: Partial<LfsFilesPage> = {}): LfsFilesPage => ({
  files: [
    { oid: 'a'.repeat(64), size: 5, path: 'a.bin', downloaded: true },
    { oid: 'b'.repeat(64), size: 1_572_864, path: 'b.psd', downloaded: false },
  ],
  truncated: false,
  ...overrides,
})

describe('LFS 模式校验', () => {
  it('接受常见通配模式并去掉首尾空白', () => {
    expect(validateLfsPattern('  *.psd  ', zhT)).toBeNull()
    expect(validateLfsPattern('assets/**/*.bin', zhT)).toBeNull()
    expect(validateLfsPattern('my file.bin', zhT)).toBeNull()
  })

  it('拒绝空串、选项注入、注释与换行/NUL/控制字符', () => {
    expect(validateLfsPattern('', zhT)).toContain('不能为空')
    expect(validateLfsPattern('   ', zhT)).toContain('不能为空')
    expect(validateLfsPattern('-x', zhT)).toContain('不能以 - 开头')
    expect(validateLfsPattern('#comment', zhT)).toContain('不能以 # 开头')
    expect(validateLfsPattern('*.bin\nfilter=lfs', zhT)).toContain('换行')
    expect(validateLfsPattern('a\0b', zhT)).toContain('NUL')
    expect(validateLfsPattern('a\tb', zhT)).toContain('控制字符')
  })

  it('拒绝超长模式', () => {
    expect(validateLfsPattern('a'.repeat(501), zhT)).toContain('过长')
  })
})

describe('LFS 状态分类与文案', () => {
  it('区分未安装、未在仓库启用与已就绪', () => {
    expect(lfsStatusTone(status({ available: false, version: null }))).toBe('unavailable')
    expect(lfsStatusTone(status({ installedLocally: false }))).toBe('attention')
    expect(lfsStatusTone(status())).toBe('ready')
    expect(lfsStatusTone(null)).toBe('unavailable')
  })

  it('优先展示后端 notice，否则汇总版本与数量', () => {
    expect(lfsStatusLabel(status({ available: false }), zhT)).toBe('未安装 git-lfs')
    expect(lfsStatusLabel(status({ installedLocally: false }), zhT)).toBe('本仓库未启用 LFS')
    expect(lfsStatusLabel(status(), zhT)).toBe('LFS 已就绪')
    expect(lfsStatusDescription(status({ notice: '未安装 git-lfs' }), zhT)).toBe('未安装 git-lfs')
    expect(lfsStatusDescription(status(), zhT)).toContain('git-lfs 3.8.1')
    expect(lfsStatusDescription(status(), zhT)).toContain('1 个模式')
    expect(lfsStatusDescription(null, zhT)).toContain('正在读取')
  })
})

describe('LFS 文件展示模型', () => {
  it('格式化大小并保留未知大小的占位符', () => {
    expect(formatLfsBytes(0)).toBe('—')
    expect(formatLfsBytes(-1)).toBe('—')
    expect(formatLfsBytes(512)).toBe('512 B')
    expect(formatLfsBytes(1536)).toBe('1.5 KB')
    expect(formatLfsBytes(5 * 1024 * 1024)).toBe('5 MB')
  })

  it('截断时给出显式提示，不伪装成完整列表', () => {
    expect(lfsFilesSummary(page(), zhT)).toBe('共 2 个 LFS 文件')
    expect(lfsFilesSummary(page({ truncated: true }), zhT)).toContain('已截断')
    expect(lfsFilesSummary(page({ files: [] }), zhT)).toContain('没有 LFS 文件')
    expect(lfsFilesSummary(null, zhT)).toContain('尚未读取')
  })

  it('短 OID 与下载状态可读', () => {
    expect(shortLfsOid('a'.repeat(64))).toBe('aaaaaaaaaa')
    expect(lfsDownloadLabel(page().files[0], zhT)).toBe('已下载')
    expect(lfsDownloadLabel(page().files[1], zhT)).toBe('未下载')
  })
})

describe('LFS 危险操作确认门槛', () => {
  it('只有 pull / prune 需要二次确认', () => {
    expect(lfsActionRequiresConfirmation('fetch')).toBe(false)
    expect(lfsActionRequiresConfirmation('pull')).toBe(true)
    expect(lfsActionRequiresConfirmation('prune')).toBe(true)
    expect(lfsActionLabel('prune', zhT)).toBe('清理缓存')
  })

  it('确认文案带仓库路径与后果，prune 用 danger 样式', () => {
    const prune = lfsActionConfirmation('prune', '/repo', zhT)
    expect(prune.title).toContain('清理')
    expect(prune.message).toContain('/repo')
    expect(prune.variant).toBe('danger')
    const pull = lfsActionConfirmation('pull', '/repo', zhT)
    expect(pull.message).toContain('/repo')
    expect(pull.variant).toBe('primary')
  })

  it('操作回执把 stdout 摘要拼回通知', () => {
    const report: LfsOperationReport = { action: 'fetch', summary: '已抓取', output: '12 objects' }
    expect(lfsOperationNotice(report, zhT)).toBe('已抓取：12 objects')
    expect(lfsOperationNotice({ ...report, output: '' }, zhT)).toBe('已抓取')
  })
})
