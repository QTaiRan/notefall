import { audioEngine } from './engine'
import { ensureAudioReady } from './midiInput'
import { useStore } from '../store'

/**
 * Brief preview note for the in-app MIDI editor (click-to-select / drag).
 * Wraps `audioEngine.triggerPreview` with the AudioContext + sampler load
 * dance: if the user opens a MIDI and starts editing without ever pressing
 * Play, the sampler hasn't been initialised yet, and `triggerPreview`
 * would silently no-op. Here we kick off the load (showing the standard
 * loading overlay), then play once it resolves.
 *
 * Must be called from a user-gesture event handler so the AudioContext
 * can resume — Tone.start() inside ensureAudioReady requires it.
 *
 * The first preview after a fresh load may be inaudible because the
 * sample fetch hasn't finished by the time setTimeout fires. Subsequent
 * previews are immediate.
 */
export async function previewNote(midi: number, velocity = 0.7, durationMs = 200): Promise<void> {
  if (midi < 0 || midi > 127) return
  if (!audioEngine.isReady()) {
    const store = useStore.getState()
    store.setLoadStatus({ state: 'loading', loaded: 0, total: 1 })
    const ok = await ensureAudioReady((loaded, total) =>
      useStore.getState().setLoadStatus({ state: 'loading', loaded, total }),
    )
    useStore.getState().setLoadStatus(ok ? { state: 'ready' } : { state: 'idle' })
    if (!ok) return
  }
  audioEngine.triggerPreview(midi, velocity, durationMs)
}
