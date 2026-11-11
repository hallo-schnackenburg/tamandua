// Builds the snapshot of the data repository: all object files in one gzip-compressed file (see src/snapshot.ts).
// Run in the data repository's CI (see .github/workflows/snapshot.yml):
//   npx tsx core/scripts/build-snapshot.ts <path to the data repository> <file to write>

import { execFileSync } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createGzip } from 'node:zlib'
import { objectPath } from '../src/paths.js'
import { snapshotHeader, snapshotLine, type SnapshotRecord } from '../src/snapshot.js'

/** Writes the snapshot of the repository at `root` (the files git has in its index) to `out`. */
export async function buildSnapshot(root: string, out: string): Promise<{ count: number; commit: string }> {
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })

  // The hashes are the ones git has in its index: "<mode> <hash> <stage>\t<path>".
  const records: SnapshotRecord[] = []
  let listed = 0
  for (const line of git('ls-files', '-s', '-z', '--', 'objects').split('\0')) {
    const found = /^\d+ ([0-9a-f]{40}) 0\t(.+)$/s.exec(line)
    if (!found) continue
    listed++
    // An object file is where objectPath puts it. Anything else is not one: the validation of the data repository complains about those.
    const id = /([0-9A-Z]{26})\.yaml$/.exec(found[2])?.[1]
    if (!id || objectPath(id) !== found[2]) continue
    records.push({ path: found[2], id, sha: found[1], text: readFileSync(join(root, found[2]), 'utf8') })
  }
  // A snapshot of nothing would pass for a real one and make every browser read all objects one by one: better to fail.
  if (listed > 0 && records.length === 0) {
    throw new Error(`${listed} file(s) under objects/, but none at the path an object has (objects/<a>/<b>/<id>.yaml): did the layout change?`)
  }
  records.sort((a, b) => a.path.localeCompare(b.path))

  const commit = git('rev-parse', 'HEAD').trim()
  mkdirSync(dirname(out), { recursive: true })
  async function* lines() {
    yield snapshotHeader({ commit, count: records.length }) + '\n'
    for (const record of records) yield snapshotLine(record) + '\n'
  }
  await pipeline(Readable.from(lines()), createGzip({ level: 9 }), createWriteStream(out))
  return { count: records.length, commit }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [root, out] = process.argv.slice(2)
  if (!root || !out) {
    console.error('Usage: build-snapshot <path to the data repository> <file to write>')
    process.exit(2)
  }
  try {
    const { count, commit } = await buildSnapshot(root, out)
    console.log(`${count} objects of commit ${commit.slice(0, 7)} written to ${out}`)
  } catch (error) {
    console.error((error as Error).message)
    process.exit(1)
  }
}
