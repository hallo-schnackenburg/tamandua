// Everything is kept in the browser (IndexedDB) so that a reload or a crash loses
// nothing: the files that were dropped (hash, name, preview, upload state) and the
// objects (YAML text). The original files themselves are not kept.

import type { FileRecord, ObjectRecord } from './workspace.svelte.js'

const DB_NAME = 'stadtarchiv'
const FILES = 'files'
const OBJECTS = 'objects'

let opened: Promise<IDBDatabase> | undefined

function database(): Promise<IDBDatabase> {
  opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2)
    request.onupgradeneeded = () => {
      const db = request.result
      if (db.objectStoreNames.contains('drafts')) db.deleteObjectStore('drafts') // version 1, dropped
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: 'sha256' })
      if (!db.objectStoreNames.contains(OBJECTS)) db.createObjectStore(OBJECTS, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
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
export async function save(files: FileRecord[], objects: ObjectRecord[]): Promise<void> {
  const db = await database()
  const transaction = db.transaction([FILES, OBJECTS], 'readwrite')
  for (const file of files) transaction.objectStore(FILES).put(file)
  for (const object of objects) transaction.objectStore(OBJECTS).put(object)
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

export const loadFiles = () => readAll<FileRecord>(FILES)
export const loadObjects = () => readAll<ObjectRecord>(OBJECTS)
