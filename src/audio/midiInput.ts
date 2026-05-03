import * as Tone from 'tone'
import { audioEngine } from './engine'

export type MidiDeviceInfo = {
  id: string
  name: string
  manufacturer: string
}

/**
 * Bridge between the browser's Web MIDI API and the audio engine. Listens
 * to a single user-selected input device, translates note on / note off /
 * sustain pedal CC into engine calls, and tracks active voices so a held
 * note can be released cleanly when the engine resets or the device is
 * disconnected mid-stream.
 *
 * Singleton — there's only ever one connected device at a time.
 */
class MidiInputManager {
  private access: MIDIAccess | null = null
  private listeningInputId: string | null = null
  // Original incoming midi → release fn. Stored under the *raw* note number
  // (not the transposed one) so noteOff still finds the active voice even
  // if the user changes the transpose between noteOn and noteOff.
  private activeNotes = new Map<number, () => void>()
  private listeners = new Set<() => void>()

  // Input pre-processing — mutated by setters from the React layer.
  // Velocity shaping is NOT here: it lives in the engine so it applies
  // uniformly to song playback and on-screen keyboard input as well.
  private transpose = 0

  setTranspose(n: number): void { this.transpose = Math.round(n) }

  isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator
  }

  /**
   * Request MIDI device access (triggers a browser permission prompt the
   * first time). Must be called from a user gesture. Idempotent.
   */
  async requestAccess(): Promise<boolean> {
    if (this.access) return true
    if (!this.isSupported()) return false
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false })
      this.access.onstatechange = () => this.onStateChange()
      this.notify()
      return true
    } catch {
      return false
    }
  }

  hasAccess(): boolean {
    return this.access !== null
  }

  getDevices(): MidiDeviceInfo[] {
    if (!this.access) return []
    return [...this.access.inputs.values()].map((input) => ({
      id: input.id,
      name: input.name ?? 'Unknown device',
      manufacturer: input.manufacturer ?? '',
    }))
  }

  getActiveDeviceId(): string | null {
    return this.listeningInputId
  }

  /**
   * Connect to a specific device id, or pass null to disconnect. Disconnects
   * the previous device first if any is connected.
   */
  connect(deviceId: string | null): void {
    if (!this.access) return
    if (this.listeningInputId === deviceId) return
    // Detach the previous handler and release any sounding notes from it.
    if (this.listeningInputId) {
      const prev = this.access.inputs.get(this.listeningInputId)
      if (prev) prev.onmidimessage = null
      this.releaseAll()
    }
    this.listeningInputId = deviceId
    if (deviceId) {
      const input = this.access.inputs.get(deviceId)
      if (input) input.onmidimessage = (e: MIDIMessageEvent) => this.onMessage(e.data)
    }
    this.notify()
  }

  addListener(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private notify(): void {
    this.listeners.forEach((l) => l())
  }

  private onStateChange(): void {
    // If our currently listening device went away (cable unplugged, device
    // power off), release any held notes and clear the listening id so the
    // UI reflects the disconnect.
    if (this.listeningInputId && this.access) {
      const input = this.access.inputs.get(this.listeningInputId)
      if (!input || input.state === 'disconnected') {
        this.releaseAll()
        this.listeningInputId = null
      }
    }
    this.notify()
  }

  private onMessage(data: Uint8Array | null): void {
    if (!data || data.length < 1) return
    // Status byte: high nibble is event type, low nibble is channel. We
    // accept all channels — most home digital pianos send on channel 1
    // but many splits / dual modes use other channels too.
    const status = data[0] & 0xf0

    if (status === 0x90 && data.length >= 3) {
      // Note On. MIDI convention: velocity 0 is equivalent to Note Off.
      const midi = data[1]
      const velocity = data[2] / 127
      if (velocity > 0) this.noteOn(midi, velocity)
      else this.noteOff(midi)
    } else if (status === 0x80 && data.length >= 3) {
      this.noteOff(data[1])
    } else if (status === 0xb0 && data.length >= 3) {
      // Control Change. CC#64 = sustain pedal. MIDI convention: ≥64 = down.
      const cc = data[1]
      const value = data[2]
      if (cc === 64) {
        audioEngine.setLivePedalDown(value >= 64)
      }
    }
    // Pitch bend, channel pressure, program change, etc. are ignored — a
    // sampled grand piano has no meaningful response to them.
  }

  private noteOn(midi: number, velocity: number): void {
    // Transpose the input midi. Velocity shaping happens downstream in
    // audioEngine.triggerKey so song playback shares the same curve.
    const transposed = midi + this.transpose
    // Out of MIDI range after transpose → silently drop. Common when the
    // user's keyboard already covers the extreme range and they shift it.
    if (transposed < 0 || transposed > 127) return
    // Same-pitch retrigger: release the previous voice first to avoid the
    // stuck-note state where the second Note Off only releases one of two
    // overlapping voices.
    const existing = this.activeNotes.get(midi)
    if (existing) existing()
    const handle = audioEngine.triggerKey(transposed, velocity)
    if (handle) this.activeNotes.set(midi, handle.release)
  }

  private noteOff(midi: number): void {
    const release = this.activeNotes.get(midi)
    if (release) {
      release()
      this.activeNotes.delete(midi)
    }
  }

  private releaseAll(): void {
    for (const release of this.activeNotes.values()) release()
    this.activeNotes.clear()
    audioEngine.setLivePedalDown(false)
  }
}

export const midiInput = new MidiInputManager()

/**
 * Ensure the AudioContext is running and the sampler is loaded. Call from
 * a user gesture (the MIDI device picker click) before connecting so the
 * first MIDI message can immediately produce sound.
 */
export async function ensureAudioReady(
  onProgress?: (loaded: number, total: number) => void,
): Promise<boolean> {
  if (Tone.getContext().state !== 'running') {
    try {
      await Tone.start()
    } catch {
      /* ignored */
    }
  }
  if (audioEngine.isReady()) return true
  try {
    await audioEngine.init((p) => onProgress?.(p.loaded, p.total))
    return true
  } catch {
    return false
  }
}
