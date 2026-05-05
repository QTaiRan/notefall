import { Button, DialogTrigger, Dialog, FileTrigger, Popover } from 'react-aria-components'
import { useStore } from '../store'
import { useState } from 'react'
import { audioEngine } from '../audio/engine'
import { pauseSong, playSong } from '../audio/playback'
import { ensureAudioReady } from '../audio/midiInput'
import { useMidiInput } from '../audio/useMidiInput'
import { useRecorder } from '../audio/useRecorder'
import { parseMidi } from '../midi/parse'
import { SAMPLES } from '../samples'
import { DownloadIcon, PauseIcon, PlayIcon, PlaylistIcon, RecordIcon, StopIcon, TrashIcon } from './icons'

function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function fmtCreatedAt(epochMs: number): string {
  const d = new Date(epochMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function Toolbar() {
  const song = useStore((s) => s.song)
  const setSong = useStore((s) => s.setSong)
  const setTransport = useStore((s) => s.setTransport)
  const setLoadStatus = useStore((s) => s.setLoadStatus)
  const midi = useMidiInput()
  const rec = useRecorder()
  const transport = useStore((s) => s.transport)
  // Tracks which recording (if any) is currently loaded as the active
  // song. Lets the per-row button toggle between play (load + play) and
  // pause (stop the running playback) instead of always restarting.
  const [activeRecordingId, setActiveRecordingId] = useState<string | null>(null)

  const onFile = async (file: File) => {
    const buf = await file.arrayBuffer()
    const parsed = await parseMidi(buf, file.name)
    setSong(parsed)
    audioEngine.loadSong(parsed)
    setTransport('stopped')
    setActiveRecordingId(null)
  }

  const onLoadSample = (build: () => ReturnType<typeof parseMidi> extends Promise<infer T> ? T : never) => {
    const parsed = build()
    setSong(parsed)
    audioEngine.loadSong(parsed)
    setTransport('stopped')
    setActiveRecordingId(null)
  }

  // Click handler for the MIDI button — request access on the first open
  // (must be called from a user gesture for the browser permission prompt).
  const onOpenMidiPanel = async () => {
    if (!midi.hasAccess) await midi.requestAccess()
  }

  // Connect to a device. Ensures the AudioContext is running and the sampler
  // is loaded before the first MIDI message arrives so the user doesn't tap
  // a key into silence.
  const onConnect = async (deviceId: string) => {
    if (!audioEngine.isReady()) {
      setLoadStatus({ state: 'loading', loaded: 0, total: 1 })
      const ok = await ensureAudioReady((loaded, total) =>
        setLoadStatus({ state: 'loading', loaded, total }),
      )
      setLoadStatus(ok ? { state: 'ready' } : { state: 'idle' })
      if (!ok) return
    }
    midi.connect(deviceId)
  }

  // Recording requires the AudioContext + sampler so the first input
  // sound captured isn't silently dropped while the load races.
  const onToggleRecord = async () => {
    if (rec.state === 'recording') {
      rec.stop()
      return
    }
    if (!audioEngine.isReady()) {
      setLoadStatus({ state: 'loading', loaded: 0, total: 1 })
      const ok = await ensureAudioReady((loaded, total) =>
        setLoadStatus({ state: 'loading', loaded, total }),
      )
      setLoadStatus(ok ? { state: 'ready' } : { state: 'idle' })
      if (!ok) return
    }
    // Drop any currently-loaded song so the on-screen falling notes from
    // the prior MIDI don't keep streaming through the keyboard while the
    // user is recording fresh input.
    setSong(null)
    audioEngine.unloadSong()
    setTransport('stopped')
    setActiveRecordingId(null)
    rec.start()
  }

  const onLoadRecording = async (id: string, name: string) => {
    const buf = rec.toArrayBuffer(id)
    if (!buf) return
    const parsed = await parseMidi(buf, name)
    setSong(parsed)
    audioEngine.loadSong(parsed)
    setTransport('stopped')
    setActiveRecordingId(id)
    // Start playback automatically — pressing the play-shaped button in
    // the list reads as "play this take", not just "load it and wait".
    await playSong()
  }

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-800 bg-neutral-950 px-3">
      <div className="flex items-center gap-2">
        <span className="flex items-baseline gap-1.5 mr-2">
          <span className="text-sm font-semibold tracking-wide text-neutral-200">notefall</span>
          <span className="font-mono text-[10px] text-neutral-500">v{__APP_VERSION__}</span>
        </span>
        <FileTrigger
          acceptedFileTypes={['.mid', '.midi', 'audio/midi', 'audio/x-midi']}
          onSelect={(files) => {
            const f = files?.[0]
            if (f) onFile(f)
          }}
        >
          <Button className="rounded border border-neutral-700 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-200 outline-none hover:border-neutral-600 focus-visible:border-sky-500">
            Open MIDI
          </Button>
        </FileTrigger>

        {midi.supported && (
          <DialogTrigger>
            <Button
              onPress={onOpenMidiPanel}
              className={
                midi.activeDeviceId
                  ? 'flex items-center gap-1.5 rounded border border-sky-500/60 bg-sky-500/10 px-2.5 py-1 text-xs text-sky-300 outline-none hover:bg-sky-500/20 focus-visible:border-sky-400'
                  : 'flex items-center gap-1.5 rounded border border-neutral-700 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-200 outline-none hover:border-neutral-600 focus-visible:border-sky-500'
              }
            >
              {/* Live dot — solid when a device is connected */}
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  midi.activeDeviceId ? 'bg-sky-400' : 'bg-neutral-600'
                }`}
              />
              MIDI Input
            </Button>
            <Popover
              placement="bottom start"
              className="rounded-lg border border-neutral-700 bg-neutral-900 p-2 shadow-xl outline-none data-[entering]:animate-in data-[entering]:fade-in data-[entering]:duration-150"
            >
              <Dialog className="flex w-64 flex-col gap-1 outline-none">
                <div className="px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                  Input devices
                </div>
                {midi.devices.length === 0 ? (
                  <div className="px-2 py-2 text-xs text-neutral-500">
                    No MIDI devices detected. Plug in a USB MIDI device and reopen.
                  </div>
                ) : (
                  midi.devices.map((d) => {
                    const active = d.id === midi.activeDeviceId
                    return (
                      <Button
                        key={d.id}
                        onPress={() => (active ? midi.connect(null) : onConnect(d.id))}
                        className={
                          active
                            ? 'flex items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs text-sky-300 outline-none hover:bg-neutral-800'
                            : 'flex items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs text-neutral-200 outline-none hover:bg-neutral-800'
                        }
                      >
                        <span className="flex flex-col">
                          <span>{d.name}</span>
                          {d.manufacturer && (
                            <span className="text-[10px] text-neutral-500">{d.manufacturer}</span>
                          )}
                        </span>
                        <span className="text-[10px] text-neutral-500">
                          {active ? 'Disconnect' : 'Connect'}
                        </span>
                      </Button>
                    )
                  })
                )}
              </Dialog>
            </Popover>
          </DialogTrigger>
        )}

        {/* Record / stop / save group. Captures live input (PC keyboard,
            on-screen, MIDI device) into a downloadable .mid. */}
        <div className="ml-2 flex items-center gap-1 border-l border-neutral-800 pl-3">
          <Button
            onPress={onToggleRecord}
            aria-label={rec.state === 'recording' ? 'Stop recording' : 'Start recording'}
            className={
              rec.state === 'recording'
                ? 'flex items-center gap-1.5 rounded border border-rose-500/60 bg-rose-500/10 px-2.5 py-1 text-xs text-rose-300 outline-none hover:bg-rose-500/20 focus-visible:border-rose-400'
                : 'flex items-center gap-1.5 rounded border border-neutral-700 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-200 outline-none hover:border-neutral-600 focus-visible:border-sky-500'
            }
          >
            {rec.state === 'recording' ? (
              <>
                <StopIcon className="h-3 w-3" />
                <span className="font-mono tabular-nums">{fmtElapsed(rec.elapsed)}</span>
              </>
            ) : (
              <>
                <RecordIcon className="h-3 w-3 text-rose-400" />
                Record
              </>
            )}
          </Button>
          <DialogTrigger>
            <Button
              aria-label="Show recordings"
              className="flex items-center justify-center rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-200 outline-none hover:border-neutral-600 focus-visible:border-sky-500"
            >
              <PlaylistIcon className="h-4 w-4" />
            </Button>
            <Popover
              placement="bottom start"
              className="rounded-lg border border-neutral-700 bg-neutral-900 p-2 shadow-xl outline-none data-[entering]:animate-in data-[entering]:fade-in data-[entering]:duration-150"
            >
              <Dialog className="flex w-80 flex-col gap-1 outline-none">
                <div className="flex items-center justify-between px-2 pb-1 pt-0.5">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                    Recordings
                  </span>
                  {rec.recordings.length > 0 && (
                    <Button
                      onPress={() => rec.clearAll()}
                      className="rounded px-1.5 py-0.5 text-[10px] text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
                    >
                      Clear all
                    </Button>
                  )}
                </div>
                {rec.recordings.length === 0 ? (
                  <div className="px-2 py-4 text-center text-xs text-neutral-500">
                    No recordings yet. Press the Record button to capture your input.
                  </div>
                ) : (
                  <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
                    {rec.recordings.map((r) => {
                      const isPlayingThis = r.id === activeRecordingId && transport === 'playing'
                      return (
                        <div
                          key={r.id}
                          className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-neutral-800/60"
                        >
                          <div className="flex flex-1 flex-col overflow-hidden">
                            <span className="truncate text-neutral-200">{r.name}</span>
                            <span className="font-mono text-[10px] text-neutral-500">
                              {fmtCreatedAt(r.createdAt)} · {fmtElapsed(r.duration)}
                            </span>
                          </div>
                          <Button
                            onPress={() =>
                              isPlayingThis ? pauseSong() : onLoadRecording(r.id, r.name)
                            }
                            aria-label={isPlayingThis ? 'Pause playback' : 'Load and play'}
                            className="flex h-6 w-6 items-center justify-center rounded text-sky-300 outline-none hover:bg-sky-500/20 focus-visible:ring-1 focus-visible:ring-sky-400"
                          >
                            {isPlayingThis ? (
                              <PauseIcon className="h-3.5 w-3.5" />
                            ) : (
                              <PlayIcon className="h-3.5 w-3.5" />
                            )}
                          </Button>
                          <Button
                            onPress={() => rec.download(r.id)}
                            aria-label="Save as .mid"
                            className="flex h-6 w-6 items-center justify-center rounded text-neutral-300 outline-none hover:bg-neutral-700 focus-visible:ring-1 focus-visible:ring-sky-400"
                          >
                            <DownloadIcon className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            onPress={() => rec.delete(r.id)}
                            aria-label="Delete recording"
                            className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 outline-none hover:bg-neutral-700 hover:text-neutral-200 focus-visible:ring-1 focus-visible:ring-sky-400"
                          >
                            <TrashIcon className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </Dialog>
            </Popover>
          </DialogTrigger>
        </div>

        <div className="ml-2 flex items-center gap-1 border-l border-neutral-800 pl-3">
          {SAMPLES.map((s) => (
            <Button
              key={s.label}
              onPress={() => onLoadSample(s.build)}
              className="rounded border border-neutral-800 bg-neutral-900/60 px-2 py-1 text-[11px] text-neutral-400 outline-none hover:border-neutral-600 hover:text-neutral-200 focus-visible:border-sky-500"
            >
              {s.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="truncate text-[11px] text-neutral-500">
        {song ? song.name : 'No file loaded'}
      </div>
    </header>
  )
}
