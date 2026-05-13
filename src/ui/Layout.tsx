import { useEffect } from 'react'
import { DropZone } from 'react-aria-components'
import { Toolbar } from './Toolbar'
import { Inspector } from './Inspector'
import { Viewport } from './Viewport'
import { TimelineEditor } from './TimelineEditor'
import { ConfirmModal } from './ConfirmModal'
import { LoadingOverlay } from './LoadingOverlay'
import { useStore } from '../store'
import { audioEngine } from '../audio/engine'
import { midiInput } from '../audio/midiInput'
import { isAudioName, useUserAudio } from '../audio/userAudio'
import { parseMidi } from '../midi/parse'
import { importUserAudio, openProjectFromFile } from '../projects/actions'
import { PROJECT_FILE_EXTENSION } from '../projects/types'
import { showAlert } from './confirm'
import { useGlobalShortcuts } from './useGlobalShortcuts'

// Accepted file types. Match case-insensitively so files renamed in
// uppercase (`.NFZ`, `.MID`) still load.
const PROJECT_EXT_RE = new RegExp(
  `${PROJECT_FILE_EXTENSION.replace('.', '\\.')}$`,
  'i',
)
const MIDI_EXT_RE = /\.midi?$/i
const isProjectName = (name: string) => PROJECT_EXT_RE.test(name)
const isMidiName = (name: string) => MIDI_EXT_RE.test(name)

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
    audioEngine.setMidiVolume(settings.midiVolume)
  }, [settings.midiVolume])
  useEffect(() => {
    audioEngine.setMidiEnabled(settings.midiEnabled)
  }, [settings.midiEnabled])
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

  // ── Sync user-provided audio buffer + offset + volume into the engine ──
  // The buffer is a heavy decoded AudioBuffer kept outside the main
  // store; subscribing here (not via a `useStore` selector that returns
  // an object) lets us push it through to the engine without forcing
  // every Layout re-render to re-set it. Offset / volume are normal
  // settings.
  const userAudioBuffer = useUserAudio((s) => s.buffer)
  useEffect(() => {
    audioEngine.setUserAudio(userAudioBuffer)
  }, [userAudioBuffer])
  useEffect(() => {
    audioEngine.setUserAudioOffset(settings.userAudioOffsetSec)
  }, [settings.userAudioOffsetSec])
  useEffect(() => {
    audioEngine.setUserAudioVolume(settings.userAudioVolume)
  }, [settings.userAudioVolume])
  useEffect(() => {
    audioEngine.setMidiOffset(settings.midiOffsetSec)
  }, [settings.midiOffsetSec])
  useEffect(() => {
    audioEngine.setMidiTrim(settings.midiTrimStartSec, settings.midiTrimEndSec)
  }, [settings.midiTrimStartSec, settings.midiTrimEndSec])
  useEffect(() => {
    audioEngine.setUserAudioTrim(
      settings.userAudioTrimStartSec,
      settings.userAudioTrimEndSec,
    )
  }, [settings.userAudioTrimStartSec, settings.userAudioTrimEndSec])
  useEffect(() => {
    audioEngine.setSpeedAutomation(settings.midiSpeedAutomation)
  }, [settings.midiSpeedAutomation])

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
          if (result.kind === 'error') {
            void showAlert({
              title: 'Could not open project',
              message: `"${fileItem.name}" could not be loaded.\n\n${result.message}`,
              tone: 'error',
            })
          }
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
            void showAlert({
              title: 'Could not load MIDI',
              message: `"${fileItem.name}" could not be parsed.\n\n${err instanceof Error ? err.message : String(err)}`,
              tone: 'error',
            })
          }
          return
        }
        if (isAudioName(fileItem.name)) {
          const file = await fileItem.getFile()
          const result = await importUserAudio(file)
          if (result.kind === 'error') {
            void showAlert({
              title: result.title ?? 'Could not load audio',
              message: result.message,
              tone: 'error',
            })
          }
          return
        }
        // Unsupported extension — surface a clear message rather than
        // silently ignoring the drop. Users were left wondering whether
        // the drop registered at all.
        void showAlert({
          title: 'Unsupported file type',
          message: `"${fileItem.name}" is not a supported format. Drop a .nfz project, .mid / .midi, or .mp3 / .wav audio file.`,
          tone: 'error',
        })
      }}
    >
      {({ isDropTarget }) => (
        <>
          <Toolbar />
          {/* Viewport + TimelineEditor stack in a left column so the
              timeline editor sits under the canvas only. The Inspector
              remains a tall right column from Toolbar to bottom — the
              editor never extends under it. */}
          <div className="flex flex-1 overflow-hidden">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <Viewport />
              <TimelineEditor />
            </div>
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
                Drop to load (.mid / .midi / .nfz / .mp3 / .wav)
              </div>
            </div>
          )}
        </>
      )}
    </DropZone>
  )
}
