// One-off migration: the field `holder` of an object became `original.holder` (together with `reference`, the call number).
// Rewrites the object files of a data repository in place; `git diff` shows what changed.
//   npx tsx core/scripts/migrate-holder.ts <path to the data repository>

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The text with `holder` moved into `original`, in the same place; undefined if there is nothing to do. Works on the lines,
 * not on a parsed copy, so that everything else stays exactly as it is (a parser would fold the long lines again).
 */
export function migrateHolder(text: string): string | undefined {
  const lines = text.split('\n')
  const at = lines.findIndex((line) => /^holder:/.test(line))
  if (at < 0) return undefined
  if (lines.some((line) => /^original:/.test(line))) throw new Error('has both "holder" and "original"')
  if (lines[at].trim() !== 'holder:') throw new Error('"holder" is not written as a block')
  // The block is the indented lines below the key.
  let end = at + 1
  while (end < lines.length && /^[ \t]/.test(lines[end])) end++
  const block = lines.slice(at + 1, end).map((line) => `  ${line}`)
  return [...lines.slice(0, at), 'original:', '  holder:', ...block, ...lines.slice(end)].join('\n')
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* walk(path)
    else if (path.endsWith('.yaml')) yield path
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2]
  if (!root) {
    console.error('Usage: migrate-holder <path to the data repository>')
    process.exit(2)
  }
  let changed = 0
  let failed = 0
  for (const path of walk(join(root, 'objects'))) {
    try {
      const next = migrateHolder(readFileSync(path, 'utf8'))
      if (next !== undefined) {
        writeFileSync(path, next)
        changed++
      }
    } catch (error) {
      failed++
      console.error(`${path}: ${(error as Error).message}`)
    }
  }
  console.log(`${changed} object file(s) changed, ${failed} failed.`)
  process.exit(failed === 0 ? 0 : 1)
}
