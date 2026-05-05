import type { FileRef } from './types'

/**
 * Recent-projects list. Persists `FileSystemFileHandle` references in
 * IndexedDB so the user can reopen a project with one click instead of
 * navigating the file picker each time. **FSA-only**: handles can't be
 * created on Safari / Firefox (no `showOpenFilePicker`), so on those
 * browsers `addRecent` silently no-ops and the list stays empty — the
 * Toolbar hides the section in that case.
 *
 * No project DATA lives here — only the handle (the OS-level pointer
 * to the file on disk). Losing this list is harmless: the project
 * files themselves are unaffected, the user just has to navigate to
 * them via Open the next time.
 *
 * Pattern mirrors `recorder.ts`: in-memory array + IndexedDB
 * write-through + listener channel for React's `useSyncExternalStore`.
 * Each mutation builds a NEW array so subscribers see a changed
 * reference and re-render.
 */

export type RecentEntry = {
  id: string
  name: string
  handle: FileSystemFileHandle
  lastOpenedAt: number
}

const DB_NAME = 'notefall-recents'
const DB_VERSION = 1
const STORE = 'handles'
const MAX_ENTRIES = 8

// ───────── IndexedDB plumbing (mirrors recordingStore.ts) ─────────

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
      const req = fn(tx.objectStore(STORE))
      req.onsuccess = () => resolve(req.result as T)
      req.onerror = () => reject(req.error)
    })
  } catch {
    return null
  }
}

async function loadAllFromDb(): Promise<RecentEntry[]> {
  const result = await withStore<RecentEntry[]>('readonly', (store) => store.getAll())
  return result ?? []
}

function writeOne(entry: RecentEntry): void {
  void withStore('readwrite', (store) => store.put(entry))
}

function deleteOne(id: string): void {
  void withStore('readwrite', (store) => store.delete(id))
}

function clearAllFromDb(): void {
  void withStore('readwrite', (store) => store.clear())
}

// ───────── In-memory cache + subscribe ─────────

let entries: RecentEntry[] = []
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((l) => l())
}

async function hydrate(): Promise<void> {
  const stored = await loadAllFromDb()
  if (stored.length === 0) return
  // Newest first; cap to MAX_ENTRIES so a stale DB doesn't bloat the menu.
  const sorted = stored.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
  entries = sorted.slice(0, MAX_ENTRIES)
  // Trim DB-side overflow so the disk view matches in-memory.
  for (const e of sorted.slice(MAX_ENTRIES)) deleteOne(e.id)
  notify()
}

// Hydrate on module import. Fire-and-forget — the list is usable
// immediately (empty until hydrate resolves).
void hydrate()

function freshId(): string {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// ───────── Public API ─────────

/**
 * Insert (or move-to-top) `ref` in the recent list. Updates
 * `lastOpenedAt`. Dedupes against existing handles via the FSA
 * `isSameEntry` API so opening the same file twice doesn't create
 * duplicate entries. No-op on browsers without FSA (`ref.handle === null`).
 */
export async function addRecent(ref: FileRef): Promise<void> {
  if (!ref.handle) return

  let existingIdx = -1
  for (let i = 0; i < entries.length; i++) {
    try {
      if (await entries[i].handle.isSameEntry(ref.handle)) {
        existingIdx = i
        break
      }
    } catch {
      // isSameEntry can throw if the prior handle has gone stale; treat
      // as "different" so a fresh entry is added and the stale one
      // ages out via MAX_ENTRIES trimming.
    }
  }

  const id = existingIdx >= 0 ? entries[existingIdx].id : freshId()
  const entry: RecentEntry = {
    id,
    name: ref.name,
    handle: ref.handle,
    lastOpenedAt: Date.now(),
  }

  // Immutable update so `useSyncExternalStore` subscribers see a fresh
  // array reference and re-render.
  const filtered = existingIdx >= 0 ? entries.filter((_, i) => i !== existingIdx) : entries
  const next = [entry, ...filtered]
  const overflow = next.slice(MAX_ENTRIES)
  entries = next.slice(0, MAX_ENTRIES)

  writeOne(entry)
  for (const o of overflow) deleteOne(o.id)
  notify()
}

export function removeRecent(id: string): void {
  const before = entries.length
  entries = entries.filter((e) => e.id !== id)
  if (entries.length === before) return
  deleteOne(id)
  notify()
}

export function clearAllRecent(): void {
  if (entries.length === 0) return
  entries = []
  clearAllFromDb()
  notify()
}

export function getRecent(): readonly RecentEntry[] {
  return entries
}

export function subscribeRecent(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
