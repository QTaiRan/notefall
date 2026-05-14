/**
 * User-editable velocity curve. Maps an incoming 0..1 velocity to a
 * 0..1 output. Replaces the older `velocityGamma` / `velocityFloor` /
 * `velocityCap` triple — one curve handles all three behaviours
 * (gamma = arching the middle, floor = lifting p0.y, cap = pulling
 * p4.y below 1).
 *
 * Shape:
 *   - Five control points (p0..p4), all draggable along Y.
 *   - p0.x is fixed at 0, p4.x is fixed at 1. p1.x / p2.x / p3.x are
 *     user-controlled within (p0.x, p4.x) and must stay in order.
 *   - Both axes are normalised 0..1 (display layer converts to 0..127
 *     MIDI).
 *   - Interpolation is monotone cubic Hermite (Fritsch-Carlson) so
 *     the curve stays non-decreasing — important because a
 *     decreasing velocity curve would feel broken (harder hit →
 *     quieter note).
 */

export type VelocityCurvePoint = { x: number; y: number }

export type VelocityCurve = {
  p0: VelocityCurvePoint
  p1: VelocityCurvePoint
  p2: VelocityCurvePoint
  p3: VelocityCurvePoint
  p4: VelocityCurvePoint
}

// Default in MIDI 0..127 space:
//   (0,0)  (32,20)  (64,50)  (96,105)  (127,127)
// Concave-up shape: soft hits stay soft, mid-range stays slightly
// pulled-down, the upper register accelerates into full power. Tuned
// for expressive playback on the Salamander sample set.
export const DEFAULT_VELOCITY_CURVE: VelocityCurve = {
  p0: { x: 0, y: 0 },
  p1: { x: 32 / 127, y: 20 / 127 },
  p2: { x: 64 / 127, y: 50 / 127 },
  p3: { x: 96 / 127, y: 105 / 127 },
  p4: { x: 1, y: 1 },
}

// Minimum X separation between adjacent control points. Without a gap
// the cubic-Hermite slopes blow up (division by zero) and the curve
// would clamp.
const MIN_DX = 0.02

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

/** Clamp a candidate curve so x-order and bounds are preserved. */
export function clampVelocityCurve(c: VelocityCurve): VelocityCurve {
  // Endpoints stay pinned to x=0 and x=1; only their Y is movable.
  // Interior points get clamped left-to-right so each leaves at least
  // MIN_DX for the points to its right.
  const p1x = Math.max(MIN_DX, Math.min(1 - 3 * MIN_DX, c.p1.x))
  const p2x = Math.max(p1x + MIN_DX, Math.min(1 - 2 * MIN_DX, c.p2.x))
  const p3x = Math.max(p2x + MIN_DX, Math.min(1 - MIN_DX, c.p3.x))
  return {
    p0: { x: 0, y: clamp01(c.p0.y) },
    p1: { x: p1x, y: clamp01(c.p1.y) },
    p2: { x: p2x, y: clamp01(c.p2.y) },
    p3: { x: p3x, y: clamp01(c.p3.y) },
    p4: { x: 1, y: clamp01(c.p4.y) },
  }
}

/**
 * Evaluate the curve at input x (0..1). Uses Fritsch-Carlson monotone
 * cubic Hermite through (0,0), p1, p2, (1,1).
 *
 * Returned y is clamped to [0, 1].
 */
export function evaluateVelocityCurve(curve: VelocityCurve, x: number): number {
  if (!Number.isFinite(x)) return 0
  const xs = [curve.p0.x, curve.p1.x, curve.p2.x, curve.p3.x, curve.p4.x]
  const ys = [curve.p0.y, curve.p1.y, curve.p2.y, curve.p3.y, curve.p4.y]
  const n = xs.length
  const segCount = n - 1

  // Fritsch-Carlson tangents. Compute secant slopes between points,
  // then derive tangents that preserve monotonicity by zeroing or
  // limiting them where neighbours disagree on direction.
  const d: number[] = new Array(segCount)
  for (let i = 0; i < segCount; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i])
  const m: number[] = new Array(n).fill(0)
  m[0] = d[0]
  m[n - 1] = d[segCount - 1]
  for (let i = 1; i < segCount; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0
    else m[i] = (d[i - 1] + d[i]) / 2
  }
  for (let i = 0; i < segCount; i++) {
    if (d[i] === 0) {
      m[i] = 0
      m[i + 1] = 0
      continue
    }
    const a = m[i] / d[i]
    const b = m[i + 1] / d[i]
    const h = a * a + b * b
    if (h > 9) {
      const t = 3 / Math.sqrt(h)
      m[i] = t * a * d[i]
      m[i + 1] = t * b * d[i]
    }
  }

  // Find the segment containing x and evaluate the Hermite basis.
  const clampedX = Math.max(0, Math.min(1, x))
  let i = 0
  for (let k = segCount - 1; k >= 0; k--) {
    if (clampedX >= xs[k]) { i = k; break }
  }
  const h = xs[i + 1] - xs[i]
  const t = (clampedX - xs[i]) / h
  const t2 = t * t
  const t3 = t2 * t
  const h00 = 2 * t3 - 3 * t2 + 1
  const h10 = t3 - 2 * t2 + t
  const h01 = -2 * t3 + 3 * t2
  const h11 = t3 - t2
  const y = h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1]
  return Math.max(0, Math.min(1, y))
}

/** Whether two curves are equivalent within numerical noise. */
export function velocityCurvesEqual(
  a: VelocityCurve,
  b: VelocityCurve,
  eps = 1e-6,
): boolean {
  const keys: (keyof VelocityCurve)[] = ['p0', 'p1', 'p2', 'p3', 'p4']
  for (const k of keys) {
    if (Math.abs(a[k].x - b[k].x) >= eps) return false
    if (Math.abs(a[k].y - b[k].y) >= eps) return false
  }
  return true
}
