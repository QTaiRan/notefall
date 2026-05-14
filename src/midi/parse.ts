import { Midi } from '@tonejs/midi'
import type { ParsedSong, NoteEvent, PedalEvent, TrackInfo } from './types'

export async function parseMidi(file: ArrayBuffer, name: string): Promise<ParsedSong> {
  const midi = new Midi(file)
  const notes: NoteEvent[] = []
  const pedals: PedalEvent[] = []
  const tracks: TrackInfo[] = []
  let id = 0

  midi.tracks.forEach((track, trackIdx) => {
    track.notes.forEach((n) => {
      notes.push({
        id: id++,
        midi: n.midi,
        time: n.time,
        duration: n.duration,
        velocity: n.velocity,
        track: trackIdx,
      })
    })
    const cc64 = track.controlChanges[64]
    if (cc64) {
      cc64.forEach((cc) => {
        pedals.push({ time: cc.time, value: cc.value })
      })
    }
    // SMF track names are often empty or whitespace; fall back to a
    // synthetic "Track N" label so the per-track UI has something to
    // render. The index stays in lockstep with `NoteEvent.track`.
    const rawName = (track.name ?? '').trim()
    tracks.push({
      name: rawName.length > 0 ? rawName : `Track ${trackIdx + 1}`,
      hasNotes: track.notes.length > 0,
    })
  })

  notes.sort((a, b) => a.time - b.time)
  pedals.sort((a, b) => a.time - b.time)

  return {
    name,
    duration: midi.duration,
    notes,
    pedals,
    tracks,
  }
}
