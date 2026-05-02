import { Midi } from '@tonejs/midi'
import type { ParsedSong, NoteEvent, PedalEvent } from './types'

export async function parseMidi(file: ArrayBuffer, name: string): Promise<ParsedSong> {
  const midi = new Midi(file)
  const notes: NoteEvent[] = []
  const pedals: PedalEvent[] = []
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
  })

  notes.sort((a, b) => a.time - b.time)
  pedals.sort((a, b) => a.time - b.time)

  return {
    name,
    duration: midi.duration,
    notes,
    pedals,
  }
}
