import type { SmplrGroup, SmplrJson, SmplrRegion } from 'smplr'

/**
 * Builds a `SmplrJson` descriptor for Salamander Grand Piano V3
 * (Alexander Holm, CC-BY 3.0), close-mic position only.
 *
 * The original release ships as SFZ + OGG samples; we encode the same
 * structure into smplr's region/group model so we can route it through
 * the same effect chain as SplendidGrandPiano. Sample naming follows
 * the upstream convention: `<note><sharp?>v<layer>.ogg` (e.g.
 * `A0v1.ogg`, `D#3v16.ogg`). The 30 sampled root keys are every minor
 * third from A0..C8; intermediate pitches are produced by smplr's
 * built-in pitch-shifting of the nearest sample.
 *
 * Sample-side prep (NOT done in this file):
 *   - `scripts/fetch-salamander.sh` — Docker pipeline that fetches
 *     the pre-encoded OGG release from archive.org, renames `#`→`s`,
 *     and drops the 480 files into a working directory.
 *   - `scripts/upload-r2.sh` — Docker rclone upload to the R2
 *     bucket bound to `samples.notefall.app`. Production fetches
 *     come from there; Cache Storage (see `sampleCache.ts`) makes
 *     the one-time ~77 MB download invisible on subsequent loads.
 *
 * Velocity compensation. smplr applies `(v/127)^2` gain to every
 * voice (see `midiVelToGain` in smplr/dist/index.js) AND uses the
 * same velocity to pick the velocity layer. Salamander's 16 layers
 * are already pre-recorded at velocity-appropriate dynamic levels —
 * the quadratic gain compounds on top, so soft layers come out far
 * too quiet. smplr ignores SFZ-style `ampVelCurve` at playback time,
 * so the only lever we have is per-group `volume` (dB). We add a
 * positive dB offset to each layer that cancels HALF of smplr's
 * quadratic attenuation at the layer's centre velocity (equivalent
 * to SFZ `amp_veltrack ≈ 50`). The recorded per-layer amplitudes
 * still provide natural piano dynamics on top of this.
 */

// 30 sampled root keys — every minor third from A0 (MIDI 21) to C8
// (MIDI 108). Naming matches Salamander V3's filename convention
// ("s" for sharp, e.g. `Ds1` = D♯1). URLs with `#` would be parsed
// as fragments by fetch, so the "s" convention is mandatory rather
// than cosmetic.
const SAMPLED_KEYS: ReadonlyArray<readonly [string, number]> = [
  ['A0', 21],
  ['C1', 24],
  ['Ds1', 27],
  ['Fs1', 30],
  ['A1', 33],
  ['C2', 36],
  ['Ds2', 39],
  ['Fs2', 42],
  ['A2', 45],
  ['C3', 48],
  ['Ds3', 51],
  ['Fs3', 54],
  ['A3', 57],
  ['C4', 60],
  ['Ds4', 63],
  ['Fs4', 66],
  ['A4', 69],
  ['C5', 72],
  ['Ds5', 75],
  ['Fs5', 78],
  ['A5', 81],
  ['C6', 84],
  ['Ds6', 87],
  ['Fs6', 90],
  ['A6', 93],
  ['C7', 96],
  ['Ds7', 99],
  ['Fs7', 102],
  ['A7', 105],
  ['C8', 108],
]

const VELOCITY_LAYERS = 16

/**
 * For each sampled root, compute the [low, high] MIDI range it covers
 * by splitting the gap to its neighbours roughly in half. Low end
 * extends to 21 (A0); high end extends to 108 (C8) so the topmost
 * sample owns any keys above it.
 */
function computeKeyRanges(): Array<{
  name: string
  midi: number
  range: [number, number]
}> {
  const sorted = [...SAMPLED_KEYS].sort((a, b) => a[1] - b[1])
  const out: Array<{ name: string; midi: number; range: [number, number] }> = []
  for (let i = 0; i < sorted.length; i++) {
    const [name, midi] = sorted[i]
    const prev = sorted[i - 1]?.[1] ?? 21
    const next = sorted[i + 1]?.[1] ?? 108
    const low = i === 0 ? 21 : Math.floor((prev + midi) / 2) + 1
    const high = i === sorted.length - 1 ? 108 : Math.floor((midi + next) / 2)
    out.push({ name, midi, range: [low, high] })
  }
  return out
}

/**
 * Default value used to seed a new piano build. Changes at runtime go
 * through `setGroupVolumeCompensation` which mutates the live
 * descriptor (smplr re-reads `group.volume` on every `start()`).
 */
export const DEFAULT_VELOCITY_COMPENSATION = 0.80

/**
 * dB compensation for layer N (1-indexed) at compensation level `c`.
 * The smplr playback path applies `(v/127)^2` gain at the layer's
 * centre velocity — we add `-c · 40·log10(vCenter/127)` dB on the
 * group to cancel `c` of that quadratic attenuation. `c = 0` leaves
 * smplr's default; `c = 1` fully neutralises velocity-driven gain so
 * only the recorded per-layer amplitudes contribute to dynamics.
 */
function computeLayerVolumeDb(layer: number, compensation: number): number {
  const vLow = Math.max(1, Math.round(((layer - 1) * 127) / VELOCITY_LAYERS) + 1)
  const vHigh = Math.round((layer * 127) / VELOCITY_LAYERS)
  const vCenter = (vLow + vHigh) / 2
  return -compensation * 40 * Math.log10(vCenter / 127)
}

export function buildSalamanderDescriptor(
  baseUrl: string,
  compensation: number = DEFAULT_VELOCITY_COMPENSATION,
): SmplrJson {
  const keyRanges = computeKeyRanges()
  const groups: SmplrGroup[] = []
  for (let layer = 1; layer <= VELOCITY_LAYERS; layer++) {
    // Evenly partition velocity 1..127 across the 16 layers.
    // smplr's velRange is inclusive at both ends.
    const vLow = Math.max(1, Math.round(((layer - 1) * 127) / VELOCITY_LAYERS) + 1)
    const vHigh = Math.round((layer * 127) / VELOCITY_LAYERS)
    // NOTE: use `pitch` + `keyRange`, NOT `key`. smplr's
    // processRegion collapses keyRange to `[key, key]` when `key` is
    // set, which would make the region match only the sampled root
    // and leave the in-between semitones silent. `pitch` tells smplr
    // what native pitch the buffer was recorded at so the pitch-
    // shift for keys inside `keyRange` is computed correctly.
    const regions: SmplrRegion[] = keyRanges.map((k) => ({
      sample: `${k.name}v${layer}`,
      pitch: k.midi,
      keyRange: k.range,
    }))
    groups.push({
      velRange: [vLow, vHigh],
      volume: computeLayerVolumeDb(layer, compensation),
      regions,
    })
  }
  return {
    meta: {
      name: 'Salamander Grand Piano V3 (close)',
      license: 'CC-BY 3.0',
      source: 'https://github.com/sgossner/Salamander-Grand-Piano',
    },
    samples: {
      baseUrl,
      formats: ['ogg'],
    },
    groups,
  }
}

/**
 * Mutate the per-group `volume` of an already-built descriptor.
 * smplr's `RegionMatcher` keeps each group by reference (`groupRef`),
 * and `Smplr.start()` calls `resolveParams` which re-reads
 * `group.volume` on every voice, so subsequent notes pick up the new
 * value without reloading samples or reconstructing the instrument.
 * Currently-sounding voices keep their previously-set gain.
 */
export function applyVelocityCompensation(
  descriptor: SmplrJson,
  compensation: number,
): void {
  for (let i = 0; i < descriptor.groups.length; i++) {
    descriptor.groups[i].volume = computeLayerVolumeDb(i + 1, compensation)
  }
}
