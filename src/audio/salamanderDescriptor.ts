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
 * Velocity layers are evenly split across 1..127 for now — the SFZ
 * file's `amp_velcurve_N` curve isn't replicated here, so soft layers
 * may be louder than the original. Re-tune `ampVelCurve` later if
 * needed.
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

export function buildSalamanderDescriptor(baseUrl: string): SmplrJson {
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
