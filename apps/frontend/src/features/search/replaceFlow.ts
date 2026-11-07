type Translate = (key: string, params?: Record<string, string | number>) => string

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
export function validateReplaceForm(form: ReplaceForm, preview: ReplacePreview | null, t: Translate) {
  if (!form.pattern.trim()) return t('search.replaceFindRequired')
  if (preview && preview.totalOccurrences === 0) return t('search.noReplaceableHits')
  if (form.regex && /([$\\]\d)/.test(form.replacement)) {
    return t('search.regexBackrefUnsupported')
  }
  if (/[\r\n]/.test(form.replacement)) return t('search.replaceNoNewlines')
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
export function applyBlocker(preview: ReplacePreview | null, t: Translate) {
  if (!preview) return t('search.previewFirst')
  if (preview.truncated) return preview.notice ?? t('search.previewTruncatedReplace')
  if (preview.totalOccurrences <= 0) return t('search.noReplaceableHits')
  if (!preview.files.some((file) => !file.skipped)) return t('search.allSkipped')
  return null
}

/** 确认框正文：文件数、处数、字节量、抽样文件与跳过项，一次读全。 */
export function replacementConfirmation(preview: ReplacePreview, t: Translate) {
  const lines = [
    t('replace.confirmSummary', { fileCount: preview.fileCount, occurrences: preview.totalOccurrences, bytes: formatBytes(preview.estimatedBytes) }),
    t('replace.findPrefix', { pattern: preview.pattern }),
    t('replace.replaceWithPrefix', { replacement: preview.replacement || t('search.emptyRemoval') }),
  ]
  const writable = preview.files.filter((file) => !file.skipped)
  const sample = writable.slice(0, 8).map((file) => t('replace.fileOccurrences', { path: file.filePath, count: file.occurrences }))
  if (sample.length) lines.push(t('replace.affectedFiles', { sample: sample.join('\n') }) + (writable.length > sample.length ? t('replace.moreFilesSuffix', { count: writable.length }) : ''))
  const skipped = preview.files.filter((file) => file.skipped)
  if (skipped.length) lines.push(t('replace.skippedNote', { count: skipped.length }))
  lines.push(t('search.backupNote'))
  return lines
}

/** 执行后的播报：必须把备份位置带出来，用户才有逃生通道。 */
export function reportNotice(report: ReplaceReport, t: Translate) {
  const parts = [t('replace.done', { fileCount: report.filesChanged.length, occurrences: report.occurrences })]
  if (report.backupAvailable && report.backupPath) parts.push(t('replace.backupPath', { path: report.backupPath }))
  if (report.skipped.length) parts.push(t('replace.skippedCount', { count: report.skipped.length }))
  if (report.warnings.length) parts.push(report.warnings[0])
  return parts.join('；')
}

/** 撤销后的播报。 */
export function undoNotice(report: ReplaceReport, t: Translate) {
  const parts = [t('replace.restored', { count: report.restoredFiles.length })]
  if (report.skipped.length) parts.push(t('replace.overwriteRefused', { count: report.skipped.length }))
  if (report.backupAvailable && report.backupPath) parts.push(t('replace.backupKept', { path: report.backupPath }))
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
}, t: Translate) {
  const when = new Date(Number(backup.createdAtMs)).toLocaleString()
  return t('replace.backupLine', { when, pattern: backup.pattern, replacement: backup.replacement || t('search.removal'), fileCount: backup.fileCount, occurrences: backup.occurrences, bytes: formatBytes(backup.byteSize) })
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
}, t: Translate): { ok: boolean; reason: string | null } {
  if (file.binary) return { ok: false, reason: t('search.binaryNotSavable') }
  if (file.truncated) return { ok: false, reason: t('search.truncatedSaveLoses') }
  if (file.revision) return { ok: false, reason: t('search.viewingHistoryVersion') }
  if (!file.checksum) return { ok: false, reason: t('search.missingBaseline') }
  return { ok: true, reason: null }
}
