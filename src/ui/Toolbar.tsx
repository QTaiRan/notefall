import { useRef } from 'react'
import { Button } from 'react-aria-components'
import { useStore } from '../store'
import { audioEngine } from '../audio/engine'
import { parseMidi } from '../midi/parse'
import { SAMPLES } from '../samples'

export function Toolbar() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const song = useStore((s) => s.song)
  const setSong = useStore((s) => s.setSong)
  const setTransport = useStore((s) => s.setTransport)

  const onOpenFile = () => fileInputRef.current?.click()

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

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-800 bg-neutral-950 px-3">
      <div className="flex items-center gap-2">
        <span className="mr-2 text-sm font-semibold tracking-wide text-neutral-200">notefall</span>
        <Button
          onPress={onOpenFile}
          className="rounded border border-neutral-700 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-200 outline-none hover:border-neutral-600 focus-visible:border-sky-500"
        >
          Open MIDI
        </Button>
        <input
          type="file"
          ref={fileInputRef}
          accept=".mid,.midi"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onFile(f)
            e.target.value = ''
          }}
        />
        <div className="ml-1 flex items-center gap-1">
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
