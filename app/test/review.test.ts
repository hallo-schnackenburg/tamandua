import { describe, expect, it, vi } from 'vitest'
import type { Backend, Comment, RemoteErfassung, Review } from '../src/backend.js'
import { ArchiveDb, entryOf } from '../src/database.svelte.js'
import { ReviewDb, type ReviewCache } from '../src/review.svelte.js'

const GROUP = '01JC8Z3Q7M5K2V9X4T6R1B0N01'
const OLD = '01JC8Z3Q7M5K2V9X4T6R1B0N09'
const NEW = '01JC8Z3Q7M5K2V9X4T6R1B1N01'
const BAD = '01JC8Z3Q7M5K2V9X4T6R1B1N02'

const remote = (over: Partial<RemoteErfassung>): RemoteErfassung => ({ number: 1, url: 'u', state: 'submitted', closed: false, login: 'anna', slug: 's', name: 'Name', createdAt: '2026-11-08T10:00:00Z', head: 'h1', ...over })
const list = [
  remote({ number: 1, name: 'Eingereicht von Anna' }),
  remote({ number: 2, login: 'sven', name: 'Eingereicht von Sven' }),
  remote({ number: 3, state: 'open', name: 'Entwurf' }),
  remote({ number: 4, state: 'merged', name: 'Übernommen' }),
  remote({ number: 5, state: 'open', closed: true, name: 'Abgelehnt' }),
]
const valid = (id: string, title: string, parent?: string) =>
  `id: ${id}\ntype: document\nsubtype: letter\ntitle: ${title}\nstorage: external\nexternal:\n  - type: archive\n    site: Stadtarchiv X\n${parent ? `parents:\n  - ${parent}\n` : ''}`
const detail = (over: Partial<Review> = {}): Review => ({
  head: 'h1',
  pull: { number: 1, url: 'u', state: 'open', merged: false, draft: false },
  mergeable: true,
  checks: 'success',
  objects: [
    { id: OLD, status: 'removed' },
    { id: NEW, status: 'added', text: valid(NEW, 'Neuer Brief', GROUP) },
  ],
  ...over,
})

const comments: Comment[] = [
  { id: 1, kind: 'issue', login: 'anna', avatar: '', text: 'Bitte schaut mal.', createdAt: 't1', edited: false },
  { id: 2, kind: 'issue', login: 'sven', avatar: '', text: 'Das Datum stimmt.', createdAt: 't2', edited: false, object: NEW, field: 'date' },
  { id: 3, kind: 'review', login: 'bernd', avatar: '', text: 'Auf GitHub.', createdAt: 't2', edited: false, object: NEW },
]

function setup(over: Partial<Review> = {}, cache?: ReviewCache) {
  const archive = new ArchiveDb({} as never)
  const mk = (id: string, data: Record<string, unknown>) => entryOf({ path: '', id, sha: id, text: '', data: { id, ...data } })
  archive.entries = [mk(GROUP, { type: 'group', subtype: 'album', title: 'Album' }), mk(OLD, { type: 'document', title: 'Alter Brief', parents: [GROUP] })]
  archive.state = 'ready'
  const backend = {
    erfassungen: vi.fn(async () => list),
    review: vi.fn(async () => detail(over)),
    merge: vi.fn(async () => ({}) as never),
    reject: vi.fn(async () => ({}) as never),
    comments: vi.fn(async (): Promise<Comment[]> => comments),
    addComment: vi.fn(async (_n: number, text: string): Promise<Comment> => ({ id: 50, kind: 'issue', login: 'sven', avatar: '', text, createdAt: 't3', edited: false })),
    editComment: vi.fn(async (id: number, text: string): Promise<Comment> => ({ ...comments.find((c) => c.id === id)!, text, edited: true })),
    deleteComment: vi.fn(async () => undefined),
  }
  const review = new ReviewDb(backend as unknown as Backend, archive, () => 'sven', cache)
  return { review, backend, archive }
}

describe('ReviewDb', () => {
  it('sorts the sessions into those to review, drafts and finished ones (merged or closed)', async () => {
    const { review } = setup()
    await review.refresh()
    expect(review.waiting.map((e) => e.number)).toEqual([1, 2])
    expect(review.drafts.map((e) => e.number)).toEqual([3])
    expect(review.done.map((e) => e.number)).toEqual([4, 5])
  })

  it('shows what a session does with its objects, and the first object that stays', async () => {
    const { review } = setup()
    await review.refresh()
    await review.select(1)
    expect(review.items.map((i) => [i.entry.title, i.change])).toEqual([
      ['Alter Brief', 'removed'], // as the archive has it
      ['Neuer Brief', 'added'],
    ])
    expect(review.selectedId).toBe(NEW)
  })

  it('shows the groups of an object as they would be after accepting: the members come from the session and the archive', async () => {
    const { review } = setup()
    await review.select(1)
    expect(review.membersOf(GROUP).map((e) => e.id)).toEqual([NEW]) // the removed object is not a member any more
    expect(review.lookup(GROUP)?.title).toBe('Album')
  })

  it('can be accepted when everything is fine', async () => {
    const { review } = setup()
    await review.select(1)
    expect(review.problems.size).toBe(0)
    expect(review.blocked).toBeUndefined()
  })

  it.each<[Partial<Review>, RegExp]>([
    [{ checks: 'failure' }, /fehlgeschlagen/],
    [{ checks: 'pending' }, /läuft noch/],
    [{ mergeable: false }, /Konflikt/],
  ])('cannot be accepted when %j', async (over, why) => {
    const { review } = setup(over)
    await review.select(1)
    expect(review.blocked).toMatch(why)
  })

  it('cannot be accepted with an object that is not fit for the archive, and says which', async () => {
    const { review } = setup({ objects: [{ id: BAD, status: 'added', text: `id: ${BAD}\ntype: image\ntitle: Kaputt\n` }] })
    await review.select(1)
    expect(review.problems.get(BAD)?.[0]).toMatch(/Unvollständig/)
    expect(review.blocked).toMatch(/nicht in Ordnung/)
  })

  it('finds a group that does not exist', async () => {
    const { review } = setup({ objects: [{ id: NEW, status: 'added', text: valid(NEW, 'Waise', '01JC8Z3Q7M5K2V9X4T6R1B7N77') }] })
    await review.select(1)
    expect(review.problems.get(NEW)?.join(' ')).toMatch(/01JC8Z3Q7M5K2V9X4T6R1B7N77/)
  })

  it('accepts what was looked at (the commit), and brings the archive up to date', async () => {
    const { review, backend, archive } = setup()
    const refresh = vi.spyOn(archive, 'refresh').mockResolvedValue()
    await review.select(1)
    expect(await review.act('merge')).toBe(true)
    expect(backend.merge).toHaveBeenCalledWith(1, 'h1')
    expect(refresh).toHaveBeenCalled()
  })

  it('closes a session', async () => {
    const { review, backend } = setup()
    await review.select(1)
    expect(await review.act('close')).toBe(true)
    expect(backend.reject).toHaveBeenCalledWith(1)
  })

  it('tells why an action failed, and nothing is lost', async () => {
    const { review, backend } = setup()
    backend.merge.mockRejectedValueOnce(new Error('Head branch was modified.'))
    await review.select(1)
    expect(await review.act('merge')).toBe(false)
    expect(review.actionError).toBe('Head branch was modified.')
    expect(review.acting).toBeUndefined()
  })

  it('reads a session again when it changed on GitHub, and only then', async () => {
    const { review, backend } = setup()
    await review.refresh()
    await review.select(1)
    expect(backend.review).toHaveBeenCalledTimes(1)
    await review.refresh()
    expect(backend.review).toHaveBeenCalledTimes(1)
    list[0] = { ...list[0], head: 'h2' }
    await review.refresh()
    expect(backend.review).toHaveBeenCalledTimes(2)
    list[0] = { ...list[0], head: 'h1' }
  })

  it('asks only once at a time, and once more when news came meanwhile', async () => {
    const { review, backend } = setup()
    const first = review.refresh()
    void review.refresh() // news while it is asking
    void review.refresh()
    await first
    await new Promise((r) => setTimeout(r, 0))
    expect(backend.erfassungen).toHaveBeenCalledTimes(2)
  })

  it('takes the filter that shows a session that was named in the address', async () => {
    const { review } = setup()
    await review.refresh()
    await review.select(4)
    expect(review.filter).toBe('done')
  })

  describe('comments', () => {
    it('reads the comments with the session', async () => {
      const { review } = setup()
      await review.select(1)
      await vi.waitFor(() => expect(review.commentsState).toBe('ready'))
      expect(review.comments.map((c) => c.id)).toEqual([1, 2, 3])
    })

    it('knows which comments are the person\'s own and can be changed: not those from GitHub lines, not those of others', async () => {
      const { review } = setup()
      await review.select(1)
      await vi.waitFor(() => expect(review.commentsState).toBe('ready'))
      expect(review.comments.filter((c) => review.isOwnComment(c)).map((c) => c.id)).toEqual([2])
    })

    it('writes a comment and shows it at once', async () => {
      const { review, backend } = setup()
      await review.select(1)
      await vi.waitFor(() => expect(review.commentsState).toBe('ready'))
      expect(await review.comment('Ich prüfe es.')).toBe(true)
      expect(backend.addComment).toHaveBeenCalledWith(1, 'Ich prüfe es.')
      expect(review.comments.at(-1)).toMatchObject({ id: 50, text: 'Ich prüfe es.' })
    })

    it('does not show a comment twice when it also came in through the live connection', async () => {
      const { review, backend } = setup()
      await review.select(1)
      await vi.waitFor(() => expect(review.commentsState).toBe('ready'))
      backend.addComment.mockImplementationOnce(async () => {
        const made = { id: 50, kind: 'issue' as const, login: 'sven', avatar: '', text: 'x', createdAt: 't3', edited: false }
        review.comments = [...review.comments, made] // the news was faster
        return made
      })
      await review.comment('x')
      expect(review.comments.filter((c) => c.id === 50)).toHaveLength(1)
    })

    it('changes and removes a comment', async () => {
      const { review } = setup()
      await review.select(1)
      await vi.waitFor(() => expect(review.commentsState).toBe('ready'))
      await review.editComment(2, 'Doch nicht.')
      expect(review.comments.find((c) => c.id === 2)).toMatchObject({ text: 'Doch nicht.', edited: true })
      await review.deleteComment(2)
      expect(review.comments.map((c) => c.id)).toEqual([1, 3])
    })

    it('tells why a comment could not be written, and keeps what is there', async () => {
      const { review, backend } = setup()
      await review.select(1)
      await vi.waitFor(() => expect(review.commentsState).toBe('ready'))
      backend.addComment.mockRejectedValueOnce(new Error('Keine Verbindung.'))
      expect(await review.comment('x')).toBe(false)
      expect(review.commentError).toBe('Keine Verbindung.')
      expect(review.comments).toHaveLength(3)
    })

    it('keeps the comments on the screen when asking again fails', async () => {
      const { review, backend } = setup()
      await review.select(1)
      await vi.waitFor(() => expect(review.commentsState).toBe('ready'))
      backend.comments.mockRejectedValueOnce(new Error('offline'))
      await review.loadComments(1)
      expect(review.commentsState).toBe('ready')
      expect(review.comments).toHaveLength(3)
    })
  })

  describe('what the browser kept', () => {
    /** A cache in memory, like the browser's database. */
    const memory = (records: { id: string; value: unknown }[] = []) => {
      const store = new Map(records.map((r) => [r.id, r.value]))
      const cache: ReviewCache = {
        load: async () => [...store].map(([id, value]) => ({ id, value })),
        save: async (put, remove) => {
          for (const r of put) store.set(r.id, r.value)
          for (const id of remove) store.delete(id)
        },
      }
      return { store, cache }
    }

    it('writes down the list, the session and its comments as they are read', async () => {
      const { store, cache } = memory()
      const { review } = setup({}, cache)
      review.start()
      await vi.waitFor(() => expect(review.state).toBe('ready'))
      await review.select(1)
      await vi.waitFor(() => expect(review.commentsState).toBe('ready'))
      expect([...store.keys()].sort()).toEqual(['comments:1', 'detail:1', 'list'])
      review.stop()
    })

    it('shows the list, the session and the comments at once, before GitHub has answered', async () => {
      const first = memory()
      const a = setup({}, first.cache)
      a.review.start()
      await vi.waitFor(() => expect(a.review.state).toBe('ready'))
      await a.review.select(1)
      await vi.waitFor(() => expect(a.review.commentsState).toBe('ready'))
      a.review.stop()
      // A new start of the page: the network does not answer.
      const second = setup({}, memory([...first.store].map(([id, value]) => ({ id, value }))).cache)
      second.backend.erfassungen.mockImplementation(() => new Promise(() => undefined))
      second.backend.review.mockImplementation(() => new Promise(() => undefined))
      second.backend.comments.mockImplementation(() => new Promise(() => undefined))
      second.review.start()
      await vi.waitFor(() => expect(second.review.state).toBe('ready'))
      expect(second.review.list.map((e) => e.number)).toEqual([1, 2, 3, 4, 5])
      void second.review.select(1)
      await vi.waitFor(() => expect(second.review.detailState).toBe('ready'))
      expect(second.review.detailState).toBe('ready')
      expect(second.review.items.length).toBeGreaterThan(0)
      expect(second.review.comments.map((c) => c.id)).toEqual([1, 2, 3])
      second.review.stop()
    })

    it('keeps what it shows when GitHub cannot be reached, and forgets sessions that are gone', async () => {
      const { store, cache } = memory([
        { id: 'list', value: list },
        { id: 'detail:99', value: {} },
        { id: 'comments:99', value: [] },
      ])
      const { review, backend } = setup({}, cache)
      backend.review.mockRejectedValue(new Error('offline'))
      review.start()
      await vi.waitFor(() => expect(review.state).toBe('ready'))
      await vi.waitFor(() => expect(store.has('detail:99')).toBe(false))
      expect(store.has('comments:99')).toBe(false)
      review.stop()
    })

    it('writes a comment it made into what it kept', async () => {
      const { store, cache } = memory()
      const { review } = setup({}, cache)
      await review.select(1)
      await vi.waitFor(() => expect(review.commentsState).toBe('ready'))
      await review.comment('Neu.')
      expect((store.get('comments:1') as Comment[]).map((c) => c.text)).toContain('Neu.')
    })
  })
})
