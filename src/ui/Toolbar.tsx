import { Button, DialogTrigger, Dialog, FileTrigger, Popover } from 'react-aria-components'
import { useStore } from '../store'
import { useEffect, useRef, useState } from 'react'
import { audioEngine } from '../audio/engine'
import { pauseSong, playSong } from '../audio/playback'
import { addEmptyStopListener, COUNT_IN_BEATS, toggleRecord as toggleRecordControl } from '../audio/recordControl'
import { ensureAudioReady } from '../audio/midiInput'
import { useMidiInput } from '../audio/useMidiInput'
import { useRecorder } from '../audio/useRecorder'
import { parseMidi } from '../midi/parse'
import { SAMPLES } from '../samples'
import { DownloadIcon, MetronomeIcon, PauseIcon, PlayIcon, PlaylistIcon, RecordIcon, StopIcon, TrashIcon } from './icons'

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
  const countInEnabled = useStore((s) => s.countInEnabled)
  const setCountInEnabled = useStore((s) => s.setCountInEnabled)
  // Mid-count-in beat number from the global record-control module so the
  // shortcut and the toolbar button stay in sync.
  const countInBeat = useStore((s) => s.countInBeat)
  // Tracks which recording (if any) is currently loaded as the active
  // song. Lets the per-row button toggle between play (load + play) and
  // pause (stop the running playback) instead of always restarting.
  const [activeRecordingId, setActiveRecordingId] = useState<string | null>(null)
  // Brief inline notice shown when the user stops a recording without
  // having pressed any keys — the empty take is silently dropped, so
  // without this the Stop click would feel like nothing happened.
  const [emptyToast, setEmptyToast] = useState(false)
  const emptyToastTimerRef = useRef<number | null>(null)
  // Inline rename state for the recordings list.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingDraft, setEditingDraft] = useState('')
  // Two-step delete: first click on trash arms a 2.5s window during which
  // the second click actually deletes. Lets the user undo a mis-click by
  // simply waiting it out or hovering away.
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)
  const confirmingDeleteTimerRef = useRef<number | null>(null)
  useEffect(() => {
    return () => {
      if (confirmingDeleteTimerRef.current !== null) {
        clearTimeout(confirmingDeleteTimerRef.current)
      }
    }
  }, [])
  const armDeleteConfirm = (id: string) => {
    setConfirmingDeleteId(id)
    if (confirmingDeleteTimerRef.current !== null) clearTimeout(confirmingDeleteTimerRef.current)
    confirmingDeleteTimerRef.current = window.setTimeout(() => {
      setConfirmingDeleteId(null)
    }, 2500)
  }
  const onDeleteRecording = (id: string) => {
    if (confirmingDeleteId === id) {
      if (confirmingDeleteTimerRef.current !== null) clearTimeout(confirmingDeleteTimerRef.current)
      setConfirmingDeleteId(null)
      rec.delete(id)
    } else {
      armDeleteConfirm(id)
    }
  }
  useEffect(() => {
    return () => {
      if (emptyToastTimerRef.current !== null) clearTimeout(emptyToastTimerRef.current)
    }
  }, [])

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
  // Whenever the loaded song clears (e.g. record press unloads the prior
  // MIDI), drop the "active recording" highlight so it doesn't outlive
  // the song it referenced.
  useEffect(() => {
    if (!song) setActiveRecordingId(null)
  }, [song])

  // Toast trigger for empty-stop, plumbed via the recordControl module
  // since the stop can also originate from the global Shift+R shortcut.
  useEffect(() => {
    return addEmptyStopListener(() => {
      setEmptyToast(true)
      if (emptyToastTimerRef.current !== null) clearTimeout(emptyToastTimerRef.current)
      emptyToastTimerRef.current = window.setTimeout(() => setEmptyToast(false), 2500)
    })
  }, [])

  const onToggleRecord = () => {
    void toggleRecordControl()
  }

  const onPickRecording = async (id: string, name: string) => {
    const buf = rec.toArrayBuffer(id)
    if (!buf) return
    const parsed = await parseMidi(buf, name)
    setSong(parsed)
    audioEngine.loadSong(parsed)
    setTransport('stopped')
    setActiveRecordingId(id)
  }

  const onLoadAndPlayRecording = async (id: string, name: string) => {
    await onPickRecording(id, name)
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
          <Button
            isDisabled={rec.state === 'recording'}
            className="rounded border border-neutral-700 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-200 outline-none hover:border-neutral-600 focus-visible:border-sky-500 disabled:cursor-not-allowed disabled:border-neutral-800 disabled:bg-neutral-950 disabled:text-neutral-600 disabled:hover:border-neutral-800"
          >
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
        <div className="relative ml-2 flex items-center gap-1 border-l border-neutral-800 pl-3">
          <Button
            onPress={onToggleRecord}
            aria-label={
              rec.state === 'recording'
                ? 'Stop recording'
                : countInBeat > 0
                  ? 'Cancel count-in'
                  : 'Start recording'
            }
            className={
              rec.state === 'recording' || countInBeat > 0
                ? 'flex items-center gap-1.5 rounded border border-rose-500/60 bg-rose-500/10 px-2.5 py-1 text-xs text-rose-300 outline-none hover:bg-rose-500/20 focus-visible:border-rose-400'
                : 'flex items-center gap-1.5 rounded border border-neutral-700 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-200 outline-none hover:border-neutral-600 focus-visible:border-sky-500'
            }
          >
            {countInBeat > 0 ? (
              <>
                <StopIcon className="h-3 w-3" />
                <span className="font-mono tabular-nums">
                  {countInBeat}/{COUNT_IN_BEATS}
                </span>
              </>
            ) : rec.state === 'recording' ? (
              <>
                <StopIcon className="h-3 w-3" />
                <span className="font-mono tabular-nums">{fmtElapsed(rec.elapsed)}</span>
                {rec.noteOnCount > 0 && (
                  <span className="font-mono text-[10px] text-rose-400/80">
                    · {rec.lastNote} · {rec.noteOnCount}
                  </span>
                )}
              </>
            ) : (
              <>
                <RecordIcon className="h-3 w-3 text-rose-400" />
                Record
              </>
            )}
          </Button>
          <Button
            onPress={() => setCountInEnabled(!countInEnabled)}
            isDisabled={rec.state === 'recording' || countInBeat > 0}
            aria-label={countInEnabled ? 'Disable count-in' : 'Enable count-in'}
            className={
              countInEnabled
                ? 'flex items-center justify-center rounded border border-sky-500/60 bg-sky-500/10 px-2 py-1 text-sky-300 outline-none hover:bg-sky-500/20 focus-visible:border-sky-400 disabled:opacity-50'
                : 'flex items-center justify-center rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-400 outline-none hover:border-neutral-600 hover:text-neutral-200 focus-visible:border-sky-500 disabled:opacity-50'
            }
          >
            <MetronomeIcon className="h-4 w-4" />
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
                      const isActive = r.id === activeRecordingId
                      const isPlayingThis = isActive && transport === 'playing'
                      return (
                        <div
                          key={r.id}
                          // Whole-row click = load only (no auto-play).
                          // Clicks that originate on one of the action
                          // buttons are ignored here — those buttons run
                          // their own handler and we don't want the row's
                          // load to fire twice / fight the play action.
                          onClick={(e) => {
                            if ((e.target as HTMLElement).closest('button')) return
                            if (isActive) return
                            onPickRecording(r.id, r.name)
                          }}
                          className={
                            'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs ' +
                            (isActive
                              ? 'bg-sky-500/10 ring-1 ring-inset ring-sky-500/40'
                              : 'hover:bg-neutral-800/60')
                          }
                        >
                          <div className="flex flex-1 flex-col overflow-hidden">
                            {editingId === r.id ? (
                              <input
                                value={editingDraft}
                                autoFocus
                                onChange={(e) => setEditingDraft(e.target.value)}
                                onClick={(e) => e.stopPropagation()}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    const next = editingDraft.trim()
                                    if (next) rec.rename(r.id, next)
                                    setEditingId(null)
                                  } else if (e.key === 'Escape') {
                                    setEditingId(null)
                                  }
                                }}
                                onBlur={() => {
                                  const next = editingDraft.trim()
                                  if (next && next !== r.name) rec.rename(r.id, next)
                                  setEditingId(null)
                                }}
                                className="rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 text-xs text-neutral-100 outline-none focus:border-sky-500"
                              />
                            ) : (
                              <span
                                role="button"
                                tabIndex={0}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setEditingId(r.id)
                                  setEditingDraft(r.name)
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.stopPropagation()
                                    setEditingId(r.id)
                                    setEditingDraft(r.name)
                                  }
                                }}
                                className={
                                  'cursor-text truncate rounded px-0.5 hover:bg-neutral-700/40 ' +
                                  (isActive ? 'text-sky-200' : 'text-neutral-200')
                                }
                                title="Click to rename"
                              >
                                {r.name}
                              </span>
                            )}
                            <span className="font-mono text-[10px] text-neutral-500">
                              {fmtCreatedAt(r.createdAt)} · {fmtElapsed(r.duration)}
                            </span>
                          </div>
                          <Button
                            onPress={() => {
                              if (isPlayingThis) {
                                pauseSong()
                              } else if (isActive) {
                                // Already loaded — just resume audio.
                                void playSong()
                              } else {
                                void onLoadAndPlayRecording(r.id, r.name)
                              }
                            }}
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
                            onPress={() => onDeleteRecording(r.id)}
                            aria-label={
                              confirmingDeleteId === r.id
                                ? 'Confirm delete recording'
                                : 'Delete recording'
                            }
                            className={
                              confirmingDeleteId === r.id
                                ? 'flex h-6 w-6 items-center justify-center rounded bg-rose-500/20 text-rose-300 outline-none ring-1 ring-rose-500/60 hover:bg-rose-500/30 focus-visible:ring-1 focus-visible:ring-rose-400'
                                : 'flex h-6 w-6 items-center justify-center rounded text-neutral-500 outline-none hover:bg-neutral-700 hover:text-neutral-200 focus-visible:ring-1 focus-visible:ring-sky-400'
                            }
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
          {/* Empty-recording toast — shown when Stop is pressed without
              any keystrokes captured. Floats just below the toolbar so it
              doesn't push other controls around. */}
          <div
            aria-live="polite"
            className={`pointer-events-none absolute left-3 top-full z-50 mt-1.5 whitespace-nowrap rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[10px] text-neutral-300 shadow-md transition-opacity duration-200 ${
              emptyToast ? 'opacity-100' : 'opacity-0'
            }`}
          >
            No notes captured — recording was empty
          </div>
        </div>

        <div className="ml-2 flex items-center gap-1 border-l border-neutral-800 pl-3">
          {SAMPLES.map((s) => (
            <Button
              key={s.label}
              isDisabled={rec.state === 'recording'}
              onPress={() => onLoadSample(s.build)}
              className="rounded border border-neutral-800 bg-neutral-900/60 px-2 py-1 text-[11px] text-neutral-400 outline-none hover:border-neutral-600 hover:text-neutral-200 focus-visible:border-sky-500 disabled:cursor-not-allowed disabled:border-neutral-900 disabled:bg-neutral-950 disabled:text-neutral-700 disabled:hover:border-neutral-900 disabled:hover:text-neutral-700"
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
