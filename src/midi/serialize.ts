import { Midi } from '@tonejs/midi'
import type { ParsedSong } from './types'

/**
 * Serialise a `ParsedSong` back to a Standard MIDI File. Symmetric
 * counterpart to `parseMidi` — parse → edit → serialize round-trips
 * the data the editor cares about (notes + sustain pedal CC#64).
 *
 * Multi-track structure from the original file is collapsed to a single
 * track. notefall is a piano visualiser; the track index is preserved on
 * `NoteEvent.track` for rendering decisions but isn't part of the saved
 * shape. If multi-track output is ever needed, group notes by `track`
 * here.
 */
export function serializeMidi(song: ParsedSong): ArrayBuffer {
  const midi = new Midi()
  const track = midi.addTrack()
  for (const n of song.notes) {
    track.addNote({
      midi: n.midi,
      time: n.time,
      duration: n.duration,
      velocity: n.velocity,
    })
  }
  for (const p of song.pedals) {
    track.addCC({ number: 64, time: p.time, value: p.value })
  }
  // toArray() returns Uint8Array<ArrayBufferLike>; copy into a fresh
  // ArrayBuffer so callers (Blob, parseMidi) get a guaranteed plain
  // ArrayBuffer regardless of platform-specific lib typings.
  const arr = midi.toArray()
  const buf = new ArrayBuffer(arr.length)
  new Uint8Array(buf).set(arr)
  return buf
}
