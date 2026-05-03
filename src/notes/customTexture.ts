import { create } from 'zustand'
import * as THREE from 'three'

/**
 * Holds the user-provided image used by the 'custom' note-texture preset.
 *
 * Kept separate from the main settings store because THREE.Texture is a
 * GPU-bound object that doesn't belong in the serialisable settings tree.
 * The FallingNotes material subscribes to `texture` and rebinds its uniform
 * whenever this changes.
 */
type CustomTextureStore = {
  texture: THREE.Texture | null
  fileName: string | null
  setFromFile: (file: File | null) => Promise<void>
}

export const useCustomTexture = create<CustomTextureStore>((set, get) => ({
  texture: null,
  fileName: null,
  setFromFile: async (file) => {
    const prev = get().texture
    prev?.dispose()
    if (!file) {
      set({ texture: null, fileName: null })
      return
    }
    const url = URL.createObjectURL(file)
    try {
      const loader = new THREE.TextureLoader()
      const tex = await loader.loadAsync(url)
      // sRGB so the colours match what the user sees in their viewer.
      tex.colorSpace = THREE.SRGBColorSpace
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.RepeatWrapping
      tex.needsUpdate = true
      set({ texture: tex, fileName: file.name })
    } finally {
      // The decoded image is in GPU memory now — the blob URL is no longer needed.
      URL.revokeObjectURL(url)
    }
  },
}))
