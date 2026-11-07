import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'

const filenameOverrides: Record<string, string> = {
  dockerfile: 'Dockerfile',
  makefile: 'C',
  'cmakelists.txt': 'CMake',
  '.gitignore': 'Shell',
  '.env': 'Properties files',
}

export function matchLanguage(path: string): LanguageDescription | null {
  if (!path) return null
  const filename = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const lower = filename.toLowerCase()
  const override = filenameOverrides[lower]
  if (override) {
    const description = languages.find((item) => item.name === override)
    if (description) return description
  }
  // matchFilename 对无扩展名等未命中场景可能返回 undefined，统一归一为 null。
  return LanguageDescription.matchFilename(languages, filename) ?? null
}
