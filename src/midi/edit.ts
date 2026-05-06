import type { NoteEvent, ParsedSong } from './types'

/**
 * Pure mutation helpers for the in-app MIDI editor. Each function returns a
 * NEW ParsedSong (notes array + duration are recomputed where needed) so
 * callers feed the result through `applySongEdit` to push undo history.
 *
 * Conventions:
 * - Notes always stay sorted by `time` ascending. The audio engine relies
 *   on this sort order for its sequential scheduling cursor.
 * - `duration` (the song length) is recomputed as the max of (old duration,
 *   last note end). We never shrink it on delete — the user may have set up
 *   the timeline with trailing silence on purpose, and shrinking it would
 *   silently snap the seek bar end inward.
 * - New ids come from `nextNoteId(song)` so they don't collide with existing
 *   ids from the parsed file or earlier edits.
 */

/** Generate the next free note id for the given song. */
export function nextNoteId(song: ParsedSong): number {
  let max = -1
  for (const n of song.notes) if (n.id > max) max = n.id
  return max + 1
}

function sortByTime(notes: NoteEvent[]): NoteEvent[] {
  return notes.slice().sort((a, b) => a.time - b.time)
}

function computeDuration(prev: number, notes: NoteEvent[]): number {
  let last = 0
  for (const n of notes) {
    const end = n.time + n.duration
    if (end > last) last = end
  }
  return Math.max(prev, last)
}

/** Minimum surviving duration after auto-trim. Notes whose post-trim
 *  span falls below this are dropped — matching MIDI playback's
 *  practical lower bound (very short fragments are inaudible). */
const MIN_DURATION = 0.02

/**
 * Enforce the "no two notes of the same pitch overlap in time" rule —
 * a real piano can't sustain the same key twice in one envelope, so
 * the editor shouldn't allow it either. `priorityIds` listed notes
 * keep their full interval; existing notes that overlap them get
 * clipped (or dropped if fully contained, or kept partial if they only
 * grazed the edge). Among notes with no priority, the simple
 * "later wins, earlier trims" rule applies.
 *
 * Caller patterns:
 *   - addNote(...) → resolveOverlaps(next, [newId])
 *   - moveNotes(...) → resolveOverlaps(next, movedIds)
 *   - resize drag → resolveOverlaps(next, [resizedId])
 *
 * O(n × p) per pitch group where p = priorityIds in that group;
 * negligible for realistic editing scenarios (typically 1-2 priority).
 */
export function resolveOverlaps(
  song: ParsedSong,
  priorityIds: Iterable<number> = [],
): ParsedSong {
  const priority = priorityIds instanceof Set ? priorityIds : new Set(priorityIds)

  // Group by pitch — overlap is only meaningful between same-pitch notes.
  const byPitch = new Map<number, NoteEvent[]>()
  for (const n of song.notes) {
    let arr = byPitch.get(n.midi)
    if (!arr) {
      arr = []
      byPitch.set(n.midi, arr)
    }
    arr.push(n)
  }

  const result: NoteEvent[] = []
  for (const group of byPitch.values()) {
    if (group.length === 1) {
      result.push(group[0])
      continue
    }

    // Phase 1: clip every non-priority note against every priority note
    // in this pitch group. Cases per overlap type:
    //   - N fully inside P → drop N
    //   - N spans P entirely → keep only N's earlier portion (lose tail)
    //   - N starts before P, ends inside P → trim N's end
    //   - N starts inside P, ends after P → trim N's start
    const priorityNotes = group.filter((n) => priority.has(n.id))
    let others = group.filter((n) => !priority.has(n.id))
    for (const p of priorityNotes) {
      const pStart = p.time
      const pEnd = p.time + p.duration
      const nextOthers: NoteEvent[] = []
      for (const n of others) {
        const nStart = n.time
        const nEnd = n.time + n.duration
        if (nEnd <= pStart || nStart >= pEnd) {
          nextOthers.push(n)
          continue
        }
        if (nStart >= pStart && nEnd <= pEnd) continue // fully inside → drop
        if (nStart < pStart && nEnd > pEnd) {
          const dur = pStart - nStart
          if (dur >= MIN_DURATION) nextOthers.push({ ...n, duration: dur })
          continue
        }
        if (nStart < pStart) {
          const dur = pStart - nStart
          if (dur >= MIN_DURATION) nextOthers.push({ ...n, duration: dur })
        } else {
          const newStart = pEnd
          const dur = nEnd - newStart
          if (dur >= MIN_DURATION) nextOthers.push({ ...n, time: newStart, duration: dur })
        }
      }
      others = nextOthers
    }

    // Phase 2: among the remaining notes, enforce non-overlap with the
    // simple "trim earlier" rule. This catches priority-priority overlap
    // (multi-select move where two moved notes end up colliding) and
    // any pre-existing same-pitch overlap that wasn't introduced by the
    // current edit.
    const all = priorityNotes.concat(others).sort((a, b) => a.time - b.time)
    for (let i = 0; i < all.length; i++) {
      const cur = all[i]
      const nxt = all[i + 1]
      if (nxt && cur.time + cur.duration > nxt.time) {
        const dur = nxt.time - cur.time
        if (dur >= MIN_DURATION) result.push({ ...cur, duration: dur })
        // else: dropped
      } else {
        result.push(cur)
      }
    }
  }

  result.sort((a, b) => a.time - b.time)
  return { ...song, notes: result, duration: computeDuration(song.duration, result) }
}

/** Remove every note whose id is in `ids`. */
export function deleteNotes(song: ParsedSong, ids: Iterable<number>): ParsedSong {
  const idSet = ids instanceof Set ? ids : new Set(ids)
  if (idSet.size === 0) return song
  const next = song.notes.filter((n) => !idSet.has(n.id))
  if (next.length === song.notes.length) return song
  return { ...song, notes: next }
}

/**
 * Move every note whose id is in `ids` by (deltaTime, deltaSemitones).
 *
 * Collision behavior — moved notes are SOLID and STOP at existing notes
 * of the same pitch instead of overwriting them:
 *   - The pitch shift clamps in the direction of intent: we try the
 *     requested shift first, and if any moved note would land on an
 *     existing note we step |k| toward 0 by one semitone at a time and
 *     re-check, picking the largest valid shift. This means a single
 *     occupied semitone in the way blocks at the slot before it, but if
 *     the user drags PAST the obstacle (target lands on a free pitch
 *     beyond), the moved set jumps over — "stop at collision until you
 *     push further, then leap past". Multi-select shifts as one block,
 *     so the most-restrictive member governs the clamp and the
 *     selection's shape is preserved.
 *   - The time shift is clamped uniformly: we compute the smallest
 *     "room to move" across all moved notes (forward + backward) and
 *     scale the delta back so no moved note crosses into an existing
 *     same-pitch note. Touching boundaries are allowed; the user
 *     redistributes lengths between abutting notes by edge-resizing
 *     afterward.
 *
 * Time is clamped at 0 so notes can't slide into the negative. MIDI is
 * clamped to [0, 127]; out-of-range moved notes are dropped (the user
 * dragged off the keyboard).
 */
export function moveNotes(
  song: ParsedSong,
  ids: Iterable<number>,
  deltaTime: number,
  deltaSemitones: number,
): ParsedSong {
  const idSet = ids instanceof Set ? ids : new Set(ids)
  if (idSet.size === 0 || (deltaTime === 0 && deltaSemitones === 0)) return song

  const moved: NoteEvent[] = []
  const others: NoteEvent[] = []
  for (const n of song.notes) {
    if (idSet.has(n.id)) moved.push(n)
    else others.push(n)
  }
  if (moved.length === 0) return song

  // --- Pitch shift clamping (toward 0 from the requested k) ---
  // Search from |deltaSemitones| down to 1 in the same direction; the
  // first |k| where every moved note's post-shift pitch is in range and
  // time-overlap-free wins. This gives "stop at the obstacle, but jump
  // past when the cursor goes further" without per-gesture state, while
  // still permitting placement at a same-pitch slot when no time
  // collision exists (e.g. moving a note past another at the same pitch
  // that's elsewhere in the song).
  let appliedSemis = 0
  if (deltaSemitones !== 0) {
    const dir = deltaSemitones > 0 ? 1 : -1
    const maxAbs = Math.abs(deltaSemitones)
    const isValidShift = (k: number): boolean => {
      for (const m of moved) {
        const newMidi = m.midi + k
        if (newMidi < 0 || newMidi > 127) return false
        const mEnd = m.time + m.duration
        for (const o of others) {
          if (o.midi !== newMidi) continue
          if (m.time < o.time + o.duration && mEnd > o.time) return false
        }
      }
      return true
    }
    for (let absK = maxAbs; absK >= 1; absK--) {
      const k = dir * absK
      if (isValidShift(k)) {
        appliedSemis = k
        break
      }
    }
  }

  // --- Time shift clamping ---
  // For each moved note, the maximum forward / backward room is the
  // distance to the nearest non-moved obstacle at its (post-shift)
  // pitch. The whole moved set is constrained by the most restrictive
  // note so relative spacing within the selection is preserved.
  let maxForward = Infinity
  let maxBackward = Infinity
  for (const m of moved) {
    const checkMidi = m.midi + appliedSemis
    if (checkMidi < 0 || checkMidi > 127) continue
    const mEnd = m.time + m.duration

    let fwd = Infinity
    let bwd = Infinity
    for (const o of others) {
      if (o.midi !== checkMidi) continue
      const oEnd = o.time + o.duration
      if (o.time >= mEnd) {
        const room = o.time - mEnd
        if (room < fwd) fwd = room
      } else if (oEnd <= m.time) {
        const room = m.time - oEnd
        if (room < bwd) bwd = room
      }
    }
    if (fwd < maxForward) maxForward = fwd
    if (bwd < maxBackward) maxBackward = bwd
    // Time can't go negative — every moved note's `time` is also a
    // backward limit.
    if (m.time < maxBackward) maxBackward = m.time
  }

  let appliedDelta = deltaTime
  if (appliedDelta > maxForward) appliedDelta = maxForward
  if (appliedDelta < -maxBackward) appliedDelta = -maxBackward

  if (appliedDelta === 0 && appliedSemis === 0) return song

  const next: NoteEvent[] = []
  for (const n of song.notes) {
    if (!idSet.has(n.id)) {
      next.push(n)
      continue
    }
    const newMidi = n.midi + appliedSemis
    if (newMidi < 0 || newMidi > 127) continue
    next.push({ ...n, time: Math.max(0, n.time + appliedDelta), midi: newMidi })
  }
  const sorted = sortByTime(next)
  return { ...song, notes: sorted, duration: computeDuration(song.duration, sorted) }
}

/**
 * Replace each selected note's velocity with the result of `mapper(prev)`.
 * Result is clamped to (0, 1] — a velocity of 0 would silently drop the
 * note at playback time, which is rarely intended; users who want that
 * outcome should delete the note instead.
 */
export function setNotesVelocity(
  song: ParsedSong,
  ids: Iterable<number>,
  mapper: (prev: number) => number,
): ParsedSong {
  const idSet = ids instanceof Set ? ids : new Set(ids)
  if (idSet.size === 0) return song
  const next = song.notes.map((n) =>
    idSet.has(n.id) ? { ...n, velocity: Math.max(0.01, Math.min(1, mapper(n.velocity))) } : n,
  )
  return { ...song, notes: next }
}

/**
 * Insert a new note. Returns the new song and the assigned id so callers
 * can immediately select it (a freshly-drawn note with no visible feedback
 * would feel disconnected).
 */
export function addNote(
  song: ParsedSong,
  midi: number,
  time: number,
  duration: number,
  velocity: number,
  track = 0,
): { song: ParsedSong; id: number } {
  const id = nextNoteId(song)
  const note: NoteEvent = {
    id,
    midi: Math.max(0, Math.min(127, Math.round(midi))),
    time: Math.max(0, time),
    duration: Math.max(0.01, duration),
    velocity: Math.max(0.01, Math.min(1, velocity)),
    track,
  }
  const sorted = sortByTime(song.notes.concat(note))
  // Brand-new note "wins" over any same-pitch note it lands on top of.
  const resolved = resolveOverlaps({ ...song, notes: sorted }, [id])
  return { song: resolved, id }
}

/**
 * Cut a note in two at `splitTime`. The original is replaced by a head note
 * (start..splitTime) and a tail note (splitTime..end). No-op if the split
 * lies outside the note. The tail keeps the original's velocity/track; the
 * head's id is recycled from the original so any selection / outline that
 * referenced it stays anchored to the visible left half.
 */
export function splitNote(
  song: ParsedSong,
  id: number,
  splitTime: number,
): { song: ParsedSong; tailId: number } | null {
  const idx = song.notes.findIndex((n) => n.id === id)
  if (idx < 0) return null
  const note = song.notes[idx]
  // Need a minimum sliver on each side, otherwise the split is meaningless.
  const MIN_SPLIT_GAP = 0.02
  if (
    splitTime <= note.time + MIN_SPLIT_GAP ||
    splitTime >= note.time + note.duration - MIN_SPLIT_GAP
  ) {
    return null
  }
  const head: NoteEvent = { ...note, duration: splitTime - note.time }
  const tailId = nextNoteId(song)
  const tail: NoteEvent = {
    ...note,
    id: tailId,
    time: splitTime,
    duration: note.time + note.duration - splitTime,
  }
  const next = song.notes.slice()
  next[idx] = head
  next.push(tail)
  const sorted = sortByTime(next)
  return {
    song: { ...song, notes: sorted, duration: computeDuration(song.duration, sorted) },
    tailId,
  }
}
