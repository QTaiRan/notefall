// Piano: 88 keys, MIDI 21 (A0) .. 108 (C8)
// Top-down flat layout: all keys live in the XY plane.
//   x = lateral position
//   y = position along the keyboard (front=0, back=WHITE_KEY_LENGTH)
//   z = thin extrusion (visually flat from the front camera)
export const MIDI_MIN = 21
export const MIDI_MAX = 108
export const KEY_COUNT = MIDI_MAX - MIDI_MIN + 1 // 88

export const WHITE_KEY_WIDTH = 0.23
export const WHITE_KEY_LENGTH = 1.6
export const BLACK_KEY_WIDTH = 0.13
export const BLACK_KEY_LENGTH = 1.0
export const KEY_THICKNESS = 0.06

const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10])

export function isBlackKey(midi: number): boolean {
  return BLACK_PITCH_CLASSES.has(((midi % 12) + 12) % 12)
}

export type KeyInfo = {
  midi: number
  isBlack: boolean
  whiteIndex: number
  x: number // world-x of key center
  yLocal: number // local-y center within the keyboard group (0 = front edge)
  zCenter: number
  width: number
  length: number
  thickness: number
}

function buildLayout(): { keys: KeyInfo[]; totalWidth: number; whiteCount: number } {
  const keys: KeyInfo[] = []
  let whiteIdx = 0
  const whiteIndices: number[] = new Array(KEY_COUNT).fill(0)
  const isBlackArr: boolean[] = new Array(KEY_COUNT).fill(false)
  for (let i = 0; i < KEY_COUNT; i++) {
    const midi = MIDI_MIN + i
    const black = isBlackKey(midi)
    isBlackArr[i] = black
    if (!black) {
      whiteIndices[i] = whiteIdx
      whiteIdx++
    } else {
      whiteIndices[i] = whiteIdx - 1
    }
  }
  const whiteCount = whiteIdx
  const totalWidth = whiteCount * WHITE_KEY_WIDTH
  const xOffset = -totalWidth / 2 + WHITE_KEY_WIDTH / 2

  for (let i = 0; i < KEY_COUNT; i++) {
    const midi = MIDI_MIN + i
    const black = isBlackArr[i]
    const wi = whiteIndices[i]
    const xWhite = xOffset + wi * WHITE_KEY_WIDTH
    const x = black ? xWhite + WHITE_KEY_WIDTH / 2 : xWhite
    keys.push({
      midi,
      isBlack: black,
      whiteIndex: wi,
      x,
      // Front of keyboard is local-y=0 (visually toward bottom of screen).
      // White key center sits at half-length up from the front.
      // Black key sits at the back portion. We extend it 0.01 past the white
      // key's back edge so there's no sub-pixel sliver of white showing
      // through at the shared edge.
      yLocal: black ? WHITE_KEY_LENGTH - BLACK_KEY_LENGTH / 2 + 0.01 : WHITE_KEY_LENGTH / 2,
      // Black keys clearly in front of white keys (well beyond depth-buffer
      // precision at typical camera distances).
      zCenter: black ? 0.04 : 0,
      width: black ? BLACK_KEY_WIDTH : WHITE_KEY_WIDTH,
      length: black ? BLACK_KEY_LENGTH : WHITE_KEY_LENGTH,
      thickness: KEY_THICKNESS,
    })
  }
  return { keys, totalWidth, whiteCount }
}

export const KEYBOARD_LAYOUT = buildLayout()

export function keyForMidi(midi: number): KeyInfo | null {
  const idx = midi - MIDI_MIN
  if (idx < 0 || idx >= KEY_COUNT) return null
  return KEYBOARD_LAYOUT.keys[idx]
}

// Notes hit the back edge of the keyboard.
export function noteHitYWorld(keyboardYWorld: number): number {
  return keyboardYWorld + WHITE_KEY_LENGTH
}
