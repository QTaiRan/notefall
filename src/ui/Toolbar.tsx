import { Button, DialogTrigger, Dialog, FileTrigger, Popover } from 'react-aria-components'
import { useStore } from '../store'
import { audioEngine } from '../audio/engine'
import { ensureAudioReady } from '../audio/midiInput'
import { useMidiInput } from '../audio/useMidiInput'
import { parseMidi } from '../midi/parse'
import { SAMPLES } from '../samples'

export function Toolbar() {
  const song = useStore((s) => s.song)
  const setSong = useStore((s) => s.setSong)
  const setTransport = useStore((s) => s.setTransport)
  const setLoadStatus = useStore((s) => s.setLoadStatus)
  const midi = useMidiInput()

  const onFile = async (file: File) => {
    const buf = await file.arrayBuffer()
    const parsed = await parseMidi(buf, file.name)
    setSong(parsed)
    audioEngine.loadSong(parsed)
    setTransport('stopped')
  }

  const onLoadSample = (build: () => ReturnType<typeof parseMidi> extends Promise<infer T> ? T : never) => {
    const parsed = build()
    setSong(parsed)
    audioEngine.loadSong(parsed)
    setTransport('stopped')
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
