import { useEffect, useState } from 'react'
import { Toolbar } from './Toolbar'
import { Inspector } from './Inspector'
import { SeekBar } from './SeekBar'
import { Viewport } from './Viewport'
import { LoadingOverlay } from './LoadingOverlay'
import { useStore } from '../store'
import { audioEngine } from '../audio/engine'

export function Layout() {
  const settings = useStore((s) => s.settings)
  const transport = useStore((s) => s.transport)
  const loop = useStore((s) => s.loop)
  const [currentTime, setCurrentTime] = useState(0)

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
    audioEngine.setLoop(loop)
  }, [loop])

  // poll engine time for UI display (the 3D scene reads it directly)
  useEffect(() => {
    let raf = 0
    const loop = () => {
      setCurrentTime(audioEngine.currentSongTime())
      // also sync transport state if engine auto-stopped
      if (transport === 'playing' && !audioEngine.isPlaying()) {
        useStore.getState().setTransport('stopped')
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
      <SeekBar currentTime={currentTime} />
      <LoadingOverlay />
    </div>
  )
}
