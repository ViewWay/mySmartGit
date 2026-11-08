import { javascript } from '@codemirror/lang-javascript'
import { describe, expect, it } from 'vitest'
import { matchLanguage } from './languages'
import { clearHighlightCache, highlightBlock, tokenizeBlock } from './highlight'

const language = javascript({ typescript: true }).language

async function loadLanguage(path: string) {
  const description = matchLanguage(path)
  expect(description).not.toBeNull()
  return (await description!.load()).language
}

describe('matchLanguage', () => {
  it('matches common filenames', () => {
    expect(matchLanguage('src/App.tsx')?.name).toBe('TSX')
    expect(matchLanguage('src/main.ts')?.name).toBe('TypeScript')
    expect(matchLanguage('Dockerfile')?.name).toBe('Dockerfile')
    expect(matchLanguage('Makefile')?.name).toBe('C')
    expect(matchLanguage('unknown.zzz')).toBeNull()
  })

  it('matches tree-preview paths with any supported extension', () => {
    expect(matchLanguage('src/main/java/org/openmuc/jdlms/APduBlockingQueue.java')?.name).toBe('Java')
    expect(matchLanguage('src/lib.rs')?.name).toBe('Rust')
    expect(matchLanguage('cmd/server/main.go')?.name).toBe('Go')
    expect(matchLanguage('styles/main.css')?.name).toBe('CSS')
    expect(matchLanguage('py/main.py')?.name).toBe('Python')
    expect(matchLanguage('doc/readme')).toBeNull()
  })

  it('maps telecom asn1 files and config extensions', () => {
    expect(matchLanguage('specs/ASN1.G')?.name).toBe('ASN.1')
    expect(matchLanguage('specs/protocol.asn')?.name).toBe('ASN.1')
    expect(matchLanguage('specs/ASNTokenTypes.txt')?.name).toBe('ASN.1')
    expect(matchLanguage('conf/app.ini')?.name).toBe('Properties files')
    expect(matchLanguage('Cargo.toml')?.name).toBe('TOML')
    // 普通 txt 不挂语法，保持纯文本。
    expect(matchLanguage('docs/notes.txt')).toBeNull()
  })

  it('covers common repo dotfiles, lockfiles, and resource extensions', () => {
    expect(matchLanguage('repo/.editorconfig')?.name).toBe('Properties files')
    expect(matchLanguage('repo/.npmrc')?.name).toBe('Properties files')
    expect(matchLanguage('repo/.bashrc')?.name).toBe('Shell')
    expect(matchLanguage('repo/.gitattributes')?.name).toBe('Shell')
    expect(matchLanguage('repo/.prettierrc')?.name).toBe('JSON')
    expect(matchLanguage('repo/Cargo.lock')?.name).toBe('TOML')
    expect(matchLanguage('repo/composer.lock')?.name).toBe('JSON')
    expect(matchLanguage('src/App.csproj')?.name).toBe('XML')
    expect(matchLanguage('ios/Info.plist')?.name).toBe('XML')
    expect(matchLanguage('notebook.ipynb')?.name).toBe('JSON')
    expect(matchLanguage('tsconfig.jsonc')?.name).toBe('JSON')
    expect(matchLanguage('lib/main.tcc')?.name).toBe('C++')
    expect(matchLanguage('app/Vagrantfile')?.name).toBe('Ruby')
    expect(matchLanguage('ui/Comp.svelte')?.name).toBe('HTML')
    expect(matchLanguage('tmpl/page.twig')?.name).toBe('Jinja')
    expect(matchLanguage('deploy/main.tf')?.name).toBe('Properties files')
    expect(matchLanguage('deploy/vars.hcl')?.name).toBe('Properties files')
    expect(matchLanguage('deploy/terraform.tfvars')?.name).toBe('Properties files')
  })

  it('highlights batch comments, labels, commands, and variables', async () => {
    expect(matchLanguage('scripts/deploy.bat')?.name).toBe('Batch')
    const language = await loadLanguage('scripts/run.cmd')
    const tokens = tokenizeBlock('@echo off\nREM 初始化\n:setvar\nset VAR=1\necho "%VAR%" done', language)
    const classes = tokens.flat().map((token) => token.className ?? '')
    expect(classes.some((className) => className.includes('tok-keyword'))).toBe(true)
    expect(classes.some((className) => className.includes('tok-comment'))).toBe(true)
    expect(classes.some((className) => className.includes('tok-labelName'))).toBe(true)
    expect(classes.some((className) => className.includes('tok-propertyName'))).toBe(true)
  })
})

describe('tokenizeBlock', () => {
  it('highlights keywords, strings, and cross-line comments', () => {
    const tokens = tokenizeBlock('const a = 1\n/* line\ncomment */\nconst b = "x"', language)
    expect(tokens).toHaveLength(4)
    expect(tokens[0].some((token) => token.className?.includes('tok-keyword'))).toBe(true)
    expect(tokens.flat().some((token) => token.className?.includes('tok-string'))).toBe(true)
    expect(tokens[1].some((token) => token.className?.includes('tok-comment'))).toBe(true)
    expect(tokens[2].some((token) => token.className?.includes('tok-comment'))).toBe(true)
  })

  it('returns plain tokens without a language', () => {
    expect(tokenizeBlock('hello\nworld', null)).toEqual([
      [{ text: 'hello', className: null }],
      [{ text: 'world', className: null }],
    ])
  })

  it('highlights lines beyond the 3000-char initial parse viewport', () => {
    // 200 行 × ~32 字符 ≈ 6400 字符，越过裸 EditorState 的 3000 字符解析视口
    const filler = Array.from({ length: 200 }, (_, index) => `const filler${index} = ${index} // fill beyond viewport`)
    const code = [...filler, 'const tail = "still colored"', ''].join('\n')
    const tokens = tokenizeBlock(code, language)
    expect(tokens).toHaveLength(202)
    const tail = tokens[200]
    expect(tail.some((token) => token.className?.includes('tok-keyword'))).toBe(true)
    expect(tail.some((token) => token.className?.includes('tok-string'))).toBe(true)
  })

  it('caches identical blocks', () => {
    clearHighlightCache()
    const description = { name: 'TypeScript' } as never
    const first = highlightBlock('let x = 1', language, description)
    const second = highlightBlock('let x = 1', language, description)
    expect(second).toBe(first)
  })

  it('highlights markdown headings, emphasis marks, and table delimiters', async () => {
    const language = await loadLanguage('docs/README_ZH.md')
    const tokens = tokenizeBlock('## 版本更新\n**加粗** and *斜体*\n| a | b |\n|---|---|\n| 1 | 2 |', language)
    const classes = tokens.flat().map((token) => token.className ?? '')
    expect(classes.some((className) => className.includes('tok-heading'))).toBe(true)
    expect(classes.some((className) => className.includes('tok-strong'))).toBe(true)
    expect(classes.some((className) => className.includes('tok-processingInstruction'))).toBe(true)
  })

  it('highlights inline code and links in markdown', async () => {
    const language = await loadLanguage('docs/README_ZH.md')
    const tokens = tokenizeBlock('use `npm run` see [文档](https://example.com)', language)
    const classes = tokens.flat().map((token) => token.className ?? '')
    expect(classes.some((className) => className.includes('tok-monospace'))).toBe(true)
    expect(classes.some((className) => className.includes('tok-link'))).toBe(true)
  })

  it('highlights html tags and attributes', async () => {
    const language = await loadLanguage('index.html')
    const tokens = tokenizeBlock('<a href="https://example.com">链接</a>', language)
    const classes = tokens.flat().map((token) => token.className ?? '')
    expect(classes.some((className) => className.includes('tok-tagName'))).toBe(true)
    expect(classes.some((className) => className.includes('tok-attributeName'))).toBe(true)
    expect(classes.some((className) => className.includes('tok-string'))).toBe(true)
  })

  it('highlights adoc headings, bold, and fenced code via the custom AsciiDoc mode', async () => {
    expect(matchLanguage('docs/guide.adoc')?.name).toBe('AsciiDoc')
    const language = await loadLanguage('docs/guide.asciidoc')
    const tokens = tokenizeBlock('== 安装指南\n*粗体* 与 _斜体_\nNOTE: 提示\n----\nconst x = 1\n----', language)
    const classes = tokens.flat().map((token) => token.className ?? '')
    expect(classes.some((className) => className.includes('tok-heading'))).toBe(true)
    expect(classes.some((className) => className.includes('tok-strong'))).toBe(true)
    expect(classes.some((className) => className.includes('tok-emphasis'))).toBe(true)
    expect(classes.some((className) => className.includes('tok-keyword'))).toBe(true)
    expect(classes.some((className) => className.includes('tok-monospace'))).toBe(true)
  })
})
