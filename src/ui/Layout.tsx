import { useEffect } from 'react'
import { DropZone } from 'react-aria-components'
import { Toolbar } from './Toolbar'
import { Inspector } from './Inspector'
import { Viewport } from './Viewport'
import { ConfirmModal } from './ConfirmModal'
import { LoadingOverlay } from './LoadingOverlay'
import { useStore } from '../store'
import { audioEngine } from '../audio/engine'
import { midiInput } from '../audio/midiInput'
import { parseMidi } from '../midi/parse'
import { openProjectFromFile } from '../projects/actions'
import { PROJECT_FILE_EXTENSION } from '../projects/types'
import { useGlobalShortcuts } from './useGlobalShortcuts'

const isProjectName = (name: string) =>
  name.toLowerCase().endsWith(PROJECT_FILE_EXTENSION)
const isMidiName = (name: string) => /\.midi?$/i.test(name)

export function Layout() {
  const settings = useStore((s) => s.settings)
  const transport = useStore((s) => s.transport)
  const loop = useStore((s) => s.loop)
  useGlobalShortcuts()

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
    // App-wide DropZone. Wrapping the entire Layout means a drop
    // anywhere — Toolbar, Inspector, or canvas — routes the file. The
    // earlier Viewport-scoped DropZone left users dropping onto the
    // wrong surface with nothing happening.
    <DropZone
      className="relative flex h-full w-full flex-col bg-neutral-950 outline-none"
      // Accept every file drop. react-aria's `DragTypes.has('Files')`
      // does NOT match native file drops the way HTML's
      // `dataTransfer.types.includes('Files')` does — it checks the
      // underlying MIME-type set, not the OS sentinel — so a `'Files'`
      // gate would always cancel and the DropZone would silently never
      // fire. We accept any drop here and filter by file extension in
      // `onDrop` below.
      getDropOperation={() => 'copy'}
      onDrop={async (e) => {
        const fileItem = e.items.find((item) => item.kind === 'file')
        if (!fileItem || fileItem.kind !== 'file') return
        if (isProjectName(fileItem.name)) {
          const file = await fileItem.getFile()
          const result = await openProjectFromFile(file)
          if (result.kind === 'error') window.alert(result.message)
          return
        }
        if (isMidiName(fileItem.name)) {
          const file = await fileItem.getFile()
          try {
            const buf = await file.arrayBuffer()
            const parsed = await parseMidi(buf, file.name)
            const store = useStore.getState()
            store.setSong(parsed)
            audioEngine.loadSong(parsed)
            store.setTransport('stopped')
          } catch (err) {
            window.alert(
              `MIDI parse failed: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
        // Unknown extensions — silently ignored.
      }}
    >
      {({ isDropTarget }) => (
        <>
          <Toolbar />
          <div className="flex flex-1 overflow-hidden">
            <Viewport />
            <Inspector />
          </div>
          <LoadingOverlay />
          <ConfirmModal />
          {/* Drop indicator. `pointer-events-none` so the DropZone
              underneath still receives the drop event regardless of
              which UI surface the user releases on. */}
          {isDropTarget && (
            <div
              aria-hidden
              className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-sky-500/10 backdrop-blur-sm"
            >
              <div className="rounded-md border border-sky-500/40 bg-black/55 px-5 py-3 text-sm font-medium text-sky-100 shadow-lg backdrop-blur-md">
                Drop to load (.mid / .midi / .nfz)
              </div>
            </div>
          )}
        </>
      )}
    </DropZone>
  )
}
