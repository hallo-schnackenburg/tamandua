// Everything is kept in the browser (IndexedDB) so that a reload or a crash loses
// nothing: the files that were dropped (hash, name, preview, upload state) and the
// objects (YAML text). The original files themselves are not kept.

import type { ChatMessage, FileRecord, ObjectRecord } from './workspace.svelte.js'

const DB_NAME = 'tamandua'
const FILES = 'files'
const OBJECTS = 'objects'
const CHAT = 'chat' // one record, {id: 'log', messages: [...]}
const META = 'meta' // what the user was looking at, one record {id: 'ui', ...}

let opened: Promise<IDBDatabase> | undefined

function database(): Promise<IDBDatabase> {
  opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 4)
    request.onupgradeneeded = () => {
      const db = request.result
      if (db.objectStoreNames.contains('drafts')) db.deleteObjectStore('drafts') // version 1, dropped
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: 'sha256' })
      if (!db.objectStoreNames.contains(OBJECTS)) db.createObjectStore(OBJECTS, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(CHAT)) db.createObjectStore(CHAT, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' })
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
): Promise<void> {
  const db = await database()
  const transaction = db.transaction([FILES, OBJECTS, CHAT, META], 'readwrite')
  for (const file of files) transaction.objectStore(FILES).put(file)
  for (const object of objects) transaction.objectStore(OBJECTS).put(object)
  for (const id of removedObjects) transaction.objectStore(OBJECTS).delete(id)
  for (const sha of removedFiles) transaction.objectStore(FILES).delete(sha)
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
}

export async function loadUi(): Promise<UiState | undefined> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const request = db.transaction(META, 'readonly').objectStore(META).get('ui')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export const loadFiles = () => readAll<FileRecord>(FILES)
export const loadObjects = () => readAll<ObjectRecord>(OBJECTS)

export async function loadChat(): Promise<ChatMessage[]> {
  const records = await readAll<{ id: string; messages: ChatMessage[] }>(CHAT)
  return records.find((r) => r.id === 'log')?.messages ?? []
}
