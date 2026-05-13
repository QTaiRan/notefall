import { create } from 'zustand'
import { useStore } from '../store'

/**
 * User-provided accompaniment track (WAV / MP3 / etc.) the user wants
 * to sync with the MIDI visualization. Kept in its own store because
 * the decoded `AudioBuffer` is heavy and Web-Audio-bound — it doesn't
 * belong in the serialisable settings tree.
 *
 * The original file bytes are retained alongside the decoded buffer so
 * the audio survives a project save/load cycle: `pack`/`unpack` in
 * `projects/io.ts` ferry these bytes through the .nfz zip as a binary
 * asset, and `setFromBytes` rehydrates the buffer + peak data on
 * project load without requiring the user to re-pick the file.
 *
 * The sync offset (`userAudioOffsetSec`) and volume (`userAudioVolume`)
 * live in the main `Settings` store so they persist with the rest of
 * the project's preferences and ride the existing undo plumbing.
 */

/**
 * Pre-computed waveform peaks for timeline rendering. `buckets` is an
 * interleaved [min, max, min, max, …] Float32 array — using a single
 * typed array (instead of two) halves allocation count and makes the
 * canvas drawing loop cache-friendly. `bucketDurationSec` lets the
 * timeline pick which bucket index covers a given second of audio.
 */
export type UserAudioPeaks = {
  buckets: Float32Array
  bucketCount: number
  bucketDurationSec: number
  totalDurationSec: number
}

// Granularity of the peak array. ~200 buckets/sec ≈ 5 ms per bucket — fine
// enough to draw a smooth waveform at any reasonable timeline zoom level
// without keeping the full sample array around. A 4-minute song ≈ 48 000
// buckets ≈ 384 KB of Float32 (acceptable; the source bytes themselves are
// far larger).
const PEAK_BUCKETS_PER_SEC = 200

// Singleton AudioContext used purely for `decodeAudioData`. Decoding doesn't
// need to share a context with the realtime engine — the resulting
// AudioBuffer is portable across contexts. Keeping this separate avoids
// tying decode to Tone's lazy lifecycle (which only starts after a user
// gesture); the user can drop an audio file before ever pressing Play.
let sharedDecodeContext: AudioContext | null = null
function getDecodeContext(): AudioContext {
  if (!sharedDecodeContext) {
    sharedDecodeContext = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext)()
  }
  return sharedDecodeContext
}

/**
 * Decode the bytes via WebAudio and compute a min/max peak summary for
 * timeline rendering. Channels are reduced to mono by averaging — for
 * a waveform overview a coherent mono envelope reads better than two
 * stacked mono traces.
 */
async function decodeAndPeak(
  bytes: ArrayBuffer,
): Promise<{ buffer: AudioBuffer; peaks: UserAudioPeaks }> {
  const ctx = getDecodeContext()
  // `decodeAudioData` consumes its input ArrayBuffer (transfers ownership)
  // in some browsers — clone before handing off so the caller's bytes
  // remain usable for `.nfz` serialisation later.
  const clone = bytes.slice(0)
  const buffer = await ctx.decodeAudioData(clone)
  const samplesPerBucket = Math.max(
    1,
    Math.floor(buffer.sampleRate / PEAK_BUCKETS_PER_SEC),
  )
  const bucketCount = Math.ceil(buffer.length / samplesPerBucket)
  const buckets = new Float32Array(bucketCount * 2)
  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(buffer.getChannelData(c))
  }
  const channelCount = channels.length
  for (let i = 0; i < bucketCount; i++) {
    const start = i * samplesPerBucket
    const end = Math.min(start + samplesPerBucket, buffer.length)
    let mn = 0
    let mx = 0
    for (let j = start; j < end; j++) {
      let v = 0
      for (let c = 0; c < channelCount; c++) v += channels[c][j]
      v /= channelCount
      if (v < mn) mn = v
      if (v > mx) mx = v
    }
    buckets[i * 2] = mn
    buckets[i * 2 + 1] = mx
  }
  const peaks: UserAudioPeaks = {
    buckets,
    bucketCount,
    bucketDurationSec: samplesPerBucket / buffer.sampleRate,
    totalDurationSec: buffer.duration,
  }
  return { buffer, peaks }
}

type UserAudioStore = {
  /** Decoded buffer used by the audio engine for realtime playback. */
  buffer: AudioBuffer | null
  /** Pre-computed peaks for timeline rendering. */
  peaks: UserAudioPeaks | null
  fileName: string | null
  /** Original file bytes — kept so the audio can be re-serialised into a project zip. */
  fileBytes: ArrayBuffer | null
  /** MIME captured at load time — needed to redecode on project open. */
  fileMime: string | null
  /** True while the file is being decoded (potentially a multi-second op for MP3s). */
  loading: boolean
  /** Set to a human-readable message when the most recent decode failed. */
  error: string | null

  /** User-gesture entry point (drop / Import Audio menu). Marks the project dirty. */
  setFromFile: (file: File | null) => Promise<void>
  /** Project-load entry point. Same loading logic as `setFromFile` but skips the dirty mark. */
  setFromBytes: (
    bytes: ArrayBuffer,
    mime: string,
    fileName: string,
  ) => Promise<void>
  /** Project-load clear (called when a loaded project doesn't carry user audio). No dirty mark. */
  clearFromLoad: () => void
  /** User-gesture clear ("remove" button on the audio lane). Marks dirty + resets the offset. */
  clear: () => void
}

function guessAudioMimeFromName(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'mp3') return 'audio/mpeg'
  if (ext === 'wav') return 'audio/wav'
  if (ext === 'ogg' || ext === 'oga') return 'audio/ogg'
  if (ext === 'm4a' || ext === 'aac') return 'audio/aac'
  if (ext === 'flac') return 'audio/flac'
  if (ext === 'webm') return 'audio/webm'
  return 'application/octet-stream'
}

export function isAudioName(name: string): boolean {
  return /\.(mp3|wav|ogg|oga|m4a|aac|flac|webm)$/i.test(name)
}

export const useUserAudio = create<UserAudioStore>((set, get) => {
  const clear = () => {
    set({
      buffer: null,
      peaks: null,
      fileName: null,
      fileBytes: null,
      fileMime: null,
      loading: false,
      error: null,
    })
  }

  const loadFromBytes = async (
    bytes: ArrayBuffer,
    mime: string,
    fileName: string,
  ) => {
    set({ loading: true, error: null })
    try {
      const { buffer, peaks } = await decodeAndPeak(bytes)
      set({
        buffer,
        peaks,
        fileName,
        fileBytes: bytes,
        fileMime: mime,
        loading: false,
        error: null,
      })
    } catch (e) {
      // Decode failure is recoverable — clear the loaded audio so the UI
      // doesn't keep displaying the previous file's waveform alongside an
      // error toast. Surface the message via the `error` field; the
      // Timeline header can render it inline.
      set({
        buffer: null,
        peaks: null,
        fileName: null,
        fileBytes: null,
        fileMime: null,
        loading: false,
        error: e instanceof Error ? e.message : 'Could not decode audio',
      })
      throw e
    }
  }

  return {
    buffer: null,
    peaks: null,
    fileName: null,
    fileBytes: null,
    fileMime: null,
    loading: false,
    error: null,
    setFromFile: async (file) => {
      if (!file) {
        clear()
        useStore.getState().updateSettings({ userAudioOffsetSec: 0 })
        useStore.getState().markDirty()
        return
      }
      const bytes = await file.arrayBuffer()
      const mime = file.type || guessAudioMimeFromName(file.name)
      await loadFromBytes(bytes, mime, file.name)
      // Reset the sync offset on every fresh import — an offset that
      // referred to the previous file shouldn't silently apply to the new
      // one. Volume is intentionally NOT reset; users who set a level
      // typically want the next track at the same level.
      //
      // Auto-mute the MIDI sampler on import: users who attach an
      // accompaniment usually want to hear THAT, not a synthesized
      // piano playing on top of it. Re-enabling is one click on the
      // MIDI lane's mute button. Done only on user-gesture imports
      // (`setFromFile`) — `setFromBytes` is for project loads and must
      // respect the saved setting.
      useStore.getState().updateSettings({
        userAudioOffsetSec: 0,
        midiEnabled: false,
      })
      useStore.getState().markDirty()
    },
    setFromBytes: async (bytes, mime, fileName) => {
      await loadFromBytes(bytes, mime, fileName)
    },
    clearFromLoad: () => {
      clear()
    },
    clear: () => {
      if (get().buffer === null && get().fileBytes === null) return
      clear()
      useStore.getState().updateSettings({ userAudioOffsetSec: 0 })
      useStore.getState().markDirty()
    },
  }
})
