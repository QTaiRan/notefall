import type { RootState } from '@react-three/fiber'

/**
 * Bridge between the (live) R3F Canvas and the offline video exporter.
 *
 * The exporter needs imperative access to the running scene's
 * `gl` (renderer), `scene`, `camera`, `advance`, and `set` so it can:
 *   1. switch `frameloop` from "always" to "never" for the duration of
 *      the export pass (no real-time rendering during a render),
 *   2. resize the drawing buffer to the chosen export resolution
 *      (`gl.setSize(w, h, false)` — `false` keeps CSS unchanged so the
 *      visible canvas doesn't reflow), and
 *   3. step the scene one virtual frame at a time via `advance()`,
 *      which fires every `useFrame` subscriber (engine.tick(), particle
 *      integrators, hit-line shader uTime, etc.) AND triggers a render.
 *
 * The bridge stores a getter (not a snapshot) so callers always read
 * the current state — R3F's RootState mutates in place for things like
 * `frameloop`, and we don't want the exporter operating on stale data.
 *
 * `<R3FStateBridge />` is mounted inside the Canvas and registers /
 * unregisters with the module-scoped slot. There is at most one Canvas
 * in the app, so a single slot is sufficient.
 */

let activeStateGetter: (() => RootState) | null = null

export function registerR3FStateGetter(get: () => RootState): () => void {
  activeStateGetter = get
  return () => {
    if (activeStateGetter === get) activeStateGetter = null
  }
}

/**
 * Returns the live R3F state, or `null` if the Canvas hasn't mounted
 * yet. Always read just-in-time — callers should not cache the
 * returned object across frames or across the begin/end of an export
 * pass, since R3F mutates `frameloop` and other fields in place.
 */
export function getR3FState(): RootState | null {
  return activeStateGetter?.() ?? null
}
