import type { CommandRunReport, PipelineCommand, TerminalOutput } from '../../repository'

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
  output: Pick<TerminalOutput, 'alive'> & { exitCode?: number | null },
): string {
  if (output.alive) return '运行中'
  if (output.exitCode === null || output.exitCode === undefined) return '进程已退出'
  return `进程已退出（代码 ${output.exitCode}）`
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
export function terminalTruncatedNotice(truncated: boolean): string | null {
  return truncated ? '终端输出超过 256 KiB 缓冲上限，较早内容已被丢弃。' : null
}

/** Shell 展示名：绝对路径只保留最后一段，裸名字原样返回。 */
export function terminalShellLabel(shell: string): string {
  const trimmed = shell.trim()
  if (!trimmed) return 'Shell'
  const segments = trimmed.split(/[\\/]/)
  return segments[segments.length - 1] || trimmed
}

export function formatRunDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '—'
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)} 秒`
  const minutes = Math.floor(durationMs / 60_000)
  const seconds = Math.round((durationMs % 60_000) / 1000)
  return `${minutes} 分 ${seconds} 秒`
}

export type CommandRunTone = 'success' | 'danger' | 'warning' | 'neutral'

export function formatCommandRunExit(report: CommandRunReport): string {
  if (report.cancelled) return '已取消'
  if (report.timedOut) return '已超时'
  if (report.exitCode === 0) return '成功（代码 0）'
  if (report.exitCode === null || report.exitCode === undefined) return '已结束（无退出码）'
  return `失败（代码 ${report.exitCode}）`
}

export function commandRunTone(report: CommandRunReport): CommandRunTone {
  if (report.cancelled) return 'warning'
  if (report.timedOut) return 'warning'
  if (report.exitCode === 0) return 'success'
  if (report.exitCode === null || report.exitCode === undefined) return 'neutral'
  return 'danger'
}

export function commandRunSummary(report: CommandRunReport): string {
  const parts = [formatCommandRunExit(report), `用时 ${formatRunDuration(report.durationMs)}`]
  if (report.truncated) parts.push('输出已截断')
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
export function validatePipelineCwd(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return '工作目录不能包含控制字符'
  if (isAbsoluteLikePath(value)) return '工作目录必须是仓库内的相对路径，不能是绝对路径'
  const segments = value.split(/[\\/]+/)
  if (segments.some((segment) => segment === '..')) {
    return '工作目录不能包含 ..，必须位于仓库内'
  }
  return null
}

/** 输入框下方的安全说明；非法时直接给出错误，合法时解释后端约束。 */
export function pipelineCwdSafetyNote(raw: string): string {
  const value = raw.trim()
  if (!value) return '留空表示在仓库根目录运行。'
  const invalid = validatePipelineCwd(value)
  if (invalid) return invalid
  return '相对仓库根目录；后端还会拒绝符号链接逃逸。'
}

export function validatePipelineDraft(draft: PipelineDraft): string | null {
  const name = draft.name.trim()
  const program = draft.program.trim()
  if (!name) return '命令名称不能为空'
  if (charCount(name) > PIPELINE_MAX_NAME_CHARS) {
    return `命令名称过长（上限 ${PIPELINE_MAX_NAME_CHARS} 字符）`
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return '命令名称不能包含控制字符'
  if (charCount(draft.description.trim()) > PIPELINE_MAX_DESCRIPTION_CHARS) {
    return `命令描述过长（上限 ${PIPELINE_MAX_DESCRIPTION_CHARS} 字符）`
  }
  if (!program) return '程序不能为空'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(program)) return '程序不能包含控制字符'
  const args = parsePipelineArgs(draft.argsText)
  if (args.length > PIPELINE_MAX_ARGS) {
    return `参数过多（上限 ${PIPELINE_MAX_ARGS} 个，一行一个）`
  }
  for (const argument of args) {
    if (charCount(argument) > PIPELINE_MAX_ARG_CHARS) {
      return `单个参数过长（上限 ${PIPELINE_MAX_ARG_CHARS} 字符）`
    }
    if (argument.includes('\0')) return '参数不能包含 NUL'
  }
  return validatePipelineCwd(draft.cwdRelative)
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

export function pipelineCommandsSummary(commands: PipelineCommand[]): string {
  if (!commands.length) return '还没有自定义命令，可在下方新建。'
  return `共 ${commands.length} 条命令；运行时不经过 shell，参数按字面值传递。`
}

/** 内置示例只用于「填入编辑器」，不会自动保存或执行。 */
export function builtinPipelineCommands(): PipelineCommand[] {
  return [
    {
      id: 'builtin-status',
      name: 'Git 状态',
      description: '查看当前分支与工作区改动',
      program: 'git',
      args: ['status', '--short', '--branch'],
      cwdRelative: null,
    },
    {
      id: 'builtin-log',
      name: '最近提交',
      description: '列出最近 20 条提交标题',
      program: 'git',
      args: ['log', '--oneline', '-n', '20'],
      cwdRelative: null,
    },
    {
      id: 'builtin-diff-stat',
      name: '改动统计',
      description: '按文件统计工作区改动行数',
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
