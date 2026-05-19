import { useRef } from 'react'
import { audioEngine } from '../audio/engine'
import { useStore } from '../store'
import { midiToTimeline, timelineToMidi, type SpeedMap } from '../midi/speedMap'
import type { SettingsKeyframe } from '../midi/settingsKeyframes'

/**
 * Timeline "pins" strip — modelled on `SpeedAutomationLane`, but a
 * thin VALUE-LESS marker track: each pin is a whole settings
 * snapshot, so there's no y-axis curve to draw — just diamond
 * markers at each pin's time. Sits as a fixed-height strip directly
 * under the ruler so it reads as part of the time scale rather than
 * a track.
 *
 * Coordinate note: a pin's `time` is **TL_audio** (the SeekBar /
 * `currentSongTime()` axis — "this point in the rendered video"),
 * whereas the timeline editor's x-axis is **display-time**
 * (natural-MIDI-time + offset, un-stretched by the speed curve).
 * We bridge the two exactly like `RulerCanvas` / `seekToTime` do:
 *
 *   display → audio:  audio = midiOffset + midiToTimeline(map, display − midiOffset)
 *   audio → display:  display = midiOffset + timelineToMidi(map, audio − midiOffset)
 *
 * so a pin dragged to a ruler tick lands on the elapsed-time that
 * tick represents, and vice-versa.
 */

// Fixed strip height — independent of the per-lane ratio settings
// (those store keys are frozen). Tall enough for a comfortable
// diamond hit target plus the "pins" label.
export const PIN_LANE_HEIGHT = 16

/** Pin TL_audio time → editor display-time. */
function audioToDisplay(
  audioT: number,
  speedMap: SpeedMap,
  midiOffsetSec: number,
): number {
  return midiOffsetSec + timelineToMidi(speedMap, audioT - midiOffsetSec)
}
/** Editor display-time → pin TL_audio time. */
function displayToAudio(
  displayT: number,
  speedMap: SpeedMap,
  midiOffsetSec: number,
): number {
  return midiOffsetSec + midiToTimeline(speedMap, displayT - midiOffsetSec)
}

/** Seek the transport playhead to a TL_audio time (same call the
 *  SeekBar / ruler use — engine.seek + store.setCurrentTime). */
function seekAudio(audioT: number): void {
  const t = Math.max(0, audioT)
  audioEngine.seek(t)
  useStore.getState().setCurrentTime(t)
}

function fmtTime(sec: number): string {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  const r = s - m * 60
  return `${m}:${r.toFixed(2).padStart(5, '0')}`
}

export function SettingsPinLane({
  keyframes,
  editingTime,
  speedMap,
  laneHeight,
  pxPerSec,
  clampedScroll,
  viewDuration,
  midiOffsetSec,
  totalDuration,
}: {
  keyframes: readonly SettingsKeyframe[]
  editingTime: number | null
  speedMap: SpeedMap
  laneHeight: number
  pxPerSec: number
  /** display-time → px (timeline editor x-axis is display-time). */
  clampedScroll: number
  viewDuration: number
  midiOffsetSec: number
  totalDuration: number
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null)

  // Drag a pin: bracket the whole gesture with begin/endSettingsEdit
  // so it collapses to one undo entry (same model as the speed lane's
  // breakpoint drag), and call moveKeyframe per move. We track the
  // pin by its LIVE time (which moveKeyframe rewrites) so re-sorting
  // inside the store doesn't strand the drag. `keyframes` is sorted
  // by time ascending; we snapshot the neighbour times at drag start
  // and clamp between them so the dragged pin can't cross a
  // neighbour — that keeps the React key (index) stable through the
  // gesture, so the element isn't remounted (which would drop
  // pointer capture mid-drag), exactly like SpeedAutomationLane.
  const dragRef = useRef<{
    currentTime: number
    prevTime: number
    nextTime: number
  } | null>(null)

  const visEnd = clampedScroll + viewDuration

  const onPinPointerDown =
    (index: number) => (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.stopPropagation()
      const kf = keyframes[index]
      if (!kf) return
      // Select + seek immediately so the viewport / Inspector jump to
      // this pin's look even if the user only clicks (no drag).
      useStore.getState().selectKeyframe(kf.time)
      seekAudio(kf.time)
      const prev = index > 0 ? keyframes[index - 1].time : 0
      const next =
        index < keyframes.length - 1
          ? keyframes[index + 1].time
          : Number.POSITIVE_INFINITY
      dragRef.current = {
        currentTime: kf.time,
        prevTime: prev,
        nextTime: next,
      }
      e.currentTarget.setPointerCapture(e.pointerId)
      useStore.getState().beginSettingsEdit()
    }
  const onPinPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    // Missed pointerup (capture sometimes drops it when released off-
    // element) — buttons===0 means the button is already up.
    if ((e.buttons & 1) === 0) {
      onPinPointerUp(e)
      return
    }
    const wrap = wrapRef.current
    if (!wrap) return
    e.stopPropagation()
    const rect = wrap.getBoundingClientRect()
    const localX = e.clientX - rect.left
    const displayT = Math.max(0, clampedScroll + localX / pxPerSec)
    const cappedDisplay =
      totalDuration > 0 ? Math.min(totalDuration, displayT) : displayT
    let nextAudio = Math.max(
      0,
      displayToAudio(cappedDisplay, speedMap, midiOffsetSec),
    )
    // Keep time order so the index (React key) stays valid. Touching
    // a neighbour is allowed; crossing it is not.
    nextAudio = Math.max(d.prevTime, Math.min(d.nextTime, nextAudio))
    if (Math.abs(nextAudio - d.currentTime) < 1e-9) return
    useStore.getState().moveKeyframe(d.currentTime, nextAudio)
    d.currentTime = nextAudio
    // Keep the playhead glued to the dragged pin so the viewport
    // previews the pin's look at its new spot.
    seekAudio(nextAudio)
  }
  const onPinPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    e.stopPropagation()
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* capture may already be released — ignore */
    }
    dragRef.current = null
    useStore.getState().endSettingsEdit()
  }
  const onPinContextMenu =
    (time: number) => (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation()
      if (dragRef.current) return
      useStore.getState().removeKeyframe(time)
    }

  // Left-click on empty lane space → add a pin at the clicked time.
  // The diamond markers stopPropagation their own pointerdown, so this
  // only fires for clicks that miss every marker — no double-create and
  // no interference with select / drag. `addKeyframe` captures the
  // resolved look at that time and selects the new pin (one undo
  // entry); seeking makes the viewport / Inspector jump to it, matching
  // the click-a-pin behaviour.
  const onLanePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || dragRef.current) return
    const wrap = wrapRef.current
    if (!wrap) return
    const rect = wrap.getBoundingClientRect()
    const localX = e.clientX - rect.left
    const displayT = Math.max(0, clampedScroll + localX / pxPerSec)
    const cappedDisplay =
      totalDuration > 0 ? Math.min(totalDuration, displayT) : displayT
    const audioT = Math.max(
      0,
      displayToAudio(cappedDisplay, speedMap, midiOffsetSec),
    )
    useStore.getState().addKeyframe(audioT)
    seekAudio(audioT)
  }

  return (
    <div
      ref={wrapRef}
      onPointerDown={onLanePointerDown}
      style={{ height: laneHeight, touchAction: 'none' }}
      className="relative cursor-copy overflow-hidden rounded bg-neutral-900/40"
      aria-label="Settings pins"
      title="Pins capture the visual settings at a point in time — the scene morphs between consecutive pins. Click empty space to add a pin · click a pin to select + seek · drag to move · right-click to delete."
    >
      {keyframes.map((kf, i) => {
        const displayT = audioToDisplay(kf.time, speedMap, midiOffsetSec)
        if (displayT < clampedScroll || displayT > visEnd) return null
        const x = (displayT - clampedScroll) * pxPerSec
        const selected =
          editingTime !== null && Math.abs(editingTime - kf.time) < 1e-6
        return (
          <div
            key={i}
            onPointerDown={onPinPointerDown(i)}
            onPointerMove={onPinPointerMove}
            onPointerUp={onPinPointerUp}
            onPointerCancel={onPinPointerUp}
            onContextMenu={onPinContextMenu(kf.time)}
            title={`Pin @ ${fmtTime(kf.time)} — click to select + seek · drag to move · right-click to delete`}
            className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-grab active:cursor-grabbing"
            style={{ left: x, width: 12, height: 12, touchAction: 'none' }}
          >
            {/* Diamond marker — a rotated square. Selected pin glows
                amber so it's distinct from the sky-toned speed lane. */}
            <div
              className={
                selected
                  ? 'h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[1px] bg-amber-300 ring-2 ring-amber-300/40'
                  : 'h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[1px] bg-amber-400/70 ring-1 ring-amber-300/20 hover:bg-amber-300'
              }
              style={{ position: 'absolute', left: '50%', top: '50%' }}
            />
          </div>
        )
      })}
      {/* Static label so the strip is identifiable when empty.
          Click-through so it never blocks a marker. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 font-mono text-[9px] text-neutral-500"
      >
        pins
      </div>
    </div>
  )
}
