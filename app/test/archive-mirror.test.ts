import { describe, expect, it, vi } from 'vitest'
import { Mirror, type Change, type MirrorBackend, type MirrorRecord, type MirrorStore } from '../src/archive-mirror.js'

const idOf = (n: number) => `01JABCDEFGHJKMNPQRSTVWXY${String(n).padStart(2, '0')}`
const pathOf = (id: string) => `objects/${id.slice(10, 12)}/${id}.yaml`
const shaOf = (text: string) => `sha:${text}`

/** A repository that moves on: every commit is a set of changes. */
class FakeRepo implements MirrorBackend {
  files = new Map<string, string>()
  commits: string[] = ['c0']
  history: { commit: string; changes: Change[] }[] = []
  calls = { tree: 0, changes: 0, texts: [] as string[][] }
  reloadNext = false
  failing = false
  /** What the snapshot has (none: there is no snapshot); it can be older than the repository. */
  snapshotOf: { path: string; id: string; sha: string; text: string }[] | undefined
  snapshotFails = false
  /** Reading the texts fails from this many reads on (for an interrupted reading). */
  failTextsAfter = Infinity
  textsRead = 0

  async snapshot(progress?: (bytes: number, total: number) => void) {
    if (this.snapshotFails) throw new Error('no snapshot')
    progress?.(10, 10)
    return this.snapshotOf && { records: this.snapshotOf }
  }

  get head() {
    return this.commits[this.commits.length - 1]
  }

  commit(put: Record<number, string> = {}, remove: number[] = []) {
    const changes: Change[] = []
    for (const [n, text] of Object.entries(put)) {
      const id = idOf(Number(n))
      const path = pathOf(id)
      changes.push({ id, path, sha: shaOf(text), status: this.files.has(path) ? 'modified' : 'added' })
      this.files.set(path, text)
    }
    for (const n of remove) {
      const id = idOf(n)
      const path = pathOf(id)
      changes.push({ id, path, sha: shaOf(this.files.get(path) ?? ''), status: 'removed' })
      this.files.delete(path)
    }
    const commit = `c${this.commits.length}`
    this.commits.push(commit)
    this.history.push({ commit, changes })
    return commit
  }

  async tree() {
    if (this.failing) throw new Error('offline')
    this.calls.tree++
    const objects = [...this.files].map(([path, text]) => ({ id: path.slice(-31, -5), path, sha: shaOf(text) }))
    return { head: this.head, raw: this.head, objects }
  }

  async changes(since: string) {
    if (this.failing) throw new Error('offline')
    this.calls.changes++
    const index = this.commits.indexOf(since)
    if (this.reloadNext || index < 0) return { reload: true as const }
    // The newest change of a path wins.
    const last = new Map<string, Change>()
    for (const { changes } of this.history.slice(index)) for (const c of changes) last.set(c.path, c)
    return { head: this.head, raw: this.head, changes: [...last.values()] }
  }

  async texts(_raw: string, objects: { id: string; path: string }[]) {
    this.calls.texts.push(objects.map((o) => o.id))
    this.textsRead += objects.length
    if (this.textsRead > this.failTextsAfter) throw new Error('connection lost')
    return objects.map((o) => ({ id: o.id, text: this.files.get(o.path) ?? '' }))
  }
}

class MemoryStore implements MirrorStore {
  synced: string | undefined
  records = new Map<string, MirrorRecord>()
  async load() {
    return { synced: this.synced, records: [...this.records.values()] }
  }
  async apply(synced: string | undefined, put: MirrorRecord[], remove: string[]) {
    if (synced) this.synced = synced
    for (const r of put) this.records.set(r.path, r)
    for (const p of remove) this.records.delete(p)
  }
}

const texts = (mirror: Mirror) => Object.fromEntries([...mirror.records.values()].map((r) => [r.id, r.text]))
const setup = () => {
  const repo = new FakeRepo()
  const store = new MemoryStore()
  let changed = 0
  const mirror = new Mirror(store, repo, () => changed++)
  return { repo, store, mirror, changes: () => changed }
}

describe('the first reading', () => {
  it('reads everything and remembers the commit', async () => {
    const { repo, store, mirror } = setup()
    repo.commit({ 1: 'a', 2: 'b' })
    expect(await mirror.open()).toBe(false)
    await mirror.sync()
    expect(mirror.synced).toBe(repo.head)
    expect(texts(mirror)).toEqual({ [idOf(1)]: 'a', [idOf(2)]: 'b' })
    expect(store.synced).toBe(repo.head)
    expect(store.records.size).toBe(2)
  })

  it('works with an empty archive', async () => {
    const { repo, mirror } = setup()
    await mirror.sync()
    expect(mirror.synced).toBe(repo.head)
    expect(mirror.records.size).toBe(0)
  })
})

describe('keeping up', () => {
  it('reads only what changed', async () => {
    const { repo, mirror } = setup()
    repo.commit({ 1: 'a', 2: 'b', 3: 'c' })
    await mirror.sync()
    repo.calls.texts.length = 0

    repo.commit({ 2: 'b2', 4: 'd' }, [3])
    await mirror.sync()
    expect(texts(mirror)).toEqual({ [idOf(1)]: 'a', [idOf(2)]: 'b2', [idOf(4)]: 'd' })
    expect(mirror.synced).toBe(repo.head)
    expect(repo.calls.texts).toEqual([[idOf(2), idOf(4)]])
    expect(repo.calls.tree).toBe(1) // the first reading only
  })

  it('has nothing to do when nothing changed, and says nothing', async () => {
    const { repo, mirror, changes } = setup()
    repo.commit({ 1: 'a' })
    await mirror.sync()
    const before = changes()
    repo.calls.texts.length = 0
    await mirror.sync()
    expect(repo.calls.texts).toEqual([])
    expect(changes()).toBe(before)
  })

  it('reads everything again when the repository cannot tell what changed, but not what is equal', async () => {
    const { repo, mirror } = setup()
    repo.commit({ 1: 'a', 2: 'b' })
    await mirror.sync()
    repo.commit({ 2: 'b2', 3: 'c' })
    repo.reloadNext = true
    repo.calls.texts.length = 0
    await mirror.sync()
    expect(texts(mirror)).toEqual({ [idOf(1)]: 'a', [idOf(2)]: 'b2', [idOf(3)]: 'c' })
    expect(repo.calls.texts).toEqual([[idOf(2), idOf(3)]]) // object 1 is equal: not read again
  })

  it('reads everything again when the commit it knew is gone', async () => {
    const { repo, mirror } = setup()
    repo.commit({ 1: 'a' })
    await mirror.sync()
    repo.commits = ['x0', 'x1'] // history rewritten
    repo.files.set(pathOf(idOf(9)), 'z')
    await mirror.sync()
    expect(mirror.synced).toBe('x1')
    expect(texts(mirror)).toEqual({ [idOf(1)]: 'a', [idOf(9)]: 'z' })
  })

  it('does not lose a call that comes while it works: one more round follows', async () => {
    const { repo, mirror } = setup()
    repo.commit({ 1: 'a' })
    const first = mirror.sync()
    repo.commit({ 2: 'b' }) // happens while the first round runs
    const second = mirror.sync()
    await Promise.all([first, second])
    expect(mirror.synced).toBe(repo.head)
    expect(texts(mirror)).toEqual({ [idOf(1)]: 'a', [idOf(2)]: 'b' })
  })

  it('keeps the copy as it was when the repository cannot be reached', async () => {
    const { repo, store, mirror } = setup()
    repo.commit({ 1: 'a' })
    await mirror.sync()
    repo.commit({ 2: 'b' })
    repo.failing = true
    await expect(mirror.sync()).rejects.toThrow('offline')
    expect(texts(mirror)).toEqual({ [idOf(1)]: 'a' })
    expect(store.records.size).toBe(1)
    repo.failing = false
    await mirror.sync()
    expect(texts(mirror)).toEqual({ [idOf(1)]: 'a', [idOf(2)]: 'b' })
  })
})

describe('the copy in the browser', () => {
  it('is there after a reload, and is brought up to date from where it was', async () => {
    const { repo, store, mirror } = setup()
    repo.commit({ 1: 'a', 2: 'b' })
    await mirror.sync()

    // A new page load: a new mirror over the same store.
    const again = new Mirror(store, repo)
    expect(await again.open()).toBe(true)
    expect(texts(again)).toEqual({ [idOf(1)]: 'a', [idOf(2)]: 'b' })
    repo.commit({ 3: 'c' })
    repo.calls.tree = 0
    await again.sync()
    expect(texts(again)).toEqual({ [idOf(1)]: 'a', [idOf(2)]: 'b', [idOf(3)]: 'c' })
    expect(repo.calls.tree).toBe(0) // a delta, not everything
  })
})

describe('sync(true): making sure', () => {
  it('repairs what a missed change left behind: a changed, a removed and a new object', async () => {
    const { repo, mirror } = setup()
    repo.commit({ 1: 'a', 2: 'b', 3: 'c' })
    await mirror.sync()
    // Changes that the copy never heard of (and that a delta would not tell any more):
    repo.files.set(pathOf(idOf(1)), 'a2')
    repo.files.delete(pathOf(idOf(2)))
    repo.files.set(pathOf(idOf(5)), 'e')
    await mirror.sync(true)
    expect(texts(mirror)).toEqual({ [idOf(1)]: 'a2', [idOf(3)]: 'c', [idOf(5)]: 'e' })
  })
})

describe('the parsed data of the records', () => {
  const derive = { version: 1, run: (text: string) => ({ text }) }
  const withDerive = (version = 1) => {
    const repo = new FakeRepo()
    const store = new MemoryStore()
    const run = vi.fn((text: string) => ({ text }))
    return { repo, store, run, make: () => new Mirror(store, repo, () => {}, { version, run }) }
  }

  it('parses what is read, once, and keeps the result with the text', async () => {
    const { repo, store, run, make } = withDerive()
    repo.commit({ 1: 'a', 2: 'b' })
    const mirror = make()
    await mirror.sync()
    expect(run).toHaveBeenCalledTimes(2)
    expect([...store.records.values()].map((r) => [r.text, r.data, r.v]).sort()).toEqual([['a', { text: 'a' }, 1], ['b', { text: 'b' }, 1]])
    expect(derive.version).toBe(1)

    repo.commit({ 2: 'b2' })
    await mirror.sync()
    expect(run).toHaveBeenCalledTimes(3) // only the one that changed
    expect(mirror.records.get(pathOf(idOf(2)))?.data).toEqual({ text: 'b2' })
  })

  it('does not parse what is kept, after a reload and after a full comparison', async () => {
    const { repo, run, make } = withDerive()
    repo.commit({ 1: 'a', 2: 'b' })
    await make().sync()
    run.mockClear()
    const again = make()
    await again.open()
    await again.sync(true)
    expect(run).not.toHaveBeenCalled()
  })

  it('makes the data again, once, when the version of the parsing changed', async () => {
    const { repo, store, make, run } = withDerive(1)
    repo.commit({ 1: 'a', 2: 'b' })
    await make().sync()
    run.mockClear()

    const newer = new Mirror(store, repo, () => {}, { version: 2, run })
    await newer.open()
    expect(run).toHaveBeenCalledTimes(2)
    expect([...store.records.values()].every((r) => r.v === 2)).toBe(true) // kept in the store too
    run.mockClear()
    await newer.sync(true)
    expect(run).not.toHaveBeenCalled()
  })

  it('is not needed for a mirror that does not parse', async () => {
    const { repo, mirror } = setup()
    repo.commit({ 1: 'a' })
    await mirror.sync()
    expect([...mirror.records.values()][0].data).toBeUndefined()
  })
})

describe('comparing everything', () => {
  it('writes only the differences', async () => {
    const { repo, store, mirror } = setup()
    repo.commit({ 1: 'a', 2: 'b', 3: 'c' })
    await mirror.sync()
    const writes: string[][] = []
    const apply = store.apply.bind(store)
    store.apply = async (synced, put, remove) => {
      writes.push([...put.map((r) => `+${r.id.slice(-2)}`), ...remove.map((p) => `-${p.slice(-7, -5)}`)])
      return apply(synced, put, remove)
    }
    repo.files.set(pathOf(idOf(2)), 'b2')
    repo.files.delete(pathOf(idOf(3)))
    await mirror.sync(true)
    expect(writes.flat().sort()).toEqual(['+02', '-03'])
    expect(store.records.size).toBe(2)
  })
})

describe('progress', () => {
  it('tells how far reading and preparing are, and that it is over', async () => {
    const repo = new FakeRepo()
    const store = new MemoryStore()
    const texts = repo.texts.bind(repo)
    repo.texts = async (raw, objects, progress) => {
      const answer = await texts(raw, objects)
      answer.forEach((_, i) => progress?.(i + 1))
      return answer
    }
    const mirror = new Mirror(store, repo, () => {}, { version: 1, run: () => ({}) })
    const seen: (string | undefined)[] = []
    mirror.onProgress = (p) => seen.push(p && `${p.phase} ${p.done}/${p.total}`)
    repo.commit({ 1: 'a', 2: 'b', 3: 'c' })
    await mirror.sync()
    // Reports that come close together are thinned out, but the last of each phase is always there.
    expect(seen).toContain('reading 3/3')
    expect(seen.at(-1)).toBeUndefined()
    // A later, shorter reading (what changed) reports the preparing too; the first one only shows the reading (it is portions of 500).
    seen.length = 0
    repo.commit({ 4: 'd' })
    await mirror.sync()
    expect(seen).toContain('reading 1/1')
    expect(seen).toContain('preparing 1/1')
    expect(seen.indexOf('reading 1/1')).toBeLessThan(seen.indexOf('preparing 1/1'))
    expect(seen.at(-1)).toBeUndefined()
  })
})

describe('the snapshot', () => {
  const entryOfText = (n: number, text: string) => ({ path: pathOf(idOf(n)), id: idOf(n), sha: shaOf(text), text })

  it('gives the first copy; only what differs from the repository is read one by one', async () => {
    const { repo, store, mirror } = setup()
    repo.commit({ 1: 'a', 2: 'b', 3: 'c' })
    repo.snapshotOf = [entryOfText(1, 'a'), entryOfText(2, 'b-old'), entryOfText(9, 'gone')] // made a while ago
    await mirror.sync()
    expect(texts(mirror)).toEqual({ [idOf(1)]: 'a', [idOf(2)]: 'b', [idOf(3)]: 'c' })
    expect(repo.calls.texts).toEqual([[idOf(2), idOf(3)]]) // 1 is equal, 2 changed, 3 is new, 9 is removed
    expect(store.records.size).toBe(3)
    expect(store.synced).toBe(repo.head)
  })

  it('is not used when there is a copy already, and not asked for when there is none', async () => {
    const { repo, mirror } = setup()
    repo.commit({ 1: 'a' })
    repo.snapshotOf = [entryOfText(1, 'a')]
    const snapshot = vi.spyOn(repo, 'snapshot')
    await mirror.sync()
    await mirror.sync(true)
    expect(snapshot).toHaveBeenCalledTimes(1)
  })

  it('is left out when there is none, when it fails, or when it is empty: everything is read one by one', async () => {
    for (const prepare of [(r: FakeRepo) => (r.snapshotOf = undefined), (r: FakeRepo) => ((r.snapshotOf = []), undefined), (r: FakeRepo) => (r.snapshotFails = true)]) {
      const { repo, mirror } = setup()
      repo.commit({ 1: 'a', 2: 'b' })
      prepare(repo)
      await mirror.sync()
      expect(texts(mirror)).toEqual({ [idOf(1)]: 'a', [idOf(2)]: 'b' })
      expect(repo.calls.texts).toEqual([[idOf(1), idOf(2)]])
    }
  })

  it('reports the download', async () => {
    const { repo, mirror } = setup()
    repo.commit({ 1: 'a' })
    repo.snapshotOf = [entryOfText(1, 'a')]
    const seen: (string | undefined)[] = []
    mirror.onProgress = (p) => seen.push(p && `${p.phase} ${p.done}/${p.total}`)
    await mirror.sync()
    expect(seen).toContain('downloading 10/10')
  })
})

describe('an interrupted first reading', () => {
  it('keeps what was read and goes on from there', async () => {
    const { repo, store, mirror } = setup()
    const many = Object.fromEntries(Array.from({ length: 1200 }, (_, i) => [i + 1, `t${i + 1}`]))
    repo.commit(many)
    repo.failTextsAfter = 600 // the first portion (500) arrives, the second fails
    await expect(mirror.sync()).rejects.toThrow('connection lost')
    expect(store.records.size).toBe(500) // kept
    expect(store.synced).toBeUndefined() // but the copy does not claim to be complete

    // A new page load: the kept objects are there, and only the rest is read.
    repo.failTextsAfter = Infinity
    repo.calls.texts.length = 0
    const again = new Mirror(store, repo, () => {})
    expect(await again.open()).toBe(false) // not complete: nothing to show yet
    await again.sync()
    expect(again.records.size).toBe(1200)
    expect(repo.calls.texts.flat()).toHaveLength(700)
    expect(store.synced).toBe(repo.head)
  })
})
