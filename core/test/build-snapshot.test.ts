import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { buildSnapshot } from '../scripts/build-snapshot.js'
import { objectPath } from '../src/paths.js'
import { parseSnapshotHeader, parseSnapshotLine } from '../src/snapshot.js'

const A = '01JC8Z3Q7M5K2V9X4T6R1B0N8D'
const B = '01JC8Z4A2P0H7W3E5S9Y6F1G2C'
let root: string

function repo(files: Record<string, string>) {
  root = mkdtempSync(join(tmpdir(), 'tamandua-snap-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
  git('init', '-q')
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@example.org', 'commit', '-q', '-m', 'x')
}

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('buildSnapshot', () => {
  it('writes the objects at the path an object has, and nothing else', async () => {
    repo({ [objectPath(A)]: `id: ${A}\ntitle: A\n`, [objectPath(B)]: `id: ${B}\ntitle: "Ä"\n`, 'objects/README.md': 'x', 'other.txt': 'y' })
    const out = join(root, '..', `${A}.gz`)
    const { count } = await buildSnapshot(root, out)
    expect(count).toBe(2)
    const lines = gunzipSync(readFileSync(out)).toString('utf8').trimEnd().split('\n')
    expect(parseSnapshotHeader(lines[0])).toMatchObject({ count: 2 })
    expect(lines.slice(1).map((l) => parseSnapshotLine(l)?.path)).toEqual([objectPath(A), objectPath(B)].sort())
    rmSync(out)
  })

  it('fails instead of writing an empty snapshot when the files are not where objects are', async () => {
    repo({ [`objects/${A.slice(10, 12)}/${A}.yaml`]: `id: ${A}\n` }) // the old layout
    await expect(buildSnapshot(root, join(root, '..', 'never.gz'))).rejects.toThrow(/did the layout change/)
  })

  it('writes an empty snapshot for a repository without objects', async () => {
    repo({ 'README.md': 'x' })
    const out = join(root, '..', 'empty.gz')
    expect((await buildSnapshot(root, out)).count).toBe(0)
    rmSync(out)
  })
})
