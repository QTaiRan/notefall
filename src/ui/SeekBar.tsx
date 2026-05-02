import { useState } from 'react'
import { Button, Slider, SliderTrack, SliderThumb } from 'react-aria-components'
import { useStore } from '../store'
import { audioEngine } from '../audio/engine'

function fmt(t: number): string {
  if (!isFinite(t)) return '00:00'
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * Bottom transport bar: rewind / play-pause centered above the seek slider.
 * Pause keeps the current play position; rewind is a separate dedicated button.
 */
export function SeekBar({ currentTime }: { currentTime: number }) {
  const song = useStore((s) => s.song)
  const transport = useStore((s) => s.transport)
  const setTransport = useStore((s) => s.setTransport)
  const loadStatus = useStore((s) => s.loadStatus)
  const setLoadStatus = useStore((s) => s.setLoadStatus)
  const loop = useStore((s) => s.loop)
  const setLoop = useStore((s) => s.setLoop)

  const [dragValue, setDragValue] = useState<number | null>(null)
  const duration = song?.duration ?? 0
  const value = dragValue ?? Math.min(currentTime, duration)

  const onSliderChange = (v: number | number[]) => {
    setDragValue(typeof v === 'number' ? v : v[0])
  }
  const onSliderEnd = (v: number | number[]) => {
    const t = typeof v === 'number' ? v : v[0]
    audioEngine.seek(t)
    useStore.getState().setCurrentTime(t)
    setDragValue(null)
  }

  const onPlay = async () => {
    if (!song) return
    if (loadStatus.state !== 'ready') {
      setLoadStatus({ state: 'loading', loaded: 0, total: 1 })
      await audioEngine.init((p) => {
        setLoadStatus({ state: 'loading', loaded: p.loaded, total: p.total })
      })
      setLoadStatus({ state: 'ready' })
    }
    await audioEngine.play()
    setTransport('playing')
  }
  const onPause = () => {
    audioEngine.pause()
    setTransport('paused')
  }
  const onRewind = () => {
    audioEngine.seek(0)
    useStore.getState().setCurrentTime(0)
  }

  return (
    <div className="shrink-0 border-t border-neutral-800 bg-neutral-950 px-3 pt-2 pb-2">
      <div className="mb-2 grid grid-cols-3 items-center">
        <span className="font-mono text-xs tabular-nums text-neutral-400">
          {fmt(value)} / {fmt(duration)}
        </span>

        <div className="flex items-center justify-self-center gap-2">
          <Button
            isDisabled={!song}
            onPress={onRewind}
            aria-label="Rewind to start"
            className="flex h-8 w-8 items-center justify-center rounded-full border border-neutral-700 text-neutral-200 outline-none hover:bg-neutral-800 focus-visible:border-sky-500 disabled:border-neutral-800 disabled:text-neutral-600"
          >
            ⏮
          </Button>
          <Button
            isDisabled={!song || loadStatus.state === 'loading'}
            onPress={transport === 'playing' ? onPause : onPlay}
            aria-label={transport === 'playing' ? 'Pause' : 'Play'}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-sky-500 text-neutral-950 outline-none hover:bg-sky-400 focus-visible:ring-2 focus-visible:ring-sky-300 disabled:bg-neutral-800 disabled:text-neutral-600"
          >
            {loadStatus.state === 'loading' ? '…' : transport === 'playing' ? '❚❚' : '▶'}
          </Button>
          <Button
            onPress={() => setLoop(!loop)}
            aria-label={loop ? 'Disable loop' : 'Enable loop'}
            className={
              loop
                ? 'flex h-8 w-8 items-center justify-center rounded-full border border-sky-500 bg-sky-500/15 text-sky-300 outline-none hover:bg-sky-500/25 focus-visible:ring-2 focus-visible:ring-sky-300'
                : 'flex h-8 w-8 items-center justify-center rounded-full border border-neutral-700 text-neutral-200 outline-none hover:bg-neutral-800 focus-visible:border-sky-500'
            }
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
              <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" />
            </svg>
          </Button>
        </div>

        <span className="justify-self-end" />
      </div>

      <Slider
        value={value}
        minValue={0}
        maxValue={Math.max(0.001, duration)}
        step={0.01}
        onChange={onSliderChange}
        onChangeEnd={onSliderEnd}
        isDisabled={!song}
        className="w-full"
      >
        <SliderTrack className="relative h-1.5 w-full rounded-full bg-neutral-800">
          {({ state }) => (
            <>
              <div
                className="absolute h-full rounded-full bg-sky-500/70"
                style={{ width: `${state.getThumbPercent(0) * 100}%` }}
              />
              <SliderThumb className="top-1/2 h-3 w-3 rounded-full bg-white shadow ring-1 ring-neutral-900 outline-none focus-visible:ring-2 focus-visible:ring-sky-400" />
            </>
          )}
        </SliderTrack>
      </Slider>
    </div>
  )
}
