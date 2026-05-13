/**
 * Piecewise speed automation curve for MIDI playback. Each segment
 * between two breakpoints has an independent CURVATURE knob that
 * controls how the speed transitions:
 *
 *   curvature  0 → log-linear (straight line on the log-y lane axis)
 *   curvature  > 0 → ease-in: slow start, fast convergence to next value
 *   curvature  < 0 → ease-out: fast start, slow approach to next value
 *
 * Speed is interpolated on `log₂(c)`:
 *   c(τ) = c₁ · (c₂/c₁)^u′,  u′ = applyCurvature(u, curvature)
 *   u = (τ−τ₁)/(τ₂−τ₁)
 *
 * The integral `∫ dτ/c(τ)` has no closed form for general `u′(u)`, so
 * each segment carries a precomputed cumulative-timeline table of
 * `N+1` samples (uniform in `u`). Both forward (`midiToTimeline`) and
 * inverse (`timelineToMidi`) lookups walk this table — O(log N)
 * within a segment, O(log P) to find the segment, total O(log(P·N)).
 *
 * Convention with N breakpoints:
 *   - N = 0   → speed is 1 everywhere (no automation).
 *   - N ≥ 1   → speed before the first / after the last point is held
 *               constant at that endpoint's value (matches Logic /
 *               Ableton automation curves).
 *
 * Integral anchors at `τ = 0 → t = 0`, so a breakpoint placed before
 * any played note still shifts subsequent timing (its constant-speed
 * region from 0 to its time contributes `time/value` to t).
 */

export const MIN_SPEED = 0.05
export const MAX_SPEED = 8
export const MIN_CURVATURE = -1
export const MAX_CURVATURE = 1

/**
 * Sub-samples per segment for the numerical integral. 32 keeps the
 * cumulative-timeline error well under 1 ms for realistic speed
 * curves while staying cheap (~1 KB per segment).
 */
const SEGMENT_SAMPLES = 32

export type SpeedPoint = {
  /** MIDI-time, seconds. ≥ 0. */
  time: number
  /** Speed multiplier, clamped to [MIN_SPEED, MAX_SPEED]. */
  value: number
  /**
   * Curve shape from THIS point to the NEXT point. Stored per
   * starting-point so a 2-point automation can have one curvature
   * setting (the last point's `curvature` is unused). Defaults to 0
   * (linear on the log-y axis).
   */
  curvature?: number
}

type Segment = {
  /**
   * Cumulative timeline-time at `u = i / SEGMENT_SAMPLES` for
   * `i ∈ [0, SEGMENT_SAMPLES]`. First entry is 0, last is the full
   * segment's timeline duration.
   */
  cumTl: Float32Array
}

export type SpeedMap = {
  points: readonly SpeedPoint[]
  /** Cumulative timeline-time at each breakpoint (anchored τ=0 → t=0). */
  timelineAt: readonly number[]
  /** Sub-sample integration tables, one per segment `[i, i+1]`. */
  segments: readonly Segment[]
}

export const EMPTY_SPEED_MAP: SpeedMap = {
  points: [],
  timelineAt: [],
  segments: [],
}

/**
 * Apply the curvature warp to a normalised position `u ∈ [0, 1]`.
 * Boundaries are exact: `applyCurvature(0, *) = 0`,
 * `applyCurvature(1, *) = 1`.
 *
 * `curvature > 0` produces ease-IN (u^k, slow start). The
 * exponent `k = 1 + curvature·3` smoothly leaves linear at
 * curvature=0 and reaches a strong ease at curvature=1 (k=4).
 *
 * `curvature < 0` produces ease-OUT (`1 − (1−u)^k`, fast start)
 * with the same exponent magnitude.
 */
function applyCurvature(u: number, curvature: number): number {
  if (curvature === 0) return u
  if (curvature > 0) {
    const k = 1 + curvature * 3
    return Math.pow(u, k)
  }
  const k = 1 + -curvature * 3
  return 1 - Math.pow(1 - u, k)
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function clampSpeed(v: number): number {
  return clamp(v, MIN_SPEED, MAX_SPEED)
}

function clampCurvature(v: number): number {
  return clamp(v, MIN_CURVATURE, MAX_CURVATURE)
}

/**
 * Speed value within a segment at normalised position `u ∈ [0, 1]`.
 * Used both for the visual curve sampling and for the cumulative-
 * timeline integral builder.
 */
function speedInSegment(a: SpeedPoint, b: SpeedPoint, u: number): number {
  const curvature = a.curvature ?? 0
  const uPrime = applyCurvature(u, curvature)
  return a.value * Math.pow(b.value / a.value, uPrime)
}

/**
 * Numerically integrate `∫₀^Δτ dτ/c(τ)` for a segment, producing
 * `SEGMENT_SAMPLES + 1` cumulative samples (uniform in `u`). Uses the
 * trapezoid rule on `1/c(u)` per sub-interval — adequate at N=32 for
 * speed curves with `c ∈ [0.05, 8]` and any curvature in `[−1, 1]`
 * (verified by spot-checking against closed-form integrals at
 * curvature=0).
 */
function buildSegment(a: SpeedPoint, b: SpeedPoint): Segment {
  const N = SEGMENT_SAMPLES
  const cumTl = new Float32Array(N + 1)
  const dτ = b.time - a.time
  if (dτ <= 0) return { cumTl }
  const step = dτ / N
  let acc = 0
  let prevInv = 1 / speedInSegment(a, b, 0)
  cumTl[0] = 0
  for (let j = 1; j <= N; j++) {
    const u = j / N
    const inv = 1 / speedInSegment(a, b, u)
    acc += step * 0.5 * (prevInv + inv)
    cumTl[j] = acc
    prevInv = inv
  }
  return { cumTl }
}

/**
 * Build a SpeedMap from a list of breakpoints. Input doesn't need to
 * be sorted; duplicates at the same time collapse to the last one.
 * Speed and curvature are clamped to their respective ranges.
 */
export function buildSpeedMap(points: readonly SpeedPoint[]): SpeedMap {
  if (points.length === 0) return EMPTY_SPEED_MAP
  // Sort by time only (stable sort, so the input order is preserved
  // for equal-time entries — gives a deterministic "incoming" vs
  // "outgoing" duplicate). Equal-time duplicates are KEPT so users
  // can express an instantaneous speed jump as two stacked
  // breakpoints; the zero-duration segment between them passes
  // through with `dτ=0` (cumulative timeline doesn't advance) and
  // the canvas draws a vertical line between the two values.
  const sorted = [...points].sort((a, b) => a.time - b.time)
  const cleaned: SpeedPoint[] = sorted.map((p) => ({
    time: Math.max(0, p.time),
    value: clampSpeed(p.value),
    curvature: clampCurvature(p.curvature ?? 0),
  }))
  const timelineAt: number[] = new Array(cleaned.length)
  const segments: Segment[] = []
  // Region before the first point is constant at `points[0].value`,
  // so its timeline-time is `firstTime / firstValue`.
  timelineAt[0] = cleaned[0].time / cleaned[0].value
  for (let i = 0; i < cleaned.length - 1; i++) {
    const seg = buildSegment(cleaned[i], cleaned[i + 1])
    segments.push(seg)
    timelineAt[i + 1] = timelineAt[i] + seg.cumTl[SEGMENT_SAMPLES]
  }
  return { points: cleaned, timelineAt, segments }
}

/** Binary search: largest index `i` with `arr[i] <= target`. -1 if none. */
function lowerIdx(arr: ArrayLike<number>, target: number): number {
  const len = arr.length
  if (len === 0 || target < arr[0]) return -1
  let lo = 0
  let hi = len - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (arr[mid] <= target) lo = mid
    else hi = mid - 1
  }
  return lo
}

function lowerIdxByTime(map: SpeedMap, target: number): number {
  const pts = map.points
  if (pts.length === 0 || target < pts[0].time) return -1
  let lo = 0
  let hi = pts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (pts[mid].time <= target) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Map a MIDI-time to timeline-time. O(log P · log N). */
export function midiToTimeline(map: SpeedMap, midiTime: number): number {
  if (map.points.length === 0) return midiTime
  const pts = map.points
  if (midiTime <= pts[0].time) return midiTime / pts[0].value
  const lastIdx = pts.length - 1
  if (midiTime >= pts[lastIdx].time) {
    return (
      map.timelineAt[lastIdx] +
      (midiTime - pts[lastIdx].time) / pts[lastIdx].value
    )
  }
  const i = lowerIdxByTime(map, midiTime)
  const a = pts[i]
  const b = pts[i + 1]
  const seg = map.segments[i]
  const u = (midiTime - a.time) / (b.time - a.time)
  const idxF = u * SEGMENT_SAMPLES
  const lo = Math.min(SEGMENT_SAMPLES - 1, Math.floor(idxF))
  const frac = idxF - lo
  const withinSeg =
    seg.cumTl[lo] + frac * (seg.cumTl[lo + 1] - seg.cumTl[lo])
  return map.timelineAt[i] + withinSeg
}

/** Inverse map: timeline-time → MIDI-time. O(log P · log N). */
export function timelineToMidi(map: SpeedMap, timelineTime: number): number {
  if (map.points.length === 0) return timelineTime
  const pts = map.points
  if (timelineTime <= 0) return timelineTime * pts[0].value
  if (timelineTime <= map.timelineAt[0]) return timelineTime * pts[0].value
  const lastIdx = pts.length - 1
  if (timelineTime >= map.timelineAt[lastIdx]) {
    return (
      pts[lastIdx].time +
      (timelineTime - map.timelineAt[lastIdx]) * pts[lastIdx].value
    )
  }
  // Binary-search timelineAt to find segment.
  let lo = 0
  let hi = lastIdx
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (map.timelineAt[mid] <= timelineTime) lo = mid
    else hi = mid - 1
  }
  const a = pts[lo]
  const b = pts[lo + 1]
  const seg = map.segments[lo]
  const dt = timelineTime - map.timelineAt[lo]
  // Binary-search within cumTl for sub-position.
  const j = lowerIdx(seg.cumTl, dt)
  const jLo = Math.max(0, Math.min(SEGMENT_SAMPLES - 1, j))
  const span = seg.cumTl[jLo + 1] - seg.cumTl[jLo]
  const frac = span > 0 ? (dt - seg.cumTl[jLo]) / span : 0
  const u = (jLo + frac) / SEGMENT_SAMPLES
  return a.time + u * (b.time - a.time)
}

/** Speed value at a given MIDI-time. */
export function speedAt(map: SpeedMap, midiTime: number): number {
  if (map.points.length === 0) return 1
  const pts = map.points
  if (midiTime <= pts[0].time) return pts[0].value
  const lastIdx = pts.length - 1
  if (midiTime >= pts[lastIdx].time) return pts[lastIdx].value
  const i = lowerIdxByTime(map, midiTime)
  const a = pts[i]
  const b = pts[i + 1]
  const u = (midiTime - a.time) / (b.time - a.time)
  return speedInSegment(a, b, u)
}
