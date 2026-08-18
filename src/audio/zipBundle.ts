import { unzipSync } from 'fflate'
import type { Storage, StorageResponse } from 'smplr'
import { isSampleCacheAvailable, type StatusFilteredCacheStorage } from './sampleCache'

/**
 * Storage wrapper that fetches the WHOLE sample set as a single ZIP
 * bundle (see scripts/pack-samples.cjs) and serves individual samples
 * from the unpacked in-memory map. Turns ~480 network round-trips into
 * exactly one ~76 MB download, with byte-granular progress surfaced via
 * `onZipProgress`.
 *
 * The bundle is persisted through the same Cache Storage layer as the
 * per-file samples (`StatusFilteredCacheStorage`), so second loads hit
 * disk without touching the network.
 *
 * If the bundle fetch fails (missing file, network error, corrupt zip),
 * we degrade to the per-file storage — slower, but the piano still
 * works. smplr silently omits failed samples, so an unconditional
 * throw would otherwise leave the instrument half-silent.
 */
export type ZipProgress = { loaded: number; total: number }

export class ZipBundleStorage implements Storage {
  private bundlePromise: Promise<Map<string, Uint8Array> | null> | null = null

  constructor(
    private readonly zipUrl: string,
    private readonly perFile: StatusFilteredCacheStorage,
    private readonly onZipProgress?: (p: ZipProgress) => void,
  ) {}

  fetch(url: string): Promise<StorageResponse> {
    return this.bundle().then((map) => {
      if (map) {
        const name = url.slice(url.lastIndexOf('/') + 1)
        const data = map.get(name)
        if (data) {
          return {
            status: 200,
            arrayBuffer: () => Promise.resolve(data.slice().buffer as ArrayBuffer),
            json: () => Promise.reject(new Error('sample is not JSON')),
            text: () => Promise.reject(new Error('sample is not text')),
          }
        }
      }
      return this.perFile.fetch(url)
    })
  }

  /** Whether the zip bundle is (or will be) in use for this session. */
  private bundle(): Promise<Map<string, Uint8Array> | null> {
    if (!this.bundlePromise) {
      this.bundlePromise = this.loadBundle().catch((err) => {
        console.warn('[zipBundle] bundle load failed, falling back to per-file samples', err)
        return null
      })
    }
    return this.bundlePromise
  }

  private async loadBundle(): Promise<Map<string, Uint8Array>> {
    const request = new Request(this.zipUrl, { method: 'GET' })
    const cache = isSampleCacheAvailable() ? await caches.open('notefall-samples-v4').catch(() => null) : null

    let ab: ArrayBuffer
    let persist = false
    const hit = cache ? await cache.match(request).catch(() => undefined) : undefined
    if (hit && hit.status === 200) {
      ab = await hit.arrayBuffer()
    } else {
      const res = await fetch(request)
      if (!res.ok) throw new Error(`zip bundle HTTP ${res.status}: ${this.zipUrl}`)
      ab = await readWithProgress(res, this.onZipProgress)
      persist = !!cache
    }

    const unpacked = unzipSync(new Uint8Array(ab))
    if (persist && cache) {
      try {
        // Store a pristine Response (the arrayBuffer we already hold) so
        // `cache.match` can serve it on the next page load.
        await cache.put(request, new Response(ab, { status: 200, headers: { 'content-type': 'application/zip' } }))
      } catch {
        /* cache quota edge cases are non-fatal */
      }
    }
    return new Map(Object.entries(unpacked))
  }
}

async function readWithProgress(
  res: Response,
  onProgress?: (p: ZipProgress) => void,
): Promise<ArrayBuffer> {
  if (!res.body) return res.arrayBuffer()
  const total = Number(res.headers.get('content-length')) || 0
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      loaded += value.length
      onProgress?.({ loaded, total })
    }
  }
  const merged = new Uint8Array(loaded)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.length
  }
  return merged.buffer as ArrayBuffer
}
