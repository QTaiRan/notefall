import { HttpStorage, type Storage, type StorageResponse } from 'smplr'

/**
 * Persistent on-disk sample cache backed by the Cache Storage API.
 *
 * smplr ships its own `CacheStorage` wrapper, but it caches *every*
 * response — including 404s and 5xx errors. If the user toggles
 * HQ Piano on before the sample files are deployed, the 404
 * responses get cached and persist after the files become
 * available, leaving specific samples permanently silent until the
 * user manually clears site data. We wrap our own layer that only
 * stores 200 responses so transient failures self-heal.
 *
 * Versioned cache name (`v2` and up) lets us invalidate on a code
 * deploy if we discover poisoned caches from older builds.
 *
 * Falls back to plain HttpStorage if Cache Storage isn't available
 * (e.g. third-party iframe, very old browser).
 */

// v2: superseded v1 to drop any 404s poisoned during pre-sample
// development. Bump again when the sample set changes server-side.
const CACHE_NAME = 'notefall-samples-v2'
const LEGACY_CACHE_NAMES = ['notefall-samples-v1'] as const

/** Whether Cache Storage is usable in this environment. */
export function isSampleCacheAvailable(): boolean {
  return typeof globalThis.caches !== 'undefined'
}

/**
 * Storage wrapper that caches successful (200) responses only.
 * 404 / 5xx / network failures fall through to the underlying
 * HttpStorage on every call so a deferred file deployment becomes
 * playable as soon as it shows up, instead of being stuck behind a
 * cached failure forever.
 */
class StatusFilteredCacheStorage implements Storage {
  constructor(private readonly cacheName: string) {}

  async fetch(url: string): Promise<StorageResponse> {
    const cache = isSampleCacheAvailable()
      ? await caches.open(this.cacheName).catch(() => null)
      : null
    if (cache) {
      const hit = await cache.match(url).catch(() => undefined)
      if (hit && hit.status === 200) {
        return hit
      }
    }
    const fresh = await HttpStorage.fetch(url)
    if (cache && fresh.status === 200) {
      try {
        // smplr's StorageResponse exposes only `arrayBuffer()` —
        // synthesise a Response we can `cache.put` cleanly. We
        // copy the bytes once; the second copy goes back to smplr.
        const ab = await fresh.arrayBuffer()
        await cache.put(url, new Response(ab.slice(0), { status: 200 }))
        return {
          status: 200,
          arrayBuffer: async () => ab.slice(0),
          json: () => Promise.reject(new Error('not json')),
          text: () => Promise.reject(new Error('not text')),
        }
      } catch {
        // Quota / opaque-response / private-mode failures fall
        // through — sample still plays, just no persistence this
        // session.
      }
    }
    return fresh
  }
}

/** Returns the Cache Storage-backed Storage for use with smplr's Smplr
 *  constructor, or the plain HttpStorage fallback. */
export function createSampleStorage(): Storage {
  if (!isSampleCacheAvailable()) return HttpStorage
  // Best-effort cleanup of older cache versions so they don't
  // silently consume disk forever. Fire-and-forget.
  void purgeLegacyCaches()
  return new StatusFilteredCacheStorage(CACHE_NAME)
}

async function purgeLegacyCaches(): Promise<void> {
  if (!isSampleCacheAvailable()) return
  for (const name of LEGACY_CACHE_NAMES) {
    try {
      await caches.delete(name)
    } catch {
      /* ignore */
    }
  }
}

/**
 * Returns true if `url` is already present in the cache. Cheap probe
 * used by the UI to decide whether the HQ-piano toggle should warn
 * about a fresh download. A single hit isn't proof the *whole* sample
 * set is cached — but it's a strong signal (the first sample is
 * fetched eagerly and the rest follow), and probing every URL would
 * cost real disk-read time.
 */
export async function isUrlCached(url: string): Promise<boolean> {
  if (!isSampleCacheAvailable()) return false
  try {
    const cache = await caches.open(CACHE_NAME)
    const hit = await cache.match(url)
    return hit !== undefined
  } catch {
    return false
  }
}

/**
 * Drop every cached sample. Used by a "Clear sample cache" action in
 * the settings UI when the user wants to reclaim disk space.
 */
export async function clearSampleCache(): Promise<void> {
  if (!isSampleCacheAvailable()) return
  for (const name of [CACHE_NAME, ...LEGACY_CACHE_NAMES]) {
    try {
      await caches.delete(name)
    } catch {
      // Most likely a quota / permission edge case — surfacing the
      // error to the user gives them nothing actionable, so swallow.
    }
  }
}

/** Re-export StorageResponse so callers don't need to import smplr directly. */
export type { StorageResponse }
