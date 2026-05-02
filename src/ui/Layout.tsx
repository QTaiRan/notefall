import { useEffect } from 'react'
import { Toolbar } from './Toolbar'
import { Inspector } from './Inspector'
import { Viewport } from './Viewport'
import { LoadingOverlay } from './LoadingOverlay'
import { useStore } from '../store'
import { audioEngine } from '../audio/engine'

export function Layout() {
  const settings = useStore((s) => s.settings)
  const transport = useStore((s) => s.transport)
  const loop = useStore((s) => s.loop)

  // sync engine settings
  useEffect(() => {
    audioEngine.setVolumeDb(settings.volume)
  }, [settings.volume])
  useEffect(() => {
    audioEngine.setRate(settings.playbackRate)
  }, [settings.playbackRate])
  useEffect(() => {
    audioEngine.setPedalEnabled(settings.pedalEnabled)
  }, [settings.pedalEnabled])
  useEffect(() => {
    audioEngine.setReverbMix(settings.reverbMix)
  }, [settings.reverbMix])
  useEffect(() => {
    audioEngine.setReverbSize(settings.reverbSize)
  }, [settings.reverbSize])
  useEffect(() => {
    audioEngine.setLoop(loop)
  }, [loop])

  // sync transport state if engine auto-stopped at end-of-song
  useEffect(() => {
    if (transport !== 'playing') return
    let raf = 0
    const loop = () => {
      if (!audioEngine.isPlaying()) {
        useStore.getState().setTransport('stopped')
        return
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [transport])

  return (
    <div className="flex h-full w-full flex-col bg-neutral-950">
      <Toolbar />
      <div className="flex flex-1 overflow-hidden">
        <Viewport />
        <Inspector />
      </div>
      <LoadingOverlay />
    </div>
  )
}
