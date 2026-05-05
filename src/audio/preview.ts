import { audioEngine } from './engine'
import { ensureAudioReady } from './midiInput'
import { useStore } from '../store'

/**
 * Editor-side audio plumbing.
 *
 * `previewNote` is **synchronous** and **drops requests when the sampler
 * isn't ready**. The earlier async-and-await version queued every
 * preview emitted while samples were downloading, so when the sampler
 * finally became ready every queued promise resolved at once and fired
 * a chord-burst — not just startling, but loud enough to be a
 * heart-attack-scale UX bug. Dropping silently means the user gets no
 * audible feedback during load, then full feedback once ready: a clean
 * boundary instead of a queued debt.
 *
 * `ensureSamplerLoaded` is the shared "kick off the sample download +
 * mirror the progress into `loadStatus`" helper. The first edit-mode
 * gesture calls it (so the user gets to a usable state without having
 * to click a piano key first) and `previewNote` calls it on every miss
 * — both are idempotent thanks to `audioEngine.init()`'s init dedupe.
 *
 * Both must be invoked from a user-gesture event handler so the
 * AudioContext can resume — Tone.start() inside ensureAudioReady
 * requires it.
 */

/**
 * Idempotent. Returns true once samples are ready; false on permission
 * denial / fetch failure. Safe to fire-and-forget — multiple concurrent
 * callers share the same underlying download via `audioEngine.init()`'s
 * promise dedupe.
 */
export async function ensureSamplerLoaded(): Promise<boolean> {
  if (audioEngine.isReady()) return true
  const store = useStore.getState()
  // Don't reset to 0% if a load is already in progress — that would
  // visually rewind the progress bar.
  if (store.loadStatus.state !== 'loading') {
    store.setLoadStatus({ state: 'loading', loaded: 0, total: 1 })
  }
  const ok = await ensureAudioReady((loaded, total) =>
    useStore.getState().setLoadStatus({ state: 'loading', loaded, total }),
  )
  useStore.getState().setLoadStatus(ok ? { state: 'ready' } : { state: 'idle' })
  return ok
}

export function previewNote(midi: number, velocity = 0.7, durationMs = 200): void {
  if (midi < 0 || midi > 127) return
  if (!audioEngine.isReady()) {
    // Kick off the load so the next preview can be heard, but drop this
    // attempt — see file header for the burst rationale.
    void ensureSamplerLoaded()
    return
  }
  audioEngine.triggerPreview(midi, velocity, durationMs)
}
