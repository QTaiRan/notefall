import { useEffect, useRef, useState } from 'react'
import { recorder } from './recorder'

/**
 * React hook around the recorder singleton. Exposes the current state, the
 * list of stopped recordings, a live elapsed counter (ticks only while
 * recording), and stable handles for every recorder action.
 */
export function useRecorder() {
  const [, setTick] = useState(0)
  useEffect(() => recorder.addListener(() => setTick((n) => n + 1)), [])

  // Smooth elapsed-second counter for the recording badge. Re-armed every
  // time the manager state changes so we don't burn a 250ms wakeup while
  // idle.
  const [elapsed, setElapsed] = useState(0)
  const intervalRef = useRef<number | null>(null)
  useEffect(() => {
    const arm = () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      if (recorder.getState() === 'recording') {
        const update = () => setElapsed(recorder.getElapsedSec())
        update()
        intervalRef.current = window.setInterval(update, 250)
      } else {
        setElapsed(0)
      }
    }
    arm()
    return recorder.addListener(arm)
  }, [])

  return {
    state: recorder.getState(),
    elapsed,
    recordings: recorder.getRecordings(),
    start: () => recorder.start(),
    stop: () => recorder.stop(),
    cancel: () => recorder.cancel(),
    delete: (id: string) => recorder.delete(id),
    rename: (id: string, name: string) => recorder.rename(id, name),
    clearAll: () => recorder.clearAll(),
    download: (id: string) => recorder.download(id),
    toArrayBuffer: (id: string) => recorder.toArrayBuffer(id),
  }
}
