import type { ReplacePreview, ReplaceReport, TextReplaceQuery } from '../../repository'
import { parseList } from './searchModel'

/**
 * 批量替换的安全语义（后端 preview/apply 两段式的客户端镜像）。
 *
 * 红线，按重要性排序：
 * 1. 默认只 dry-run。没有 `previewId` 就没有写盘这条路。
 * 2. 预览被截断（truncated）时**禁止**执行：范围不完整，写下去等于凭猜测改文件。
 * 3. 确认框必须写清「哪 N 个文件、共 M 处」，破坏性影响要在点确认之前读得到。
 * 4. 一次预览只能执行一次：apply 之后立即失效，防止双击二次替换。
 * 5. 执行后必须给出备份位置与撤销入口。
 */

export const DEFAULT_MAX_REPLACE_FILES = 512

export type ReplaceForm = {
  pattern: string
  replacement: string
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
  includes: string
  excludePaths: string
  maxFiles?: number | null
}

export const defaultReplaceForm = (): ReplaceForm => ({
  pattern: '',
  replacement: '',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  includes: '',
  excludePaths: '',
  maxFiles: DEFAULT_MAX_REPLACE_FILES,
})

export function buildReplaceQuery(form: ReplaceForm): TextReplaceQuery {
  return {
    pattern: form.pattern.trim(),
    replacement: form.replacement,
    caseSensitive: form.caseSensitive,
    wholeWord: form.wholeWord,
    regex: form.regex,
    includes: parseList(form.includes),
    excludePaths: parseList(form.excludePaths),
    maxFiles: form.maxFiles ?? null,
  }
}

/** 替换前置校验：命中数为 0 不发起，正则回填引用先挡一道。 */
export function validateReplaceForm(form: ReplaceForm, preview: ReplacePreview | null): string | null {
  if (!form.pattern.trim()) return '请输入要查找的内容'
  if (preview && preview.totalOccurrences === 0) return '没有可替换的命中'
  if (form.regex && /([$\\]\d)/.test(form.replacement)) {
    return '正则替换不支持捕获组引用（如 $1、\\1）：请改用固定字符串，或逐文件在编辑器里修改'
  }
  if (/[\r\n]/.test(form.replacement)) return '替换文本不支持换行：请改用内置编辑器逐行修改'
  return null
}

/** 是否允许进入写盘那一步。截断与空命中都在这里挡住。 */
export function canApply(preview: ReplacePreview | null): boolean {
  if (!preview) return false
  if (preview.truncated) return false
  if (preview.totalOccurrences <= 0) return false
  if (!preview.previewId) return false
  return preview.files.some((file) => !file.skipped)
}

/** apply 被挡住时要说清原因，而不是把按钮静默禁用。 */
export function applyBlocker(preview: ReplacePreview | null): string | null {
  if (!preview) return '请先预览命中范围'
  if (preview.truncated) return preview.notice ?? '预览范围被上限截断，请缩小路径范围后再替换'
  if (preview.totalOccurrences <= 0) return '没有可替换的命中'
  if (!preview.files.some((file) => !file.skipped)) return '所有命中文件都被跳过，没有可写盘的目标'
  return null
}

/** 确认框正文：文件数、处数、字节量、抽样文件与跳过项，一次读全。 */
export function replacementConfirmation(preview: ReplacePreview): string[] {
  const lines = [
    `将替换 ${preview.fileCount} 个文件、共 ${preview.totalOccurrences} 处（预计影响约 ${formatBytes(preview.estimatedBytes)}）。`,
    `查找：${preview.pattern}`,
    `替换为：${preview.replacement || '(空字符串，即删除命中内容)'}`,
  ]
  const writable = preview.files.filter((file) => !file.skipped)
  const sample = writable.slice(0, 8).map((file) => `· ${file.filePath}（${file.occurrences} 处）`)
  if (sample.length) lines.push(`受影响文件：\n${sample.join('\n')}${writable.length > sample.length ? `\n… 等共 ${writable.length} 个` : ''}`)
  const skipped = preview.files.filter((file) => file.skipped)
  if (skipped.length) lines.push(`${skipped.length} 个文件会被跳过（二进制/超限/位置校验失败），不会被写入。`)
  lines.push('执行前会整体备份到仓库的 Git 目录内，可随时撤销。')
  return lines
}

/** 执行后的播报：必须把备份位置带出来，用户才有逃生通道。 */
export function reportNotice(report: ReplaceReport): string {
  const parts = [`已替换 ${report.filesChanged.length} 个文件、${report.occurrences} 处`]
  if (report.backupAvailable && report.backupPath) parts.push(`备份：${report.backupPath}`)
  if (report.skipped.length) parts.push(`${report.skipped.length} 个文件被跳过`)
  if (report.warnings.length) parts.push(report.warnings[0])
  return parts.join('；')
}

/** 撤销后的播报。 */
export function undoNotice(report: ReplaceReport): string {
  const parts = [`已恢复 ${report.restoredFiles.length} 个文件`]
  if (report.skipped.length) parts.push(`${report.skipped.length} 个文件因外部改动被拒绝覆盖`)
  if (report.backupAvailable && report.backupPath) parts.push(`备份仍保留：${report.backupPath}`)
  return parts.join('；')
}

/** 备份摘要的一行展示。 */
export function backupLabel(backup: {
  replaceId: string
  fileCount: number
  occurrences: number
  pattern: string
  replacement: string
  createdAtMs: number
  byteSize: number
}): string {
  const when = new Date(Number(backup.createdAtMs)).toLocaleString()
  return `${when}｜${backup.pattern} → ${backup.replacement || '(删除)'}｜${backup.fileCount} 个文件 / ${backup.occurrences} 处｜${formatBytes(backup.byteSize)}`
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 已加载文件页的可保存判定：截断或二进制都不允许写回。
 * 后端的校验和比对是最后一道防线，前端先挡住可以避免无谓的往返和误导性的报错。
 */
export function canSaveFile(file: {
  binary: boolean
  truncated: boolean
  checksum: string
  revision?: string | null
}): { ok: boolean; reason: string | null } {
  if (file.binary) return { ok: false, reason: '二进制文件不可保存' }
  if (file.truncated) return { ok: false, reason: '内容被截断，保存会丢失后半部分' }
  if (file.revision) return { ok: false, reason: '正在查看历史版本，请在工作区文件上编辑' }
  if (!file.checksum) return { ok: false, reason: '缺少内容校验基线' }
  return { ok: true, reason: null }
}
