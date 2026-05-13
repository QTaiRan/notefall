import { audioBufferToWav } from 'smplr'
import type { ParsedSong } from '../midi/types'
import type { Settings } from '../store'
import { AudioRenderAborted, renderSongAudio, type AudioRenderProgress } from './renderAudio'

/**
 * Default sample rate for offline audio export. 44.1 kHz is CD quality
 * and keeps `OfflineAudioContext.startRendering()` noticeably faster
 * than 48 kHz on Chrome's main-thread implementation — the convolution
 * reverb cost scales linearly with sample rate, and the dominant cost
 * during export is convolution, not voice scheduling. The audible
 * difference vs. 48 kHz is below human-hearing thresholds for piano
 * material; when the video pass lands it can override this via
 * `options.sampleRate` to match its container's expected rate.
 */
const DEFAULT_SAMPLE_RATE = 44100

export type AudioExportResult =
  | { kind: 'ok' }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }

/**
 * Render the loaded song to a WAV blob and trigger a browser download.
 * Phase 2 of the video-export feature: validates that the offline audio
 * pipeline (smplr + OfflineAudioContext + the engine's effect chain)
 * produces audible output that matches live playback. The eventual
 * video-export pipeline will reuse `renderSongAudio` and feed the
 * resulting `AudioBuffer` into the muxer instead of writing a WAV.
 *
 * Filename is derived from the song name with disallowed filesystem
 * characters stripped (Windows is the strictest target). A leading
 * `notefall-` prefix is added when the song name is empty so an unnamed
 * recording still produces a recognisable filename.
 */
export async function exportSongToWav(
  song: ParsedSong,
  settings: Settings,
  options?: {
    sampleRate?: number
    fileName?: string
    onProgress?: (p: AudioRenderProgress) => void
    signal?: AbortSignal
    userAudio?: {
      buffer: AudioBuffer
      offsetSec: number
      volume: number
      trimStartSec: number
      trimEndSec: number | null
    } | null
  },
): Promise<AudioExportResult> {
  try {
    const buffer = await renderSongAudio(
      song,
      settings,
      options?.sampleRate ?? DEFAULT_SAMPLE_RATE,
      options?.onProgress,
      options?.signal,
      options?.userAudio ?? null,
    )
    if (options?.signal?.aborted) return { kind: 'cancelled' }
    const blob = audioBufferToWav(buffer)
    const fileName = options?.fileName ?? defaultWavFileName(song.name)
    triggerDownload(blob, fileName)
    return { kind: 'ok' }
  } catch (e) {
    if (e instanceof AudioRenderAborted) return { kind: 'cancelled' }
    const message = e instanceof Error ? e.message : String(e)
    return { kind: 'error', message }
  }
}

function defaultWavFileName(songName: string): string {
  const base = songName.trim().replace(/\.(mid|midi)$/i, '')
  // Strip Windows-disallowed characters and runs of whitespace. Result is
  // ASCII-safe but still preserves Unicode letters / Japanese characters
  // that are valid filenames on every modern OS.
  const cleaned = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim()
  const fallback = `notefall-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`
  return `${cleaned || fallback}.wav`
}

function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
