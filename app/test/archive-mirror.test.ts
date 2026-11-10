import { describe, expect, it } from 'vitest'
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
    return objects.map((o) => ({ id: o.id, text: this.files.get(o.path) ?? '' }))
  }
}

class MemoryStore implements MirrorStore {
  synced: string | undefined
  records = new Map<string, MirrorRecord>()
  async load() {
    return { synced: this.synced, records: [...this.records.values()] }
  }
  async replace(synced: string, records: MirrorRecord[]) {
    this.synced = synced
    this.records = new Map(records.map((r) => [r.path, r]))
  }
  async apply(synced: string, put: MirrorRecord[], remove: string[]) {
    this.synced = synced
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
