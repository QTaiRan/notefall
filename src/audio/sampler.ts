import {
  Smplr,
  Scheduler,
  type StopFn,
} from 'smplr'
import {
  applyVelocityCompensation,
  buildSalamanderDescriptor,
} from './salamanderDescriptor'
// Side-effect import: patches AudioParam.prototype.linearRampToValueAtTime
// so smplr's hardcoded linear release becomes an exponential decay.
// MUST be imported before any Smplr instance is created; placing it
// here (top of sampler.ts) guarantees that since createPiano is the
// only construction site.
import './smoothRelease'
import { createSampleStorage } from './sampleCache'
import * as Tone from 'tone'

/**
 * Salamander Grand Piano V3 sample base URL. `VITE_SAMPLES_BASE_URL`
 * overrides at build time (used for staging / preview deploys);
 * otherwise we go directly to the production R2-backed CDN. Trailing
 * slashes get stripped so `${base}/A0v1.ogg` always produces a clean
 * URL.
 *
 * In `npm run dev` we route through Vite's `/samples-cdn` proxy
 * (see `vite.config.ts`) — the R2 bucket's CORS allow-list is locked
 * to https://notefall.app, so a direct cross-origin fetch from
 * localhost would be blocked. Going through the proxy makes the
 * request same-origin and CORS-free.
 *
 * Cache Storage (see `sampleCache.ts`) absorbs the one-time ~77 MB
 * download — subsequent loads return from disk without touching the
 * network, so there's no UX cost to always hitting the CDN on first
 * play.
 */
const SAMPLES_BASE_URL =
  (import.meta.env.VITE_SAMPLES_BASE_URL as string | undefined)?.replace(
    /\/$/,
    '',
  ) ??
  (import.meta.env.DEV
    ? '/samples-cdn/salamander-v3-close'
    : 'https://samples.notefall.app/salamander-v3-close')

export type LoadProgress = { loaded: number; total: number }

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
  /**
   * Adjust how much of smplr's built-in quadratic velocity-to-gain
   * curve we cancel out via the per-layer group `volume`. See
   * `salamanderDescriptor.applyVelocityCompensation`. 0 = leave
   * smplr's default attenuation in place; 1 = neutralise it
   * entirely. Changes apply to subsequent voices only.
   */
  setVelocityCompensation(compensation: number): void
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
 * Salamander Grand Piano V3 (close-mic, ~77 MB OGG, 16 vel layers,
 * 30 sampled roots) via smplr. Same effect-chain wiring is shared
 * between the realtime engine and the offline export — see
 * `salamanderDescriptor.ts` for the descriptor and
 * `sampleCache.ts` for the Cache Storage persistence layer.
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

  // rAF-coalesced IR rebuild. Each impulse-response generator call walks
  // `sampleRate * irSize` samples with Math.random + Math.exp + Math.pow
  // per sample — ~5-15 ms on a 3 s reverb. Dragging any of the four
  // IR-affecting sliders (Size / Decay Time / Decay / Damping) at 60 fps
  // would otherwise rebuild the buffer every pointermove and saturate
  // the main thread. With this scheduler, multiple setter calls in the
  // same frame coalesce to a single rebuild on the next animation frame.
  let irRebuildPending = false
  const scheduleIrRebuild = () => {
    if (irRebuildPending) return
    irRebuildPending = true
    // requestAnimationFrame keeps the cadence aligned to the screen and
    // automatically yields to the rest of the frame's work; if rAF isn't
    // available (offline render context), fall back to a microtask so
    // the rebuild still happens but doesn't block the caller.
    const flush = () => {
      irRebuildPending = false
      convolver.buffer = createImpulseResponse(
        context,
        irSize,
        irDecayTime,
        irShape,
        irDamping,
      )
    }
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(flush)
    } else {
      queueMicrotask(flush)
    }
  }

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
  // Salamander samples are pro-recorded with a zero-amplitude head,
  // so the click-on-first-frame problem that older 4-layer piano
  // sets had doesn't apply here — we don't need a fade-in storage
  // wrapper.
  // Hold a reference to the descriptor so `setVelocityCompensation`
  // can mutate per-group `volume` later — smplr re-reads these on
  // every `piano.start()` (RegionMatcher stores `groupRef`).
  const descriptor = buildSalamanderDescriptor(SAMPLES_BASE_URL)
  const piano = new Smplr(
    context as AudioContext,
    descriptor,
    {
      destination: masterGain,
      storage: createSampleStorage(),
      velocity: 100,
      scheduler: options?.scheduler,
      onLoadProgress: (p) =>
        onProgress?.({ loaded: p.loaded, total: p.total }),
    },
  )
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
      scheduleIrRebuild()
    },
    setReverbDecayTime(seconds) {
      irDecayTime = Math.max(0.1, Math.min(10, seconds))
      scheduleIrRebuild()
    },
    setReverbDecay(decay) {
      irShape = Math.max(0, Math.min(8, decay))
      scheduleIrRebuild()
    },
    setReverbPreDelay(seconds) {
      const v = Math.max(0, Math.min(0.5, seconds))
      const now = context.currentTime
      preDelay.delayTime.cancelScheduledValues(now)
      preDelay.delayTime.setTargetAtTime(v, now, 0.02)
    },
    setReverbDamping(amount) {
      irDamping = Math.max(0, Math.min(0.99, amount))
      scheduleIrRebuild()
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
    setVelocityCompensation(compensation) {
      const c = Math.max(0, Math.min(1, compensation))
      applyVelocityCompensation(descriptor, c)
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
