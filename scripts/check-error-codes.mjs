import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const rustRoot = join(root, 'apps/desktop/src')
const dictionaries = ['zh', 'en'].map((language) => ({
  language,
  source: readFileSync(join(root, `apps/frontend/src/i18n/messages/${language}/errors.ts`), 'utf8'),
}))

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return walk(path)
    return entry.name.endsWith('.rs') ? [path] : []
  })
}

const codes = new Set()
const patterns = [/CommandError::new\("([a-z0-9.]+)"/g, /code:\s*"([a-z0-9.]+)"/g]
for (const path of walk(rustRoot)) {
  const source = readFileSync(path, 'utf8')
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) codes.add(match[1])
  }
}

const missing = []
for (const code of codes) {
  for (const dictionary of dictionaries) {
    if (!dictionary.source.includes(`'errors.${code}':`)) missing.push(`${dictionary.language}: errors.${code}`)
  }
}

if (missing.length) {
  console.error(`missing error translations:\n${missing.map((item) => `  ${item}`).join('\n')}`)
  process.exit(1)
}
console.log(`error code catalog OK: ${codes.size} codes`)
