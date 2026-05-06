import {
  Button,
  Dialog,
  DialogTrigger,
  Header,
  Menu,
  MenuItem,
  MenuSection,
  MenuTrigger,
  Popover,
  Separator,
  SubmenuTrigger,
} from 'react-aria-components'
import { useStore } from '../store'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { audioEngine } from '../audio/engine'
import { pauseSong, playSong } from '../audio/playback'
import { recorder } from '../audio/recorder'
import { addEmptyStopListener, COUNT_IN_BEATS, toggleRecord as toggleRecordControl } from '../audio/recordControl'
import { ensureAudioReady } from '../audio/midiInput'
import { useMidiInput } from '../audio/useMidiInput'
import { useRecorder } from '../audio/useRecorder'
import { parseMidi } from '../midi/parse'
import { newProject, openProject, openRecent, saveProject, saveProjectAs } from '../projects/actions'
import { hasFileSystemAccess } from '../projects/io'
import { clearAllRecent, getRecent, subscribeRecent } from '../projects/recent'
import { SAMPLES } from '../samples'
import { showAlert } from './confirm'
import { DownloadIcon, MetronomeIcon, PauseIcon, PlayIcon, PlaylistIcon, RecordIcon, StopIcon, TrashIcon } from './icons'

// Display modifier symbols for the File menu's keyboard hints. Mac uses
// the standard ⌘ / ⇧ glyphs; everywhere else falls back to "Ctrl+ /
// Shift+" word labels so the hint reads naturally on Windows and Linux.
const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '')
const SHORTCUT_OPEN = IS_MAC ? '⌘O' : 'Ctrl+O'
const SHORTCUT_SAVE = IS_MAC ? '⌘S' : 'Ctrl+S'
const SHORTCUT_SAVE_AS = IS_MAC ? '⇧⌘S' : 'Ctrl+Shift+S'

// Whether to surface the Recent submenu. Recent files rely on persisted
// `FileSystemFileHandle`s — Safari / Firefox can't reopen by handle, so
// the section would be a dead end for those users. Detected once at
// module load since FSA support doesn't change at runtime.
const RECENT_AVAILABLE = hasFileSystemAccess()

// GitHub repo for the Help menu's bug / feature / browse links. Kept as
// a constant rather than read from package.json at runtime — the repo
// URL doesn't change without a code change anyway, and a constant keeps
// the bundle from pulling extra metadata.
const REPO_URL = 'https://github.com/ekkx/notefall'

/**
 * Diagnostic info auto-attached to bug reports / feature requests.
 *
 * Kept intentionally narrow: only browser / OS / viewport / FSA support
 * — nothing about the user's notes, recordings, or settings. The
 * environment field in the issue template renders this as a code block
 * so it stays visually distinct from the user's prose. Reads `window`
 * lazily so the template URL is only built when the menu item fires
 * (irrelevant in practice but cheap to do right).
 */
function buildEnvironmentBlock(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'
  const w = typeof window !== 'undefined' ? window.innerWidth : 0
  const h = typeof window !== 'undefined' ? window.innerHeight : 0
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1
  const fsa = hasFileSystemAccess() ? 'yes' : 'no'
  return [
    `notefall: v${__APP_VERSION__}`,
    `User-Agent: ${ua}`,
    `Viewport: ${w}×${h} (DPR ${dpr})`,
    `File System Access: ${fsa}`,
  ].join('\n')
}

/**
 * Build a "new issue" URL with the given form template, pre-filling
 * the `environment` field. Pre-fill works because `bug.yml` and
 * `feature.yml` both expose a textarea with `id: environment` — query
 * parameters with matching ids populate the corresponding form field
 * (see GitHub Docs: "Syntax for issue forms").
 */
function buildIssueUrl(template: 'bug' | 'feature'): string {
  const env = encodeURIComponent(buildEnvironmentBlock())
  return `${REPO_URL}/issues/new?template=${template}.yml&environment=${env}`
}

const openExternal = (url: string) => {
  // `noopener,noreferrer` keeps the new tab from getting `window.opener`
  // back to the app — standard hygiene for any externally-controlled
  // URL even though our destinations are hard-coded.
  window.open(url, '_blank', 'noopener,noreferrer')
}

// Shared className strings for File menu items. Centralised so the three
// project items, the MIDI import, and the demo-song items stay visually
// consistent when something changes.
const menuItemClass =
  'flex cursor-pointer items-center justify-between gap-6 rounded px-2 py-1.5 text-xs text-neutral-200 outline-none data-[focused]:bg-neutral-800 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50'
const menuShortcutClass = 'font-mono text-[10px] text-neutral-500'

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
  const currentFile = useStore((s) => s.currentFile)
  const dirty = useStore((s) => s.dirty)
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

  // MenuItem replaces the old FileTrigger button, so we open the file
  // picker programmatically from the click handler. Same accept list
  // FileTrigger was using.
  const onOpenMidi = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.mid,.midi,audio/midi,audio/x-midi'
    input.onchange = () => {
      const f = input.files?.[0]
      if (f) void onFile(f)
    }
    input.click()
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

  // Auto-load a finalized recording as the current song. Record start
  // already cleared the previous song (recordControl.ts: setSong(null) +
  // unloadSong) so this just fills the empty slot — the user's project
  // song is not at risk of being silently overwritten by stop.
  useEffect(() => {
    return recorder.addFinalizedListener((r) => {
      void (async () => {
        const buf = recorder.toArrayBuffer(r.id)
        if (!buf) return
        const parsed = await parseMidi(buf, r.name)
        setSong(parsed)
        audioEngine.loadSong(parsed)
        setTransport('stopped')
        setActiveRecordingId(r.id)
      })()
    })
  }, [setSong, setTransport])

  const onToggleRecord = () => {
    void toggleRecordControl()
  }

  // Project actions. Dirty-confirm for `newProject` and `openProject`
  // lives inside the action itself so the keyboard shortcut path
  // (Cmd+O in useGlobalShortcuts) stays in sync with the menu path.
  // Shared error surface for project actions. Wraps the in-app alert
  // modal so the loading-modal visual language is preserved (vs the
  // jarring native window.alert popup).
  const reportError = (title: string, message: string) =>
    void showAlert({ title, message, tone: 'error' })

  const onNewProject = async () => {
    const result = await newProject()
    if (result.kind === 'ok') setActiveRecordingId(null)
  }
  const onOpenProject = async () => {
    const result = await openProject()
    if (result.kind === 'error') reportError('Could not open project', result.message)
    else if (result.kind === 'ok') setActiveRecordingId(null)
  }
  const onSaveProject = async () => {
    const result = await saveProject()
    if (result.kind === 'error') reportError('Could not save project', result.message)
  }
  const onSaveProjectAs = async () => {
    const result = await saveProjectAs()
    if (result.kind === 'error') reportError('Could not save project', result.message)
  }
  // Recents subscription — empty array on browsers without FSA since
  // `addRecent` no-ops there, so the submenu naturally hides itself
  // via the recents.length === 0 check below.
  const recents = useSyncExternalStore(subscribeRecent, getRecent, getRecent)
  const onOpenRecent = async (entry: (typeof recents)[number]) => {
    const result = await openRecent(entry)
    if (result.kind === 'error') reportError('Could not open project', result.message)
    else if (result.kind === 'ok') setActiveRecordingId(null)
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
      {/* Section spacing: every border-l divider has 12px (`pl-3` /
          `pr-3`) padding on BOTH sides. The outer flex therefore runs
          gap-less; intra-section spacing comes from each section's own
          flex gap. Result: every border has symmetric room around it
          and the toolbar's visual rhythm stays even. */}
      <div className="flex items-center">
        {/* Section 1 — branding + file ops. No left border (it sits at
            the toolbar's start), so only `pr-3` to leave 12px before
            the next divider. */}
        <div className="flex items-center gap-2 pr-3">
        <span className="flex items-baseline gap-1.5">
          <span className="text-sm font-semibold tracking-wide text-neutral-200">notefall</span>
          <span className="font-mono text-[10px] text-neutral-500">v{__APP_VERSION__}</span>
        </span>

        {/* File menu — single entry point for everything that loads or
            saves a song-bearing payload. Project ops (.nfz round-trip),
            raw MIDI import, and the bundled demo songs all live here so
            the toolbar stays narrow. The whole menu is disabled during
            recording to keep the active take from being clobbered by a
            mid-capture song swap. */}
        <MenuTrigger>
          <Button
            isDisabled={rec.state === 'recording'}
            className="rounded border border-neutral-700 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-200 outline-none hover:border-neutral-600 focus-visible:border-sky-500 data-[pressed]:bg-neutral-800 disabled:cursor-not-allowed disabled:border-neutral-800 disabled:bg-neutral-950 disabled:text-neutral-600 disabled:hover:border-neutral-800"
          >
            File
          </Button>
          <Popover
            placement="bottom start"
            className="rounded-lg border border-neutral-700 bg-neutral-900 p-1 shadow-xl outline-none data-[entering]:animate-in data-[entering]:fade-in data-[entering]:duration-150"
          >
            <Menu
              aria-label="File"
              className="flex w-60 flex-col gap-0.5 outline-none"
            >
              <MenuItem
                onAction={() => void onNewProject()}
                textValue="New"
                className={menuItemClass}
              >
                <span>New</span>
              </MenuItem>
              <MenuItem
                onAction={() => void onOpenProject()}
                textValue="Open"
                className={menuItemClass}
              >
                <span>Open…</span>
                <span className={menuShortcutClass}>{SHORTCUT_OPEN}</span>
              </MenuItem>
              {RECENT_AVAILABLE && recents.length > 0 && (
                <SubmenuTrigger>
                  <MenuItem className={menuItemClass} textValue="Open Recent">
                    <span>Open Recent</span>
                    <span className={menuShortcutClass}>▸</span>
                  </MenuItem>
                  <Popover
                    placement="end top"
                    className="rounded-lg border border-neutral-700 bg-neutral-900 p-1 shadow-xl outline-none data-[entering]:animate-in data-[entering]:fade-in data-[entering]:duration-150"
                  >
                    <Menu
                      aria-label="Open Recent"
                      className="flex w-64 flex-col gap-0.5 outline-none"
                    >
                      {recents.map((entry) => (
                        <MenuItem
                          key={entry.id}
                          onAction={() => void onOpenRecent(entry)}
                          textValue={entry.name}
                          className={menuItemClass}
                        >
                          <span className="truncate">{entry.name}</span>
                        </MenuItem>
                      ))}
                      <Separator className="my-1 h-px bg-neutral-800" />
                      <MenuItem
                        onAction={() => clearAllRecent()}
                        textValue="Clear Recent"
                        className={menuItemClass}
                      >
                        <span className="text-neutral-400">Clear Recent</span>
                      </MenuItem>
                    </Menu>
                  </Popover>
                </SubmenuTrigger>
              )}
              <MenuItem
                onAction={() => void onSaveProject()}
                textValue="Save"
                className={menuItemClass}
              >
                <span>Save</span>
                <span className={menuShortcutClass}>{SHORTCUT_SAVE}</span>
              </MenuItem>
              <MenuItem
                onAction={() => void onSaveProjectAs()}
                textValue="Save As"
                className={menuItemClass}
              >
                <span>Save As…</span>
                <span className={menuShortcutClass}>{SHORTCUT_SAVE_AS}</span>
              </MenuItem>
              <Separator className="my-1 h-px bg-neutral-800" />
              <MenuItem
                onAction={onOpenMidi}
                textValue="Open MIDI"
                className={menuItemClass}
              >
                <span>Open MIDI…</span>
              </MenuItem>
              <Separator className="my-1 h-px bg-neutral-800" />
              <MenuSection className="flex flex-col gap-0.5">
                <Header className="px-2 pt-0.5 pb-1 text-[9px] font-semibold uppercase tracking-wider text-neutral-500">
                  Demo Songs
                </Header>
                {SAMPLES.map((sample) => (
                  <MenuItem
                    key={sample.label}
                    onAction={() => onLoadSample(sample.build)}
                    textValue={sample.label}
                    className={menuItemClass}
                  >
                    <span>{sample.label}</span>
                  </MenuItem>
                ))}
              </MenuSection>
            </Menu>
          </Popover>
        </MenuTrigger>

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
        </div>

        {/* Section 2 — recording group. `px-3` for symmetric padding
            inside both the preceding and following borders. */}
        <div className="relative flex items-center gap-1 border-l border-neutral-800 px-3">
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

        {/* Section 3 — Help menu. Single entry point for "tell us
            something" (bug / feature reports + repo link). The issue
            URLs pre-fill the template's `environment` textarea with
            browser / viewport / FSA info so the maintainer doesn't
            have to ask. Last section, so only `pl-3` to mirror the
            previous border's 12px right side. */}
        <div className="flex items-center border-l border-neutral-800 pl-3">
        <MenuTrigger>
          <Button
            aria-label="Help and feedback"
            className="flex h-7 w-7 items-center justify-center rounded-full border border-neutral-800 text-xs font-semibold text-neutral-400 outline-none hover:border-neutral-600 hover:text-neutral-200 focus-visible:border-sky-500 data-[pressed]:bg-neutral-800"
          >
            ?
          </Button>
          <Popover
            placement="bottom end"
            className="rounded-lg border border-neutral-700 bg-neutral-900 p-1 shadow-xl outline-none data-[entering]:animate-in data-[entering]:fade-in data-[entering]:duration-150"
          >
            <Menu
              aria-label="Help"
              className="flex w-56 flex-col gap-0.5 outline-none"
            >
              <MenuItem
                onAction={() => openExternal(buildIssueUrl('bug'))}
                textValue="Report a bug"
                className={menuItemClass}
              >
                <span>Report a bug…</span>
              </MenuItem>
              <MenuItem
                onAction={() => openExternal(buildIssueUrl('feature'))}
                textValue="Request a feature"
                className={menuItemClass}
              >
                <span>Request a feature…</span>
              </MenuItem>
              <Separator className="my-1 h-px bg-neutral-800" />
              <MenuItem
                onAction={() => openExternal(REPO_URL)}
                textValue="View on GitHub"
                className={menuItemClass}
              >
                <span>View on GitHub</span>
              </MenuItem>
            </Menu>
          </Popover>
        </MenuTrigger>
        </div>

      </div>

      <div className="flex items-center gap-1.5 truncate text-[11px] text-neutral-500">
        {/* Dirty indicator. Only meaningful when a project is loaded —
            "no project" doesn't have a save target so the dot would be
            misleading there. */}
        {currentFile && dirty && (
          <span aria-label="Unsaved changes" className="text-amber-400">●</span>
        )}
        {currentFile ? (
          <span className="text-neutral-300">{currentFile.name}</span>
        ) : song ? (
          song.name
        ) : (
          'No file loaded'
        )}
      </div>
    </header>
  )
}
