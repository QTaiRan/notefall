import { Scheduler } from 'smplr'
import type { ParsedSong } from '../midi/types'
import { buildSpeedMap, midiToTimeline } from '../midi/speedMap'
import type { Settings } from '../store'
import { createPiano } from '../audio/sampler'
import { evaluateVelocityCurve } from '../audio/velocityCurve'

/**
 * Offline render of `song` with the given `settings` into a stereo
 * `AudioBuffer`. Mirrors the realtime AudioEngine's scheduling so the
 * exported audio sounds identical to live playback at rate=1, with the
 * same per-note attack lookahead, stop buffer, and pedal-sustain
 * semantics.
 *
 * Live (touch / MIDI input) notes are NOT rendered — only the song
 * timeline. Loop / playbackRate / fast-forward are also ignored: a
 * single linear pass from t=0 through `song.duration + TAIL_SECONDS`.
 *
 * Implemented as a single `OfflineAudioContext.startRendering()` call.
 * That means everything must be scheduled up-front; we don't get
 * incremental progress callbacks during the render itself, only the
 * up-front sample-load progress.
 */

// Mirror engine.ts. The lookahead has no audible-click concern in an
// offline render (samples are perfectly quantum-aligned), but matching
// the live engine's offset means a re-rendered take lines up sample-
// for-sample with what the user heard during preview.
const LOOKAHEAD = 0.015
const STOP_BUFFER = 0.02
// Same SONG_TAIL_SECONDS as the engine — the visual layer's reverb wash
// + landing flashes need this window to play out, and offline audio
// must match so the wash isn't trimmed mid-decay.
const TAIL_SECONDS = 5

export type AudioRenderProgress =
  | { phase: 'loading'; loaded: number; total: number }
  | { phase: 'rendering'; progress: number }
  | { phase: 'done' }

/**
 * Thrown when the caller's `AbortSignal` aborts during a render. Surfaces
 * so the UI layer can skip the download and quietly tear down the modal
 * without the generic "could not export audio" error toast.
 */
export class AudioRenderAborted extends Error {
  constructor() {
    super('Audio render aborted')
    this.name = 'AudioRenderAborted'
  }
}

/**
 * Race a promise against an AbortSignal so that cancel is responsive
 * even during long awaits (sample fetching, OfflineAudioContext.
 * startRendering()) we can't otherwise interrupt. The underlying
 * promise keeps running in the background — caller is responsible
 * for letting that GPU/network/audio work get GC'd by dropping
 * references to the OfflineAudioContext / encoder it's tied to.
 */
function raceWithAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p
  if (signal.aborted) return Promise.reject(new AudioRenderAborted())
  return new Promise<T>((resolve, reject) => {
    p.then(resolve, reject)
    signal.addEventListener('abort', () => reject(new AudioRenderAborted()), { once: true })
  })
}


/**
 * Convert pedal CC events into closed [start,end] sustain ranges. A note
 * whose natural off-time falls inside any range is held until that
 * range's end (the realtime engine's `pedalHeld` deferred-release
 * behaviour, expressed declaratively for offline scheduling).
 *
 * If the song ends with the pedal still down, the open range is
 * truncated at `endTime` so trailing notes still release within the
 * rendered window.
 */
function buildPedalRanges(
  events: ParsedSong['pedals'],
  endTime: number,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  let down = false
  let downStart = 0
  for (const ev of events) {
    const isDown = ev.value >= 0.5
    if (isDown && !down) {
      down = true
      downStart = ev.time
    } else if (!isDown && down) {
      down = false
      ranges.push({ start: downStart, end: ev.time })
    }
  }
  if (down) ranges.push({ start: downStart, end: endTime })
  return ranges
}

function findRangeContaining(
  ranges: Array<{ start: number; end: number }>,
  t: number,
): { start: number; end: number } | null {
  // Linear scan — pedal range counts are small (dozens at most for a
  // typical piano piece), and ranges are sorted, so a binary search
  // would just be ceremony for no measurable win.
  for (const r of ranges) {
    if (t < r.start) return null
    if (t < r.end) return r
  }
  return null
}

export async function renderSongAudio(
  song: ParsedSong,
  settings: Settings,
  sampleRate: number,
  onProgress?: (p: AudioRenderProgress) => void,
  signal?: AbortSignal,
  userAudio?: {
    buffer: AudioBuffer
    offsetSec: number
    volume: number
    trimStartSec: number
    trimEndSec: number | null
  } | null,
): Promise<AudioBuffer> {
  if (signal?.aborted) throw new AudioRenderAborted()
  // Effective end is the later of the MIDI end and (when present) the
  // user-provided accompaniment's tail, so the render captures the
  // whole sync window even when the audio extends past the song. The
  // MIDI is shifted by `midiOffsetSec` so its end on the export
  // timeline is `song.duration + midiOffsetSec`. Trim ends collapse
  // the timeline to the trimmed window so we don't render silent
  // padding.
  const midiOffset = settings.midiOffsetSec
  const midiTrimStart = settings.midiTrimStartSec
  const midiTrimEnd = settings.midiTrimEndSec ?? song.duration
  // Speed automation maps MIDI-time to a stretched / compressed
  // timeline. Apply the same mapping the realtime engine uses so an
  // export comes out sample-identical to live playback.
  const speedMap = buildSpeedMap(settings.midiSpeedAutomation)
  const midiTrimEndTimeline = midiToTimeline(speedMap, midiTrimEnd)
  const audioTrimStart = userAudio ? Math.max(0, userAudio.trimStartSec) : 0
  const audioTrimEnd = userAudio
    ? Math.min(userAudio.buffer.duration, userAudio.trimEndSec ?? userAudio.buffer.duration)
    : 0
  const audioEnd = userAudio ? userAudio.offsetSec + audioTrimEnd : 0
  const songEnd = Math.max(midiTrimEndTimeline + midiOffset, audioEnd)
  const totalDuration = songEnd + TAIL_SECONDS
  const length = Math.max(1, Math.ceil(totalDuration * sampleRate))

  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length,
    sampleRate,
  })

  // Mirror the realtime engine's master × midi × enabled stacking so
  // an export sounds the same as live playback. midiEnabled = false
  // produces a silent sampler track (the user audio still mixes,
  // matching the user's intent of "synced accompaniment, no synth").
  const samplerGain = settings.midiEnabled
    ? settings.volume * settings.midiVolume
    : 0
  // When the sampler track is muted (volume = 0) we skip loading the
  // ~60 MB sample set AND scheduling notes entirely. The render
  // collapses to "userAudio mix + silence" — orders of magnitude
  // faster, and audibly identical to the muted render.
  const renderSampler = samplerGain > 0

  // Bring the piano up against the offline context. Reuses the
  // realtime-engine's effect-chain wiring (master → 6-band EQ → split →
  // dry / pre-delay → reverb → wet) verbatim — same setters, same IR
  // synthesis — so render parity with live playback is "free".
  //
  // The custom scheduler is critical: smplr's default Scheduler defers
  // any event scheduled more than ~100 ms ahead to a setInterval-driven
  // dispatcher. That dispatcher never gets a chance to run during
  // OfflineAudioContext.startRendering() (the render is one synchronous
  // microtask burst from the caller's perspective), so the default
  // would dispatch only the first ~100 ms of notes and silently drop
  // everything afterward. A Scheduler with an effectively-infinite
  // lookahead forces every `piano.start()` call to dispatch its voice
  // synchronously, scheduling each AudioBufferSourceNode at the
  // correct absolute time via `source.start(time)` — sample-accurate
  // because Web Audio honours the absolute time even on offline ctx.
  let piano: Awaited<ReturnType<typeof createPiano>> | null = null
  if (renderSampler) {
    onProgress?.({ phase: 'loading', loaded: 0, total: 1 })
    // Race against the abort signal so Cancel is responsive even during
    // the ~60 MB sample fetch — without this, `await createPiano` blocks
    // for the entire load before the next signal check fires.
    piano = await raceWithAbort(
      createPiano(
        ctx,
        (p) => {
          onProgress?.({ phase: 'loading', loaded: p.loaded, total: p.total })
        },
        {
          scheduler: new Scheduler(ctx, { lookaheadMs: Number.POSITIVE_INFINITY }),
        },
      ),
      signal,
    )

    // Apply settings BEFORE scheduling any notes so the render pass sees
    // them at currentTime=0. setTargetAtTime ramps complete in well under
    // a millisecond at the given time constants, so notes scheduled at
    // t=LOOKAHEAD already inherit the final values.
    piano.setVolume(samplerGain)
    piano.setReverbDry(settings.reverbDry)
    piano.setReverbWet(settings.reverbEnabled ? settings.reverbWet : 0)
    piano.setReverbSize(settings.reverbSize)
    piano.setReverbDecayTime(settings.reverbDecayTime)
    piano.setReverbDecay(settings.reverbDecay)
    piano.setReverbPreDelay(settings.reverbPreDelay)
    piano.setReverbDamping(settings.reverbDamping)
    piano.setReverbHiCut(settings.reverbHiCut)
    piano.setReverbLowCut(settings.reverbLowCut)
    piano.setReleaseTime(settings.releaseTime)
    piano.setDetune(settings.samplerDetune)
    piano.setVelocityCompensation(settings.velocityCompensation)
    for (let i = 0; i < settings.eqBands.length; i++) {
      piano.setEqBand(i, settings.eqBands[i])
    }
  } else {
    // Emit a synthetic "loaded" pulse so progress UI doesn't sit on
    // 0/1 — the modal's audio-fraction calculation expects to see
    // the loading sub-phase complete.
    onProgress?.({ phase: 'loading', loaded: 1, total: 1 })
  }

  // Pedal handling. Mirror the engine: when settings.pedalEnabled is off,
  // ignore the song's pedal track entirely (notes release at their
  // natural offTime). Pedal events are stored in MIDI-time, so the
  // ranges are still in MIDI-time and get shifted at the per-note
  // comparison site below.
  const pedalRanges =
    renderSampler && settings.pedalEnabled
      ? buildPedalRanges(song.pedals, totalDuration - midiOffset)
      : []

  // Schedule the user-provided accompaniment alongside the piano. Goes
  // through its own GainNode so the mix volume is independent of the
  // sampler's. Negative offsets aren't supported in the MVP, so the
  // start time is always ≥ 0; if the offset overshoots the rendered
  // window the source simply never fires.
  if (userAudio && userAudio.offsetSec < totalDuration && audioTrimEnd > audioTrimStart) {
    const src = ctx.createBufferSource()
    src.buffer = userAudio.buffer
    const gain = ctx.createGain()
    // Master × per-track stacking so the export tracks live playback.
    gain.gain.value = settings.volume * userAudio.volume
    src.connect(gain)
    gain.connect(ctx.destination)
    // Schedule with `(when, offset, duration)` so the trim window is
    // honoured by the audio graph itself rather than us needing to
    // pre-slice the buffer.
    const startTime = Math.max(0, userAudio.offsetSec + audioTrimStart)
    src.start(startTime, audioTrimStart, audioTrimEnd - audioTrimStart)
  }

  if (piano) {
    for (const n of song.notes) {
      // Trim filter — match the engine's tick semantics so a rendered
      // export sounds the same as live playback under the same trim.
      if (n.time < midiTrimStart) continue
      if (n.time >= midiTrimEnd) continue
      const playedMidi = n.midi + settings.transpose
      if (playedMidi < 0 || playedMidi > 127) continue

      const shaped = evaluateVelocityCurve(settings.velocityCurve, n.velocity)
      // n.time is MIDI-time; map through the speed curve and shift by
      // `midiOffset` to land on the export timeline. Without
      // automation `midiToTimeline` is the identity, so this collapses
      // to the linear `n.time + midiOffset` of before.
      const onTime = midiOffset + midiToTimeline(speedMap, n.time) + LOOKAHEAD
      // Clamp the natural note-off to the trim end (MIDI-time), then
      // optionally extend via pedal sustain (still MIDI-time), and
      // finally map to timeline-time.
      const naturalOff = Math.min(n.time + n.duration, midiTrimEnd)
      const range = findRangeContaining(pedalRanges, naturalOff)
      const offMidi = Math.min(range ? range.end : naturalOff, midiTrimEnd)
      const actualOff = midiOffset + midiToTimeline(speedMap, offMidi)

      const stopFn = piano.start(playedMidi, shaped, onTime, `s${n.id}`)
      stopFn(actualOff + STOP_BUFFER)
    }
  }

  if (signal?.aborted) {
    piano?.dispose()
    throw new AudioRenderAborted()
  }

  // Poll `ctx.currentTime` to report rendering progress. OfflineAudioContext
  // doesn't fire a progress event, but `currentTime` does advance during
  // rendering (the engine processes blocks off the main thread and updates
  // the timeline). 100 ms is fine-grained enough for a smooth progress bar
  // without burning main-thread cycles. We always emit a final 1.0 after
  // the promise resolves so the bar settles at 100% before the modal
  // dismisses.
  onProgress?.({ phase: 'rendering', progress: 0 })
  const renderPromise = ctx.startRendering()
  const pollHandle = window.setInterval(() => {
    onProgress?.({
      phase: 'rendering',
      progress: Math.min(1, ctx.currentTime / totalDuration),
    })
  }, 100)
  let buffer: AudioBuffer
  try {
    // Race the offline render against the abort signal — once
    // `startRendering()` is called there's no way to actually stop
    // the offline context, but at least surface the cancel
    // synchronously so the modal dismisses immediately, and tear
    // down the piano + chain so the still-pending render finishes
    // near-instantly with silence rather than burning CPU on the
    // convolver + voice graph.
    buffer = await raceWithAbort(renderPromise, signal)
  } catch (e) {
    // dispose() severs the entire effect chain — see sampler.ts.
    // Without this, the OfflineAudioContext can hog CPU for tens of
    // seconds after Cancel, leaving the page unresponsive even
    // through a reload (the browser's reload waits for the running
    // task to yield).
    piano?.dispose()
    throw e
  } finally {
    window.clearInterval(pollHandle)
  }
  onProgress?.({ phase: 'rendering', progress: 1 })

  // Belt-and-suspenders: if abort fired in the narrow window between
  // raceWithAbort resolving and now, still dispose + bail.
  if (signal?.aborted) {
    piano?.dispose()
    throw new AudioRenderAborted()
  }

  onProgress?.({ phase: 'done' })

  // Free the smplr-internal AudioNodes once rendering is complete. The
  // OfflineAudioContext itself is single-use and will be GC'd once we
  // return.
  piano?.dispose()

  return buffer
}
