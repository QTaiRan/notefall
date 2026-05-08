/**
 * Pluggable time source for the audio engine and time-based visual effects.
 *
 * Default: real wall clock (`performance.now() / 1000`). The video exporter
 * (when added) swaps in a virtual clock so the engine + visualizers can be
 * stepped at non-realtime frame intervals deterministically — the same scene
 * is rendered at e.g. 60 fps virtual time regardless of how long each frame
 * actually takes to encode.
 *
 * `now()` returns seconds. The absolute origin is unspecified — only deltas
 * between successive calls are meaningful.
 *
 * The realtime recorder (`audio/recorder.ts`) and live MIDI input
 * (`audio/midiInput.ts`) intentionally still call `performance.now()`
 * directly: they only operate during live user performance, never under a
 * virtualised clock, so virtualising them would only invite drift bugs.
 */
export interface Clock {
  now(): number
}

const realClock: Clock = {
  now: () => performance.now() / 1000,
}

let active: Clock = realClock

export function setActiveClock(clock: Clock): void {
  active = clock
}

export function resetActiveClock(): void {
  active = realClock
}

export function now(): number {
  return active.now()
}

/**
 * Externally-driven clock for offline rendering. The video exporter
 * advances this between frames so every consumer of `now()` (engine,
 * particle systems, hit-line animation, custom-texture animator)
 * sees the same virtual time within a frame, and successive frames
 * land on a deterministic 1/fps grid regardless of how long each
 * actual frame takes to render and encode.
 *
 * `setTime` is preferred over `advance` for offline use: cumulative
 * floating-point error from many tiny `advance` calls would
 * eventually drift the timeline against the underlying song; setting
 * an absolute `frame / fps` keeps each frame's virtual time exact
 * regardless of how many came before it.
 */
export class VirtualClock implements Clock {
  private t = 0
  now(): number {
    return this.t
  }
  setTime(seconds: number): void {
    this.t = seconds
  }
  advance(seconds: number): void {
    this.t += seconds
  }
}
