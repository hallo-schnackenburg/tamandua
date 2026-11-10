// A copy of the archive (the objects on main of the data repository) in the browser, kept equal to the
// repository: read completely once, then brought up to date by what changed since the commit it was
// last equal to. Plain TypeScript without the UI, so that it can be tested: the browser's storage and the
// Worker are handed in.

/** One object file as it is in the repository. */
export interface MirrorRecord {
  /** Where it is in the repository: objects/<xx>/<id>.yaml. The key. */
  path: string
  id: string
  /** The hash GitHub has for the file: equal hash, equal text. */
  sha: string
  text: string
}

export interface MirrorStore {
  /** What was kept: the commit the copy was equal to, and the records. */
  load(): Promise<{ synced?: string; records: MirrorRecord[] }>
  /** Replaces everything and sets the commit, in one step. */
  replace(synced: string, records: MirrorRecord[]): Promise<void>
  /** Writes and removes records and sets the commit, in one step. */
  apply(synced: string, put: MirrorRecord[], remove: string[]): Promise<void>
}

export interface TreeObject {
  id: string
  path: string
  sha: string
}

export interface Change extends TreeObject {
  status: 'added' | 'modified' | 'removed'
}

export interface MirrorBackend {
  /** All objects of main, with the hash of each. */
  tree(): Promise<{ head: string; raw: string; objects: TreeObject[] }>
  /** What changed on main since a commit; `reload` if that cannot be told. */
  changes(since: string): Promise<{ reload: true } | { head: string; raw: string; changes: Change[] }>
  /** The text of the objects at a commit. */
  texts(raw: string, objects: { id: string; path: string }[]): Promise<{ id: string; text: string }[]>
}

export class Mirror {
  /** The records by path. */
  records = new Map<string, MirrorRecord>()
  /** The commit of main the copy is equal to; none before the first reading. */
  synced: string | undefined
  #store: MirrorStore
  #backend: MirrorBackend
  #changed: () => void
  #running: Promise<void> | undefined
  #again = false
  #fullNext = false

  constructor(store: MirrorStore, backend: MirrorBackend, changed: () => void = () => {}) {
    this.#store = store
    this.#backend = backend
    this.#changed = changed
  }

  /** Takes what the browser kept. Returns whether there was anything. */
  async open(): Promise<boolean> {
    const kept = await this.#store.load()
    this.records = new Map(kept.records.map((r) => [r.path, r]))
    this.synced = kept.records.length > 0 || kept.synced ? kept.synced : undefined
    if (this.synced) this.#changed()
    return this.synced !== undefined
  }

  /**
   * Brings the copy up to date. Calls that come while it runs are not lost: one more round follows.
   * `full` compares the copy with everything on main and repairs it (for the first reading, and to be sure now and then).
   * Throws if the repository cannot be reached; the copy stays as it was.
   */
  sync(full = false): Promise<void> {
    if (full) this.#fullNext = true
    if (this.#running) {
      this.#again = true
      return this.#running
    }
    this.#running = (async () => {
      do {
        this.#again = false
        const all = this.#fullNext
        this.#fullNext = false
        await (all ? this.#full() : this.#once())
      } while (this.#again)
    })().finally(() => (this.#running = undefined))
    return this.#running
  }

  async #once(): Promise<void> {
    if (!this.synced) return this.#full()
    const answer = await this.#backend.changes(this.synced)
    if ('reload' in answer) return this.#full()
    if (answer.head === this.synced && answer.changes.length === 0) return

    const wanted = answer.changes.filter((c) => c.status !== 'removed')
    const texts = new Map((await this.#backend.texts(answer.raw, wanted)).map((t) => [t.id, t.text]))
    const put: MirrorRecord[] = []
    for (const change of wanted) {
      const text = texts.get(change.id)
      if (text === undefined) throw new Error(`Objekt ${change.id} fehlt in der Antwort.`)
      put.push({ path: change.path, id: change.id, sha: change.sha, text })
    }
    const remove = answer.changes.filter((c) => c.status === 'removed').map((c) => c.path)
    await this.#store.apply(answer.head, put, remove)

    for (const record of put) this.records.set(record.path, record)
    for (const path of remove) this.records.delete(path)
    this.synced = answer.head
    this.#changed()
  }

  /** Everything on main; what is equal here already (same hash) is not read again. */
  async #full(): Promise<void> {
    const tree = await this.#backend.tree()
    const need = tree.objects.filter((o) => this.records.get(o.path)?.sha !== o.sha)
    const texts = new Map((await this.#backend.texts(tree.raw, need)).map((t) => [t.id, t.text]))
    const records: MirrorRecord[] = []
    for (const object of tree.objects) {
      const kept = this.records.get(object.path)
      if (kept && kept.sha === object.sha) {
        records.push(kept)
        continue
      }
      const text = texts.get(object.id)
      if (text === undefined) throw new Error(`Objekt ${object.id} fehlt in der Antwort.`)
      records.push({ path: object.path, id: object.id, sha: object.sha, text })
    }
    await this.#store.replace(tree.head, records)
    this.records = new Map(records.map((r) => [r.path, r]))
    this.synced = tree.head
    this.#changed()
  }
}
