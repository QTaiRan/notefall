import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import {
  Button,
  Slider,
  SliderTrack,
  SliderThumb,
} from 'react-aria-components'
import { useStore } from '../store'
import { audioEngine } from '../audio/engine'
import { pauseSong, playSong } from '../audio/playback'
import { useCurrentTime } from '../audio/useCurrentTime'
import { SliderRow } from './controls'

function fmt(t: number): string {
  if (!isFinite(t)) return '00:00'
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

type Props = {
  isFullscreen: boolean
  onToggleFullscreen: () => void
  /**
   * Notify parent whenever any popover (volume / speed) opens or closes.
   * Used to suppress the playback-area auto-hide while the user is
   * interacting with a popover that lives outside the viewport.
   */
  onPopoverOpenChange?: (open: boolean) => void
}

/**
 * Transport bar overlay: rewind / play-pause centered above the seek slider.
 * Pause keeps the current play position; rewind is a separate dedicated button.
 * Designed to sit at the bottom of the viewport with a dark gradient backdrop
 * (rendered by the parent), revealed on hover like a video player.
 */
/**
 * Pop-up slider attached to a transport-bar icon button. Used for volume
 * and playback speed — both are quick adjustments the user makes while
 * watching, so they live in the player chrome instead of the Inspector.
 *
 * Hover-triggered (not click): the popover opens whenever the cursor is
 * over either the button or the popover itself, with a brief grace period
 * on leave so the user can travel from button → popover without it
 * snapping closed.
 *
 * `onClick` lets the caller override what happens when the button is
 * pressed — used by Volume to toggle mute instead of opening the slider.
 * `onOpenChange` informs the parent so the playback-area auto-hide can
 * pause while the popover is visible.
 */
const HOVER_CLOSE_DELAY_MS = 150

function PopSliderButton({
  id,
  openId,
  setOpenId,
  ariaLabel,
  iconLabel,
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  buttonClass,
  onClick,
}: {
  /** Stable id for this button. Acts as the slot key in the shared open state. */
  id: string
  /** Currently-open popover id from the shared parent state, or null. */
  openId: string | null
  /** Setter for the shared open id. Functional updates supported. */
  setOpenId: Dispatch<SetStateAction<string | null>>
  ariaLabel: string
  iconLabel: React.ReactNode
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  format?: (v: number) => string
  buttonClass?: string
  onClick?: () => void
}) {
  const isOpen = openId === id
  const closeTimerRef = useRef<number | null>(null)

  const cancelClose = () => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }
  const open = () => {
    cancelClose()
    // Claim the slot — implicitly closes any other open popover instantly.
    setOpenId(id)
  }
  const scheduleClose = () => {
    cancelClose()
    closeTimerRef.current = window.setTimeout(() => {
      // Only release the slot if we still own it. A sibling may have taken
      // over while our timer was pending; clearing unconditionally would
      // close THEIR popover.
      setOpenId((prev) => (prev === id ? null : prev))
    }, HOVER_CLOSE_DELAY_MS)
  }
  useEffect(() => () => cancelClose(), [])
  // If a sibling claims the open slot, drop our pending close timer so it
  // doesn't fire later and try to clear someone else's popover.
  useEffect(() => {
    if (!isOpen) cancelClose()
  }, [isOpen])

  // Plain-DOM positioning (no portal): popover renders as an absolute child
  // of the button's wrapper, which keeps it in the same hover/render flow
  // as the button. Avoids the flicker we got from react-aria Popover —
  // its portal lands in document.body and there's a brief layout/positioning
  // window where the cursor effectively bounces on/off the trigger.
  return (
    <div className="pointer-events-auto relative">
      <Button
        aria-label={ariaLabel}
        // Default press: open the popover so touch devices (no hover) can
        // still reach the slider. onClick overrides — Volume uses it to mute.
        onPress={onClick ?? open}
        onHoverStart={open}
        onHoverEnd={scheduleClose}
        className={
          buttonClass ??
          'flex h-11 w-11 items-center justify-center rounded-full border border-neutral-700 text-neutral-200 outline-none hover:bg-neutral-800 focus-visible:border-sky-500'
        }
      >
        {iconLabel}
      </Button>
      {isOpen && (
        <div
          className="absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2"
          onMouseEnter={open}
          onMouseLeave={scheduleClose}
        >
          <div className="w-44 rounded-lg bg-black/55 p-3 shadow-lg ring-1 ring-white/10 backdrop-blur-sm">
            <SliderRow
              label={label}
              value={value}
              min={min}
              max={max}
              step={step}
              onChange={onChange}
              format={format}
            />
          </div>
        </div>
      )}
    </div>
  )
}

const fmtSpeed = (v: number) => `${v.toFixed(2)}×`
const fmtVolume = (v: number) => `${Math.round(v * 100)}%`

export function SeekBar({ isFullscreen, onToggleFullscreen, onPopoverOpenChange }: Props) {
  const currentTime = useCurrentTime()
  const song = useStore((s) => s.song)
  const transport = useStore((s) => s.transport)
  const loadStatus = useStore((s) => s.loadStatus)
  const loop = useStore((s) => s.loop)
  const setLoop = useStore((s) => s.setLoop)
  const volume = useStore((s) => s.settings.volume)
  const playbackRate = useStore((s) => s.settings.playbackRate)
  const updateSettings = useStore((s) => s.updateSettings)

  // Single shared "which popover is open" slot. Mutual exclusion: opening
  // one popover (e.g. Speed) immediately drops any other (e.g. Volume) so
  // they can never overlap visually for even a frame.
  const [openPopoverId, setOpenPopoverId] = useState<string | null>(null)
  useEffect(() => {
    onPopoverOpenChange?.(openPopoverId !== null)
  }, [openPopoverId, onPopoverOpenChange])

  // Last user-set non-zero volume — restored when toggling off mute.
  // Initialised lazily and updated whenever the user moves the slider away
  // from zero, so an unmute returns to whatever they were last listening at.
  const lastNonZeroVolumeRef = useRef(volume > 0.001 ? volume : 0.5)
  useEffect(() => {
    if (volume > 0.001) lastNonZeroVolumeRef.current = volume
  }, [volume])
  const toggleMute = () => {
    if (volume > 0.001) {
      updateSettings({ volume: 0 })
    } else {
      updateSettings({ volume: lastNonZeroVolumeRef.current })
    }
  }

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

  // Root + the time/grid/button row are pointer-events-none so empty padding
  // around the controls falls through to the play-toggle area on the canvas.
  // Each interactive widget (Button, Slider) re-enables pointer-events-auto.
  return (
    <div className="pointer-events-none px-4 pt-3 pb-4">
      <div className="relative mb-3 flex items-center">
        <span className="font-mono text-sm tabular-nums text-neutral-300">
          {fmt(value)} / {fmt(duration)}
        </span>

        {/* Absolute-centered transport group: always at the geometric
            middle of the seek-bar row, independent of how wide the left
            (time) or right (volume/speed/fullscreen) groups become. */}
        <div className="pointer-events-none absolute left-1/2 flex -translate-x-1/2 items-center gap-3">
          <Button
            isDisabled={!song}
            onPress={onRewind}
            aria-label="Rewind to start"
            className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full border border-neutral-700 text-neutral-200 outline-none hover:bg-neutral-800 focus-visible:border-sky-500 disabled:border-neutral-800 disabled:text-neutral-600"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
              <path d="M6 6h2v12H6zM9.5 12l8.5 6V6z" />
            </svg>
          </Button>
          <Button
            isDisabled={!song || loadStatus.state === 'loading'}
            onPress={transport === 'playing' ? pauseSong : playSong}
            aria-label={transport === 'playing' ? 'Pause' : 'Play'}
            className="pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full bg-sky-500 text-neutral-950 outline-none hover:bg-sky-400 focus-visible:ring-2 focus-visible:ring-sky-300 disabled:bg-neutral-800 disabled:text-neutral-600"
          >
            {transport === 'playing' ? (
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
                ? 'pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full border border-sky-500 bg-sky-500/15 text-sky-300 outline-none hover:bg-sky-500/25 focus-visible:ring-2 focus-visible:ring-sky-300 disabled:border-neutral-800 disabled:bg-transparent disabled:text-neutral-600'
                : 'pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full border border-neutral-700 text-neutral-200 outline-none hover:bg-neutral-800 focus-visible:border-sky-500 disabled:border-neutral-800 disabled:text-neutral-600'
            }
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
              <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" />
            </svg>
          </Button>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Volume */}
          <PopSliderButton
            id="volume"
            openId={openPopoverId}
            setOpenId={setOpenPopoverId}
            ariaLabel="Volume"
            label="Volume"
            iconLabel={
              volume <= 0.001 ? (
                <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
                  <path d="M7 9v6h4l5 5V4l-5 5H7zm12.59 5.41L17.17 12l2.42-2.41-1.41-1.42L15.76 10.59 13.34 8.17 11.93 9.59 14.34 12l-2.41 2.41 1.41 1.42L15.76 13.41l2.42 2.42 1.41-1.42z" />
                </svg>
              ) : volume <= 0.4 ? (
                <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
                  <path d="M7 9v6h4l5 5V4l-5 5H7z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
                  <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05A4.5 4.5 0 0016.5 12zM14 3.23v2.06A7 7 0 0119 12a7 7 0 01-5 6.7v2.07A9 9 0 0021 12 9 9 0 0014 3.23z" />
                </svg>
              )
            }
            value={volume}
            min={0}
            max={1.5}
            step={0.01}
            onChange={(v) => updateSettings({ volume: v })}
            format={fmtVolume}
            onClick={toggleMute}
          />
          {/* Speed: text label doubles as the icon */}
          <PopSliderButton
            id="speed"
            openId={openPopoverId}
            setOpenId={setOpenPopoverId}
            ariaLabel="Playback speed"
            label="Speed"
            iconLabel={
              <span className="font-mono text-[11px] tabular-nums">{fmtSpeed(playbackRate)}</span>
            }
            value={playbackRate}
            min={0.25}
            max={2}
            step={0.05}
            onChange={(v) => updateSettings({ playbackRate: v })}
            format={fmtSpeed}
            buttonClass="flex h-11 min-w-[52px] items-center justify-center rounded-full border border-neutral-700 px-2 text-neutral-200 outline-none hover:bg-neutral-800 focus-visible:border-sky-500"
          />
          <Button
            onPress={onToggleFullscreen}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full border border-neutral-700 text-neutral-200 outline-none hover:bg-neutral-800 focus-visible:border-sky-500"
          >
            {isFullscreen ? (
              <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
                <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
                <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
              </svg>
            )}
          </Button>
        </div>
      </div>

      <Slider
        value={value}
        minValue={0}
        maxValue={Math.max(0.001, duration)}
        step={0.01}
        onChange={onSliderChange}
        onChangeEnd={onSliderEnd}
        isDisabled={!song}
        className="pointer-events-auto w-full"
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
