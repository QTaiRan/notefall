import { audioEngine } from './engine'
import { scheduleCountIn, type CountInHandle } from './click'
import { ensureAudioReady } from './midiInput'
import { recorder } from './recorder'
import { useStore } from '../store'
import { track } from '../usage'
import type { ParsedSong } from '../midi/types'

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

// Snapshot of the song that was loaded when Record was pressed. Stashed
// at start so we can restore it if (a) the recording finishes empty
// (no notes captured), or (b) the user cancels the count-in by pressing
// Record again. Without this, an accidental Record press silently
// destroys whatever the user had open. Cleared on a successful
// non-empty stop — there the recorder's auto-load takes over.
let preRecordSnapshot: { song: ParsedSong; wasClean: boolean } | null = null

function restorePreRecordSnapshot(): void {
  if (!preRecordSnapshot) return
  const { song, wasClean } = preRecordSnapshot
  preRecordSnapshot = null
  const store = useStore.getState()
  store.setSong(song)
  audioEngine.loadSong(song)
  store.setTransport('stopped')
  // setSong now rebases the dirty hash so a fresh load reads as
  // clean. If the prior session was already dirty (unsaved edits
  // before the user pressed Record), restore that bit so the
  // unsaved indicator stays accurate; clean sessions are already
  // in the right state.
  if (!wasClean) store.markDirty()
}

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
    track('record_finished', { outcome: wasEmpty ? 'empty' : 'saved' })
    if (wasEmpty) {
      // Nothing was captured — put the user's previous song back so
      // an accidental Record press isn't a silent way to lose work.
      restorePreRecordSnapshot()
      notifyEmptyStop()
    } else {
      // A take was finalized; the recorder's `addFinalizedListener`
      // (Toolbar) auto-loads it as the active song, so the snapshot is
      // no longer needed. Drop it so a *future* empty record doesn't
      // resurrect a stale song.
      preRecordSnapshot = null
    }
    return
  }
  // Currently counting-in → cancel (button feels like a "nope" press).
  if (activeCountIn) {
    activeCountIn.cancel()
    activeCountIn = null
    track('record_finished', { outcome: 'cancelled_countin' })
    useStore.getState().setCountInBeat(0)
    // Cancelled before any recording happened; restore for the same
    // reason we do on empty stop — pressing Record then bailing out
    // shouldn't destroy the loaded song.
    restorePreRecordSnapshot()
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

  const state = useStore.getState()
  // Capture the pre-record song (if any) BEFORE clearing it — that's
  // what we'll restore on empty-stop / count-in-cancel. `wasClean`
  // tracks whether the song was a saved project so the dirty indicator
  // stays accurate across the round-trip.
  preRecordSnapshot = state.song
    ? { song: state.song, wasClean: !state.dirty }
    : null

  const { setSong, setTransport, countInEnabled, setCountInBeat } = state
  // Only clear if there's actually something to clear. `setSong(null)`
  // unconditionally flips `dirty: true`, which would falsely surface
  // the "Unsaved" badge when the user records nothing on a fresh New
  // project — there was no song to begin with, so the empty stop
  // should leave the project in its clean state.
  if (state.song) {
    setSong(null)
    audioEngine.unloadSong()
  }
  setTransport('stopped')

  track('record_started', { count_in: countInEnabled })

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
