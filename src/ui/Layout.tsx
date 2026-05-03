import { useEffect } from 'react'
import { Toolbar } from './Toolbar'
import { Inspector } from './Inspector'
import { Viewport } from './Viewport'
import { LoadingOverlay } from './LoadingOverlay'
import { useStore } from '../store'
import { audioEngine } from '../audio/engine'
import { midiInput } from '../audio/midiInput'

export function Layout() {
  const settings = useStore((s) => s.settings)
  const transport = useStore((s) => s.transport)
  const loop = useStore((s) => s.loop)

  // sync engine settings
  useEffect(() => {
    audioEngine.setVolume(settings.volume)
  }, [settings.volume])
  useEffect(() => {
    audioEngine.setRate(settings.playbackRate)
  }, [settings.playbackRate])
  useEffect(() => {
    audioEngine.setPedalEnabled(settings.pedalEnabled)
  }, [settings.pedalEnabled])
  useEffect(() => {
    audioEngine.setReverbEnabled(settings.reverbEnabled)
  }, [settings.reverbEnabled])
  useEffect(() => {
    audioEngine.setReverbDry(settings.reverbDry)
  }, [settings.reverbDry])
  useEffect(() => {
    audioEngine.setReverbWet(settings.reverbWet)
  }, [settings.reverbWet])
  useEffect(() => {
    audioEngine.setReverbSize(settings.reverbSize)
  }, [settings.reverbSize])
  useEffect(() => {
    audioEngine.setReverbDecayTime(settings.reverbDecayTime)
  }, [settings.reverbDecayTime])
  useEffect(() => {
    audioEngine.setReverbDecay(settings.reverbDecay)
  }, [settings.reverbDecay])
  useEffect(() => {
    audioEngine.setReverbPreDelay(settings.reverbPreDelay)
  }, [settings.reverbPreDelay])
  useEffect(() => {
    audioEngine.setReverbDamping(settings.reverbDamping)
  }, [settings.reverbDamping])
  useEffect(() => {
    audioEngine.setReverbHiCut(settings.reverbHiCut)
  }, [settings.reverbHiCut])
  useEffect(() => {
    audioEngine.setReverbLowCut(settings.reverbLowCut)
  }, [settings.reverbLowCut])
  useEffect(() => {
    audioEngine.setReleaseTime(settings.releaseTime)
  }, [settings.releaseTime])
  useEffect(() => {
    audioEngine.setDetune(settings.samplerDetune)
  }, [settings.samplerDetune])
  useEffect(() => {
    settings.eqBands.forEach((db, i) => audioEngine.setEqBand(i, db))
  }, [settings.eqBands])
  useEffect(() => {
    audioEngine.setVelocityGamma(settings.velocityGamma)
  }, [settings.velocityGamma])
  useEffect(() => {
    audioEngine.setVelocityFloor(settings.velocityFloor)
  }, [settings.velocityFloor])
  useEffect(() => {
    audioEngine.setVelocityCap(settings.velocityCap)
  }, [settings.velocityCap])
  // Transpose is applied at TWO independent stages — engine handles song
  // notes, midiInput handles live MIDI input — so the value goes to both.
  // Screen-keyboard / PC-keyboard touches stay un-shifted.
  useEffect(() => {
    audioEngine.setTranspose(settings.transpose)
    midiInput.setTranspose(settings.transpose)
  }, [settings.transpose])
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
