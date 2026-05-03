import * as Tone from 'tone'
import type { ParsedSong } from '../midi/types'
import { createPiano, type PianoInstrument, type LoadProgress } from './sampler'

type ActiveNote = {
  id: number
  midi: number
  endTime: number
  stop: (time?: number) => void
}

/**
 * Buffer in seconds added when calling `stop` so it always lands after the
 * scheduled `start` time (which uses a 15 ms lookahead). Without this,
 * `voice.stop()` defaults to `ctx.currentTime` and — if the note's start was
 * scheduled in the future — the source is cancelled before it ever plays.
 * Symptom: silently dropped notes at high playback speed when many notes
 * collapse into a single frame.
 */
const STOP_BUFFER = 0.02

/**
 * Background-tab ticking. `requestAnimationFrame` (which drives `useFrame`
 * → `tick()`) is paused while `document.hidden = true`, so notes scheduled
 * during the hidden period pile up and burst at once on return. A Web Worker
 * timer is exempt from main-thread throttling and keeps the scheduler running.
 * 25 ms gives ~40 Hz tick rate, well within the 15 ms audio lookahead window.
 */
const TICK_INTERVAL_MS = 25

/**
 * Tail of song time we keep ticking after the last MIDI event before stopping
 * playback (when loop is off). Lets the in-flight visuals — falling notes
 * still rising/landing, hit-line particles (~2.5s lifetime by default),
 * landing flashes — and the reverb wash play out instead of getting cut
 * off. Tuned to be just longer than the longest natural decay so the player
 * doesn't feel stuck waiting at 100%. Loop mode bypasses this so the loop
 * point is exactly the song end with no audible gap.
 */
const SONG_TAIL_SECONDS = 5

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
  private reverbMix = 0
  private reverbSize = 2.0

  private noteIdx = 0
  private pedalIdx = 0
  private pedalDown = false // raw MIDI pedal state at current song time
  // Live pedal from the user's physical MIDI device. Independent of the
  // song's pedal events and of `pedalEnabled` (the user's physical pedal
  // should always work even when the song's pedal track is muted).
  private livePedalDown = false

  // notes currently sounding (key still held)
  private active = new Map<number, ActiveNote>()
  // notes whose key was released but a pedal is holding the dampers up.
  // `source` records WHICH pedal is sustaining the note so we can release
  // only the right entries when one of the pedals goes up while the other
  // stays down.
  private pedalHeld: Array<{
    midi: number
    stop: (time?: number) => void
    source: 'song' | 'live'
  }> = []

  private listeners = new Set<KeyEventListener>()

  // user-triggered notes (touch/click on the keyboard)
  private liveNotes: LiveNote[] = []
  private liveIdCounter = 0
  // map liveNote.id → its smplr stop fn
  private liveStops = new Map<number, () => void>()

  // Worker-driven ticker that keeps scheduling alive in background tabs
  private tickWorker: Worker | null = null
  private tickWorkerUrl: string | null = null

  async init(onProgress?: (p: LoadProgress) => void): Promise<void> {
    if (this.piano) return
    this.piano = await createPiano(onProgress)
    this.piano.setVolumeDb(this.volumeDb)
    this.piano.setReverbSize(this.reverbSize)
    this.piano.setReverbMix(this.reverbMix)
  }

  isReady(): boolean {
    return this.piano !== null
  }

  setVolumeDb(db: number): void {
    this.volumeDb = db
    this.piano?.setVolumeDb(db)
  }

  setReverbMix(mix: number): void {
    this.reverbMix = mix
    this.piano?.setReverbMix(mix)
  }

  setReverbSize(seconds: number): void {
    this.reverbSize = seconds
    this.piano?.setReverbSize(seconds)
  }

  setRate(rate: number): void {
    const t = this.currentSongTime()
    this.rate = Math.max(0.25, Math.min(4, rate))
    this.startedAt = performance.now() / 1000
    this.offsetAtStart = t
  }

  setPedalEnabled(enabled: boolean): void {
    this.pedalEnabled = enabled
    // Only release song-pedal-held notes — the user's physical pedal still
    // governs live notes regardless of this song-side toggle.
    if (!enabled) this.flushPedalHeld('song')
  }

  /**
   * Live pedal state from the user's MIDI device. Calls from the MIDI input
   * layer when CC#64 crosses the 64-value threshold.
   */
  setLivePedalDown(down: boolean): void {
    if (this.livePedalDown === down) return
    this.livePedalDown = down
    if (!down) this.flushPedalHeld('live')
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
    this.startBackgroundTicker()
  }

  pause(): void {
    if (!this.playing) return
    const t = this.currentSongTime()
    this.offsetAtStart = t
    this.playing = false
    this.releaseAllSounding()
    this.stopBackgroundTicker()
  }

  stop(): void {
    this.playing = false
    this.offsetAtStart = 0
    this.noteIdx = 0
    this.pedalIdx = 0
    this.pedalDown = false
    this.releaseAll()
    this.stopBackgroundTicker()
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
        const stopTime = (this.piano?.context.currentTime ?? 0) + STOP_BUFFER
        // Live notes are sustained by either pedal source. Tag with whichever
        // is currently down — live takes precedence when both are pressed,
        // since the physical pedal is the more direct controller.
        if (this.livePedalDown) {
          this.pedalHeld.push({ midi, stop: stopFn, source: 'live' })
        } else if (this.pedalEnabled && this.pedalDown) {
          this.pedalHeld.push({ midi, stop: stopFn, source: 'song' })
        } else {
          stopFn(stopTime)
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

  private flushPedalHeld(source: 'song' | 'live' | 'all' = 'all'): void {
    const stopTime = (this.piano?.context.currentTime ?? 0) + STOP_BUFFER
    if (source === 'all') {
      for (const h of this.pedalHeld) h.stop(stopTime)
      this.pedalHeld = []
      return
    }
    const remaining: typeof this.pedalHeld = []
    for (const h of this.pedalHeld) {
      if (h.source === source) {
        h.stop(stopTime)
      } else {
        remaining.push(h)
      }
    }
    this.pedalHeld = remaining
  }

  private startBackgroundTicker(): void {
    if (this.tickWorker || typeof Worker === 'undefined') return
    try {
      const code = `setInterval(() => postMessage(0), ${TICK_INTERVAL_MS})`
      const blob = new Blob([code], { type: 'application/javascript' })
      this.tickWorkerUrl = URL.createObjectURL(blob)
      this.tickWorker = new Worker(this.tickWorkerUrl)
      this.tickWorker.onmessage = () => this.tick()
    } catch {
      /* fall back to rAF-only ticking when Worker construction fails */
    }
  }

  private stopBackgroundTicker(): void {
    this.tickWorker?.terminate()
    this.tickWorker = null
    if (this.tickWorkerUrl) {
      URL.revokeObjectURL(this.tickWorkerUrl)
      this.tickWorkerUrl = null
    }
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

  /** Called every frame from the visual loop, plus from the background-tab worker. */
  tick(): void {
    this.cleanupLiveNotes()
    if (!this.piano || !this.song || !this.playing) return
    // Some browsers suspend the AudioContext on background tabs even with
    // sources active; nudge it back to running so scheduled notes still fire.
    if (this.piano.context.state === 'suspended') {
      this.piano.context.resume().catch(() => {})
    }
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
    const stopTime = this.piano.context.currentTime + STOP_BUFFER
    for (const a of this.active.values()) {
      if (a.endTime <= songTime) {
        if (this.pedalEnabled && this.pedalDown) {
          this.pedalHeld.push({ midi: a.midi, stop: a.stop, source: 'song' })
        } else {
          a.stop(stopTime)
        }
        this.emit({ type: 'off', midi: a.midi, songTime })
        this.active.delete(a.id)
      }
    }

    // end of song. Loop snaps back at the exact end; non-loop adds a tail
    // window so the in-flight visuals + reverb finish naturally.
    const endThreshold = this.song.duration + (this.loop ? 0 : SONG_TAIL_SECONDS)
    if (songTime >= endThreshold && this.active.size === 0 && this.pedalHeld.length === 0) {
      if (this.loop) {
        this.seek(0)
      } else {
        this.stop()
      }
    }
  }
}

export const audioEngine = new AudioEngine()
