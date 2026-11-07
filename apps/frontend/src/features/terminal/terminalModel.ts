import type { CommandRunReport, PipelineCommand, TerminalOutput } from '../../repository'

type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * 内置终端与命令流水线面板的纯逻辑。
 *
 * 组件只负责装配；这里不依赖 React 与 Tauri，便于 vitest 覆盖边界。
 * 校验规则与后端 git_terminal.rs 保持一致：
 * - 终端尺寸钳制到合理区间，0 尺寸不会发往后端；
 * - 终端输入 / 粘贴只去掉控制字符（保留 \r \n \t），不做其他改写；
 * - 命令工作目录必须是仓库内相对路径，拒绝绝对路径与 `..`。
 */

export const TERMINAL_DEFAULT_COLS = 80
export const TERMINAL_DEFAULT_ROWS = 24
export const TERMINAL_MIN_COLS = 20
export const TERMINAL_MAX_COLS = 400
export const TERMINAL_MIN_ROWS = 5
export const TERMINAL_MAX_ROWS = 200

export const PIPELINE_MAX_ARGS = 64
export const PIPELINE_MAX_ARG_CHARS = 4096
export const PIPELINE_MAX_NAME_CHARS = 200
export const PIPELINE_MAX_DESCRIPTION_CHARS = 2000
export const PIPELINE_DEFAULT_TIMEOUT_SECONDS = 120

export type TerminalSize = {
  cols: number
  rows: number
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** xterm 在隐藏容器里可能报 0，这里统一钳制，避免把非法尺寸发给 PTY。 */
export function clampTerminalSize(size: Partial<TerminalSize> = {}): TerminalSize {
  return {
    cols: clampInteger(size.cols, TERMINAL_MIN_COLS, TERMINAL_MAX_COLS, TERMINAL_DEFAULT_COLS),
    rows: clampInteger(size.rows, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS, TERMINAL_DEFAULT_ROWS),
  }
}

/**
 * 去掉除 \r \n \t 之外的控制字符（含 DEL）。
 * 终端输入仍由 xterm/PTY 解释，但 NUL、ESC 序列等不应从粘贴路径混入。
 */
export function sanitizeTerminalText(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

/** 粘贴多行文本时把换行统一成回车，符合终端里 Enter 的语义。 */
export function terminalPasteData(raw: string): string {
  return sanitizeTerminalText(raw).replace(/\r\n/g, '\n').replace(/\n/g, '\r')
}

export type TerminalExitTone = 'running' | 'success' | 'failure' | 'neutral'

export function formatTerminalExit(
  output: Pick<TerminalOutput, 'alive'> & { exitCode?: number | null }, t: Translate) {
  if (output.alive) return t('terminal.running')
  if (output.exitCode === null || output.exitCode === undefined) return t('terminal.exited')
  return t('terminal.exitedWithCode', { code: output.exitCode })
}

export function terminalExitTone(
  output: Pick<TerminalOutput, 'alive'> & { exitCode?: number | null },
): TerminalExitTone {
  if (output.alive) return 'running'
  if (output.exitCode === 0) return 'success'
  if (output.exitCode === null || output.exitCode === undefined) return 'neutral'
  return 'failure'
}

/** 截断提示只显示一次；未截断时返回 null。 */
export function terminalTruncatedNotice(truncated: boolean, t: Translate) {
  return truncated ? t('terminal.bufferOverflow') : null
}

/** Shell 展示名：绝对路径只保留最后一段，裸名字原样返回。 */
export function terminalShellLabel(shell: string, t: Translate) {
  const trimmed = shell.trim()
  if (!trimmed) return 'Shell'
  const segments = trimmed.split(/[\\/]/)
  return segments[segments.length - 1] || trimmed
}

export function formatRunDuration(durationMs: number, t: Translate): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '—'
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`
  if (durationMs < 60_000) return t('terminal.durationSeconds', { seconds: (durationMs / 1000).toFixed(1) })
  const minutes = Math.floor(durationMs / 60_000)
  const seconds = Math.round((durationMs % 60_000) / 1000)
  return t('terminal.durationMinutesSeconds', { minutes, seconds })
}

export type CommandRunTone = 'success' | 'danger' | 'warning' | 'neutral'

export function formatCommandRunExit(report: CommandRunReport, t: Translate) {
  if (report.cancelled) return t('terminal.cancelled')
  if (report.timedOut) return t('terminal.timedOut')
  if (report.exitCode === 0) return t('terminal.successZero')
  if (report.exitCode === null || report.exitCode === undefined) return t('terminal.finishedNoCode')
  return t('terminal.failedWithCode', { code: report.exitCode })
}

export function commandRunTone(report: CommandRunReport): CommandRunTone {
  if (report.cancelled) return 'warning'
  if (report.timedOut) return 'warning'
  if (report.exitCode === 0) return 'success'
  if (report.exitCode === null || report.exitCode === undefined) return 'neutral'
  return 'danger'
}

export function commandRunSummary(report: CommandRunReport, t: Translate) {
  const parts = [formatCommandRunExit(report, t), t('terminal.durationPrefix', { duration: formatRunDuration(report.durationMs, t) })]
  if (report.truncated) parts.push(t('terminal.outputTruncated'))
  return parts.join(' · ')
}

// ---------------------------------------------------------------------------
// 命令流水线编辑器
// ---------------------------------------------------------------------------

export type PipelineDraft = {
  name: string
  description: string
  program: string
  argsText: string
  cwdRelative: string
}

export function emptyPipelineDraft(): PipelineDraft {
  return { name: '', description: '', program: '', argsText: '', cwdRelative: '' }
}

/** 参数一行一个；空行忽略，首尾空白去掉（参数本身是字面值）。 */
export function parsePipelineArgs(argsText: string): string[] {
  return argsText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function charCount(value: string): number {
  return [...value].length
}

function isAbsoluteLikePath(value: string): boolean {
  return /^([\\/]|[A-Za-z]:[\\/]|\\\\)/.test(value)
}

/** 返回 null 表示工作目录合法；否则是给用户看的错误文案。 */
export function validatePipelineCwd(raw: string, t: Translate) {
  const value = raw.trim()
  if (!value) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return t('terminal.cwdControlChars')
  if (isAbsoluteLikePath(value)) return t('terminal.cwdRelative')
  const segments = value.split(/[\\/]+/)
  if (segments.some((segment) => segment === '..')) {
    return t('terminal.cwdNoParent')
  }
  return null
}

/** 输入框下方的安全说明；非法时直接给出错误，合法时解释后端约束。 */
export function pipelineCwdSafetyNote(raw: string, t: Translate): string {
  const value = raw.trim()
  if (!value) return t('terminal.cwdHint')
  const invalid = validatePipelineCwd(value, t)
  if (invalid) return invalid
  return t('terminal.cwdPlaceholder')
}

export function validatePipelineDraft(draft: PipelineDraft, t: Translate): string | null {
  const name = draft.name.trim()
  const program = draft.program.trim()
  if (!name) return t('terminal.nameRequired')
  if (charCount(name) > PIPELINE_MAX_NAME_CHARS) {
    return t('terminal.nameTooLong', { count: PIPELINE_MAX_NAME_CHARS })
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return t('terminal.nameControlChars')
  if (charCount(draft.description.trim()) > PIPELINE_MAX_DESCRIPTION_CHARS) {
    return t('terminal.descriptionTooLong', { count: PIPELINE_MAX_DESCRIPTION_CHARS })
  }
  if (!program) return t('terminal.programRequired')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(program)) return t('terminal.programControlChars')
  const args = parsePipelineArgs(draft.argsText)
  if (args.length > PIPELINE_MAX_ARGS) {
    return t('terminal.tooManyArgs', { count: PIPELINE_MAX_ARGS })
  }
  for (const argument of args) {
    if (charCount(argument) > PIPELINE_MAX_ARG_CHARS) {
      return t('terminal.argTooLong', { count: PIPELINE_MAX_ARG_CHARS })
    }
    if (argument.includes('\0')) return t('terminal.argsNoNul')
  }
  return validatePipelineCwd(draft.cwdRelative, t)
}

export function pipelineCommandFromDraft(draft: PipelineDraft, id: string): PipelineCommand {
  const cwd = draft.cwdRelative.trim()
  return {
    id: id.trim(),
    name: draft.name.trim(),
    description: draft.description.trim(),
    program: draft.program.trim(),
    args: parsePipelineArgs(draft.argsText),
    cwdRelative: cwd || null,
  }
}

export function draftFromPipelineCommand(command: PipelineCommand): PipelineDraft {
  return {
    name: command.name,
    description: command.description,
    program: command.program,
    argsText: command.args.join('\n'),
    cwdRelative: command.cwdRelative ?? '',
  }
}

/** 生成不与现有 id 冲突的 `custom-<n>`。 */
export function nextPipelineCommandId(commands: PipelineCommand[]): string {
  const used = new Set(commands.map((command) => command.id))
  for (let index = 1; index <= 9999; index += 1) {
    const candidate = `custom-${index}`
    if (!used.has(candidate)) return candidate
  }
  return `custom-${Date.now().toString(36)}`
}

/** 预览一行命令；含空白 / 引号的参数用 JSON 引号包裹，避免歧义。 */
export function pipelineCommandPreview(command: PipelineCommand): string {
  const parts = [command.program, ...command.args]
  return parts
    .map((part) => (/[\s"']/.test(part) ? JSON.stringify(part) : part))
    .join(' ')
}

export function pipelineCommandsSummary(commands: PipelineCommand[], t: Translate): string {
  if (!commands.length) return t('terminal.noCommands')
  return t('terminal.commandsSummary', { count: commands.length })
}

/** 内置示例只用于「填入编辑器」，不会自动保存或执行。 */
export function builtinPipelineCommands(t: Translate): PipelineCommand[] {
  return [
    {
      id: 'builtin-status',
      name: t('terminal.presetGitStatus'),
      description: t('terminal.presetGitStatusHint'),
      program: 'git',
      args: ['status', '--short', '--branch'],
      cwdRelative: null,
    },
    {
      id: 'builtin-log',
      name: t('terminal.presetRecentCommits'),
      description: t('terminal.presetRecentCommitsHint'),
      program: 'git',
      args: ['log', '--oneline', '-n', '20'],
      cwdRelative: null,
    },
    {
      id: 'builtin-diff-stat',
      name: t('terminal.presetDiffStat'),
      description: t('terminal.presetDiffStatHint'),
      program: 'git',
      args: ['diff', '--stat'],
      cwdRelative: null,
    },
  ]
}

/** 前端预生成取消令牌；后端只接受字母、数字、- 与 _（最长 64）。 */
export function createPipelineRunId(now = Date.now(), random = Math.random()): string {
  const suffix = Math.floor(Math.abs(random) * 36 ** 8)
    .toString(36)
    .slice(0, 8)
  return `run-${now.toString(36)}-${suffix}`
}
