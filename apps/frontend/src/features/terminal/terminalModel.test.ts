import { describe, expect, it } from 'vitest'
import type { CommandRunReport, PipelineCommand } from '../../repository'
import {
  PIPELINE_DEFAULT_TIMEOUT_SECONDS,
  PIPELINE_MAX_ARGS,
  TERMINAL_DEFAULT_COLS,
  TERMINAL_DEFAULT_ROWS,
  TERMINAL_MAX_COLS,
  TERMINAL_MIN_COLS,
  builtinPipelineCommands,
  clampTerminalSize,
  commandRunSummary,
  commandRunTone,
  createPipelineRunId,
  draftFromPipelineCommand,
  emptyPipelineDraft,
  formatCommandRunExit,
  formatRunDuration,
  formatTerminalExit,
  nextPipelineCommandId,
  parsePipelineArgs,
  pipelineCommandFromDraft,
  pipelineCommandPreview,
  pipelineCommandsSummary,
  pipelineCwdSafetyNote,
  sanitizeTerminalText,
  terminalExitTone,
  terminalPasteData,
  terminalShellLabel,
  terminalTruncatedNotice,
  validatePipelineCwd,
  validatePipelineDraft,
} from './terminalModel'

const report = (overrides: Partial<CommandRunReport> = {}): CommandRunReport => ({
  runId: 'run-1',
  commandId: 'status',
  exitCode: 0,
  timedOut: false,
  cancelled: false,
  durationMs: 1234,
  stdout: 'ok\n',
  stderr: '',
  truncated: false,
  ...overrides,
})

const command = (overrides: Partial<PipelineCommand> = {}): PipelineCommand => ({
  id: 'status',
  name: '查看状态',
  description: 'git status',
  program: 'git',
  args: ['status', '--short'],
  cwdRelative: null,
  ...overrides,
})

describe('终端尺寸与输入', () => {
  it('隐藏容器报 0 或 NaN 时回退默认尺寸', () => {
    expect(clampTerminalSize()).toEqual({ cols: TERMINAL_DEFAULT_COLS, rows: TERMINAL_DEFAULT_ROWS })
    expect(clampTerminalSize({ cols: 0, rows: 0 })).toEqual({
      cols: TERMINAL_MIN_COLS,
      rows: 5,
    })
    expect(clampTerminalSize({ cols: Number.NaN, rows: Number.POSITIVE_INFINITY })).toEqual({
      cols: TERMINAL_DEFAULT_COLS,
      rows: TERMINAL_DEFAULT_ROWS,
    })
  })

  it('把过大尺寸钳制到上限', () => {
    expect(clampTerminalSize({ cols: 9999, rows: 9999 })).toEqual({
      cols: TERMINAL_MAX_COLS,
      rows: 200,
    })
    expect(clampTerminalSize({ cols: 120.7, rows: 30.2 })).toEqual({ cols: 120, rows: 30 })
  })

  it('去掉 NUL / ESC / BEL 等控制字符，保留换行制表符', () => {
    expect(sanitizeTerminalText('a\u0000b\u001bc\u0007d')).toBe('abcd')
    expect(sanitizeTerminalText('echo\tok\r\nnext')).toBe('echo\tok\r\nnext')
    expect(sanitizeTerminalText('中文🙂')).toBe('中文🙂')
    expect(sanitizeTerminalText('del\u007f')).toBe('del')
  })

  it('粘贴多行文本时把换行统一为回车', () => {
    expect(terminalPasteData('one\r\ntwo\nthree')).toBe('one\rtwo\rthree')
    expect(terminalPasteData('a\u0000b\nc')).toBe('ab\rc')
  })

  it('Shell 展示名取路径最后一段', () => {
    expect(terminalShellLabel('/bin/zsh')).toBe('zsh')
    expect(terminalShellLabel('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe(
      'powershell.exe',
    )
    expect(terminalShellLabel('bash')).toBe('bash')
    expect(terminalShellLabel('   ')).toBe('Shell')
  })
})

describe('终端状态文案', () => {
  it('区分运行中、成功退出、失败退出与无退出码', () => {
    expect(formatTerminalExit({ alive: true, exitCode: null })).toBe('运行中')
    expect(formatTerminalExit({ alive: false, exitCode: 0 })).toBe('进程已退出（代码 0）')
    expect(formatTerminalExit({ alive: false, exitCode: 2 })).toBe('进程已退出（代码 2）')
    expect(formatTerminalExit({ alive: false, exitCode: null })).toBe('进程已退出')
    expect(terminalExitTone({ alive: true })).toBe('running')
    expect(terminalExitTone({ alive: false, exitCode: 0 })).toBe('success')
    expect(terminalExitTone({ alive: false, exitCode: 1 })).toBe('failure')
    expect(terminalExitTone({ alive: false, exitCode: null })).toBe('neutral')
  })

  it('截断提示只在 truncated 时出现', () => {
    expect(terminalTruncatedNotice(false)).toBeNull()
    expect(terminalTruncatedNotice(true)).toContain('256 KiB')
  })
})

describe('流水线执行结果', () => {
  it('按取消 / 超时 / 成功 / 失败排序展示', () => {
    expect(formatCommandRunExit(report())).toBe('成功（代码 0）')
    expect(formatCommandRunExit(report({ exitCode: 3 }))).toBe('失败（代码 3）')
    expect(formatCommandRunExit(report({ timedOut: true, exitCode: null }))).toBe('已超时')
    expect(formatCommandRunExit(report({ cancelled: true, timedOut: true }))).toBe('已取消')
    expect(formatCommandRunExit(report({ exitCode: null }))).toBe('已结束（无退出码）')
    expect(commandRunTone(report())).toBe('success')
    expect(commandRunTone(report({ exitCode: 1 }))).toBe('danger')
    expect(commandRunTone(report({ timedOut: true }))).toBe('warning')
    expect(commandRunTone(report({ cancelled: true }))).toBe('warning')
    expect(commandRunTone(report({ exitCode: null }))).toBe('neutral')
  })

  it('摘要包含状态、用时与截断标记', () => {
    expect(commandRunSummary(report())).toBe('成功（代码 0） · 用时 1.2 秒')
    expect(commandRunSummary(report({ durationMs: 250, truncated: true }))).toContain('250 ms')
    expect(commandRunSummary(report({ durationMs: 250, truncated: true }))).toContain('输出已截断')
    expect(formatRunDuration(0)).toBe('0 ms')
    expect(formatRunDuration(65_000)).toBe('1 分 5 秒')
    expect(formatRunDuration(Number.NaN)).toBe('—')
    expect(PIPELINE_DEFAULT_TIMEOUT_SECONDS).toBe(120)
  })
})

describe('命令草稿校验', () => {
  it('接受合法草稿并解析一行一个参数', () => {
    const draft = {
      name: ' 查看状态 ',
      description: ' desc ',
      program: ' git ',
      argsText: 'status\n--short\n\n  --branch  \n',
      cwdRelative: 'packages/app',
    }
    expect(validatePipelineDraft(draft)).toBeNull()
    const parsed = pipelineCommandFromDraft(draft, ' custom-1 ')
    expect(parsed).toEqual({
      id: 'custom-1',
      name: '查看状态',
      description: 'desc',
      program: 'git',
      args: ['status', '--short', '--branch'],
      cwdRelative: 'packages/app',
    })
    expect(parsePipelineArgs('a\r\nb\r\n')).toEqual(['a', 'b'])
    expect(parsePipelineArgs('')).toEqual([])
  })

  it('拒绝空名称、空程序与过长参数', () => {
    const draft = emptyPipelineDraft()
    expect(validatePipelineDraft(draft)).toContain('名称不能为空')
    expect(validatePipelineDraft({ ...draft, name: 'x' })).toContain('程序不能为空')
    expect(
      validatePipelineDraft({
        ...draft,
        name: 'x',
        program: 'echo',
        argsText: Array.from({ length: PIPELINE_MAX_ARGS + 1 }, (_, index) => String(index)).join('\n'),
      }),
    ).toContain('参数过多')
    expect(
      validatePipelineDraft({ ...draft, name: 'x', program: 'echo', argsText: 'a'.repeat(4097) }),
    ).toContain('单个参数过长')
  })

  it('拒绝转义工作目录与绝对路径', () => {
    expect(validatePipelineCwd('')).toBeNull()
    expect(validatePipelineCwd('packages/app')).toBeNull()
    expect(validatePipelineCwd('../outside')).toContain('..')
    expect(validatePipelineCwd('packages/../../outside')).toContain('..')
    expect(validatePipelineCwd('/tmp')).toContain('绝对路径')
    expect(validatePipelineCwd('C:\\tmp')).toContain('绝对路径')
    expect(validatePipelineCwd('a\u0000b')).toContain('控制字符')
    expect(validatePipelineDraft({ ...emptyPipelineDraft(), name: 'x', program: 'pwd', cwdRelative: '../x' }))
      .toContain('..')
  })

  it('工作目录安全说明区分空、合法与非法输入', () => {
    expect(pipelineCwdSafetyNote('')).toContain('仓库根目录')
    expect(pipelineCwdSafetyNote('packages/app')).toContain('符号链接逃逸')
    expect(pipelineCwdSafetyNote('../x')).toContain('..')
  })

  it('从命令还原草稿并保留可选工作目录', () => {
    expect(draftFromPipelineCommand(command())).toEqual({
      name: '查看状态',
      description: 'git status',
      program: 'git',
      argsText: 'status\n--short',
      cwdRelative: '',
    })
    expect(draftFromPipelineCommand(command({ cwdRelative: 'apps' })).cwdRelative).toBe('apps')
  })
})

describe('命令列表辅助', () => {
  it('生成不与现有 id 冲突的 custom id', () => {
    expect(nextPipelineCommandId([])).toBe('custom-1')
    expect(nextPipelineCommandId([command({ id: 'custom-1' })])).toBe('custom-2')
    expect(
      nextPipelineCommandId([command({ id: 'custom-1' }), command({ id: 'custom-2' })]),
    ).toBe('custom-3')
  })

  it('预览时给含空白的参数加引号', () => {
    expect(pipelineCommandPreview(command())).toBe('git status --short')
    expect(
      pipelineCommandPreview(command({ program: '/bin/echo', args: ['hello world', 'plain'] })),
    ).toBe('/bin/echo "hello world" plain')
  })

  it('列表摘要为空与非空分别给出提示', () => {
    expect(pipelineCommandsSummary([])).toContain('还没有')
    expect(pipelineCommandsSummary([command()])).toContain('1 条')
  })

  it('内置示例不经过 shell 且都是只读 git 命令', () => {
    const builtins = builtinPipelineCommands()
    expect(builtins.length).toBeGreaterThan(0)
    for (const item of builtins) {
      expect(item.program).toBe('git')
      expect(item.args.length).toBeGreaterThan(0)
      expect(item.id.startsWith('builtin-')).toBe(true)
      expect(item.args).not.toContain('-c')
    }
  })
})

describe('运行令牌', () => {
  it('生成后端可接受的 runId', () => {
    const runId = createPipelineRunId(1_700_000_000_000, 0.123456)
    expect(runId).toMatch(/^run-[a-z0-9]+-[a-z0-9]{1,8}$/)
    expect(runId.length).toBeLessThanOrEqual(64)
    expect(createPipelineRunId(1, 0)).not.toBe(createPipelineRunId(1, 0.5))
  })
})
