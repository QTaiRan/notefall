import { gunzipSync } from 'fflate'
import type { Storage, StorageResponse } from 'smplr'
import { isSampleCacheAvailable, SAMPLE_CACHE_NAME } from './sampleCache'
import type { ZipProgress } from './zipBundle'

/**
 * Salamander V3 is published on npm as 16 @audio-samples/piano-velocity*
 * packages (30 keys × 16 layers split across 16 tarballs, one velocity
 * layer each). We fetch those tarballs from the Tencent npm mirror —
 * the ONLY source reachable at useful speed from mainland China with
 * `Access-Control-Allow-Origin: *` (measured ~2.5 MB/s vs ~30-150 KB/s
 * for github.io / jsDelivr / unpkg / Cloudflare). The whole set lands
 * in ~10-30 s instead of 40+ minutes.
 *
 * Each tarball is gzip(tar); fflate has no tar decoder, so we parse the
 * tar container ourselves (trivial 512-byte-block format — see
 * `parseTar`). Everything is unpacked into memory and served by name,
 * mirroring the ZIP-bundle storage. Cache Storage persists the raw
 * tarball responses, so second loads never touch the network.
 *
 * The app uses 8 of the 16 recorded layers (the even ones) — half the
 * download AND half the decode work, at no audible quality loss.
 *
 * If the mirror is unreachable we degrade to the ZIP bundle (github.io,
 * same-origin, slow) and then to per-file fetch — never silent.
 */
export const SALAMANDER_TARBALL_URLS: readonly string[] = Array.from(
  { length: 8 },
  (_, i) => {
    const layer = (i + 1) * 2
    return `https://mirrors.cloud.tencent.com/npm/@audio-samples/piano-velocity${layer}/-/piano-velocity${layer}-1.0.5.tgz`
  },
)

export class TarballBundleStorage implements Storage {
  private bundlePromise: Promise<Map<string, Uint8Array> | null> | null = null

  constructor(
    private readonly tarballUrls: readonly string[],
    private readonly zipFallback: Storage,
    private readonly onProgress?: (p: ZipProgress) => void,
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
      return this.zipFallback.fetch(url)
    })
  }

  private bundle(): Promise<Map<string, Uint8Array> | null> {
    if (!this.bundlePromise) {
      this.bundlePromise = this.loadAll().catch((err) => {
        console.warn('[tarballs] mirror load failed, falling back to ZIP bundle', err)
        return null
      })
    }
    return this.bundlePromise
  }

  private async loadAll(): Promise<Map<string, Uint8Array>> {
    const cache = isSampleCacheAvailable()
      ? await caches.open(SAMPLE_CACHE_NAME).catch(() => null)
      : null

    const requests = this.tarballUrls.map((url) => new Request(url, { method: 'GET' }))
    const cached = await Promise.all(
      requests.map((r) => (cache ? cache.match(r).catch(() => undefined) : undefined)),
    )

    // Aggregate byte-granular progress across the parallel downloads.
    const totals = cached.map((h) =>
      h && h.status === 200 ? Number(h.headers.get('content-length') || 0) : 0,
    )
    const loaded = new Array<number>(this.tarballUrls.length).fill(0)
    const totalBytes = totals.reduce((a, b) => a + b, 0)
    let lastReported = 0
    const report = () => {
      const sum = loaded.reduce((a, b) => a + b, 0)
      if (totalBytes > 0 && sum !== lastReported) {
        lastReported = sum
        this.onProgress?.({ loaded: sum, total: totalBytes })
      }
    }

    const map = new Map<string, Uint8Array>()
    const entries = await Promise.all(
      this.tarballUrls.map(async (url, i) => {
        const hit = cached[i]
        let ab: ArrayBuffer
        let persist = false
        if (hit && hit.status === 200) {
          ab = await hit.arrayBuffer()
        } else {
          const res = await fetch(requests[i])
          if (!res.ok) throw new Error(`tarball HTTP ${res.status}: ${url}`)
          ab = await readWithProgress(res, (p) => {
            loaded[i] = p.loaded
            report()
          })
          persist = !!cache
        }
        if (persist && cache) {
          try {
            await cache.put(
              requests[i],
              new Response(ab, { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
            )
          } catch {
            /* non-fatal */
          }
        }
        // tgz = gzip(tar); strip the gzip layer, then the tar container.
        const tar = gunzipSync(new Uint8Array(ab))
        return parseTar(tar)
      }),
    )

    for (const entry of entries) {
      for (const [name, data] of entry) {
        map.set(name, data)
      }
    }
    const oggCount = [...map.keys()].filter((k) => k.endsWith('.ogg')).length
    if (oggCount !== 240) {
      throw new Error(`expected 240 samples in tarballs, got ${oggCount}`)
    }
    report()
    return map
  }
}

/**
 * Minimal POSIX tar reader: 512-byte header blocks (name at 0..100,
 * octal size at 124..136, typeflag at 156), data padded to 512, empty
 * zero block terminates. Only regular files are returned; paths are
 * reduced to their basename (tarballs prefix with `package/audio/`).
 * npm tarballs use the upstream `D#` sharp naming, but `#` is a URL
 * fragment delimiter — the app storage keys on the `Ds` convention
 * (see salamanderDescriptor.ts), so sharps are normalised here.
 */
export function parseTar(tar: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  const decoder = new TextDecoder()
  let off = 0
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512)
    if (header.every((b) => b === 0)) break
    const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, '')
    if (!name) break
    const size = parseInt(decoder.decode(header.subarray(124, 136)).replace(/\0.*$/, '').trim(), 8) || 0
    const typeflag = header[156]
    const dataStart = off + 512
    if ((typeflag === 0 || typeflag === 0x30) && size > 0) {
      const base = name.slice(name.lastIndexOf('/') + 1)
      files.set(base.includes('#') ? base.replaceAll('#', 's') : base, tar.slice(dataStart, dataStart + size))
    }
    off = dataStart + Math.ceil(size / 512) * 512
  }
  return files
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
