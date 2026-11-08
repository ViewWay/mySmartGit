import { LanguageDescription, LanguageSupport } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { asciidocLanguage } from './asciidoc'
import { batchLanguage } from './batch'

// 文件名特判（CodeMirror 按 extensions/filename 归类不到的常用文件）。
// 全部映射到 language-data 里已有的语言，语法近似即可，比如 Makefile 系挂 C。
const filenameOverrides: Record<string, string> = {
  dockerfile: 'Dockerfile',
  makefile: 'C',
  'makefile.am': 'C',
  'makefile.in': 'C',
  'cmakelists.txt': 'CMake',
  '.gitignore': 'Shell',
  '.gitattributes': 'Shell',
  '.bashrc': 'Shell',
  '.zshrc': 'Shell',
  '.env': 'Properties files',
  '.editorconfig': 'Properties files',
  '.npmrc': 'Properties files',
  '.gitmodules': 'Properties files',
  '.flake8': 'Properties files',
  // 无扩展名的 JSON 风格工具配置。
  '.prettierrc': 'JSON',
  '.eslintrc': 'JSON',
  '.babelrc': 'JSON',
  // lockfile 与 pipfile 本体都是 TOML；composer.lock 是 JSON。
  'cargo.lock': 'TOML',
  'poetry.lock': 'TOML',
  'uv.lock': 'TOML',
  pipfile: 'TOML',
  'composer.lock': 'JSON',
  vagrantfile: 'Ruby',
  // 电信侧的 ASN.1 令牌定义常存成 txt，按文件名特判挂 ASN.1 语法。
  'asntokentypes.txt': 'ASN.1',
}

// 扩展名特判：CodeMirror 未覆盖、但内置语言语法兼容的扩展名。
const extensionOverrides: Record<string, string> = {
  // 电信 .G 即 ASN.1 定义文件。
  g: 'ASN.1',
  // MSBuild/Apple 资源都是 XML；ipynb 与宽松 JSON 变体按 JSON 处理。
  plist: 'XML',
  mobileconfig: 'XML',
  csproj: 'XML',
  props: 'XML',
  targets: 'XML',
  resx: 'XML',
  strings: 'Properties files',
  ipynb: 'JSON',
  json5: 'JSON',
  jsonc: 'JSON',
  cjson: 'JSON',
  // Ruby 包定义；鸿蒙 ArkTS 按 TypeScript 近似。
  gemspec: 'Ruby',
  podspec: 'Ruby',
  fsx: 'F#',
  ets: 'TypeScript',
  tcc: 'C++',
  // INI 家族：systemd 单元、桌面项、注册表导出、通用 conf/cfg。
  conf: 'Properties files',
  cfg: 'Properties files',
  service: 'Properties files',
  timer: 'Properties files',
  desktop: 'Properties files',
  reg: 'Properties files',
  // 模板语言近似：svelte/astro 结构同 HTML（内嵌 script/style 仍会嵌套高亮），
  // ejs/njk/twig 同 Jinja 标记。
  svelte: 'HTML',
  astro: 'HTML',
  ejs: 'Jinja',
  njk: 'Jinja',
  twig: 'Jinja',
  // IaC 的 HCL 是 key = value + 块头结构，用 INI 语法近似着色。
  tf: 'Properties files',
  tfvars: 'Properties files',
  hcl: 'Properties files',
}

// CodeMirror 生态缺失的语言：本地自实现的 StreamLanguage 按扩展名挂载。
const customExtensions: Record<string, LanguageDescription> = {
  adoc: LanguageDescription.of({ name: 'AsciiDoc', load: () => Promise.resolve(new LanguageSupport(asciidocLanguage)) }),
  asciidoc: LanguageDescription.of({ name: 'AsciiDoc', load: () => Promise.resolve(new LanguageSupport(asciidocLanguage)) }),
  bat: LanguageDescription.of({ name: 'Batch', load: () => Promise.resolve(new LanguageSupport(batchLanguage)) }),
  cmd: LanguageDescription.of({ name: 'Batch', load: () => Promise.resolve(new LanguageSupport(batchLanguage)) }),
}

export function matchLanguage(path: string): LanguageDescription | null {
  if (!path) return null
  const filename = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const lower = filename.toLowerCase()
  const extension = lower.includes('.') ? (lower.split('.').pop() ?? '') : ''
  const findByName = (name: string) => languages.find((item) => item.name === name)
  const override = filenameOverrides[lower] ?? extensionOverrides[extension]
  if (override) {
    const description = findByName(override)
    if (description) return description
  }
  const custom = customExtensions[extension]
  if (custom) return custom
  // matchFilename 对无扩展名等未命中场景可能返回 undefined，统一归一为 null。
  return LanguageDescription.matchFilename(languages, filename) ?? null
}
