/**
 * Bundled demo projects. Drop `.nfz` files into `src/demos/` and they
 * appear in the Toolbar's "Demo Songs" menu automatically — Vite's
 * `import.meta.glob(?url)` resolves each file to a hashed asset URL at
 * build time, so demos ship as static assets alongside the app.
 *
 * Menu labels come from each project's manifest `name` (loaded
 * lazily — see `loadDemoManifestNames`). Until the manifest fetch
 * resolves, the filename (minus `.nfz`, underscores → spaces) is used
 * as a placeholder so the menu is functional offline / on slow
 * networks. Sort by filename so the order is deterministic and
 * editable (prefix files with `01-`, `02-`, …).
 */

import { strFromU8, unzipSync } from 'fflate'

const modules = import.meta.glob('./demos/*.nfz', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

export type DemoEntry = {
  /** Fallback label derived from the filename. Replaced once the
   *  manifest fetch resolves and reveals a real project name. */
  fallbackLabel: string
  url: string
}

function deriveFallback(path: string): string {
  const file = path.split('/').pop() ?? path
  const base = file.replace(/\.nfz$/i, '')
  return base.replace(/_/g, ' ')
}

export const DEMOS: DemoEntry[] = Object.entries(modules)
  .map(([path, url]) => ({ fallbackLabel: deriveFallback(path), url }))
  .sort((a, b) => a.fallbackLabel.localeCompare(b.fallbackLabel))

/**
 * Fetch and unzip just the `manifest.json` from each demo, returning
 * a `url → manifest.name` map. Failures (network, malformed zip,
 * missing/invalid manifest) drop silently — the caller falls back to
 * the filename label. Each demo is fetched in parallel; the whole
 * call resolves once every entry has settled.
 */
export async function loadDemoManifestNames(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  await Promise.all(
    DEMOS.map(async (demo) => {
      try {
        const res = await fetch(demo.url)
        if (!res.ok) return
        const buf = await res.arrayBuffer()
        const files = unzipSync(new Uint8Array(buf))
        const mf = files['manifest.json']
        if (!mf) return
        const parsed = JSON.parse(strFromU8(mf)) as { name?: unknown }
        if (typeof parsed.name === 'string' && parsed.name.length > 0) {
          out.set(demo.url, parsed.name)
        }
      } catch {
        // ignore — fallback label is used
      }
    }),
  )
  return out
}
