import { Midi } from '@tonejs/midi'
import type { ParsedSong } from './types'

export type SerializeOptions = {
  /**
   * When true, emit one SMF track per `NoteEvent.track` index, keeping
   * the original track names so the structure round-trips through
   * `.nfz` (manifest assets) and stays compatible with per-track
   * features (colours, track listing in Inspector).
   *
   * When false (default), collapses every note into a single track —
   * the right behaviour for the user-facing "Save Song as MIDI…"
   * export, which is meant to give DAWs a single instrument lane.
   */
  preserveTracks?: boolean
}

/**
 * Serialise a `ParsedSong` back to a Standard MIDI File. Symmetric
 * counterpart to `parseMidi` — parse → edit → serialize round-trips
 * the data the editor cares about (notes + sustain pedal CC#64).
 *
 * See `SerializeOptions.preserveTracks` for the two output modes.
 */
export function serializeMidi(
  song: ParsedSong,
  options: SerializeOptions = {},
): ArrayBuffer {
  const midi = new Midi()
  if (options.preserveTracks) {
    // Multi-track output. Reconstruct one SMF track per index that
    // appears in `NoteEvent.track`, in the same order as
    // `song.tracks`. Tracks that originally had a name but no notes
    // (pure meta / tempo tracks) are skipped — the @tonejs/midi
    // encoder prepends its own meta track regardless. Pedal events
    // currently live on the song as a flat array (no track tag); we
    // attach them to whichever track has the lowest index that
    // contains notes, so reparse still picks them up.
    const trackByIdx = new Map<number, ReturnType<typeof midi.addTrack>>()
    const noteTrackIndices: number[] = []
    for (const n of song.notes) {
      if (!noteTrackIndices.includes(n.track)) noteTrackIndices.push(n.track)
    }
    noteTrackIndices.sort((a, b) => a - b)
    for (const idx of noteTrackIndices) {
      const t = midi.addTrack()
      // Restore the friendly track name when we have one. The encoder
      // writes it as the SMF "trackName" meta event so reparse via
      // `parseMidi` picks it up unchanged.
      const meta = song.tracks[idx]
      if (meta?.name) t.name = meta.name
      trackByIdx.set(idx, t)
    }
    for (const n of song.notes) {
      const t = trackByIdx.get(n.track)
      if (!t) continue
      t.addNote({
        midi: n.midi,
        time: n.time,
        duration: n.duration,
        velocity: n.velocity,
      })
    }
    if (song.pedals.length > 0 && noteTrackIndices.length > 0) {
      const pedalTrack = trackByIdx.get(noteTrackIndices[0])!
      for (const p of song.pedals) {
        pedalTrack.addCC({ number: 64, time: p.time, value: p.value })
      }
    }
  } else {
    // Legacy single-track output (default). Used by the explicit
    // "Save Song as MIDI…" download — DAWs see one instrument lane.
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
  }
  // toArray() returns Uint8Array<ArrayBufferLike>; copy into a fresh
  // ArrayBuffer so callers (Blob, parseMidi) get a guaranteed plain
  // ArrayBuffer regardless of platform-specific lib typings.
  const arr = midi.toArray()
  const buf = new ArrayBuffer(arr.length)
  new Uint8Array(buf).set(arr)
  return buf
}
