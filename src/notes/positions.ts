import type { NoteEvent } from '../midi/types'
import type { Settings } from '../store'
import { KEYBOARD_LAYOUT, KEY_COUNT, MIDI_MIN, noteHitYWorld } from '../keyboard/layout'

/**
 * Shared geometry between the renderer (FallingNotes) and the editor
 * (selection / drag / range-select / new-note placement). Keeping the
 * forward equation here means the visual position the user clicks on is
 * exactly the position the editor reasons about — no drift, no transform
 * rounding mismatches.
 *
 * Forward equation (matches FallingNotes' useFrame):
 *   For 'down' fall direction:
 *     headY = hitY + ((note.time - currentTime) / fall) * FALL_DISTANCE
 *   For 'up':
 *     headY = hitY + ((currentTime - note.time) / fall) * FALL_DISTANCE
 *
 * FALL_DISTANCE is derived from the camera so it tracks any FOV / camera
 * distance change automatically.
 */

// Buffer (world units) above the visible top edge where a note's spawn
// position sits — keeps a note off-screen the moment before it slides in.
// MUST stay in sync with FallingNotes.tsx's SPAWN_BUFFER.
const SPAWN_BUFFER = 1.0

export function frustumTop(settings: Settings): number {
  const camDist = Math.abs(settings.cameraPos[2])
  const halfVis = camDist * Math.tan((settings.cameraFov * Math.PI) / 360)
  return settings.cameraLookAt[1] + halfVis
}

export function frustumBottom(settings: Settings): number {
  const camDist = Math.abs(settings.cameraPos[2])
  const halfVis = camDist * Math.tan((settings.cameraFov * Math.PI) / 360)
  return settings.cameraLookAt[1] - halfVis
}

export function fallDistance(settings: Settings): number {
  const hitY = noteHitYWorld(settings.keyboardY)
  return Math.max(0.5, frustumTop(settings) - hitY) + SPAWN_BUFFER
}

/**
 * World Y of a click → song time, accounting for fall direction. Used by
 * "double-click empty space to add a note" so the new note lands exactly
 * where the user pointed.
 */
export function clickYToTime(y: number, currentTime: number, settings: Settings): number {
  const hitY = noteHitYWorld(settings.keyboardY)
  const headT = ((y - hitY) / fallDistance(settings)) * settings.fallDurationSec
  return settings.fallDirection === 'down' ? currentTime + headT : currentTime - headT
}

/**
 * World X of a click → MIDI pitch. Returns the displayed midi WITHOUT the
 * transpose applied, so storing it in `note.midi` and adding `transpose`
 * back at render time reproduces the clicked X. Picks the nearest key by
 * absolute X distance — black keys are narrower so the threshold naturally
 * favors them when the click is near their center.
 */
export function clickXToMidi(x: number, transpose: number): number {
  let bestMidi = MIDI_MIN
  let bestDist = Infinity
  for (let i = 0; i < KEY_COUNT; i++) {
    const k = KEYBOARD_LAYOUT.keys[i]
    const d = Math.abs(k.x - x)
    if (d < bestDist) {
      bestDist = d
      bestMidi = k.midi
    }
  }
  return bestMidi - transpose
}

/**
 * Inverse of clickYToTime — used by range-select to know where each note's
 * head currently sits on screen. Mirrors the `headY` line above.
 */
export function timeToHeadY(time: number, currentTime: number, settings: Settings): number {
  const hitY = noteHitYWorld(settings.keyboardY)
  const fd = fallDistance(settings)
  const headT = settings.fallDirection === 'down' ? time - currentTime : currentTime - time
  return hitY + (headT / settings.fallDurationSec) * fd
}

/**
 * World X for a given displayed midi (i.e. `note.midi + transpose`). Returns
 * null when the midi is outside the keyboard so callers can skip drawing.
 */
export function midiToX(displayedMidi: number): number | null {
  const idx = displayedMidi - MIDI_MIN
  if (idx < 0 || idx >= KEY_COUNT) return null
  return KEYBOARD_LAYOUT.keys[idx].x
}

/**
 * Axis-aligned world bounds of a note's *visible* rectangle at `currentTime`,
 * exactly mirroring the geometry FallingNotes assembles per frame. Returns
 * null when the note is outside the keyboard or has scrolled fully past
 * the hit line / hasn't yet appeared. Used by range-select to test
 * rectangle overlap against the same shape the user sees.
 *
 * Mirroring the renderer is critical: the renderer applies a `noteMinLength`
 * floor so very short notes stay visible, which means a note's visual
 * bounds are not always its natural bounds. A naive (head, head + duration)
 * test would miss those puffed-up bars.
 */
export function noteVisualBounds(
  note: NoteEvent,
  currentTime: number,
  settings: Settings,
): { xMin: number; xMax: number; yMin: number; yMax: number } | null {
  const idx = note.midi + settings.transpose - MIDI_MIN
  if (idx < 0 || idx >= KEY_COUNT) return null
  const key = KEYBOARD_LAYOUT.keys[idx]
  const width = key.width * settings.noteWidthScale
  const halfWidth = width / 2

  const hitY = noteHitYWorld(settings.keyboardY)
  const fd = fallDistance(settings)
  const fall = settings.fallDurationSec
  const minLength = Math.max(0.01, settings.noteMinLength)

  let bottomY: number
  let topY: number
  if (settings.fallDirection === 'down') {
    const headT = note.time - currentTime
    const tailT = headT + note.duration
    if (headT > fall) return null
    const headY = hitY + (headT / fall) * fd
    const tailY = hitY + (tailT / fall) * fd
    const visualLength = Math.max(minLength, tailY - headY)
    bottomY = headY
    topY = bottomY + visualLength
    if (topY <= hitY) return null
  } else {
    const headT = currentTime - note.time
    if (headT < 0) return null
    const tailT = headT - note.duration
    const headY = hitY + (headT / fall) * fd
    const tailY = hitY + (tailT / fall) * fd
    topY = headY
    const visualLength = Math.max(minLength, headY - tailY)
    bottomY = topY - visualLength
    if (topY <= hitY) return null
  }

  return {
    xMin: key.x - halfWidth,
    xMax: key.x + halfWidth,
    yMin: bottomY,
    yMax: topY,
  }
}
