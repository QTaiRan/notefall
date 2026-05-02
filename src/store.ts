import { create } from 'zustand'
import type { ParsedSong } from './midi/types'

export type FallDirection = 'down' | 'up'

export type Settings = {
  // Layout
  keyboardY: number
  // Camera
  cameraFov: number
  cameraPos: [number, number, number]
  cameraLookAt: [number, number, number]
  // Notes
  fallDirection: FallDirection
  fallDurationSec: number // どのぐらいの時間をかけて鍵盤に到達するか
  noteColor: string
  noteEmissive: number
  noteOpacity: number
  noteCornerRadius: number
  noteWidthScale: number
  // Effects (Bloom)
  bloomIntensity: number
  bloomThreshold: number
  bloomRadius: number
  bloomSmoothing: number
  // Scene
  backgroundColor: string
  // Keyboard
  whiteKeyColor: string
  blackKeyColor: string
  keyboardBrightness: number
  keyGlowColor: string
  keyGlowIntensity: number
  keyGlowDecay: number
  // Audio
  volume: number
  playbackRate: number
  pedalEnabled: boolean
  reverbMix: number
  reverbSize: number
}

export const defaultSettings: Settings = {
  keyboardY: -2.0,
  cameraFov: 32,
  cameraPos: [0, 0, 12],
  cameraLookAt: [0, 0, 0],
  fallDirection: 'down',
  fallDurationSec: 2.5,
  noteColor: '#5ad7ff',
  noteEmissive: 1.5,
  noteOpacity: 1.0,
  noteCornerRadius: 0.05,
  noteWidthScale: 1.0,
  bloomIntensity: 1.2,
  bloomThreshold: 0.2,
  bloomRadius: 0.7,
  bloomSmoothing: 0.4,
  backgroundColor: '#05060a',
  whiteKeyColor: '#f5f5f5',
  blackKeyColor: '#161616',
  keyboardBrightness: 1.0,
  keyGlowColor: '#5ad7ff',
  keyGlowIntensity: 1.5,
  keyGlowDecay: 0.05,
  volume: -6,
  playbackRate: 1.0,
  pedalEnabled: true,
  reverbMix: 0.5,
  reverbSize: 1.0,
}

export type TransportState = 'stopped' | 'playing' | 'paused'

export type LoadStatus =
  | { state: 'idle' }
  | { state: 'loading'; loaded: number; total: number }
  | { state: 'ready' }

type AppState = {
  song: ParsedSong | null
  setSong: (s: ParsedSong | null) => void

  transport: TransportState
  setTransport: (t: TransportState) => void

  currentTime: number
  setCurrentTime: (t: number) => void

  loadStatus: LoadStatus
  setLoadStatus: (s: LoadStatus) => void

  loop: boolean
  setLoop: (b: boolean) => void

  // True while the user is holding the falling-notes area to fast-forward.
  fastForward: boolean
  setFastForward: (b: boolean) => void

  settings: Settings
  updateSettings: (patch: Partial<Settings>) => void
  resetSettings: () => void
}

export const useStore = create<AppState>((set) => ({
  song: null,
  setSong: (song) => set({ song }),

  transport: 'stopped',
  setTransport: (transport) => set({ transport }),

  currentTime: 0,
  setCurrentTime: (currentTime) => set({ currentTime }),

  loadStatus: { state: 'idle' },
  setLoadStatus: (loadStatus) => set({ loadStatus }),

  loop: false,
  setLoop: (loop) => set({ loop }),

  fastForward: false,
  setFastForward: (fastForward) => set({ fastForward }),

  settings: defaultSettings,
  updateSettings: (patch) =>
    set((state) => ({ settings: { ...state.settings, ...patch } })),
  resetSettings: () => set({ settings: defaultSettings }),
}))
