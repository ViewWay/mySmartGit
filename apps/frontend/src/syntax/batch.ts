import { StreamLanguage } from '@codemirror/language'
import { tags } from '@lezer/highlight'

/**
 * 轻量 Windows Batch 语法（CodeMirror 生态无现成模式）：`::` 与 `REM` 注释、
 * `:label` 标签、`@` 抑制符、常用命令词、`%VAR%`/`%1`/`%~dp0`/`%%i`/`!VAR!`
 * 变量展开与带引号字符串。标签名与 previewHighlightStyle / branchlineHighlighter
 * 已有规则对齐（label→labelName、变量→propertyName），无需新增 CSS。
 */

const COMMANDS = new Set([
  'call', 'cd', 'chdir', 'choice', 'cls', 'color', 'copy', 'del', 'dir', 'do', 'echo',
  'else', 'endlocal', 'erase', 'exit', 'exist', 'find', 'findstr', 'for', 'goto', 'if',
  'in', 'md', 'mkdir', 'more', 'move', 'net', 'not', 'pause', 'popd', 'pushd', 'rd',
  'reg', 'ren', 'rename', 'rmdir', 'robocopy', 'sc', 'set', 'setlocal', 'shift',
  'sort', 'start', 'taskkill', 'tasklist', 'timeout', 'title', 'type', 'verify',
  'where', 'wmic', 'xcopy',
])

export const batchLanguage = StreamLanguage.define({
  name: 'Batch',
  startState: () => null,
  tokenTable: {
    keyword: tags.keyword,
    comment: tags.comment,
    label: tags.labelName,
    // 注意：键名避开内置默认表里的 'variable'（会被 variableName 标签抢占）。
    batchVariable: tags.propertyName,
    string: tags.string,
    echoOff: tags.meta,
  },
  token(stream) {
    if (stream.sol()) {
      // :: 行注释（需在标签识别之前，避免误判为标签）。
      if (stream.match(/^::/)) {
        stream.skipToEnd()
        return 'comment'
      }
      // :label 标签行。
      if (stream.match(/^:[\w.-]+/)) {
        stream.skipToEnd()
        return 'label'
      }
      // REM 注释大小写不敏感。
      if (stream.match(/^rem\b/i)) {
        stream.skipToEnd()
        return 'comment'
      }
      // @echo off 的 @ 抑制符。
      if (stream.match(/^@/)) return 'echoOff'
      // 行首命令词：命中常用命令表才着关键字色，否则保持普通文本。
      if (stream.match(/^\w[\w-]*/)) {
        return COMMANDS.has(stream.current().toLowerCase()) ? 'keyword' : null
      }
    }
    // 变量展开：%VAR% / %~dp0 / %1 / %* / %%i（for 循环）/ !VAR!（延迟展开）。
    // 变量优先于字符串，引号内的 %VAR% 才能被单独着色。
    if (stream.match(/%[^%\s][^%\n]*%/)) return 'batchVariable'
    if (stream.match(/%~\w+|%[\d*]|%%/)) return 'batchVariable'
    if (stream.match(/![^!\s]+!/)) return 'batchVariable'
    // 带引号字符串：只消费单个引号字符，引号内的变量由后续 token 识别。
    if (stream.peek() === '"') {
      stream.next()
      return 'string'
    }
    stream.next()
    return null
  },
})
