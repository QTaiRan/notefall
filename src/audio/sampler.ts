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
  setVolumeDb(db: number): void
  dispose(): void
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
  const gain = context.createGain()
  gain.gain.value = 1
  gain.connect(context.destination)

  const piano = new SplendidGrandPiano(context, {
    destination: gain,
    storage: new FadeInStorage(context),
    onLoadProgress: (p) => onProgress?.({ loaded: p.loaded, total: p.total }),
  })
  await piano.load

  return {
    context,
    start(midi, velocity, atAudioTime, stopId) {
      return piano.start({
        note: midi,
        velocity: Math.max(1, Math.min(127, Math.round(velocity * 127))),
        time: atAudioTime,
        stopId,
      })
    },
    stopAll() {
      piano.stop()
    },
    setVolumeDb(db) {
      // ramp avoids clicks if the volume slider is moved during playback
      const target = Math.pow(10, db / 20)
      const now = context.currentTime
      gain.gain.cancelScheduledValues(now)
      gain.gain.setTargetAtTime(target, now, 0.01)
    },
    dispose() {
      piano.disconnect()
    },
  }
}
