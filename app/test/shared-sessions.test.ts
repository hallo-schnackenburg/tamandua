import { describe, expect, it, vi } from 'vitest'
import { FakeAgent } from '../src/agent.js'
import { FakeBackend, type RemoteErfassung } from '../src/backend.js'
import { FakeStore } from '../src/uploader.js'
import { Workspace } from '../src/workspace.svelte.js'

vi.mock('../src/db.js', () => ({
  save: async () => undefined,
  reset: async () => undefined,
  loadFiles: async () => [],
  loadObjects: async () => [],
  loadSessions: async () => [],
  loadChat: async () => [],
  loadUi: async () => undefined,
}))

const ID = '01JC8Z3Q7M5K2V9X4T6R1B0N8D'
const text = (title: string, note = '') => `id: ${ID}\ntype: document\ntitle: ${title}\n${note ? `note: ${note}\n` : ''}`

function setup() {
  const backend = new FakeBackend()
  const ws = new Workspace(new FakeStore(), new FakeAgent(), backend)
  ws.login = { state: 'user', user: { login: 'test', name: 'Test', avatar: '', role: 'write' } }
  // Anna's session on GitHub.
  backend.branches.set('annas-fund', new Map([[ID, text('Brief')]]))
  backend.owners.set('annas-fund', 'anna')
  return { backend, ws }
}
const annas = async (backend: FakeBackend): Promise<RemoteErfassung> => (await backend.erfassungen()).find((e) => e.slug === 'annas-fund')!

describe('sessions of somebody else', () => {
  it('are taken over like own ones, with the owner of the branch', async () => {
    const { backend, ws } = setup()
    const session = await ws.adopt(await annas(backend))
    expect(session?.owner).toBe('anna')
    expect(session?.id).toBe('anna/annas-fund')
    expect(ws.objects.map((o) => o.text)).toEqual([text('Brief')])
    expect(ws.objects[0].synced).toBe(text('Brief'))
    // the second time is the same session
    expect(await ws.adopt(await annas(backend))).toBe(session)
    expect(ws.sessions).toHaveLength(1)
  })

  it('are not taken over when they are accepted or closed', async () => {
    const { backend, ws } = setup()
    expect(await ws.adopt({ ...(await annas(backend)), state: 'merged' })).toBeUndefined()
    expect(await ws.adopt({ ...(await annas(backend)), closed: true })).toBeUndefined()
  })

  it('are saved to the branch of their owner', async () => {
    const { backend, ws } = setup()
    const session = (await ws.adopt(await annas(backend)))!
    ws.selectSession(session.id)
    ws.objects[0].text = text('Brief an Anna')
    await ws.sync()
    expect(backend.branches.get('annas-fund')?.get(ID)).toBe(text('Brief an Anna'))
    expect(ws.objects[0].synced).toBe(text('Brief an Anna'))
    expect(backend.owners.get('annas-fund')).toBe('anna')
  })

  it('take over what changed on the branch meanwhile, before saving', async () => {
    const { backend, ws } = setup()
    const session = (await ws.adopt(await annas(backend)))!
    ws.selectSession(session.id)
    backend.branches.get('annas-fund')!.set(ID, text('Brief', 'von Anna'))
    backend.heads.set('annas-fund', 5)
    ws.objects[0].text = text('Brief an Anna')
    await ws.sync()
    // both changes are in: my title and her note
    expect(backend.branches.get('annas-fund')?.get(ID)).toBe(text('Brief an Anna', 'von Anna'))
    expect(ws.objects[0].text).toBe(text('Brief an Anna', 'von Anna'))
    expect(ws.chat.some((m) => m.text.includes('zusammengeführt'))).toBe(true)
  })

  it('keep my value for a field that was changed differently, and say what the branch had', async () => {
    const { backend, ws } = setup()
    const session = (await ws.adopt(await annas(backend)))!
    ws.selectSession(session.id)
    backend.branches.get('annas-fund')!.set(ID, text('Annas Titel'))
    backend.heads.set('annas-fund', 5)
    ws.objects[0].text = text('Mein Titel')
    await ws.sync()
    expect(backend.branches.get('annas-fund')?.get(ID)).toBe(text('Mein Titel'))
    expect(ws.chat.some((m) => m.role === 'status' && m.text.includes('Annas Titel'))).toBe(true)
  })

  it('show a change from the branch at once when nothing was changed here', async () => {
    const { backend, ws } = setup()
    const session = (await ws.adopt(await annas(backend)))!
    ws.mergeRemote(session, [{ id: ID, status: 'added', text: text('Brief', 'neu') }])
    expect(ws.objects[0].text).toBe(text('Brief', 'neu'))
    expect(ws.unsaved).toHaveLength(0)
  })

  it('lose an object that was taken out on the branch, unless it was changed here', async () => {
    const { backend, ws } = setup()
    const session = (await ws.adopt(await annas(backend)))!
    ws.objects[0].text = text('Geändert')
    ws.mergeRemote(session, [{ id: ID, status: 'removed' }])
    expect(ws.objects).toHaveLength(1)
    expect(ws.objects[0].synced).toBeUndefined()
    ws.objects[0].synced = ws.objects[0].text
    ws.mergeRemote(session, [{ id: ID, status: 'removed' }])
    expect(ws.objects).toHaveLength(0)
  })

  it('do not become the place where new objects go', async () => {
    const { backend, ws } = setup()
    await ws.adopt(await annas(backend))
    ws.currentId = undefined
    ws.addObject()
    expect(ws.current?.owner).toBeUndefined()
  })

  it('follow what GitHub says: submitted by somebody else', async () => {
    const { backend, ws } = setup()
    const session = (await ws.adopt(await annas(backend)))!
    ws.align([{ ...(await annas(backend)), state: 'submitted' }])
    expect(session.state).toBe('submitted')
  })
})
