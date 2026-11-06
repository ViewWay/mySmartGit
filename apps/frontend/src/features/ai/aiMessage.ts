import type { AiCommitMessage, AiGenerateOptions, AiLanguage, AiMessageStyle } from '../../repository'

export type NormalizedAiOptions = {
  language: AiLanguage
  style: AiMessageStyle
  includeBody: boolean
  maxSubjectChars: number
}

export const AI_SUBJECT_MIN_CHARS = 16
export const AI_SUBJECT_MAX_CHARS = 200
export const AI_SUBJECT_DEFAULT_CHARS = 72

function clampSubjectChars(value: number) {
  if (!Number.isFinite(value)) return AI_SUBJECT_DEFAULT_CHARS
  return Math.min(AI_SUBJECT_MAX_CHARS, Math.max(AI_SUBJECT_MIN_CHARS, Math.round(value)))
}

/** 把界面上的可选值归一化成后端契约允许的取值（与 Rust 端钳制规则一致）。 */
export function normalizeAiOptions(
  input: AiGenerateOptions = {},
  defaults: Partial<NormalizedAiOptions> = {},
): NormalizedAiOptions {
  const requestedLanguage = input.language ?? defaults.language
  const language = requestedLanguage === 'en' || requestedLanguage === 'zh'
    ? requestedLanguage
    : defaults.language ?? 'zh'
  const requestedStyle = input.style ?? defaults.style
  const style = requestedStyle === 'plain' || requestedStyle === 'conventional'
    ? requestedStyle
    : defaults.style ?? 'conventional'
  return {
    language: language === 'en' ? 'en' : 'zh',
    style: style === 'plain' ? 'plain' : 'conventional',
    includeBody: input.includeBody ?? defaults.includeBody ?? true,
    maxSubjectChars: clampSubjectChars(input.maxSubjectChars ?? defaults.maxSubjectChars ?? AI_SUBJECT_DEFAULT_CHARS),
  }
}

/** 把 subject/body 拼回提交框文本；空正文不产生多余的空行。 */
export function composeGeneratedMessage(result: Pick<AiCommitMessage, 'subject' | 'body'>) {
  const subject = result.subject.trim()
  const body = (result.body ?? '').trim()
  return body ? `${subject}\n\n${body}` : subject
}

export type ApplyGeneratedDraftDecision = {
  applied: boolean
  requiresConfirmation: boolean
  message: string
}

/**
 * 应用生成结果的决策：
 * - 生成内容为空：不应用；
 * - 提交框草稿非空且用户尚未确认：不覆盖，要求确认；
 * - 其余情况（草稿为空或已确认）：覆盖。
 */
export function applyGeneratedDraft(input: {
  currentMessage: string
  generated: string
  confirmed?: boolean
}): ApplyGeneratedDraftDecision {
  const generated = input.generated.trim()
  if (!generated) return { applied: false, requiresConfirmation: false, message: input.currentMessage }
  const needsConfirmation = input.currentMessage.trim().length > 0 && input.confirmed !== true
  if (needsConfirmation) {
    return { applied: false, requiresConfirmation: true, message: input.currentMessage }
  }
  return { applied: true, requiresConfirmation: false, message: generated }
}

/** 生成结果的提示文案：优先展示后端 note（来源/截断），否则用 truncated 兜底。 */
export function generatedMessageNotice(result: Pick<AiCommitMessage, 'note' | 'truncated'>) {
  const note = result.note?.trim()
  if (note) return note
  return result.truncated ? '生成内容已截断，请检查后再使用' : null
}

/** 统一错误文案；后端已脱敏，这里只做空值与异常兜底。 */
export function describeAiError(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (typeof error === 'string' && error.trim()) return error.trim()
  return 'AI 生成失败，请稍后重试'
}
