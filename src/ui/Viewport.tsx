import { useEffect, useRef, useState } from 'react'
import { DropZone, Text } from 'react-aria-components'
import { useHover } from 'react-aria'
import { Scene } from '../scene/Scene'
import { SeekBar } from './SeekBar'
import { useStore } from '../store'
import { audioEngine } from '../audio/engine'
import { parseMidi } from '../midi/parse'

const ASPECT = 16 / 9
// Auto-hide the seek bar / play controls after this many ms of no pointer
// movement while the song is playing. Matches the rough cadence of video
// players; long enough that brief pauses to read the timestamp don't dismiss.
const IDLE_HIDE_MS = 2000

/**
 * Centered play badge shown over the falling-notes region whenever the
 * transport is not running. `pointer-events-none` so the underlying canvas
 * still receives the click that toggles playback.
 */
function PausedIndicator() {
  const transport = useStore((s) => s.transport)
  const song = useStore((s) => s.song)
  const loadStatus = useStore((s) => s.loadStatus)
  const visible = !!song && transport !== 'playing' && loadStatus.state !== 'loading'

  return (
    <div
      className={`pointer-events-none absolute inset-0 flex items-center justify-center pb-[15%] transition-opacity duration-200 ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
      aria-hidden={!visible}
    >
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-black/55 shadow-lg ring-1 ring-white/10 backdrop-blur-sm">
        <svg viewBox="0 0 24 24" fill="white" className="ml-1 h-9 w-9">
          <path d="M8 5v14l11-7z" />
        </svg>
      </div>
    </div>
  )
}

/**
 * Top-center pill shown while the user is holding the falling-notes area
 * to fast-forward. `pointer-events-none` so the underlying click-to-hold
 * region keeps receiving events for the entire hold duration.
 */
function FastForwardIndicator() {
  const fastForward = useStore((s) => s.fastForward)
  return (
    <div
      className={`pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 transition-all duration-150 ${
        fastForward ? 'scale-100 opacity-100' : 'scale-90 opacity-0'
      }`}
      aria-hidden={!fastForward}
    >
      <div className="flex items-center gap-1.5 rounded-full bg-black/65 px-3 py-1 text-xs font-semibold text-white shadow-lg ring-1 ring-white/15 backdrop-blur-sm">
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5">
          <path d="M4 5v14l8-7zM13 5v14l8-7z" />
        </svg>
        <span className="tabular-nums">2x</span>
      </div>
    </div>
  )
}

export function Viewport() {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const transport = useStore((s) => s.transport)
  const setSong = useStore((s) => s.setSong)
  const setTransport = useStore((s) => s.setTransport)

  // useHover is touch-aware: it does not fire on touch tap (unlike CSS :hover
  // which sticks until the next interaction) and is normalised across browsers.
  const { hoverProps, isHovered } = useHover({})
  // YouTube-style idle auto-hide: while playing+hovered, hide the controls
  // after a stretch of no pointer movement. Pause / stop keeps them visible
  // (the user can always reach play/seek).
  const [idleHidden, setIdleHidden] = useState(false)
  useEffect(() => {
    const el = wrapRef.current
    if (!el || transport !== 'playing' || !isHovered) {
      // Only the playing+hovered branch arms the timer; reset hidden flag
      // so the next time we enter that branch we start from "visible".
      setIdleHidden(false)
      return
    }
    let timer: number | null = null
    const arm = () => {
      if (timer !== null) clearTimeout(timer)
      timer = window.setTimeout(() => setIdleHidden(true), IDLE_HIDE_MS)
    }
    const onMove = () => {
      setIdleHidden(false)
      arm()
    }
    arm() // also start the countdown if entry happened with no movement (e.g. just pressed play)
    el.addEventListener('pointermove', onMove)
    return () => {
      el.removeEventListener('pointermove', onMove)
      if (timer !== null) clearTimeout(timer)
    }
  }, [transport, isHovered])
  const controlsVisible = (isHovered && !idleHidden) || transport !== 'playing'

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      const containerAspect = r.width / r.height
      let w: number, h: number
      if (containerAspect > ASPECT) {
        h = r.height
        w = h * ASPECT
      } else {
        w = r.width
        h = w / ASPECT
      }
      setSize({ w, h })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const handleFile = async (file: File) => {
    const buf = await file.arrayBuffer()
    const parsed = await parseMidi(buf, file.name)
    setSong(parsed)
    audioEngine.loadSong(parsed)
    setTransport('stopped')
  }

  return (
    <DropZone
      ref={wrapRef}
      className="relative flex flex-1 items-center justify-center overflow-hidden bg-black outline-none"
      getDropOperation={(types) =>
        // Accept any file drop; we filter by .mid/.midi in onDrop
        types.has('Files') ? 'copy' : 'cancel'
      }
      onDrop={async (e) => {
        const fileItem = e.items.find((item) => item.kind === 'file')
        if (!fileItem || fileItem.kind !== 'file') return
        if (!/\.midi?$/i.test(fileItem.name)) return
        const file = await fileItem.getFile()
        await handleFile(file)
      }}
    >
      {({ isDropTarget }) => (
        <>
          {/* Visually-hidden label for screen readers */}
          <Text slot="label" className="sr-only">
            Drop a MIDI file here
          </Text>
          <div
            className="relative shadow-2xl"
            style={{ width: size.w, height: size.h, touchAction: 'none' }}
            {...hoverProps}
          >
            <Scene />
            <PausedIndicator />
            <FastForwardIndicator />
            {/* Gradient and SeekBar root are click-through (pointer-events-none);
                only the buttons / slider inside SeekBar carry pointer-events-auto.
                That lets the lower PlayToggleArea under the keyboard still
                receive clicks in the empty space around the controls.
                When hiding, visibility transitions to hidden after the opacity
                fade so the (invisible) buttons stop intercepting events. */}
            <div
              className={`pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent pt-10 transition-[opacity,visibility] duration-200 ${
                controlsVisible
                  ? 'visible opacity-100'
                  : 'invisible opacity-0 [transition-delay:0s,200ms]'
              }`}
            >
              <SeekBar />
            </div>
            {isDropTarget && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-sky-500/10 ring-2 ring-inset ring-sky-400">
                <span className="rounded bg-neutral-950/80 px-3 py-1 text-sm text-sky-300">
                  Drop MIDI file
                </span>
              </div>
            )}
          </div>
        </>
      )}
    </DropZone>
  )
}
