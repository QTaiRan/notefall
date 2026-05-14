import { now } from '../audio/clock'

/**
 * Channel for "a note was deleted via right-click / eraser drag". Two
 * subscribers consume each event:
 *   1. HitParticles — fires its standard curl-noise particle burst at
 *      the death position via the listener API.
 *   2. FallingNotes — reads the active fading-ghost list each frame and
 *      renders each dying note as an extra instance with a smoothly-
 *      easing alpha multiplier. Same shader as a normal falling note,
 *      so the ghost matches the deleted note's appearance exactly.
 *
 * Bulk-delete paths (Delete/Backspace, programmatic deleteNotes) skip
 * this channel — wholesale deletion shouldn't spawn dozens of overlapping
 * puffs.
 */

export type DyingNote = {
  /** Displayed midi (i.e. note.midi + transpose) at deletion time. */
  midi: number
  /** Stored velocity 0..1 — drives the particle burst's size + speed
   *  scaling so the puff feels proportional to the deleted note's
   *  loudness, the same way a held key's particle column scales with
   *  how hard it was struck. */
  velocity: number
  /** Center X / Y at the moment of deletion (world units). */
  x: number
  centerY: number
  /** Visible width / length at the moment of deletion. */
  width: number
  length: number
  /** Source track index (so the death puff inherits the note's
   *  per-track tint). Undefined for notes that have no track tag. */
  track?: number
}

/** How long the fading ghost is rendered (seconds). Linear ramp from 1
 *  → 0 over this window. Short on purpose — the gesture is "delete",
 *  not "watch a note dissolve" — so the visual hand-off to the
 *  particle puff is snappy. */
export const FADE_DURATION = 0.12

type ActiveGhost = DyingNote & { startTime: number }
type DeathListener = (d: DyingNote) => void

class NoteDeathFxManager {
  private items: ActiveGhost[] = []
  private listeners = new Set<DeathListener>()

  emit(d: DyingNote): void {
    this.items.push({ ...d, startTime: now() })
    for (const fn of this.listeners) fn(d)
  }

  /** Drop ghosts whose fade has completed. Cheap in-place compaction.
   *  Called from FallingNotes' useFrame to keep the list bounded. */
  prune(now: number): void {
    if (this.items.length === 0) return
    let writeIdx = 0
    for (let i = 0; i < this.items.length; i++) {
      if (now - this.items[i].startTime < FADE_DURATION) {
        if (writeIdx !== i) this.items[writeIdx] = this.items[i]
        writeIdx++
      }
    }
    this.items.length = writeIdx
  }

  list(): readonly ActiveGhost[] {
    return this.items
  }

  subscribe(fn: DeathListener): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
}

export const noteDeathFx = new NoteDeathFxManager()
