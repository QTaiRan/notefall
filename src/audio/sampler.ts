import {
  SplendidGrandPiano,
  HttpStorage,
  audioBufferToWav,
  type StopFn,
  type Storage,
  type StorageResponse,
} from 'smplr'
import * as Tone from 'tone'

export type LoadProgress = { loaded: number; total: number }

/**
 * Wraps another Storage and applies a tiny linear fade-in to every audio
 * buffer it serves. smplr's Voice attaches no attack envelope (envelope.gain
 * is hard-coded to 1), so any non-zero first sample in the source file causes
 * an audible click. A 1.5ms fade is short enough to preserve the piano hammer
 * attack character while masking the discontinuity.
 */
class FadeInStorage implements Storage {
  constructor(
    private readonly context: AudioContext,
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
  readonly context: AudioContext
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
  /** Wet/dry mix of the convolution reverb (0 = dry only, 1 = wet only). */
  setReverbMix(mix: number): void
  /** Reverb tail length in seconds. Regenerates the impulse response. */
  setReverbSize(seconds: number): void
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
 * Synthesise a stereo impulse response: white noise with exponential decay.
 * Good enough for a "room" feel without bundling external IR files.
 */
function createImpulseResponse(ctx: AudioContext, durationSec: number, decay: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * durationSec))
  const ir = ctx.createBuffer(2, length, ctx.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch)
    for (let i = 0; i < length; i++) {
      const t = i / length
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay)
    }
  }
  return ir
}

/**
 * SplendidGrandPiano (Yamaha CFX) via smplr — has multiple velocity layers
 * (so the timbre changes with velocity, not just the volume) plus release
 * noise samples.
 */
export async function createPiano(
  onProgress?: (p: LoadProgress) => void,
): Promise<PianoInstrument> {
  const context = Tone.getContext().rawContext as AudioContext

  // Signal chain:
  //   piano -> masterGain -> eqLow -> eqMid -> eqHigh -> split:
  //                                                ├─ dryGain   ──────────────────> destination
  //                                                └─ wetGain ──> convolver ──────> destination
  // Master volume sits before EQ + split so it scales everything equally.
  // EQ before reverb so the reverb tail inherits the user's tone shaping.
  const masterGain = context.createGain()
  const dryGain = context.createGain()
  const wetGain = context.createGain()
  const convolver = context.createConvolver()
  convolver.buffer = createImpulseResponse(context, 2.0, 2.5)

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
  wetGain.gain.value = 0

  // Wire master → eq chain (in series) → split to dry/wet
  masterGain.connect(eqFilters[0])
  for (let i = 0; i < eqFilters.length - 1; i++) {
    eqFilters[i].connect(eqFilters[i + 1])
  }
  const lastEq = eqFilters[eqFilters.length - 1]
  lastEq.connect(dryGain)
  lastEq.connect(wetGain)
  dryGain.connect(context.destination)
  wetGain.connect(convolver)
  convolver.connect(context.destination)

  const piano = new SplendidGrandPiano(context, {
    destination: masterGain,
    storage: new FadeInStorage(context),
    onLoadProgress: (p) => onProgress?.({ loaded: p.loaded, total: p.total }),
  })
  await piano.load

  // Per-voice options applied at start time. Held as closure variables and
  // mutated by setters so changes reach subsequent notes without rebuilding
  // the sampler.
  let releaseTime = 0.3
  let detuneCents = 0

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
    setReverbMix(mix) {
      const m = Math.max(0, Math.min(1, mix))
      // equal-power crossfade so perceived loudness stays roughly flat
      const dry = Math.cos((m * Math.PI) / 2)
      const wet = Math.sin((m * Math.PI) / 2)
      const now = context.currentTime
      dryGain.gain.cancelScheduledValues(now)
      wetGain.gain.cancelScheduledValues(now)
      dryGain.gain.setTargetAtTime(dry, now, 0.02)
      wetGain.gain.setTargetAtTime(wet, now, 0.02)
    },
    setReverbSize(seconds) {
      const dur = Math.max(0.1, Math.min(8, seconds))
      convolver.buffer = createImpulseResponse(context, dur, 2.5)
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
      piano.disconnect()
    },
  }
}
