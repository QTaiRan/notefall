import type { ParsedSong, NoteEvent, PedalEvent } from './midi/types'

/**
 * Procedural demo patterns. Real MIDI files can be loaded via the Open button
 * or drag-and-drop. These exist to verify the rendering / audio pipeline
 * without bundling third-party files.
 */

let idCounter = 0
function note(midi: number, time: number, duration: number, velocity = 0.8): NoteEvent {
  return { id: idCounter++, midi, time, duration, velocity, track: 0 }
}

function buildScale(): ParsedSong {
  idCounter = 0
  const notes: NoteEvent[] = []
  const scale = [0, 2, 4, 5, 7, 9, 11, 12]
  let t = 0.5
  const step = 0.18
  for (let oct = 0; oct < 6; oct++) {
    for (const s of scale) {
      notes.push(note(36 + oct * 12 + s, t, step * 0.95))
      t += step
    }
  }
  for (let oct = 5; oct >= 0; oct--) {
    for (let i = scale.length - 1; i >= 0; i--) {
      notes.push(note(36 + oct * 12 + scale[i], t, step * 0.95))
      t += step
    }
  }
  return { name: 'Demo: Scales', duration: t + 1, notes, pedals: [] }
}

function buildArpeggios(): ParsedSong {
  idCounter = 0
  const notes: NoteEvent[] = []
  // C - Am - F - G progression, broken chord arpeggios
  const chords = [
    [60, 64, 67, 72],
    [57, 60, 64, 69],
    [53, 57, 60, 65],
    [55, 59, 62, 67],
  ]
  let t = 0.5
  const step = 0.16
  for (let bar = 0; bar < 8; bar++) {
    const c = chords[bar % chords.length]
    const seq = [...c, ...c.slice().reverse()]
    for (const m of seq) {
      notes.push(note(m, t, step * 0.9, 0.7))
      // bass octave
      if (m === c[0]) notes.push(note(m - 24, t, step * 0.9, 0.85))
      t += step
    }
  }
  return { name: 'Demo: Arpeggios', duration: t + 1, notes, pedals: [] }
}

function buildChords(): ParsedSong {
  idCounter = 0
  const notes: NoteEvent[] = []
  const pedals: PedalEvent[] = []
  // I-V-vi-IV in C. The keystrokes are short, but a sustain pedal is held
  // continuously and re-pressed exactly at each chord boundary (legato
  // pedaling). This is how a pianist maintains a continuous wash of harmony
  // while changing chords. Toggling Pedal Enabled off in the Inspector should
  // make the notes cut off after their key release instead of ringing out.
  const chords = [
    [48, 60, 64, 67],
    [43, 59, 62, 67],
    [45, 60, 64, 69],
    [41, 60, 65, 69],
  ]
  const start = 0.5
  const beat = 2.0
  let t = start
  // initial pedal press just before the first chord
  pedals.push({ time: t - 0.05, value: 1 })
  for (let bar = 0; bar < 4; bar++) {
    const c = chords[bar % chords.length]
    if (bar > 0) {
      // legato pedal: lift exactly at the new chord, re-press one frame later
      pedals.push({ time: t, value: 0 })
      pedals.push({ time: t + 0.005, value: 1 })
    }
    for (const m of c) notes.push(note(m, t, 0.4, 0.78))
    t += beat
  }
  // final pedal release
  pedals.push({ time: t, value: 0 })
  return { name: 'Demo: Chords + Pedal', duration: t + 1.5, notes, pedals }
}

export type SampleEntry = {
  label: string
  build: () => ParsedSong
}

export const SAMPLES: SampleEntry[] = [
  { label: 'Scales', build: buildScale },
  { label: 'Arpeggios', build: buildArpeggios },
  { label: 'Chords + Pedal', build: buildChords },
]
