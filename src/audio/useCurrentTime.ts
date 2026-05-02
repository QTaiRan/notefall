import { useEffect, useState } from 'react'
import { audioEngine } from './engine'

/**
 * Polls the engine's clock at rAF rate and returns the current song time.
 * Used by the seek slider / time readout. Local state — only the consumer
 * re-renders, not the whole tree (we deliberately avoid putting this in
 * the Zustand store).
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
