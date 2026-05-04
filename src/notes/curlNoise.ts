// Curl-noise particle motion. Pipeline follows Robert Bridson's
// "Curl-Noise for Procedural Fluid Flow" (SIGGRAPH 2007):
//
//   ψ(p) = (Perlin(p + ox), Perlin(p + oy), Perlin(p + oz))
//   v(p) = curl(ψ) = (∂ψ_z/∂y - ∂ψ_y/∂z,
//                     ∂ψ_x/∂z - ∂ψ_z/∂x,
//                     ∂ψ_y/∂x - ∂ψ_x/∂y)
//
// curl(ψ) is divergence-free by construction, so the resulting flow has
// no sources or sinks — particles read as if carried by an actual fluid
// rather than draining into a sink. Octave summation (FBM) on top of the
// base curl gives the wisp / branching texture seen at moderate frequency.
//
// The Perlin sampler is Ken Perlin's improved noise (public domain
// reference: https://mrl.cs.princeton.edu/~ken/Perlin/Noise.cpp), with a
// deterministically-seeded permutation table so noise is reproducible
// across page reloads.

// 256-entry permutation table, doubled to 512 for the modular indexing
// trick. Initialised once at module load with a deterministic LCG-seeded
// Fisher-Yates shuffle so the noise pattern is the same on every load.
const PERM = new Uint8Array(512)
{
  const p = new Uint8Array(256)
  for (let i = 0; i < 256; i++) p[i] = i
  let state = 0x9E3779B1 >>> 0
  for (let i = 255; i > 0; i--) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    const j = state % (i + 1)
    const t = p[i]; p[i] = p[j]; p[j] = t
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255]
}

// 6t⁵ − 15t⁴ + 10t³ — Perlin's improved smoothstep, C² continuous.
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

function lerp(t: number, a: number, b: number): number {
  return a + t * (b - a)
}

// Perlin's "improved" gradient — 12 fixed gradients, hash-selected. Returns
// dot(grad, offset) directly without storing the gradient vector.
function grad(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15
  const u = h < 8 ? x : y
  const v = h < 4 ? y : (h === 12 || h === 14 ? x : z)
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v)
}

// Magnitude calibration applied to every Perlin sample. The 12-gradient
// improved-noise function has a nominal output range of roughly ±0.7 in
// practice; multiplying lifts the typical peak closer to ±1 so downstream
// consumers (the curl finite-difference, multi-octave summation, and the
// final velocity scaling) end up at a useful magnitude without the user
// having to dial Turbulence very high. √(8/3) is the textbook ratio
// connecting unit-edge gradient magnitudes to the cube diagonal — using
// it as the calibration keeps the math principled.
const NOISE_OUT_SCALE = Math.sqrt(8 / 3)

// Single 3D Perlin gradient noise sample. Output range roughly [-1.6, 1.6]
// after the calibration scale above.
function pnoise3(x: number, y: number, z: number): number {
  const X = Math.floor(x) & 255
  const Y = Math.floor(y) & 255
  const Z = Math.floor(z) & 255
  x -= Math.floor(x)
  y -= Math.floor(y)
  z -= Math.floor(z)
  const u = fade(x)
  const v = fade(y)
  const w = fade(z)

  const A  = PERM[X]     + Y
  const AA = PERM[A]     + Z
  const AB = PERM[A + 1] + Z
  const B  = PERM[X + 1] + Y
  const BA = PERM[B]     + Z
  const BB = PERM[B + 1] + Z

  const result = lerp(w,
    lerp(v,
      lerp(u, grad(PERM[AA],     x,     y,     z),
              grad(PERM[BA],     x - 1, y,     z)),
      lerp(u, grad(PERM[AB],     x,     y - 1, z),
              grad(PERM[BB],     x - 1, y - 1, z))),
    lerp(v,
      lerp(u, grad(PERM[AA + 1], x,     y,     z - 1),
              grad(PERM[BA + 1], x - 1, y,     z - 1)),
      lerp(u, grad(PERM[AB + 1], x,     y - 1, z - 1),
              grad(PERM[BB + 1], x - 1, y - 1, z - 1))))
  return result * NOISE_OUT_SCALE
}

// Vector-potential displacement bases — three independent 3D offsets so
// the three potential samples land in genuinely uncorrelated regions of
// the noise domain. Each offset must be a true 3-vector (not a scalar
// applied to all axes), otherwise the three components are just shifts
// of one another along the body diagonal and their curl produces
// systematic high-frequency wobble rather than smooth swirling. Specific
// values don't matter as long as the three vectors are far apart in the
// noise lattice.
const PSI_BASE_X: [number, number, number] = [203.1, 89.7, 311.4]
const PSI_BASE_Y: [number, number, number] = [47.3, 521.9, 167.2]
const PSI_BASE_Z: [number, number, number] = [389.6, 271.5, 83.8]

function psi(comp: 0 | 1 | 2, x: number, y: number, z: number): number {
  const b = comp === 0 ? PSI_BASE_X : comp === 1 ? PSI_BASE_Y : PSI_BASE_Z
  return pnoise3(x + b[0], y + b[1], z + b[2])
}

// Single-octave 3D curl noise via central finite differences on ψ. 12
// Perlin samples (4 per ψ component, axis-paired). The step is large
// enough to smooth over the discrete-gradient blockiness of improved
// noise but small enough to keep the curl spatially accurate.
const CURL_E = 0.08
const CURL_INV_2E = 1.0 / (2 * CURL_E)

function curl3Octave(x: number, y: number, z: number, out: [number, number, number]): void {
  const x_yp = psi(0, x, y + CURL_E, z)
  const x_ym = psi(0, x, y - CURL_E, z)
  const x_zp = psi(0, x, y, z + CURL_E)
  const x_zm = psi(0, x, y, z - CURL_E)

  const y_xp = psi(1, x + CURL_E, y, z)
  const y_xm = psi(1, x - CURL_E, y, z)
  const y_zp = psi(1, x, y, z + CURL_E)
  const y_zm = psi(1, x, y, z - CURL_E)

  const z_xp = psi(2, x + CURL_E, y, z)
  const z_xm = psi(2, x - CURL_E, y, z)
  const z_yp = psi(2, x, y + CURL_E, z)
  const z_ym = psi(2, x, y - CURL_E, z)

  out[0] = ((z_yp - z_ym) - (y_zp - y_zm)) * CURL_INV_2E
  out[1] = ((x_zp - x_zm) - (z_xp - z_xm)) * CURL_INV_2E
  out[2] = ((y_xp - y_xm) - (x_yp - x_ym)) * CURL_INV_2E
}

// Multi-octave fractional Brownian motion (FBM) over the curl noise.
// `octaveScale` is the lacunarity (frequency multiplier per octave),
// `octaveMultiplier` is the gain (amplitude multiplier per octave).
const _scratch: [number, number, number] = [0, 0, 0]
export function sampleCurl(
  x: number, y: number, z: number,
  octaves: number,
  octaveScale: number,
  octaveMultiplier: number,
  out: [number, number, number],
): void {
  let amp = 1
  let freq = 1
  out[0] = 0
  out[1] = 0
  out[2] = 0
  for (let i = 0; i < octaves; i++) {
    curl3Octave(x * freq, y * freq, z * freq, _scratch)
    out[0] += _scratch[0] * amp
    out[1] += _scratch[1] * amp
    out[2] += _scratch[2] * amp
    amp *= octaveMultiplier
    freq *= octaveScale
  }
}

// Deterministic per-position direction vector. Used by the optional
// outward-kick on emission so two particles spawned at the same XY get the
// same launch direction. Hash → uniform 24-bit → angle in [0, 2π) → unit
// vector (cos, sin).
export function dirFromXY(x: number, y: number, out: [number, number]): void {
  const buf = new ArrayBuffer(8)
  const f = new Float32Array(buf)
  const u = new Uint32Array(buf)
  f[0] = x * 127.1
  f[1] = y * 311.7
  let h = u[0] ^ (u[1] >>> 0)
  h = (Math.imul(h, 0x9E3779B1) ^ (h >>> 16)) >>> 0
  const seed24 = h & 0xFFFFFF
  const angle = (seed24 / 0xFFFFFF) * (Math.PI * 2)
  out[0] = Math.cos(angle)
  out[1] = Math.sin(angle)
}
