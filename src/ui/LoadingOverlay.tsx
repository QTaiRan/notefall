import { useStore } from '../store'

/**
 * Centered overlay shown while the piano samples are loading.
 * `pointer-events-none` so it doesn't intercept key taps — the user can keep
 * interacting (the audio engine queues taps until the sampler is ready).
 */
export function LoadingOverlay() {
  const loadStatus = useStore((s) => s.loadStatus)
  if (loadStatus.state !== 'loading') return null
  const pct =
    loadStatus.total > 0 ? Math.min(100, (loadStatus.loaded / loadStatus.total) * 100) : 0

  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center">
      <div className="flex w-72 flex-col gap-3 rounded-lg border border-sky-500/40 bg-neutral-950/85 px-5 py-4 shadow-2xl backdrop-blur">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-neutral-100">
            Loading piano samples
          </span>
          <span className="font-mono text-xs tabular-nums text-sky-300">
            {Math.round(pct)}%
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
          <div
            className="h-full rounded-full bg-sky-500 transition-[width] duration-100 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="text-[11px] text-neutral-500">
          The first load fetches ~60MB of high-quality samples; subsequent sessions are cached.
        </div>
      </div>
    </div>
  )
}
