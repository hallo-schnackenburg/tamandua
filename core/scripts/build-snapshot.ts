// Builds the snapshot of the data repository: all object files in one gzip-compressed file (see src/snapshot.ts).
// Run in the data repository's CI (see .github/workflows/snapshot.yml):
//   npx tsx core/scripts/build-snapshot.ts <path to the data repository> <file to write>

import { execFileSync } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { snapshotHeader, snapshotLine, type SnapshotRecord } from '../src/snapshot.js'

const [root, out] = process.argv.slice(2)
if (!root || !out) {
  console.error('Usage: build-snapshot <path to the data repository> <file to write>')
  process.exit(2)
}

const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })

// The hashes are the ones git has in its index: "<mode> <hash> <stage>\t<path>".
const OBJECT = /^objects\/[0-9A-Z]{2}\/([0-9A-Z]{26})\.yaml$/
const records: SnapshotRecord[] = []
for (const line of git('ls-files', '-s', '-z', '--', 'objects').split('\0')) {
  const found = /^\d+ ([0-9a-f]{40}) 0\t(.+)$/s.exec(line)
  const match = found ? OBJECT.exec(found[2]) : null
  if (!found || !match) continue // not an object file: the validation of the data repository complains about those
  records.push({ path: found[2], id: match[1], sha: found[1], text: readFileSync(join(root, found[2]), 'utf8') })
}
records.sort((a, b) => a.path.localeCompare(b.path))

const commit = git('rev-parse', 'HEAD').trim()
mkdirSync(dirname(out), { recursive: true })
async function* lines() {
  yield snapshotHeader({ commit, count: records.length }) + '\n'
  for (const record of records) yield snapshotLine(record) + '\n'
}
await pipeline(Readable.from(lines()), createGzip({ level: 9 }), createWriteStream(out))
console.log(`${records.length} objects of commit ${commit.slice(0, 7)} written to ${out}`)
