import type { Recording } from './recorder'

/**
 * IndexedDB persistence layer for the recordings list. Stores each
 * recording as a row keyed by its id; events serialise via structured
 * cloning (the captured note/pedal objects are plain data so this works
 * out of the box).
 *
 * All methods swallow errors and degrade to no-op so a quota / private-
 * mode failure can't break the in-memory recorder. Callers don't need to
 * await the writes — fire-and-forget is fine for our purposes.
 */

const DB_NAME = 'notefall'
// Bump when the schema changes. Bumping forces `onupgradeneeded` to run
// on next open — useful for repairing a previously-broken DB (e.g. a
// pre-`recordings` store that older builds may have created).
const DB_VERSION = 2
const STORE = 'recordings'

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  if (typeof indexedDB === 'undefined') {
    dbPromise = Promise.reject(new Error('indexedDB unavailable'))
    return dbPromise
  }
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onerror = () => reject(req.error)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
  })
  return dbPromise
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  try {
    const db = await openDB()
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      let result: T | null = null
      const req = fn(tx.objectStore(STORE))
      req.onsuccess = () => {
        result = req.result as T
      }
      req.onerror = () => reject(req.error)
      // Resolve on tx.oncomplete (not req.onsuccess) so writes are
      // durable by the time the promise settles. Reads are unaffected
      // — they capture the result in onsuccess and replay it here.
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'))
    })
  } catch (e) {
    if (import.meta.env.DEV) {
      // Surface storage failures during development — silent degradation
      // is right for production but masks real bugs (DB blocked by
      // private mode, store missing, schema mismatch) during dev.
      // eslint-disable-next-line no-console
      console.warn('[recordingStore] IndexedDB op failed:', e)
    }
    return null
  }
}

export async function loadAllRecordings(): Promise<Recording[]> {
  const result = await withStore<Recording[]>('readonly', (store) => store.getAll())
  return result ?? []
}

export function saveRecording(rec: Recording): void {
  void withStore('readwrite', (store) => store.put(rec))
}

export function deleteRecordingFromDb(id: string): void {
  void withStore('readwrite', (store) => store.delete(id))
}

export function clearAllRecordingsFromDb(): void {
  void withStore('readwrite', (store) => store.clear())
}
