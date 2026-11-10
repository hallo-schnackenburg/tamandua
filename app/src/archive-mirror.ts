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
  /** The text, parsed once when it was read (so that the browser does not have to parse it again and again). Derived, not part of the repository. */
  data?: Record<string, unknown>
  /** The version of the parsing that made `data`; a different one means it has to be made again. */
  v?: number
}

/** How `data` is made of the text. */
export interface Derive {
  version: number
  run(text: string): Record<string, unknown> | undefined
}

/** After this many milliseconds of work the browser gets a moment to do something else (20,000 objects take seconds to parse). */
const SLICE_MS = 30
const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

export interface MirrorStore {
  /** What was kept: the commit the copy was equal to, and the records. */
  load(): Promise<{ synced?: string; records: MirrorRecord[] }>
  /** Writes and removes records and sets the commit, in one step. Without a commit the one that was set stays as it is. */
  apply(synced: string | undefined, put: MirrorRecord[], remove: string[]): Promise<void>
}

export interface TreeObject {
  id: string
  path: string
  sha: string
}

export interface Change extends TreeObject {
  status: 'added' | 'modified' | 'removed'
}

/** How far a long reading is: the texts are read (`reading`), then made ready for use (`preparing`). */
export interface Progress {
  phase: 'downloading' | 'reading' | 'preparing'
  done: number
  total: number
}

/** The texts are read, and kept in the browser, in portions of this many objects: what is done stays if the reading is interrupted. */
const PORTION = 500

/** Progress is reported at most this often (a reading of 20,000 objects must not make 20,000 changes on the screen). */
const REPORT_MS = 100

export interface MirrorBackend {
  /** All objects in one download (the snapshot), if there is one. `progress` is told the bytes that arrived and the bytes there are (0 if unknown). Optional. */
  snapshot?(progress?: (bytes: number, total: number) => void): Promise<{ records: { path: string; id: string; sha: string; text: string }[] } | undefined>
  /** All objects of main, with the hash of each. */
  tree(): Promise<{ head: string; raw: string; objects: TreeObject[] }>
  /** What changed on main since a commit; `reload` if that cannot be told. */
  changes(since: string): Promise<{ reload: true } | { head: string; raw: string; changes: Change[] }>
  /** The text of the objects at a commit. `progress` is told how many are read so far. */
  texts(raw: string, objects: { id: string; path: string }[], progress?: (done: number) => void): Promise<{ id: string; text: string }[]>
}

export class Mirror {
  /** The records by path. */
  records = new Map<string, MirrorRecord>()
  /** The commit of main the copy is equal to; none before the first reading. */
  synced: string | undefined
  #store: MirrorStore
  #backend: MirrorBackend
  #changed: () => void
  #derive: Derive | undefined
  /** Told how far a long reading is, and `undefined` when it is over. */
  onProgress: (progress: Progress | undefined) => void = () => {}
  #reported = 0
  #running: Promise<void> | undefined
  #again = false
  #fullNext = false

  constructor(store: MirrorStore, backend: MirrorBackend, changed: () => void = () => {}, derive?: Derive) {
    this.#derive = derive
    this.#store = store
    this.#backend = backend
    this.#changed = changed
  }

  /** Takes what the browser kept. Returns whether there was anything. */
  async open(): Promise<boolean> {
    const kept = await this.#store.load()
    this.records = new Map(kept.records.map((r) => [r.path, r]))
    this.synced = kept.records.length > 0 || kept.synced ? kept.synced : undefined
    // What was kept with another version of the parsing (or without) is made again, once.
    const old = this.#derive ? kept.records.filter((r) => r.v !== this.#derive!.version) : []
    if (this.synced && old.length > 0) {
      const made = await this.#complete(old)
      await this.#store.apply(this.synced, made, [])
      for (const record of made) this.records.set(record.path, record)
      this.onProgress(undefined)
    }
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
    })().finally(() => {
      this.#running = undefined
      this.onProgress(undefined)
    })
    return this.#running
  }

  async #once(): Promise<void> {
    if (!this.synced) return this.#full()
    const answer = await this.#backend.changes(this.synced)
    if ('reload' in answer) return this.#full()
    if (answer.head === this.synced && answer.changes.length === 0) return

    const wanted = answer.changes.filter((c) => c.status !== 'removed')
    const texts = new Map((await this.#backend.texts(answer.raw, wanted, (done) => this.#report('reading', done, wanted.length))).map((t) => [t.id, t.text]))
    const read: MirrorRecord[] = []
    for (const change of wanted) {
      const text = texts.get(change.id)
      if (text === undefined) throw new Error(`Objekt ${change.id} fehlt in der Antwort.`)
      read.push({ path: change.path, id: change.id, sha: change.sha, text })
    }
    const put = await this.#complete(read)
    const remove = answer.changes.filter((c) => c.status === 'removed').map((c) => c.path)
    await this.#store.apply(answer.head, put, remove)

    for (const record of put) this.records.set(record.path, record)
    for (const path of remove) this.records.delete(path)
    this.synced = answer.head
    this.#changed()
  }

  /** Everything on main; what is equal here already (same hash) is not read again. */
  async #full(): Promise<void> {
    // Nothing yet: the snapshot gives the first copy in one download; what happened since is found by the comparison below.
    if (this.records.size === 0) await this.#seed()

    const tree = await this.#backend.tree()
    const need = tree.objects.filter((o) => this.records.get(o.path)?.sha !== o.sha)
    // The texts are read and written in portions: if this is interrupted, the next time starts where it stopped
    // (the hashes tell what is there already). The commit is only set at the end, so the copy never claims more than it has.
    for (let from = 0; from < need.length; from += PORTION) {
      const portion = need.slice(from, from + PORTION)
      const texts = new Map((await this.#backend.texts(tree.raw, portion, (done) => this.#report('reading', from + done, need.length))).map((t) => [t.id, t.text]))
      const read: MirrorRecord[] = []
      for (const object of portion) {
        const text = texts.get(object.id)
        if (text === undefined) throw new Error(`Objekt ${object.id} fehlt in der Antwort.`)
        read.push({ path: object.path, id: object.id, sha: object.sha, text })
      }
      const made = await this.#complete(read, false)
      await this.#store.apply(undefined, made, [])
      for (const record of made) this.records.set(record.path, record)
    }

    const inTree = new Set(tree.objects.map((o) => o.path))
    const remove = [...this.records.keys()].filter((path) => !inTree.has(path))
    await this.#store.apply(tree.head, [], remove)
    for (const path of remove) this.records.delete(path)
    this.synced = tree.head
    this.#changed()
  }

  /** The records of the snapshot, if there is a usable one. Without one nothing happens (the objects are read one by one then). */
  async #seed(): Promise<void> {
    let snapshot: Awaited<ReturnType<NonNullable<MirrorBackend['snapshot']>>>
    try {
      snapshot = await this.#backend.snapshot?.((done, total) => this.#report('downloading', done, total))
    } catch {
      return
    }
    if (!snapshot || snapshot.records.length === 0) return
    const made = await this.#complete(snapshot.records.map(({ path, id, sha, text }) => ({ path, id, sha, text })))
    await this.#store.apply(undefined, made, [])
    for (const record of made) this.records.set(record.path, record)
  }

  /** Gives the records their `data`, in slices so that the page stays usable while thousands are parsed. */
  async #complete(records: MirrorRecord[], show = true): Promise<MirrorRecord[]> {
    const derive = this.#derive
    if (!derive) return records
    const made: MirrorRecord[] = []
    let slice = performance.now()
    for (const record of records) {
      made.push({ ...record, data: derive.run(record.text), v: derive.version })
      if (show) this.#report('preparing', made.length, records.length)
      if (performance.now() - slice > SLICE_MS) {
        await breathe()
        slice = performance.now()
      }
    }
    return made
  }

  #report(phase: Progress['phase'], done: number, total: number): void {
    const now = performance.now()
    if (done < total && now - this.#reported < REPORT_MS) return
    this.#reported = now
    this.onProgress({ phase, done, total })
  }
}
