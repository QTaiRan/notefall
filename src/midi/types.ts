export type NoteEvent = {
  id: number
  midi: number
  time: number
  duration: number
  velocity: number
  track: number
}

export type PedalEvent = {
  time: number
  value: number
}

export type ParsedSong = {
  name: string
  duration: number
  notes: NoteEvent[]
  pedals: PedalEvent[]
}
