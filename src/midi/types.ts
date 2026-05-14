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

/**
 * Per-track metadata pulled from the SMF. Index in `ParsedSong.tracks`
 * matches `NoteEvent.track`, so renderers can look up the display name
 * or per-track color from the track index alone.
 *
 * `name` is the SMF track name when present; otherwise a synthetic
 * "Track N" fallback. We keep the entry even for tracks that contain
 * no notes (e.g. tempo-only track 0 in Format 1) so the indices
 * stay in lockstep with `NoteEvent.track`.
 */
export type TrackInfo = {
  name: string
  /** True when the track contained at least one note. UI hides
   *  note-less tracks (tempo / meta) from the per-track colour list. */
  hasNotes: boolean
}

export type ParsedSong = {
  name: string
  duration: number
  notes: NoteEvent[]
  pedals: PedalEvent[]
  tracks: TrackInfo[]
}
