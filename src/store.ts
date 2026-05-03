import { create } from 'zustand'
import type { ParsedSong } from './midi/types'

export type FallDirection = 'down' | 'up'

/**
 * Surface treatment applied to falling-note instances. Add new entries here
 * AND add a matching code path inside FallingNotes' fragment shader.
 * - 'solid'  — flat tinted fill (legacy behavior)
 * - 'liquid' — molten-metal flow with bright glassy rim, FBM-driven
 * - 'gem'    — cut-crystal facets with bright cell edges, Voronoi-driven
 */
export type NoteTexture = 'solid' | 'liquid' | 'gem'

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
  // Surface treatment preset — see NoteTexture for the registry.
  noteTexture: NoteTexture
  // Spatial frequency of the texture pattern (higher = denser detail).
  noteTextureScale: number
  // Animation rate of the flowing pattern (1 = baseline).
  noteTextureSpeed: number
  // Push factor on bright spots — higher = more contrast between dark and
  // highlight regions of the pattern.
  noteTextureContrast: number
  // Bright rim around the SDF edge, in world units. 0 = no rim.
  noteRimWidth: number
  // Rim brightness multiplier.
  noteRimIntensity: number
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
  // Linear gain on the master output. 0 = silent, 1 = unity, >1 = boost.
  // Linear (not dB) so the slider's bottom is true mute.
  volume: number
  playbackRate: number
  pedalEnabled: boolean
  // Master on/off for the reverb. When off, the wet path output is silenced
  // (Dry is unaffected). Useful for A/B comparison without losing settings.
  reverbEnabled: boolean
  // Linear gain on the dry (un-reverbed) signal. 1 = unity, 0 = mute.
  reverbDry: number
  // Linear gain on the reverb output (post-convolver). 1 = unity, 0 = mute.
  reverbWet: number
  // IR buffer length (seconds) — the maximum tail before silence.
  reverbSize: number
  // RT60 — time (seconds) for the reverb to drop ~60 dB. Independent of Size.
  reverbDecayTime: number
  // Power-curve exponent on the IR envelope, on top of the RT60 exponential.
  // Higher = quicker initial drop (tighter attack on the wash).
  reverbDecay: number
  // Delay (seconds) before the wet path enters the convolver. Adds visible
  // separation between the dry attack and the reverb wash.
  reverbPreDelay: number
  // Progressive HF absorption inside the IR (0..1). 0 = no damping; higher =
  // HF dies faster than LF as the tail progresses (physical room behavior).
  // Distinct from Hi Cut: this varies over time within the IR.
  reverbDamping: number
  // Static low-pass cutoff (Hz) on the wet path AFTER the convolver. Dulls
  // the whole reverb uniformly.
  reverbHiCut: number
  // High-pass cutoff (Hz) on the wet path — keeps the reverb out of the
  // bass register so chords don't muddy.
  reverbLowCut: number
  // Sampler release time (seconds) — how long a held note takes to fade
  // out after stop is called. Smaller = sharper key-up cutoff.
  releaseTime: number
  // Sampler — applies to every note (song + live) sent to the piano.
  samplerDetune: number      // pitch offset in cents (-100..+100)
  // 6-band master EQ on the sampler output. Gain in dB per band, ordered
  // low → high (80, 250, 800, 2.5k, 6k, 12k Hz).
  eqBands: number[]
  // Velocity shaping — applied at every note trigger (song playback + live
  // MIDI + on-screen keyboard) so the user's dynamics preferences feel
  // consistent across input sources.
  velocityGamma: number      // pow(velocity, gamma): <1 = harder/brighter, >1 = softer
  velocityFloor: number      // minimum velocity floor (0..1) — boost weak taps
  velocityCap: number        // maximum velocity cap (0..1) — clip hard hits
  // Pitch shift in semitones applied at every "input" stage — live MIDI
  // input from a physical device, AND the song timeline. Falling-note
  // positions also shift so the visualization stays aligned with the
  // played pitch. Screen-keyboard / PC-keyboard touches are NOT shifted
  // (the user is clicking on visible keys directly).
  transpose: number
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
  noteTexture: 'solid',
  noteTextureScale: 3.0,
  noteTextureSpeed: 0.8,
  noteTextureContrast: 2.5,
  noteRimWidth: 0.02,
  noteRimIntensity: 1.0,
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
  keyboardBrightness: 0.5,
  keyGlowColor: '#5ad7ff',
  keyGlowIntensity: 1.5,
  keyGlowDecay: 0.05,
  volume: 0.8,
  playbackRate: 1.0,
  pedalEnabled: true,
  reverbEnabled: true,
  reverbDry: 1.0,
  reverbWet: 1.0,
  reverbSize: 3.0,
  reverbDecayTime: 2.2,
  reverbDecay: 1.0,
  reverbPreDelay: 0.03,
  reverbDamping: 0.4,
  reverbHiCut: 6000,
  reverbLowCut: 100,
  releaseTime: 0.3,
  samplerDetune: 0,
  eqBands: [0, 0, 0, 0, 0, 0],
  velocityGamma: 1.0,
  velocityFloor: 0,
  velocityCap: 1,
  transpose: 0,
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
  // Preserve transport-bar controlled settings (volume, playback speed) so
  // the user's listening setup isn't lost when they reset the visual /
  // audio Inspector. The Reset button lives in the Inspector and is
  // expected to only affect what the Inspector shows.
  resetSettings: () =>
    set((state) => ({
      settings: {
        ...defaultSettings,
        volume: state.settings.volume,
        playbackRate: state.settings.playbackRate,
      },
    })),
}))
