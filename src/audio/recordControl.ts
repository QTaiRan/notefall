import { audioEngine } from './engine'
import { scheduleCountIn, type CountInHandle } from './click'
import { ensureAudioReady } from './midiInput'
import { recorder } from './recorder'
import { useStore } from '../store'

/**
 * Single entry point for the record button behaviour. Lives outside React
 * so the Toolbar UI button AND the global Shift+R shortcut both go
 * through the same code path — this keeps count-in cancellation, sampler
 * loading, and song-unload logic in one place instead of duplicated.
 *
 * Side-effects on a successful start:
 *   - clears the loaded song so its falling notes don't keep streaming
 *   - schedules the count-in clicks (if enabled in settings)
 *
 * Listeners can subscribe to `addEmptyStopListener` to be notified when
 * Stop was pressed without anything having been captured (the recording
 * is silently discarded by the recorder; the UI typically responds with
 * a brief toast).
 */
export const COUNT_IN_BEATS = 4
export const COUNT_IN_BPM = 100

let activeCountIn: CountInHandle | null = null
const emptyStopListeners = new Set<() => void>()

export function isCountingIn(): boolean {
  return activeCountIn !== null
}

export function addEmptyStopListener(fn: () => void): () => void {
  emptyStopListeners.add(fn)
  return () => emptyStopListeners.delete(fn)
}

function notifyEmptyStop(): void {
  emptyStopListeners.forEach((fn) => fn())
}

export async function toggleRecord(): Promise<void> {
  // Currently recording → stop. Capture event count BEFORE stop because
  // the recorder clears its buffer as part of the stop transition.
  if (recorder.getState() === 'recording') {
    const wasEmpty = recorder.getCurrentEventCount() === 0
    recorder.stop()
    if (wasEmpty) notifyEmptyStop()
    return
  }
  // Currently counting-in → cancel (button feels like a "nope" press).
  if (activeCountIn) {
    activeCountIn.cancel()
    activeCountIn = null
    useStore.getState().setCountInBeat(0)
    return
  }

  // Start path. Make sure the sampler is loaded so the first input note
  // isn't silently dropped while audio races to wake up.
  if (!audioEngine.isReady()) {
    const { setLoadStatus } = useStore.getState()
    setLoadStatus({ state: 'loading', loaded: 0, total: 1 })
    const ok = await ensureAudioReady((loaded, total) =>
      setLoadStatus({ state: 'loading', loaded, total }),
    )
    setLoadStatus(ok ? { state: 'ready' } : { state: 'idle' })
    if (!ok) return
  }

  const { setSong, setTransport, countInEnabled, setCountInBeat } = useStore.getState()
  setSong(null)
  audioEngine.unloadSong()
  setTransport('stopped')

  if (countInEnabled) {
    setCountInBeat(1)
    activeCountIn = scheduleCountIn(
      COUNT_IN_BEATS,
      COUNT_IN_BPM,
      (beat) => useStore.getState().setCountInBeat(beat),
      () => {
        activeCountIn = null
        useStore.getState().setCountInBeat(0)
        recorder.start()
      },
    )
  } else {
    recorder.start()
  }
}
