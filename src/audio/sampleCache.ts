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

// v3: previous (v2) builds passed a synthetic Response to cache.put,
// which in some browsers landed without a usable body — cache.match
// then returned undefined and every page reload re-fetched. Bump on
// any code change to invalidate previous-build entries.
const CACHE_NAME = 'notefall-samples-v3'
const LEGACY_CACHE_NAMES = [
  'notefall-samples-v1',
  'notefall-samples-v2',
] as const

/** Whether Cache Storage is usable in this environment. */
export function isSampleCacheAvailable(): boolean {
  return typeof globalThis.caches !== 'undefined'
}

// One-time per-session diagnostic so the user can verify cache
// behaviour from the DevTools console. Logs the first hit + first
// miss only, to avoid 480 lines of spam.
let loggedHit = false
let loggedMiss = false

/**
 * Storage wrapper that caches successful (200) responses only.
 * 404 / 5xx / network failures fall through to the underlying
 * fetch on every call so a deferred file deployment becomes
 * playable as soon as it shows up, instead of being stuck behind
 * a cached failure forever.
 *
 * Uses `Request` + `Response.clone()` (same pattern as smplr's
 * built-in CacheStorage) — passing a synthesised `new Response(ab)`
 * to `cache.put` worked in Chrome but failed silently in some
 * other browsers, leaving the cache permanently empty.
 */
class StatusFilteredCacheStorage implements Storage {
  constructor(private readonly cacheName: string) {}

  async fetch(url: string): Promise<StorageResponse> {
    const cache = isSampleCacheAvailable()
      ? await caches.open(this.cacheName).catch(() => null)
      : null
    const request = new Request(url, { method: 'GET' })

    if (cache) {
      const hit = await cache.match(request).catch(() => undefined)
      if (hit && hit.status === 200) {
        if (!loggedHit) {
          loggedHit = true
          // eslint-disable-next-line no-console
          console.info(
            '[sampleCache] cache HIT (' + this.cacheName + ') — subsequent samples served from Cache Storage',
          )
        }
        return hit
      }
    }

    if (!loggedMiss && cache) {
      loggedMiss = true
      // eslint-disable-next-line no-console
      console.info(
        '[sampleCache] cache MISS (' + this.cacheName + ') — fetching from network and persisting',
      )
    }

    const fresh = await fetch(request)
    if (cache && fresh.status === 200) {
      try {
        // clone() gives us an independent Response stream to hand
        // to cache.put; the original `fresh` still has an intact
        // body that smplr will read via `arrayBuffer()`.
        await cache.put(request, fresh.clone())
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[sampleCache] cache.put failed for', url, err)
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
