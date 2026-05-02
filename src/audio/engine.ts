import * as Tone from 'tone'
import type { ParsedSong } from '../midi/types'
import { createPiano, type PianoInstrument, type LoadProgress } from './sampler'

type ActiveNote = {
  id: number
  midi: number
  endTime: number
  stop: () => void
}

/** Note triggered live by the user (touch/click), independent of song timeline. */
export type LiveNote = {
  id: number
  midi: number
  velocity: number
  startTime: number // performance.now() / 1000 at trigger
  endTime: number | null // null while still held
}

export type KeyEventListener = (
  event:
    | { type: 'on'; midi: number; velocity: number; songTime: number }
    | { type: 'off'; midi: number; songTime: number },
) => void

/**
 * Self-driven scheduler. Visual layer reads currentSongTime() each frame and
 * also calls tick() to push due events to the sampler.
 */
export class AudioEngine {
  private piano: PianoInstrument | null = null
  private song: ParsedSong | null = null

  private playing = false
  private startedAt = 0 // performance.now() / 1000 at last play
  private offsetAtStart = 0 // song time at startedAt

  private rate = 1
  private pedalEnabled = true
  private volumeDb = 0
  private loop = false

  private noteIdx = 0
  private pedalIdx = 0
  private pedalDown = false // raw MIDI pedal state at current song time

  // notes currently sounding (key still held)
  private active = new Map<number, ActiveNote>()
  // notes whose key was released but pedal is holding the dampers up
  private pedalHeld: Array<{ midi: number; stop: () => void }> = []

  private listeners = new Set<KeyEventListener>()

  // user-triggered notes (touch/click on the keyboard)
  private liveNotes: LiveNote[] = []
  private liveIdCounter = 0
  // map liveNote.id → its smplr stop fn
  private liveStops = new Map<number, () => void>()

  async init(onProgress?: (p: LoadProgress) => void): Promise<void> {
    if (this.piano) return
    this.piano = await createPiano(onProgress)
    this.piano.setVolumeDb(this.volumeDb)
  }

  isReady(): boolean {
    return this.piano !== null
  }

  setVolumeDb(db: number): void {
    this.volumeDb = db
    this.piano?.setVolumeDb(db)
  }

  setRate(rate: number): void {
    const t = this.currentSongTime()
    this.rate = Math.max(0.25, Math.min(4, rate))
    this.startedAt = performance.now() / 1000
    this.offsetAtStart = t
  }

  setPedalEnabled(enabled: boolean): void {
    this.pedalEnabled = enabled
    if (!enabled) this.flushPedalHeld()
  }

  setLoop(loop: boolean): void {
    this.loop = loop
  }

  loadSong(song: ParsedSong): void {
    this.releaseAll()
    this.song = song
    this.noteIdx = 0
    this.pedalIdx = 0
    this.pedalDown = false
    this.offsetAtStart = 0
    this.startedAt = performance.now() / 1000
    this.playing = false
  }

  async play(): Promise<void> {
    if (!this.song) return
    if (Tone.getContext().state !== 'running') {
      await Tone.start()
    }
    this.startedAt = performance.now() / 1000
    this.playing = true
  }

  pause(): void {
    if (!this.playing) return
    const t = this.currentSongTime()
    this.offsetAtStart = t
    this.playing = false
    this.releaseAllSounding()
  }

  stop(): void {
    this.playing = false
    this.offsetAtStart = 0
    this.noteIdx = 0
    this.pedalIdx = 0
    this.pedalDown = false
    this.releaseAll()
  }

  seek(t: number): void {
    const wasPlaying = this.playing
    this.releaseAll()
    const dur = this.song?.duration ?? 0
    const clamped = Math.max(0, Math.min(dur, t))
    this.offsetAtStart = clamped
    this.startedAt = performance.now() / 1000
    this.recomputeIndices(clamped)
    this.playing = wasPlaying
  }

  isPlaying(): boolean {
    return this.playing
  }

  currentSongTime(): number {
    if (!this.playing) return this.offsetAtStart
    const wall = performance.now() / 1000
    return this.offsetAtStart + (wall - this.startedAt) * this.rate
  }

  isPedalDown(): boolean {
    return this.pedalDown && this.pedalEnabled
  }

  /**
   * Trigger a note from the user (touch/click). Returns a release function.
   * Returns null if the piano isn't loaded yet.
   */
  triggerKey(midi: number, velocity = 0.75): { id: number; release: () => void } | null {
    if (!this.piano) return null
    const id = this.liveIdCounter++
    const stopFn = this.piano.start(midi, velocity, undefined, `live${id}`)
    const startTime = performance.now() / 1000
    const note: LiveNote = { id, midi, velocity, startTime, endTime: null }
    this.liveNotes.push(note)
    this.liveStops.set(id, stopFn)
    this.emit({ type: 'on', midi, velocity, songTime: this.currentSongTime() })

    return {
      id,
      release: () => {
        if (note.endTime !== null) return
        note.endTime = performance.now() / 1000
        // pedal sustain applies equally to user-triggered notes
        if (this.pedalEnabled && this.pedalDown) {
          this.pedalHeld.push({ midi, stop: stopFn })
        } else {
          stopFn()
        }
        this.liveStops.delete(id)
        this.emit({ type: 'off', midi, songTime: this.currentSongTime() })
      },
    }
  }

  /** Live notes currently visible / recently played (for visualization). */
  getLiveNotes(): readonly LiveNote[] {
    return this.liveNotes
  }

  private cleanupLiveNotes(): void {
    const now = performance.now() / 1000
    // retain held notes always; drop released notes after 10s (well past any reasonable fall window)
    this.liveNotes = this.liveNotes.filter((n) => n.endTime === null || now - n.endTime < 10)
  }

  addKeyListener(fn: KeyEventListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(ev: Parameters<KeyEventListener>[0]): void {
    this.listeners.forEach((l) => l(ev))
  }

  private flushPedalHeld(): void {
    for (const h of this.pedalHeld) h.stop()
    this.pedalHeld = []
  }

  private releaseAll(): void {
    this.piano?.stopAll()
    const t = this.currentSongTime()
    for (const a of this.active.values()) {
      this.emit({ type: 'off', midi: a.midi, songTime: t })
    }
    this.active.clear()
    for (const h of this.pedalHeld) {
      this.emit({ type: 'off', midi: h.midi, songTime: t })
    }
    this.pedalHeld = []
    // also mark live notes as released (audio already stopped via stopAll)
    const now = performance.now() / 1000
    for (const n of this.liveNotes) {
      if (n.endTime === null) {
        n.endTime = now
        this.emit({ type: 'off', midi: n.midi, songTime: t })
      }
    }
    this.liveStops.clear()
  }

  private releaseAllSounding(): void {
    this.piano?.stopAll()
  }

  private recomputeIndices(songTime: number): void {
    if (!this.song) return
    let ni = 0
    while (ni < this.song.notes.length && this.song.notes[ni].time <= songTime) ni++
    this.noteIdx = ni

    let pi = 0
    let pedalDown = false
    while (pi < this.song.pedals.length && this.song.pedals[pi].time <= songTime) {
      pedalDown = this.song.pedals[pi].value >= 0.5
      pi++
    }
    this.pedalIdx = pi
    this.pedalDown = pedalDown
  }

  /** Called every frame from the visual loop. */
  tick(): void {
    this.cleanupLiveNotes()
    if (!this.piano || !this.song || !this.playing) return
    const songTime = this.currentSongTime()

    // process pedal events
    while (this.pedalIdx < this.song.pedals.length && this.song.pedals[this.pedalIdx].time <= songTime) {
      const ev = this.song.pedals[this.pedalIdx]
      const wasDown = this.pedalDown
      this.pedalDown = ev.value >= 0.5
      // pedal lifted: release all pedal-held notes
      if (wasDown && !this.pedalDown && this.pedalEnabled) {
        this.flushPedalHeld()
      }
      this.pedalIdx++
    }

    // process note ons. Schedule a small lookahead in the AudioContext clock
    // so the sample starts on a clean buffer boundary instead of mid-quantum
    // — this is what causes the audible "click" at note start.
    const LOOKAHEAD = 0.015
    const audioBase = this.piano.context.currentTime + LOOKAHEAD
    while (this.noteIdx < this.song.notes.length && this.song.notes[this.noteIdx].time <= songTime) {
      const n = this.song.notes[this.noteIdx]
      // Notes that are slightly overdue still align to the same lookahead floor,
      // notes scheduled close to "on time" land precisely.
      const offset = Math.max(0, (n.time - songTime) / this.rate)
      // Unique stopId per note prevents cross-talk when the same pitch repeats
      // close enough that voices overlap in smplr's voice manager.
      const stopFn = this.piano.start(n.midi, n.velocity, audioBase + offset, `s${n.id}`)
      this.active.set(n.id, { id: n.id, midi: n.midi, endTime: n.time + n.duration, stop: stopFn })
      this.emit({ type: 'on', midi: n.midi, velocity: n.velocity, songTime })
      this.noteIdx++
    }

    // process note offs (any active note whose end has passed)
    for (const a of this.active.values()) {
      if (a.endTime <= songTime) {
        if (this.pedalEnabled && this.pedalDown) {
          this.pedalHeld.push({ midi: a.midi, stop: a.stop })
        } else {
          a.stop()
        }
        this.emit({ type: 'off', midi: a.midi, songTime })
        this.active.delete(a.id)
      }
    }

    // end of song
    if (songTime >= this.song.duration && this.active.size === 0 && this.pedalHeld.length === 0) {
      if (this.loop) {
        this.seek(0)
      } else {
        this.stop()
      }
    }
  }
}

export const audioEngine = new AudioEngine()
