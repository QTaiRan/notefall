import { useState } from 'react'
import { Button, Slider, SliderTrack, SliderThumb } from 'react-aria-components'
import { useStore } from '../store'
import { audioEngine } from '../audio/engine'
import { pauseSong, playSong } from '../audio/playback'
import { useCurrentTime } from '../audio/useCurrentTime'

function fmt(t: number): string {
  if (!isFinite(t)) return '00:00'
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * Transport bar overlay: rewind / play-pause centered above the seek slider.
 * Pause keeps the current play position; rewind is a separate dedicated button.
 * Designed to sit at the bottom of the viewport with a dark gradient backdrop
 * (rendered by the parent), revealed on hover like a video player.
 */
export function SeekBar() {
  const currentTime = useCurrentTime()
  const song = useStore((s) => s.song)
  const transport = useStore((s) => s.transport)
  const loadStatus = useStore((s) => s.loadStatus)
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

  const onRewind = () => {
    audioEngine.seek(0)
    useStore.getState().setCurrentTime(0)
  }

  return (
    <div className="px-4 pt-3 pb-4">
      <div className="mb-3 grid grid-cols-3 items-center">
        <span className="font-mono text-sm tabular-nums text-neutral-300">
          {fmt(value)} / {fmt(duration)}
        </span>

        <div className="flex items-center justify-self-center gap-3">
          <Button
            isDisabled={!song}
            onPress={onRewind}
            aria-label="Rewind to start"
            className="flex h-11 w-11 items-center justify-center rounded-full border border-neutral-700 text-neutral-200 outline-none hover:bg-neutral-800 focus-visible:border-sky-500 disabled:border-neutral-800 disabled:text-neutral-600"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
              <path d="M6 6h2v12H6zM9.5 12l8.5 6V6z" />
            </svg>
          </Button>
          <Button
            isDisabled={!song || loadStatus.state === 'loading'}
            onPress={transport === 'playing' ? pauseSong : playSong}
            aria-label={transport === 'playing' ? 'Pause' : 'Play'}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-sky-500 text-neutral-950 outline-none hover:bg-sky-400 focus-visible:ring-2 focus-visible:ring-sky-300 disabled:bg-neutral-800 disabled:text-neutral-600"
          >
            {loadStatus.state === 'loading' ? (
              <span className="text-base">…</span>
            ) : transport === 'playing' ? (
              <svg viewBox="0 0 24 24" fill="currentColor" className="h-6 w-6">
                <path d="M7 5h3v14H7zM14 5h3v14h-3z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor" className="ml-0.5 h-6 w-6">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </Button>
          <Button
            isDisabled={!song}
            onPress={() => setLoop(!loop)}
            aria-label={loop ? 'Disable loop' : 'Enable loop'}
            className={
              loop
                ? 'flex h-11 w-11 items-center justify-center rounded-full border border-sky-500 bg-sky-500/15 text-sky-300 outline-none hover:bg-sky-500/25 focus-visible:ring-2 focus-visible:ring-sky-300 disabled:border-neutral-800 disabled:bg-transparent disabled:text-neutral-600'
                : 'flex h-11 w-11 items-center justify-center rounded-full border border-neutral-700 text-neutral-200 outline-none hover:bg-neutral-800 focus-visible:border-sky-500 disabled:border-neutral-800 disabled:text-neutral-600'
            }
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
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
        {/* h-5 wrapper expands the pointer hit area so hover is easy to land
            on; the visible bar stays thin and is centered inside it. */}
        <SliderTrack className="relative flex h-5 w-full cursor-pointer items-center">
          {({ state, isHovered }) => {
            const expanded = isHovered || state.isThumbDragging(0)
            return (
              <>
                <div
                  className={`relative w-full overflow-hidden rounded-full transition-all duration-150 ${
                    expanded ? 'h-3 bg-neutral-500/80' : 'h-1.5 bg-neutral-700/70'
                  }`}
                >
                  <div
                    className={`h-full transition-colors duration-150 ${
                      expanded ? 'bg-sky-400' : 'bg-sky-500/80'
                    }`}
                    style={{ width: `${state.getThumbPercent(0) * 100}%` }}
                  />
                </div>
                {/* Required by react-aria for keyboard / a11y, but visually hidden. */}
                <SliderThumb className="sr-only" />
              </>
            )
          }}
        </SliderTrack>
      </Slider>
    </div>
  )
}
