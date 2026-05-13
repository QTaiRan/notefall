import { useEffect, useState } from 'react'
import { audioEngine } from './engine'

/**
 * Polls the engine's clock at rAF rate and returns the playhead's
 * TL_audio time (= wall-clock × rate) — i.e. the actual elapsed
 * audio time. The seek slider / time readout use this so speed
 * automation produces a truthful "elapsed N seconds" reading
 * regardless of how much MIDI-time has advanced.
 */
export function useCurrentTime(): number {
  const [t, setT] = useState(0)
  useEffect(() => {
    let raf = 0
    const loop = () => {
      setT(audioEngine.currentSongTime())
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  return t
}

/**
 * Like `useCurrentTime`, but returns the **display-time** instead —
 * `currentDisplayTime()` = `midiOffset + currentMidiTime`. Used by
 * the Timeline editor for cursor positioning, since the editor's
 * x-axis is in natural MIDI-time (un-stretched by the speed curve).
 */
export function useCurrentDisplayTime(): number {
  const [t, setT] = useState(0)
  useEffect(() => {
    let raf = 0
    const loop = () => {
      setT(audioEngine.currentDisplayTime())
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  return t
}
