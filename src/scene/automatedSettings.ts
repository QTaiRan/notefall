/**
 * Per-frame resolved-settings store for timeline pins.
 *
 * Every animatable visual consumer reads its effective settings from
 * here instead of straight from the zustand `settings` slice. A single
 * high-frequency `useFrame` driver (mounted first inside the Canvas —
 * see `AutomatedSettingsDriver` in Scene.tsx) recomputes the resolved
 * snapshot once per frame via `resolveSettingsAt(base, base.settingsKeyframes,
 * audioEngine.currentSongTime())` and stashes it in module scope.
 *
 * `audioEngine.currentSongTime()` is the same clock-derived timeline-time
 * FallingNotes uses to place notes, so pin animation is automatically
 * consistent between the live preview and the offline video export (the
 * exporter swaps in a `VirtualClock` and steps the R3F loop — the driver
 * runs inside that loop like every other useFrame consumer).
 *
 * **Zero-pin invariant:** when `settingsKeyframes` is empty,
 * `resolveSettingsAt` returns `base` *by reference* (identity early-out),
 * and the driver stores that exact reference without allocating. Reading
 * `getResolvedSettings()` then yields the live zustand settings object
 * unchanged, so behaviour is bit-for-bit identical to before the feature
 * existed — no churn, no spurious uniform writes.
 */

import { useStore, type Settings } from '../store'
import { resolveSettingsAt } from '../midi/settingsKeyframes'
import { audioEngine } from '../audio/engine'

// Seed with the current base so a read before the first driver tick
// (e.g. a consumer's mount-time effect) still returns sane values.
let resolved: Settings = useStore.getState().settings

/**
 * Effective settings for the current frame, pin-resolved. With no pins
 * this is the live zustand `settings` object by reference.
 *
 * Read this inside `useFrame` / imperative paths for any key in the
 * `ANIMATABLE_*` registry. Non-animatable keys can still be read from
 * here too (the resolver copies them straight through), but the existing
 * `useSettingsSlice` subscription is preferred for React-driven props of
 * non-animatable keys so we don't widen re-render scope.
 */
export function getResolvedSettings(): Settings {
  return resolved
}

/**
 * Recompute the resolved snapshot for timeline-time `t`. Called once per
 * frame by the driver. Pins-empty fast path keeps `resolved` pinned to
 * the live base reference (no allocation, no churn).
 */
export function updateResolvedSettings(): void {
  const base = useStore.getState().settings
  resolved = resolveSettingsAt(base, base.settingsKeyframes, audioEngine.currentSongTime())
}
