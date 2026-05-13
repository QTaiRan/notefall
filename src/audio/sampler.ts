import {
  Smplr,
  HttpStorage,
  Scheduler,
  pianoToSmplrJson,
  audioBufferToWav,
  type SmplrJson,
  type StopFn,
  type Storage,
  type StorageResponse,
} from 'smplr'
import {
  buildSalamanderDescriptor,
  SALAMANDER_SAMPLE_COUNT,
} from './salamanderDescriptor'
import { createSampleStorage } from './sampleCache'

/**
 * Sample location for smplr's `SplendidGrandPiano` preset (Yamaha CFX,
 * 4 velocity layers + release noise). We construct the inner `Smplr`
 * directly rather than using the `SplendidGrandPiano` wrapper because
 * that wrapper drops the `scheduler` option when forwarding to the
 * inner Smplr — and offline rendering REQUIRES a custom Scheduler
 * (see `src/export/renderAudio.ts`). The base URL is replicated from
 * smplr's source (`SplendidGrandPiano` constructor's `BASE_URL`
 * default); kept here as a constant so both the realtime and offline
 * pipelines load identical samples.
 */
const SPLENDID_GRAND_PIANO_BASE_URL =
  'https://smpldsnds.github.io/sfzinstruments-splendid-grand-piano/samples'

/**
 * Salamander Grand Piano V3 sample base URL. Resolves in this order:
 *   1. `VITE_SAMPLES_BASE_URL` env (set at build time per environment)
 *   2. `/samples/salamander-v3-close` (dev convention — drop OGGs into
 *      `public/samples/salamander-v3-close/`)
 *
 * Override via env when shipping to R2 / a CDN; the dev fallback lets
 * the feature work locally without touching deployment config.
 */
const SALAMANDER_BASE_URL =
  (import.meta.env.VITE_SAMPLES_BASE_URL as string | undefined)?.replace(/\/$/, '') ??
  '/samples/salamander-v3-close'

/**
 * Sample-model identifier. Maps to a sampler-construction strategy in
 * `createPiano`. Persisted via `Settings.pianoModel` so a re-opened
 * project loads the same instrument.
 */
export type PianoModel = 'splendid' | 'salamander'

/** Estimated sample-file count per model — used by the UI for the
 *  initial-download progress bar denominator. */
export function expectedSampleCount(model: PianoModel): number {
  // SplendidGrandPiano publishes ~48 files (12 keys × 4 vel layers).
  // The exact denominator doesn't matter for UX — smplr reports the
  // real total once loading begins; this is just for early-init
  // sizing before the first onLoadProgress fires.
  if (model === 'salamander') return SALAMANDER_SAMPLE_COUNT
  return 48
}

import * as Tone from 'tone'

export type LoadProgress = { loaded: number; total: number }

/**
 * Wraps another Storage and applies a tiny linear fade-in to every audio
 * buffer it serves. smplr's Voice attaches no attack envelope (envelope.gain
 * is hard-coded to 1), so any non-zero first sample in the source file causes
 * an audible click. A 1.5ms fade is short enough to preserve the piano hammer
 * attack character while masking the discontinuity.
 */
export class FadeInStorage implements Storage {
  constructor(
    private readonly context: BaseAudioContext,
    private readonly fadeSeconds = 0.0015,
    private readonly base: Storage = HttpStorage,
  ) {}

  async fetch(url: string): Promise<StorageResponse> {
    const res = await this.base.fetch(url)
    if (res.status !== 200 || !/\.(ogg|m4a|mp3|wav|aac)(\?|$)/i.test(url)) {
      return res
    }
    const original = await res.arrayBuffer()
    try {
      const decoded = await this.context.decodeAudioData(original.slice(0))
      this.applyFadeIn(decoded)
      const wav = await audioBufferToWav(decoded).arrayBuffer()
      return wrapBuffer(wav, res.status)
    } catch {
      // Format the browser can't decode (e.g. ogg on Safari). Pass through;
      // smplr will fall back to the next format and call us again.
      return wrapBuffer(original, res.status)
    }
  }

  private applyFadeIn(buf: AudioBuffer): void {
    const fadeSamples = Math.floor(buf.sampleRate * this.fadeSeconds)
    if (fadeSamples <= 0) return
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const data = buf.getChannelData(ch)
      const n = Math.min(fadeSamples, data.length)
      for (let i = 0; i < n; i++) {
        data[i] *= i / n
      }
    }
  }
}

function wrapBuffer(buf: ArrayBuffer, status: number): StorageResponse {
  return {
    status,
    arrayBuffer: () => Promise.resolve(buf),
    json: () => Promise.reject(new Error('not json')),
    text: () => Promise.reject(new Error('not text')),
  }
}

export type PianoInstrument = {
  readonly context: BaseAudioContext
  /**
   * Schedule a note. `atAudioTime` is in the AudioContext clock; default = now.
   * `stopId` should be unique per voice so the returned StopFn only stops THIS
   * voice — smplr's default stopId is the midi number, which makes
   * back-to-back notes of the same pitch interfere with each other.
   */
  start(midi: number, velocity: number, atAudioTime?: number, stopId?: string): StopFn
  stopAll(): void
  /** Master output gain. Linear scale: 0 = silent, 1 = unity, >1 = boost. */
  setVolume(value: number): void
  /** Linear gain on the dry (un-reverbed) signal. 1 = unity, 0 = mute. */
  setReverbDry(level: number): void
  /** Linear gain on the reverb output (post-convolver). 1 = unity, 0 = mute. */
  setReverbWet(level: number): void
  /** IR buffer length (seconds). The maximum possible tail before silence. */
  setReverbSize(seconds: number): void
  /** RT60 — time (seconds) for the reverb to drop ~60 dB. Independent of
   * Size so the user can have a long buffer with a quick fade, etc. */
  setReverbDecayTime(seconds: number): void
  /** Power-curve exponent on the IR envelope, on top of the RT60 exponential.
   * Higher = quicker initial drop (tighter attack on the wash); 0 = pure
   * exponential decay. */
  setReverbDecay(decay: number): void
  /** Pre-delay before the wet signal hits the convolver, in seconds. Adds
   * apparent space between the dry attack and the reverb tail. */
  setReverbPreDelay(seconds: number): void
  /** Progressive HF absorption inside the IR, 0..1. 0 = no damping (uniform
   * spectrum across tail); higher = HF dies faster than LF as the tail
   * progresses (physical room behavior). Distinct from Hi Cut. */
  setReverbDamping(amount: number): void
  /** Static low-pass cutoff (Hz) on the wet path AFTER the convolver. Dulls
   * the whole reverb uniformly — different from Damping which is time-
   * varying inside the IR. */
  setReverbHiCut(hz: number): void
  /** High-pass cutoff (Hz) on the wet path. Keeps the reverb out of the
   * bass register so chords don't muddy. */
  setReverbLowCut(hz: number): void
  /**
   * Release/decay time applied when a held note is stopped. Maps to smplr's
   * `decayTime` start option. Smaller values = sharper cutoff; larger = the
   * note rings out longer. Affects all notes triggered after the call.
   */
  setReleaseTime(seconds: number): void
  /** Pitch detune in cents applied to subsequent notes. */
  setDetune(cents: number): void
  /** 6-band master EQ. Gain in dB (typically ±12). Bands are ordered
   * low → high; see EQ_BAND_FREQUENCIES for centers. */
  setEqBand(index: number, db: number): void
  dispose(): void
}

/** Band center frequencies in Hz, ordered low → high. */
export const EQ_BAND_FREQUENCIES = [80, 250, 800, 2500, 6000, 12000] as const

/**
 * Synthesise a stereo impulse response.
 *
 * Three knobs shape the tail:
 * - sizeSec: total IR buffer length — the maximum tail before silence
 * - decayTimeSec: RT60 — time for the amplitude to drop ~60 dB
 * - shape: power-curve exponent on top of the exponential — higher = quicker
 *   initial fall (tighter attack on the wash); 0 = pure exponential
 * - damping: 0..1, simulates progressive HF absorption by a "room". A one-
 *   pole LP feedback coefficient that grows from 0 at sample 0 to `damping`
 *   at the tail end, so early reflections stay bright and late tail darkens
 *   over time. This is what a physical reverb does (HF energy bounces off
 *   walls less efficiently than LF) — distinct from a static post-convolver
 *   low-pass (Hi Cut), which dulls the whole tail uniformly.
 */
export function createImpulseResponse(
  ctx: BaseAudioContext,
  sizeSec: number,
  decayTimeSec: number,
  shape: number,
  damping: number,
): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * sizeSec))
  const ir = ctx.createBuffer(2, length, ctx.sampleRate)
  // ln(1000) ≈ 6.908 → exp(-decayPerSample * RT60_samples) = 1/1000 ≡ -60 dB
  const decayPerSample = 6.908 / (decayTimeSec * ctx.sampleRate)
  const dampingMax = Math.max(0, Math.min(0.999, damping))
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch)
    let prev = 0
    for (let i = 0; i < length; i++) {
      const t = i / length
      const noise = Math.random() * 2 - 1
      // Time-varying one-pole LP — a grows with i so HF dies faster in the tail.
      const a = dampingMax * t
      prev = prev * a + noise * (1 - a)
      const env = Math.exp(-i * decayPerSample) * Math.pow(1 - t, shape)
      data[i] = prev * env
    }
  }
  return ir
}

/**
 * SplendidGrandPiano (Yamaha CFX) via smplr — has multiple velocity layers
 * (so the timbre changes with velocity, not just the volume) plus release
 * noise samples.
 */
export type CreatePianoOptions = {
  /**
   * Override smplr's note Scheduler. The default `Scheduler` polls a
   * `setInterval` to dispatch queued events whose time exceeds the
   * lookahead window (~100 ms by default) — dead in an
   * `OfflineAudioContext`, where `currentTime` jumps from 0 to the
   * buffer length over a single `startRendering()` call and the
   * interval never gets to fire. Pass a Scheduler with a very large
   * `lookaheadMs` (e.g. `Number.POSITIVE_INFINITY`) so EVERY scheduled
   * event satisfies the synchronous-dispatch branch of `schedule()`.
   * The realtime engine leaves this undefined and gets the default.
   */
  scheduler?: Scheduler
  /**
   * Sample-model selector. `'splendid'` keeps the legacy ~60 MB
   * SplendidGrandPiano set (4 vel layers). `'salamander'` loads the
   * Salamander Grand Piano V3 close-mic set (~77 MB OGG, 16 vel
   * layers, 30 sampled roots) — see `salamanderDescriptor.ts` for
   * the descriptor and `sampleCache.ts` for the persistence layer.
   */
  model?: PianoModel
}

export async function createPiano(
  context: BaseAudioContext = Tone.getContext().rawContext as AudioContext,
  onProgress?: (p: LoadProgress) => void,
  options?: CreatePianoOptions,
): Promise<PianoInstrument> {

  // Signal chain:
  //   piano -> masterGain -> eq[0..5] -> split:
  //     ├─ dryGain ─────────────────────────────────────────────────> destination
  //     └─ preDelay ─> lowCut(HP) ─> convolver ─> hiCut(LP) ─> wetGain ─> destination
  // Master volume sits before EQ + split so it scales everything equally.
  // EQ before reverb so the reverb tail inherits the user's tone shaping.
  // Dry and Wet are independent linear gains — no equal-power crossfade — so
  // the user can dial in absolute amounts of each. The wet chain shapes WHAT
  // goes into the reverb (pre-delay separates the dry attack from the tail;
  // HP keeps the bass clean), and Hi Cut tames the tail's brightness AFTER
  // convolution. True Damping is baked into the IR itself (HF dies faster
  // as the tail progresses).
  const masterGain = context.createGain()
  const dryGain = context.createGain()
  const wetGain = context.createGain()
  const preDelay = context.createDelay(1.0) // 1 s headroom — UI caps well below
  const lowCut = context.createBiquadFilter()
  lowCut.type = 'highpass'
  lowCut.frequency.value = 100
  lowCut.Q.value = 0.7
  const hiCut = context.createBiquadFilter()
  hiCut.type = 'lowpass'
  hiCut.frequency.value = 8000
  hiCut.Q.value = 0.7
  const convolver = context.createConvolver()
  let irSize = 2.0
  let irDecayTime = 2.0
  let irShape = 2.5
  let irDamping = 0.0
  convolver.buffer = createImpulseResponse(context, irSize, irDecayTime, irShape, irDamping)

  // 6-band graphic EQ. Endpoints use shelving filters (everything below 80 Hz
  // and above 12 kHz follows the slider), middle bands use peaking with Q=1
  // (~octave-wide bell, smooth crossover with neighbors).
  const eqFilters = EQ_BAND_FREQUENCIES.map((freq, i) => {
    const node = context.createBiquadFilter()
    node.frequency.value = freq
    if (i === 0) {
      node.type = 'lowshelf'
    } else if (i === EQ_BAND_FREQUENCIES.length - 1) {
      node.type = 'highshelf'
    } else {
      node.type = 'peaking'
      node.Q.value = 1
    }
    node.gain.value = 0
    return node
  })

  masterGain.gain.value = 1
  dryGain.gain.value = 1
  wetGain.gain.value = 0.5

  // Wire master → eq chain (in series) → split to dry/wet
  masterGain.connect(eqFilters[0])
  for (let i = 0; i < eqFilters.length - 1; i++) {
    eqFilters[i].connect(eqFilters[i + 1])
  }
  const lastEq = eqFilters[eqFilters.length - 1]
  lastEq.connect(dryGain)
  lastEq.connect(preDelay)
  dryGain.connect(context.destination)
  preDelay.connect(lowCut)
  lowCut.connect(convolver)
  convolver.connect(hiCut)
  hiCut.connect(wetGain)
  wetGain.connect(context.destination)

  // smplr's signature is typed against AudioContext, but it only calls
  // BaseAudioContext APIs (AudioBufferSourceNode, GainNode). The cast lets
  // us share createPiano between the realtime engine and the offline
  // exporter without duplicating the effect-chain wiring.
  //
  // Model-specific construction:
  // - 'splendid' uses smplr's bundled pianoToSmplrJson helper +
  //   FadeInStorage (the 4-vel-layer set has non-zero first samples
  //   that click without a tiny fade).
  // - 'salamander' uses our handwritten descriptor (16 vel layers, 30
  //   sampled roots) + persistent Cache Storage so a fresh user only
  //   waits for the ~500 MB download once, ever.
  const model: PianoModel = options?.model ?? 'splendid'
  let json: SmplrJson
  let storage: Storage
  if (model === 'salamander') {
    json = buildSalamanderDescriptor(SALAMANDER_BASE_URL)
    // No FadeInStorage — Salamander samples are pro-recorded with a
    // zero-amplitude head, so the click problem the splendid set has
    // doesn't apply. Skipping the decode→fade→re-encode round-trip
    // also saves ~500 MB of CPU on first load.
    storage = createSampleStorage()
  } else {
    json = pianoToSmplrJson({
      baseUrl: SPLENDID_GRAND_PIANO_BASE_URL,
      detune: 0,
      decayTime: 0.5,
    })
    storage = new FadeInStorage(context)
  }
  const piano = new Smplr(context as AudioContext, json, {
    destination: masterGain,
    storage,
    velocity: 100,
    scheduler: options?.scheduler,
    onLoadProgress: (p) => onProgress?.({ loaded: p.loaded, total: p.total }),
  })
  await piano.load

  // Per-voice options applied at start time. Held as closure variables and
  // mutated by setters so changes reach subsequent notes without rebuilding
  // the sampler.
  let releaseTime = 0.3
  let detuneCents = 0
  // Idempotency flag so dispose() is safe to call multiple times — Web
  // Audio's `node.disconnect()` throws `InvalidAccessError` if the node
  // already has no outgoing connections, which would surface here when a
  // caller tears down on both the abort path and the success path.
  let disposed = false

  return {
    context,
    start(midi, velocity, atAudioTime, stopId) {
      return piano.start({
        note: midi,
        velocity: Math.max(1, Math.min(127, Math.round(velocity * 127))),
        time: atAudioTime,
        stopId,
        // Per-note release. smplr's NoteEvent.ampRelease maps to the voice's
        // amplitude envelope release time (seconds).
        ampRelease: releaseTime,
        detune: detuneCents,
      })
    },
    stopAll() {
      piano.stop()
    },
    setVolume(value) {
      // Clamp to non-negative; >1 is allowed for boost (caller's choice).
      const target = Math.max(0, value)
      const now = context.currentTime
      masterGain.gain.cancelScheduledValues(now)
      masterGain.gain.setTargetAtTime(target, now, 0.01)
    },
    setReverbDry(level) {
      const v = Math.max(0, level)
      const now = context.currentTime
      dryGain.gain.cancelScheduledValues(now)
      dryGain.gain.setTargetAtTime(v, now, 0.02)
    },
    setReverbWet(level) {
      const v = Math.max(0, level)
      const now = context.currentTime
      wetGain.gain.cancelScheduledValues(now)
      wetGain.gain.setTargetAtTime(v, now, 0.02)
    },
    setReverbSize(seconds) {
      irSize = Math.max(0.1, Math.min(8, seconds))
      convolver.buffer = createImpulseResponse(context, irSize, irDecayTime, irShape, irDamping)
    },
    setReverbDecayTime(seconds) {
      irDecayTime = Math.max(0.1, Math.min(10, seconds))
      convolver.buffer = createImpulseResponse(context, irSize, irDecayTime, irShape, irDamping)
    },
    setReverbDecay(decay) {
      irShape = Math.max(0, Math.min(8, decay))
      convolver.buffer = createImpulseResponse(context, irSize, irDecayTime, irShape, irDamping)
    },
    setReverbPreDelay(seconds) {
      const v = Math.max(0, Math.min(0.5, seconds))
      const now = context.currentTime
      preDelay.delayTime.cancelScheduledValues(now)
      preDelay.delayTime.setTargetAtTime(v, now, 0.02)
    },
    setReverbDamping(amount) {
      irDamping = Math.max(0, Math.min(0.99, amount))
      convolver.buffer = createImpulseResponse(context, irSize, irDecayTime, irShape, irDamping)
    },
    setReverbHiCut(hz) {
      const v = Math.max(200, Math.min(20000, hz))
      const now = context.currentTime
      hiCut.frequency.cancelScheduledValues(now)
      hiCut.frequency.setTargetAtTime(v, now, 0.02)
    },
    setReverbLowCut(hz) {
      const v = Math.max(20, Math.min(2000, hz))
      const now = context.currentTime
      lowCut.frequency.cancelScheduledValues(now)
      lowCut.frequency.setTargetAtTime(v, now, 0.02)
    },
    setReleaseTime(seconds) {
      releaseTime = Math.max(0.01, Math.min(5, seconds))
    },
    setDetune(cents) {
      detuneCents = Math.max(-1200, Math.min(1200, cents))
    },
    setEqBand(index, db) {
      const node = eqFilters[index]
      if (!node) return
      const v = Math.max(-24, Math.min(24, db))
      const now = context.currentTime
      node.gain.cancelScheduledValues(now)
      // Short-time-constant ramp avoids clicks while still feeling immediate.
      node.gain.setTargetAtTime(v, now, 0.02)
    },
    dispose() {
      if (disposed) return
      disposed = true
      // Sever the entire effect chain so any still-pending offline
      // render pumps silence through (cheap) instead of continuing to
      // process the convolver + EQs (expensive). Without this, a
      // user-cancelled offline export keeps the OfflineAudioContext
      // burning CPU for tens of seconds after Cancel — `startRendering()`
      // has no abort API and the render only finishes when its full
      // buffer length elapses. Each `disconnect()` is wrapped because
      // the node may already have no outgoing edge in some teardown
      // orderings, which would otherwise throw InvalidAccessError.
      const safeDisconnect = (node: AudioNode) => {
        try {
          node.disconnect()
        } catch {
          /* already disconnected */
        }
      }
      try {
        piano.disconnect()
      } catch {
        /* ignore */
      }
      safeDisconnect(masterGain)
      for (const eq of eqFilters) safeDisconnect(eq)
      safeDisconnect(dryGain)
      safeDisconnect(preDelay)
      safeDisconnect(lowCut)
      safeDisconnect(convolver)
      safeDisconnect(hiCut)
      safeDisconnect(wetGain)
    },
  }
}
