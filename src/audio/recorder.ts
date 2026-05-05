import { Midi } from '@tonejs/midi'
import { audioEngine } from './engine'

/**
 * Captures the user's live input (PC keyboard, on-screen keyboard, physical
 * MIDI device) into a list of recordings that can be loaded back into the
 * player or exported as Standard MIDI Files.
 *
 * Song playback is intentionally NOT captured — recording while a backing
 * track plays gives you just your performance, not a mash-up.
 *
 * Singleton; only one recording is in progress at a time. Stopped
 * recordings stay in `recordings[]` until explicitly deleted, so the user
 * can take multiple takes and pick which one to keep.
 */
type RecState = 'idle' | 'recording'

type RecEvent =
  | { type: 'noteOn'; midi: number; velocity: number; t: number }
  | { type: 'noteOff'; midi: number; t: number }
  | { type: 'pedal'; down: boolean; t: number }

export type Recording = {
  id: string
  name: string
  /** Unix ms — used to sort + format display timestamps. */
  createdAt: number
  /** Length in seconds (recorder stop time minus start time). */
  duration: number
  /** Captured events in their original order. */
  events: RecEvent[]
}

class RecorderManager {
  private state: RecState = 'idle'
  private startWall = 0
  private currentEvents: RecEvent[] = []
  private off: (() => void) | null = null
  private recordings: Recording[] = []
  private listeners = new Set<() => void>()

  start(): void {
    if (this.state === 'recording') return
    this.currentEvents = []
    this.state = 'recording'
    this.startWall = performance.now() / 1000
    this.off = audioEngine.addLiveListener((e) => {
      const t = Math.max(0, e.time - this.startWall)
      if (e.type === 'noteOn') {
        this.currentEvents.push({ type: 'noteOn', midi: e.midi, velocity: e.velocity, t })
      } else if (e.type === 'noteOff') {
        this.currentEvents.push({ type: 'noteOff', midi: e.midi, t })
      } else {
        this.currentEvents.push({ type: 'pedal', down: e.down, t })
      }
    })
    this.notify()
  }

  /**
   * End the recording. If anything was captured, a new entry is added to
   * the recordings list (newest first). Empty recordings are silently
   * discarded so the list isn't cluttered with no-op takes.
   */
  stop(): void {
    if (this.state !== 'recording') return
    this.off?.()
    this.off = null
    const duration = performance.now() / 1000 - this.startWall
    if (this.currentEvents.length > 0) {
      const id = `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const createdAt = Date.now()
      this.recordings.unshift({
        id,
        name: defaultFilename(createdAt),
        createdAt,
        duration,
        events: this.currentEvents,
      })
    }
    this.currentEvents = []
    this.state = 'idle'
    this.notify()
  }

  /** Cancel an in-progress recording without saving it. */
  cancel(): void {
    if (this.state !== 'recording') return
    this.off?.()
    this.off = null
    this.currentEvents = []
    this.state = 'idle'
    this.notify()
  }

  delete(id: string): void {
    const before = this.recordings.length
    this.recordings = this.recordings.filter((r) => r.id !== id)
    if (this.recordings.length !== before) this.notify()
  }

  rename(id: string, name: string): void {
    const r = this.recordings.find((r) => r.id === id)
    if (!r) return
    r.name = name
    this.notify()
  }

  clearAll(): void {
    if (this.recordings.length === 0) return
    this.recordings = []
    this.notify()
  }

  getState(): RecState {
    return this.state
  }

  /** Seconds since the in-progress recording began. 0 when idle. */
  getElapsedSec(): number {
    if (this.state !== 'recording') return 0
    return performance.now() / 1000 - this.startWall
  }

  getRecordings(): readonly Recording[] {
    return this.recordings
  }

  /** Build a Standard MIDI File for the given recording, in memory. */
  toArrayBuffer(id: string): ArrayBuffer | null {
    const r = this.recordings.find((r) => r.id === id)
    if (!r) return null
    const midi = new Midi()
    const track = midi.addTrack()

    const open = new Map<number, { vel: number; t: number }>()
    const finishNote = (m: number, vel: number, start: number, end: number) => {
      track.addNote({
        midi: m,
        time: start,
        duration: Math.max(0.01, end - start),
        velocity: vel,
      })
    }

    for (const e of r.events) {
      if (e.type === 'noteOn') {
        const existing = open.get(e.midi)
        if (existing) finishNote(e.midi, existing.vel, existing.t, e.t)
        open.set(e.midi, { vel: e.velocity, t: e.t })
      } else if (e.type === 'noteOff') {
        const existing = open.get(e.midi)
        if (existing) {
          finishNote(e.midi, existing.vel, existing.t, e.t)
          open.delete(e.midi)
        }
      } else {
        track.addCC({ number: 64, time: e.t, value: e.down ? 1 : 0 })
      }
    }
    for (const [m, { vel, t }] of open) {
      finishNote(m, vel, t, r.duration)
    }

    // toArray() returns Uint8Array<ArrayBufferLike>; copy into a fresh
    // ArrayBuffer so callers (Blob, parseMidi) get a guaranteed plain
    // ArrayBuffer regardless of platform-specific lib typings.
    const arr = midi.toArray()
    const buf = new ArrayBuffer(arr.length)
    new Uint8Array(buf).set(arr)
    return buf
  }

  download(id: string): void {
    const buf = this.toArrayBuffer(id)
    if (!buf) return
    const r = this.recordings.find((r) => r.id === id)
    if (!r) return
    const blob = new Blob([buf], { type: 'audio/midi' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = r.name.endsWith('.mid') ? r.name : `${r.name}.mid`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
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
}

function defaultFilename(epochMs: number = Date.now()): string {
  const d = new Date(epochMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours(),
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `notefall-${stamp}.mid`
}

export const recorder = new RecorderManager()
