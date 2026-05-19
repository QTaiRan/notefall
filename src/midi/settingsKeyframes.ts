/**
 * Timeline "pins" — snapshot keyframes for visual settings.
 *
 * The user drops a pin at a timeline-time; the pin captures the current
 * value of every *animatable* (continuous visual) setting. Between two
 * consecutive pins each animated key is interpolated, so the scene
 * morphs from one look to the next. Closer pins → steeper slope → a
 * faster visible change (an inherent property of time-parametric lerp).
 *
 * This mirrors the existing `midiSpeedAutomation` (`speedMap.ts`)
 * automation model — pins live INSIDE `Settings` as one key, so they
 * ride the normal persistence / dirty / undo / `.nfz` paths for free.
 * The difference is that a speed point carries one scalar while a pin
 * carries a whole settings snapshot.
 *
 * `time` is **timeline-time, seconds** (what the playhead / SeekBar
 * shows), NOT MIDI-time — the user thinks "at this point in the video".
 *
 * Resolution reads `audio/clock.ts`'s `now()`-derived playhead, so the
 * offline video exporter (which swaps in a `VirtualClock` and steps the
 * R3F loop) gets pin animation for free, exactly like every other
 * clock-driven visual effect.
 */

import * as THREE from 'three'
import type { Settings } from '../store'

export type SettingsKeyframe = {
  /** Timeline-time, seconds. ≥ 0. */
  time: number
  /**
   * Snapshot of the animatable settings at this pin. Only keys in
   * `ANIMATABLE_*` are stored; everything else is taken from the live
   * base settings at resolve time.
   */
  settings: Partial<Settings>
  /**
   * Curve shape from THIS pin to the NEXT one (last pin's value is
   * unused). 0 = linear, >0 ease-in, <0 ease-out. Mirrors
   * `SpeedPoint.curvature`.
   */
  curvature?: number
}

// ─── Animatable key registry ────────────────────────────────────────
//
// Explicitly enumerated (not derived) so we know *exactly* what a pin
// captures and interpolates. Discrete settings (enums / booleans),
// audio params, timeline-editor layout, and song-sync offsets are
// intentionally excluded — they can't be smoothly interpolated and
// aren't "visual continuous values". A new visual slider that should
// animate must be added to the matching list here.

export const ANIMATABLE_NUMBER_KEYS = [
  'keyboardY',
  'cameraFov',
  'fallDurationSec',
  'noteEmissive',
  'noteOpacity',
  'noteCornerRadius',
  'noteWidthScale',
  'noteMinLength',
  'noteTextureScale',
  // NOTE: `noteAnimSpeedX/Y` are deliberately NOT animatable. They are a
  // texture-flow RATE, not a state value, and keyframing a rate is
  // ill-posed: a pin-interpolated rate makes the visible speed lurch
  // (the resolver ramps the rate itself) — it caused both the "speed
  // explodes at the next pin" and the "speed decays to a standstill
  // over a couple of minutes" bugs. With them excluded the Inspector's
  // Animation Speed always reads/writes the single base value, so "1"
  // means a constant 1 everywhere regardless of pins. Texture POSITION
  // (the integrated phase in FallingNotes) is what carries over time;
  // the rate that drives it stays global.
  'noteTextureOffsetX',
  'noteTextureOffsetY',
  'noteTextureBlur',
  'noteTextureVariation',
  'noteTextureContrast',
  'noteEdgeWidth',
  'noteEdgeIntensity',
  'flashBrightness',
  'flashIntensity',
  'flashSize',
  'flashWidth',
  'flashHaloWidth',
  'particleSize',
  'particleOpacity',
  'particleBrightness',
  'particleLifetime',
  'particleSpeed',
  'particleCount',
  'particleTurbulence',
  'turbulenceFrequency',
  'flowSpeed',
  'turbulenceX',
  'turbulenceY',
  'turbulenceZ',
  'noiseLocality',
  'octaveScale',
  'octaveMultiplier',
  'drag',
  'swirl',
  'kick',
  'hitLineIntensity',
  'hitLineThickness',
  'hitLineWaveIntensity',
  'hitLineWaveAmplitude',
  'hitLineWaveScale',
  'hitLineWaveScrollSpeed',
  'hitLineWaveMorphSpeed',
  'hitLineWaveThickness',
  'hitLineWaveGrain',
  'hitLineBarY',
  'hitLineWaveY',
  'hitLineBarHalo',
  'hitLineWaveHalo',
  'bloomIntensity',
  'bloomThreshold',
  'bloomRadius',
  'bloomSmoothing',
  'keyboardBrightness',
  'keyGlowIntensity',
  'keyGlowDecay',
] as const satisfies readonly (keyof Settings)[]

export const ANIMATABLE_COLOR_KEYS = [
  'themeColor',
  'noteColor',
  'noteEdgeColor',
  'flashColor',
  'particleColor',
  'hitLineColor',
  'backgroundColor',
  'whiteKeyColor',
  'blackKeyColor',
  'woodColor',
  'keyGlowColor',
] as const satisfies readonly (keyof Settings)[]

/** Vec3 tuple keys — interpolated component-wise. */
export const ANIMATABLE_VEC3_KEYS = [
  'cameraPos',
  'cameraLookAt',
] as const satisfies readonly (keyof Settings)[]

/** `Record<string,string>` colour-map keys — interpolated per entry. */
const ANIMATABLE_COLORMAP_KEYS = ['trackColors'] as const satisfies readonly (keyof Settings)[]

/** Every key a pin snapshots. */
export const ANIMATABLE_KEYS: readonly (keyof Settings)[] = [
  ...ANIMATABLE_NUMBER_KEYS,
  ...ANIMATABLE_COLOR_KEYS,
  ...ANIMATABLE_VEC3_KEYS,
  ...ANIMATABLE_COLORMAP_KEYS,
]

const ANIMATABLE_SET: ReadonlySet<string> = new Set(
  ANIMATABLE_KEYS as readonly string[],
)

/**
 * Is this settings key one a pin snapshots / animates? Drives the
 * Inspector's "edit the selected pin vs. the base default" routing:
 * animatable keys go to the targeted pin's snapshot, everything else
 * (audio, etc.) always to base.
 */
export function isAnimatableKey(k: keyof Settings): boolean {
  return ANIMATABLE_SET.has(k as string)
}

/**
 * Extract just the animatable subset of a Settings object — the
 * snapshot stored in a freshly-dropped pin. Never includes
 * `settingsKeyframes` itself (it isn't in any ANIMATABLE list), so a
 * pin can't recursively embed the pin list.
 */
export function pickAnimatable(s: Settings): Partial<Settings> {
  const out: Record<string, unknown> = {}
  for (const k of ANIMATABLE_KEYS) out[k as string] = s[k]
  return out as Partial<Settings>
}

// ─── Easing (shared shape with speedMap's applyCurvature) ────────────

/**
 * Warp a normalised position `u ∈ [0,1]`. Boundaries exact.
 * `curvature > 0` → ease-in (slow start); `< 0` → ease-out (fast
 * start). Same exponent mapping as `speedMap.applyCurvature` so the
 * pin lane and the speed lane feel identical to drag.
 */
function applyCurvature(u: number, curvature: number): number {
  if (!curvature) return u
  if (curvature > 0) return Math.pow(u, 1 + curvature * 3)
  return 1 - Math.pow(1 - u, 1 + -curvature * 3)
}

// ─── Interpolation ──────────────────────────────────────────────────

// Module-scratch colours — the resolver runs every frame across many
// keys; allocating a THREE.Color per key per frame would churn the GC.
// Single-threaded JS makes shared scratch safe here.
const _ca = new THREE.Color()
const _cb = new THREE.Color()

function lerpNumber(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Interpolate two `#rrggbb` strings, returning `#rrggbb`. */
function lerpColor(a: string, b: string, t: number): string {
  // THREE.Color parses the same hex strings the renderer consumes, so
  // the interpolated value round-trips through exactly the path every
  // colour setting already takes.
  _ca.set(a)
  _cb.set(b)
  _ca.lerp(_cb, t)
  return '#' + _ca.getHexString()
}

function lerpVec3(
  a: readonly number[],
  b: readonly number[],
  t: number,
): [number, number, number] {
  return [
    lerpNumber(a[0] ?? 0, b[0] ?? 0, t),
    lerpNumber(a[1] ?? 0, b[1] ?? 0, t),
    lerpNumber(a[2] ?? 0, b[2] ?? 0, t),
  ]
}

function lerpColorMap(
  a: Record<string, string>,
  b: Record<string, string>,
  t: number,
): Record<string, string> {
  // Interpolate colours present in BOTH maps; keys only in one side
  // are held (no sensible "from"/"to" partner to morph against).
  const out: Record<string, string> = { ...a }
  for (const k of Object.keys(b)) {
    out[k] = k in a ? lerpColor(a[k], b[k], t) : b[k]
  }
  return out
}

function sortByTime(kfs: readonly SettingsKeyframe[]): SettingsKeyframe[] {
  // Stable sort by time; defensive non-negative clamp like buildSpeedMap.
  return [...kfs]
    .map((k) => ({ ...k, time: Math.max(0, k.time) }))
    .sort((x, y) => x.time - y.time)
}

/** Largest index `i` with `kfs[i].time <= t`, or -1 if `t` precedes all. */
function lowerIdx(kfs: readonly SettingsKeyframe[], t: number): number {
  if (kfs.length === 0 || t < kfs[0].time) return -1
  let lo = 0
  let hi = kfs.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (kfs[mid].time <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Effective settings at timeline-time `t`.
 *
 * - 0 pins → `base` unchanged (identity; behaviour is bit-for-bit the
 *   same as before the feature existed — the hot path early-returns).
 * - before the first / after the last pin → that endpoint's snapshot
 *   held constant (matches Logic / Ableton automation edges and the
 *   speed-automation convention).
 * - between two pins → per-key interpolation by type, eased by the
 *   left pin's `curvature`.
 *
 * Returns a NEW object only when pins exist; otherwise returns `base`
 * by reference so unchanged consumers don't see spurious churn.
 */
/**
 * Pick the `{ from, to, u }` blend for time `t`. `kfs` must be sorted.
 *
 * - **Before the first pin** → ramp from the editable BASE (the
 *   "default look", held separately from pins) into the first pin
 *   over `[0, firstPin.time]`. Base acts as an implicit anchor at
 *   t=0, so the region with no governing pin is driven by base —
 *   that's what makes Inspector tweaks there visible (with no pin
 *   targeted, edits land on base). If the first pin is at/≤0 there
 *   is no pre-region, just that pin.
 * - **After the last pin** → hold the last pin (automation tail
 *   convention; that region still has a governing/target pin).
 * - **Between two pins** → interpolate, eased by the left pin's
 *   `curvature`.
 */
function pickBlend(
  base: Settings,
  kfs: readonly SettingsKeyframe[],
  t: number,
): { from: Partial<Settings>; to: Partial<Settings>; u: number } {
  const last = kfs.length - 1
  const firstT = kfs[0].time
  if (t >= kfs[last].time) {
    return { from: kfs[last].settings, to: kfs[last].settings, u: 1 }
  }
  if (t <= firstT) {
    if (firstT > 0) {
      return { from: base, to: kfs[0].settings, u: Math.max(0, t) / firstT }
    }
    return { from: kfs[0].settings, to: kfs[0].settings, u: 0 }
  }
  const i = lowerIdx(kfs, t)
  const a = kfs[i]
  const b = kfs[i + 1]
  const span = b.time - a.time
  const raw = span > 0 ? (t - a.time) / span : 0
  return { from: a.settings, to: b.settings, u: applyCurvature(raw, a.curvature ?? 0) }
}

export function resolveSettingsAt(
  base: Settings,
  keyframes: readonly SettingsKeyframe[] | undefined,
  t: number,
): Settings {
  if (!keyframes || keyframes.length === 0) return base

  const kfs = sortByTime(keyframes)
  const { from, to, u } = pickBlend(base, kfs, t)

  const out = { ...base } as Record<string, unknown>

  for (const k of ANIMATABLE_NUMBER_KEYS) {
    const a = from[k] as number | undefined
    const b = to[k] as number | undefined
    if (a === undefined && b === undefined) continue
    const av = a ?? (base[k] as number)
    const bv = b ?? (base[k] as number)
    out[k] = lerpNumber(av, bv, u)
  }
  for (const k of ANIMATABLE_COLOR_KEYS) {
    const a = from[k] as string | undefined
    const b = to[k] as string | undefined
    if (a === undefined && b === undefined) continue
    const av = a ?? (base[k] as string)
    const bv = b ?? (base[k] as string)
    out[k] = lerpColor(av, bv, u)
  }
  for (const k of ANIMATABLE_VEC3_KEYS) {
    const a = from[k] as number[] | undefined
    const b = to[k] as number[] | undefined
    if (a === undefined && b === undefined) continue
    const av = a ?? (base[k] as number[])
    const bv = b ?? (base[k] as number[])
    out[k] = lerpVec3(av, bv, u)
  }
  for (const k of ANIMATABLE_COLORMAP_KEYS) {
    const a = from[k] as Record<string, string> | undefined
    const b = to[k] as Record<string, string> | undefined
    if (a === undefined && b === undefined) continue
    const av = a ?? (base[k] as Record<string, string>)
    const bv = b ?? (base[k] as Record<string, string>)
    out[k] = lerpColorMap(av, bv, u)
  }

  return out as Settings
}

/**
 * Cheap variant that interpolates ONLY the note tint (`noteColor` +
 * `trackColors`) at time `t`. The timeline MIDI overview tints every
 * note by its OWN time so the whole colour automation is visible as a
 * static gradient even while paused. Doing that with `resolveSettingsAt`
 * — which spreads the ~100-key `Settings` per call — would be needlessly
 * heavy across a thousand-note song; this touches just the two keys with
 * the identical segment-selection + easing logic. Equal endpoints short-
 * circuit the THREE.Color work so segments where only the camera (etc.)
 * animates cost almost nothing per note.
 */
export function resolveNoteTintAt(
  base: Settings,
  keyframes: readonly SettingsKeyframe[] | undefined,
  t: number,
): { noteColor: string; trackColors: Record<string, string> } {
  if (!keyframes || keyframes.length === 0) {
    return { noteColor: base.noteColor, trackColors: base.trackColors }
  }
  const kfs = sortByTime(keyframes)
  const { from, to, u } = pickBlend(base, kfs, t)
  const an = (from.noteColor as string | undefined) ?? base.noteColor
  const bn = (to.noteColor as string | undefined) ?? base.noteColor
  const at =
    (from.trackColors as Record<string, string> | undefined) ??
    base.trackColors
  const bt =
    (to.trackColors as Record<string, string> | undefined) ?? base.trackColors
  return {
    noteColor: an === bn ? an : lerpColor(an, bn, u),
    trackColors: at === bt ? at : lerpColorMap(at, bt, u),
  }
}
