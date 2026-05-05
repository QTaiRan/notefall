import * as Tone from 'tone'

/**
 * Lightweight metronome click scheduler. Uses Tone's underlying
 * AudioContext directly (bypassing the sampler chain) so the click is
 * dry, immediate, and never colours the recorded audio output.
 *
 * Each beat is a brief sine pulse with a ~70 ms exponential decay. The
 * first beat (downbeat) plays a higher pitch so the user can hear "1".
 */

export type CountInHandle = {
  /** Cancel any remaining beats and the onComplete callback. */
  cancel: () => void
}

const DOWNBEAT_HZ = 1500
const UPBEAT_HZ = 1000
const PEAK_GAIN = 0.3
const ATTACK_S = 0.005
const DECAY_S = 0.07

/**
 * Schedule `beats` evenly-spaced clicks at the given BPM, then call
 * `onComplete` immediately after the last beat finishes. `onBeat` fires
 * once per beat (1-indexed) at the audible time of that beat — useful for
 * driving a UI countdown that stays in sync with the audio.
 */
export function scheduleCountIn(
  beats: number,
  bpm: number,
  onBeat?: (beatIndex: number) => void,
  onComplete?: () => void,
): CountInHandle {
  const ctx = Tone.getContext().rawContext as unknown as AudioContext
  const beatSec = 60 / bpm
  // Small lookahead so the first beat lands cleanly on a buffer boundary
  // instead of mid-quantum (avoids the audible click we'd otherwise get
  // from the very pulse meant to be the metronome click itself).
  const startCtxTime = ctx.currentTime + 0.05
  const oscNodes: OscillatorNode[] = []
  const timeouts: number[] = []
  let cancelled = false

  for (let i = 0; i < beats; i++) {
    const time = startCtxTime + i * beatSec
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = i === 0 ? DOWNBEAT_HZ : UPBEAT_HZ
    osc.connect(gain).connect(ctx.destination)
    gain.gain.setValueAtTime(0.0001, time)
    gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, time + ATTACK_S)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + DECAY_S)
    osc.start(time)
    osc.stop(time + DECAY_S + 0.01)
    oscNodes.push(osc)

    if (onBeat) {
      const delayMs = Math.max(0, (time - ctx.currentTime) * 1000)
      timeouts.push(window.setTimeout(() => {
        if (!cancelled) onBeat(i + 1)
      }, delayMs))
    }
  }

  if (onComplete) {
    const completeMs = Math.max(0, (startCtxTime + beats * beatSec - ctx.currentTime) * 1000)
    timeouts.push(window.setTimeout(() => {
      if (!cancelled) onComplete()
    }, completeMs))
  }

  return {
    cancel: () => {
      cancelled = true
      for (const t of timeouts) clearTimeout(t)
      for (const osc of oscNodes) {
        try { osc.stop() } catch { /* already stopped */ }
      }
    },
  }
}
