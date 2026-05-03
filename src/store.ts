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
  // Minimum visible length so very short notes do not collapse into a line
  noteMinLength: number
  // White flash that appears at the contact line while a note is held
  flashIntensity: number
  flashSize: number
  flashWidth: number
  // Softness of the core falloff — larger = wider halo edge around the bright spot
  flashHaloWidth: number
  flashColor: string
  // Particles drifting up from the keyboard while a note is held
  particlesEnabled: boolean
  particleIntensity: number
  particleSize: number
  particleRate: number
  particleSpeed: number
  particleLifetime: number
  particleColor: string
  // Wind field that drives clustered, candle-flame-like sway
  particleWind: number       // strength (how far particles get pushed)
  particleWindScale: number  // gust size — larger = broader cells = more cohesive cluster motion
  particleWindSpeed: number  // how fast the field evolves over time
  particleHaloIntensity: number // brightness of the soft glow around each particle's core
  particleHaloSize: number      // how far that glow extends past the core
  // Glowing laser line at the keyboard hit point — straight bar + animated wavy beam
  hitLineEnabled: boolean
  hitLineColor: string
  hitLineIntensity: number   // straight-bar brightness
  hitLineThickness: number   // straight-bar core thickness (fraction of plane height)
  hitLineWaveIntensity: number  // wavy laser brightness
  hitLineWaveAmplitude: number  // vertical swing of the wave (fraction of plane half-height)
  hitLineWaveScale: number      // wave spatial frequency along the keyboard
  hitLineWaveScrollSpeed: number // horizontal scroll rate; signed (positive = rightward, negative = leftward)
  hitLineWaveMorphSpeed: number  // in-place shape evolution (no horizontal motion)
  hitLineWaveThickness: number  // wavy laser line thickness (fraction of plane)
  hitLineWaveGrain: number      // particulate-ness: high-freq curve tremor + brightness modulation along the line
  hitLineBarY: number           // vertical offset of the straight bar from the hit line (world units)
  hitLineWaveY: number          // vertical offset of the wave's center from the hit line (world units)
  hitLineBarHalo: number        // bar halo extent — divides the gaussian falloff so larger = wider
  hitLineWaveHalo: number       // wave halo extent — same idea, around the wavy laser line
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
  noteMinLength: 0.15,
  flashIntensity: 0.8,
  flashSize: 2.5,
  flashWidth: 2.5,
  flashHaloWidth: 0.5,
  flashColor: '#ffffff',
  particlesEnabled: true,
  particleIntensity: 0.15,
  particleSize: 0.3,
  particleRate: 20.0,
  particleSpeed: 0.8,
  particleLifetime: 2.5,
  particleColor: '#5ad7ff',
  particleWind: 1.0,
  particleWindScale: 0.3,
  particleWindSpeed: 1.0,
  particleHaloIntensity: 0.2,
  particleHaloSize: 1.5,
  hitLineEnabled: true,
  hitLineColor: '#5ad7ff',
  hitLineIntensity: 2.5,
  hitLineThickness: 0.3,
  hitLineWaveIntensity: 1.0,
  hitLineWaveAmplitude: 0.2,
  hitLineWaveScale: 60.0,
  hitLineWaveScrollSpeed: -0.5,
  hitLineWaveMorphSpeed: 0.7,
  hitLineWaveThickness: 0.04,
  hitLineWaveGrain: 0.8,
  hitLineBarY: 0,
  hitLineWaveY: 0,
  hitLineBarHalo: 2.0,
  hitLineWaveHalo: 0.8,
  bloomIntensity: 1.2,
  bloomThreshold: 0.2,
  bloomRadius: 0.7,
  bloomSmoothing: 0.4,
  backgroundColor: '#05060a',
  whiteKeyColor: '#f5f5f5',
  blackKeyColor: '#161616',
  keyboardBrightness: 0.8,
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
