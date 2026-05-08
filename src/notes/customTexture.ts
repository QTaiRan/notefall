import { create } from 'zustand'
import * as THREE from 'three'
import { useStore } from '../store'
import { now } from '../audio/clock'

/**
 * Holds the user-provided image used by the 'custom' note-texture preset.
 *
 * Kept separate from the main settings store because THREE.Texture is a
 * GPU-bound object that doesn't belong in the serialisable settings tree.
 * The FallingNotes material subscribes to `texture` and rebinds its uniform
 * whenever this changes.
 *
 * The original file bytes (`fileBytes` + `fileMime`) are retained alongside
 * the GPU texture so the image survives a project save/load cycle —
 * `pack`/`unpack` in `projects/io.ts` ferry these bytes through the .nfz
 * zip as a binary asset, and `setFromBytes` rehydrates the texture on
 * project load without requiring the user to re-pick the file.
 *
 * Animated formats (GIF, animated WebP, APNG) are decoded via the
 * `ImageDecoder` Web API. Frames are pre-decoded into ImageBitmaps, then a
 * single self-driven rAF loop ticks the active animation: the current frame
 * is drawn into a backing canvas and `texture.needsUpdate = true` is flipped
 * so three.js re-uploads the canvas contents on the next render.
 */

type AnimatedFrame = {
  bitmap: ImageBitmap
  duration: number  // seconds — minimum clamped to avoid pathological 0-duration frames
}

type Animation = {
  frames: AnimatedFrame[]
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  currentIndex: number
  elapsedInFrame: number
  lastTick: number
  rafId: number
}

// Module-level: only one custom texture animation is ever live.
let activeAnimation: Animation | null = null

function stopActiveAnimation() {
  if (!activeAnimation) return
  cancelAnimationFrame(activeAnimation.rafId)
  for (const f of activeAnimation.frames) f.bitmap.close()
  activeAnimation = null
}

type CustomTextureStore = {
  texture: THREE.Texture | null
  fileName: string | null
  /** Original file bytes — kept so the image can be re-serialised into a project zip. */
  fileBytes: ArrayBuffer | null
  /** MIME type captured at load time — needed to redecode on project open. */
  fileMime: string | null
  /** User-gesture entry point (Inspector's FileTrigger). Marks the project dirty. */
  setFromFile: (file: File | null) => Promise<void>
  /** Project-load entry point. Same loading logic as `setFromFile` but skips the dirty mark. */
  setFromBytes: (bytes: ArrayBuffer, mime: string, fileName: string) => Promise<void>
  /** Project-load clear (called when a loaded project doesn't carry a custom texture). No dirty mark. */
  clearFromLoad: () => void
}

export const useCustomTexture = create<CustomTextureStore>((set, get) => {
  const clear = () => {
    stopActiveAnimation()
    get().texture?.dispose()
    set({ texture: null, fileName: null, fileBytes: null, fileMime: null })
  }

  const loadFromBytes = async (bytes: ArrayBuffer, mime: string, fileName: string) => {
    stopActiveAnimation()
    get().texture?.dispose()

    // Try the animated path first. Returns null for unsupported types or
    // single-frame images so the static fallback handles them.
    const animated = await loadAnimatedFromBytes(bytes, mime).catch(() => null)
    if (animated) {
      set({ texture: animated, fileName, fileBytes: bytes, fileMime: mime })
      return
    }

    // Static fallback — JPEG / PNG / single-frame WebP, etc.
    const blob = new Blob([bytes], { type: mime })
    const url = URL.createObjectURL(blob)
    try {
      const loader = new THREE.TextureLoader()
      const tex = await loader.loadAsync(url)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.RepeatWrapping
      // Mipmaps + trilinear filtering let the shader's LOD-bias blur trick
      // fetch progressively-blurred versions for free. Without this, the
      // bias is ignored and the blur slider has no effect on static images.
      tex.generateMipmaps = true
      tex.minFilter = THREE.LinearMipmapLinearFilter
      tex.magFilter = THREE.LinearFilter
      tex.needsUpdate = true
      set({ texture: tex, fileName, fileBytes: bytes, fileMime: mime })
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  return {
    texture: null,
    fileName: null,
    fileBytes: null,
    fileMime: null,
    setFromFile: async (file) => {
      if (!file) {
        clear()
        useStore.getState().markDirty()
        return
      }
      const bytes = await file.arrayBuffer()
      const mime = file.type || guessMimeFromName(file.name) || 'application/octet-stream'
      await loadFromBytes(bytes, mime, file.name)
      useStore.getState().markDirty()
    },
    setFromBytes: async (bytes, mime, fileName) => {
      await loadFromBytes(bytes, mime, fileName)
    },
    clearFromLoad: () => {
      clear()
    },
  }
})

async function loadAnimatedFromBytes(
  bytes: ArrayBuffer,
  mime: string,
): Promise<THREE.Texture | null> {
  // Feature-gate. ImageDecoder is in all modern browsers (Chrome 94+,
  // Edge 94+, Safari 17+, Firefox 133+) but we keep the fallback path for
  // defensive coverage.
  if (typeof ImageDecoder === 'undefined') return null
  if (!mime) return null
  const supported = await ImageDecoder.isTypeSupported(mime).catch(() => false)
  if (!supported) return null

  const decoder = new ImageDecoder({ type: mime, data: bytes })
  await decoder.tracks.ready
  const track = decoder.tracks.selectedTrack
  if (!track) return null
  const frameCount = track.frameCount
  if (frameCount <= 1) return null  // single-frame → let the static path handle it

  const frames: AnimatedFrame[] = []
  for (let i = 0; i < frameCount; i++) {
    const result = await decoder.decode({ frameIndex: i })
    const vf = result.image
    const bitmap = await createImageBitmap(vf)
    // VideoFrame.duration is in microseconds; treat missing or <10ms as 100ms
    // so completely-untimed GIFs still play at a reasonable cadence.
    const durationUs = vf.duration ?? 100_000
    const duration = Math.max(0.01, durationUs / 1_000_000)
    vf.close()
    frames.push({ bitmap, duration })
  }

  const w = frames[0].bitmap.width
  const h = frames[0].bitmap.height
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    for (const f of frames) f.bitmap.close()
    return null
  }
  ctx.drawImage(frames[0].bitmap, 0, 0)

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  // Mipmaps regenerate on every needsUpdate; for typical GIF frame rates
  // (10–30 fps) the cost is minor compared to the visual win for the blur
  // slider. Without mipmaps the LOD-bias blur trick is a no-op.
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.needsUpdate = true

  activeAnimation = {
    frames,
    canvas,
    ctx,
    currentIndex: 0,
    elapsedInFrame: 0,
    lastTick: now(),
    rafId: 0,
  }
  scheduleTick(tex)
  return tex
}

function scheduleTick(tex: THREE.Texture) {
  const tick = () => {
    const a = activeAnimation
    if (!a) return
    const nowSec = now()
    const dt = nowSec - a.lastTick
    a.lastTick = nowSec
    a.elapsedInFrame += dt

    // Advance through any frames whose duration has elapsed (handles browser
    // tab throttling: a long dt may skip several short frames in one go).
    let advanced = false
    let safety = a.frames.length  // guard against pathological all-zero durations
    while (safety-- > 0 && a.elapsedInFrame >= a.frames[a.currentIndex].duration) {
      a.elapsedInFrame -= a.frames[a.currentIndex].duration
      a.currentIndex = (a.currentIndex + 1) % a.frames.length
      advanced = true
    }
    if (advanced) {
      const f = a.frames[a.currentIndex]
      a.ctx.clearRect(0, 0, a.canvas.width, a.canvas.height)
      a.ctx.drawImage(f.bitmap, 0, 0)
      tex.needsUpdate = true
    }
    a.rafId = requestAnimationFrame(tick)
  }
  activeAnimation!.rafId = requestAnimationFrame(tick)
}

// Best-effort MIME guess when the OS doesn't provide file.type (some drag-
// and-drop sources omit it). Only the formats ImageDecoder commonly handles.
function guessMimeFromName(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'png' || ext === 'apng') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'avif') return 'image/avif'
  return ''
}
