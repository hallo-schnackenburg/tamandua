// Everything is kept in the browser (IndexedDB) so that a reload or a crash loses
// nothing: the files that were dropped (hash, name, preview, upload state) and the
// objects (YAML text). The original files themselves are not kept.

import type { MirrorRecord } from './archive-mirror.js'
import type { ChatMessage, FileRecord, ObjectRecord, Session } from './workspace.svelte.js'

const DB_NAME = 'tamandua'
const FILES = 'files'
const OBJECTS = 'objects'
const CHAT = 'chat' // one record, {id: 'log', messages: [...]}
const SESSIONS = 'sessions'
const ARCHIVE = 'archive' // the copy of the archive: one record per object file, key: its path in the repository
const META = 'meta' // what the user was looking at, one record {id: 'ui', ...}

let opened: Promise<IDBDatabase> | undefined

function database(): Promise<IDBDatabase> {
  opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 6)
    request.onupgradeneeded = () => {
      const db = request.result
      if (db.objectStoreNames.contains('drafts')) db.deleteObjectStore('drafts') // version 1, dropped
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: 'sha256' })
      if (!db.objectStoreNames.contains(OBJECTS)) db.createObjectStore(OBJECTS, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(CHAT)) db.createObjectStore(CHAT, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(SESSIONS)) db.createObjectStore(SESSIONS, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(ARCHIVE)) db.createObjectStore(ARCHIVE, { keyPath: 'path' })
    }
    request.onsuccess = () => {
      const db = request.result
      // Another tab upgrades or someone deletes the database: let go of it, otherwise that waits for us forever.
      db.onversionchange = () => {
        db.close()
        opened = undefined
      }
      resolve(db)
    }
    request.onerror = () => reject(request.error)
  })
  return opened
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

/** Writes all given records in one transaction. Pass plain copies (`$state.snapshot`). */
export async function save(
  files: FileRecord[],
  objects: ObjectRecord[],
  chat?: ChatMessage[],
  removedObjects: string[] = [],
  ui?: UiState,
  removedFiles: string[] = [],
  sessions: Session[] = [],
  removedSessions: string[] = [],
): Promise<void> {
  const db = await database()
  const transaction = db.transaction([FILES, OBJECTS, CHAT, META, SESSIONS], 'readwrite')
  for (const file of files) transaction.objectStore(FILES).put(file)
  for (const object of objects) transaction.objectStore(OBJECTS).put(object)
  for (const id of removedObjects) transaction.objectStore(OBJECTS).delete(id)
  for (const sha of removedFiles) transaction.objectStore(FILES).delete(sha)
  for (const session of sessions) transaction.objectStore(SESSIONS).put(session)
  for (const id of removedSessions) transaction.objectStore(SESSIONS).delete(id)
  if (chat) transaction.objectStore(CHAT).put({ id: 'log', messages: chat })
  if (ui) transaction.objectStore(META).put({ id: 'ui', ...ui })
  await done(transaction)
}

function readAll<T>(store: string): Promise<T[]> {
  return database().then(
    (db) =>
      new Promise((resolve, reject) => {
        const request = db.transaction(store, 'readonly').objectStore(store).getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      }),
  )
}

/** Deletes everything stored in the browser. For development. */
export async function reset(): Promise<void> {
  const db = await database()
  db.close()
  opened = undefined
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => resolve() // closed above; other tabs close on their own
  })
}

/** What the user was looking at: restored after a reload. */
export interface UiState {
  /** SHA-256 of the files that were selected. */
  selection: string[]
  /** SHA-256 of the file whose object was open. */
  active?: string
  /** The object that was open if it has no file (it lives elsewhere). */
  object?: string
  /** The session that was open. */
  session?: string
}

export async function loadUi(): Promise<UiState | undefined> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const request = db.transaction(META, 'readonly').objectStore(META).get('ui')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** The copy of the archive: what was kept, and the commit of main it is equal to (recorded in the same step as the records). */
export async function loadArchive(): Promise<{ synced?: string; records: MirrorRecord[] }> {
  const records = await readAll<MirrorRecord>(ARCHIVE)
  const db = await database()
  const meta = await new Promise<{ synced?: string } | undefined>((resolve, reject) => {
    const request = db.transaction(META, 'readonly').objectStore(META).get('archive')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return { synced: meta?.synced, records }
}

/** Writes and removes records of the archive's copy and sets its commit, all or nothing. */
export async function saveArchive(synced: string | undefined, put: MirrorRecord[], remove: string[]): Promise<void> {
  const db = await database()
  const transaction = db.transaction([ARCHIVE, META], 'readwrite')
  const store = transaction.objectStore(ARCHIVE)
  for (const path of remove) store.delete(path)
  for (const record of put) store.put({ ...record })
  if (synced) transaction.objectStore(META).put({ id: 'archive', synced })
  await done(transaction)
}

export const loadFiles = () => readAll<FileRecord>(FILES)
export const loadSessions = () => readAll<Session>(SESSIONS)
export const loadObjects = () => readAll<ObjectRecord>(OBJECTS)

export async function loadChat(): Promise<ChatMessage[]> {
  const records = await readAll<{ id: string; messages: ChatMessage[] }>(CHAT)
  return records.find((r) => r.id === 'log')?.messages ?? []
}
