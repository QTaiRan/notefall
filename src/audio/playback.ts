import { useStore } from '../store'
import { audioEngine } from './engine'

/**
 * Shared play/pause/toggle helpers used by the bottom transport bar and the
 * click-to-toggle area in the falling-notes region. All store mutations and
 * sampler init flow through here so the two entry points stay in sync.
 */

export async function playSong(): Promise<void> {
  const { song, loadStatus, setLoadStatus, setTransport } = useStore.getState()
  if (!song) return
  if (loadStatus.state !== 'ready') {
    setLoadStatus({ state: 'loading', loaded: 0, total: 1 })
    await audioEngine.init((p) =>
      setLoadStatus({ state: 'loading', loaded: p.loaded, total: p.total }),
    )
    setLoadStatus({ state: 'ready' })
  }
  await audioEngine.play()
  setTransport('playing')
}

export function pauseSong(): void {
  audioEngine.pause()
  useStore.getState().setTransport('paused')
}

export async function togglePlayback(): Promise<void> {
  const { transport, song, loadStatus } = useStore.getState()
  if (!song || loadStatus.state === 'loading') return
  if (transport === 'playing') pauseSong()
  else await playSong()
}
