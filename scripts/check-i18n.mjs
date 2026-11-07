import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanSource } from './lib/i18n-scan.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const sourceRoot = join(root, 'apps/frontend/src')
const baselinePath = join(root, 'scripts/i18n-baseline.json')
const update = process.argv.includes('--update')

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'i18n' ? [] : walk(path)
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) return []
    return [path]
  })
}

const files = {}
for (const path of walk(sourceRoot)) {
  const count = scanSource(readFileSync(path, 'utf8'), path)
  if (count) files[relative(root, path).replaceAll('\\', '/')] = count
}
const total = Object.values(files).reduce((sum, count) => sum + count, 0)

if (update) {
  writeFileSync(baselinePath, `${JSON.stringify({ total, files }, null, 2)}\n`)
  console.log(`i18n baseline updated: ${total} occurrences in ${Object.keys(files).length} files`)
  process.exit(0)
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
const regressions = Object.entries(files).filter(([path, count]) => count > (baseline.files[path] ?? 0))
if (total > baseline.total || regressions.length) {
  console.error(`i18n regression: ${total} > ${baseline.total}`)
  for (const [path, count] of regressions) console.error(`  ${path}: ${count} > ${baseline.files[path] ?? 0}`)
  process.exit(1)
}
console.log(`i18n coverage OK: ${total} occurrences (baseline ${baseline.total})`)
