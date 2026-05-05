import { create } from 'zustand'
import type { ParsedSong } from './midi/types'

export type FallDirection = 'down' | 'up'

/**
 * Surface treatment applied to falling-note instances. Add new entries here
 * AND add a matching code path inside FallingNotes' fragment shader.
 * - 'solid'  — flat tinted fill (legacy behavior)
 * - 'liquid' — molten-metal flow with bright glassy rim, FBM-driven
 * - 'gem'    — cut-crystal facets with bright cell edges, Voronoi-driven
 * - 'custom' — user-provided image (managed via useCustomTexture store)
 */
export type NoteTexture = 'solid' | 'liquid' | 'gem' | 'custom'

export type Settings = {
  // Theme — a single color the user can apply across notes / hit line /
  // particles / keyboard glow at once via the Inspector's "Apply to All"
  // button. Stored separately so it persists between applies; individual
  // color settings can still be tweaked independently afterward.
  themeColor: string
  // Layout
  keyboardY: number
  // Camera
  cameraFov: number
  cameraPos: [number, number, number]
  cameraLookAt: [number, number, number]
  // Notes
  notesEnabled: boolean
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
  // Spatial frequency of the texture pattern (higher = denser detail /
  // more repetitions; lower = zoomed in).
  noteTextureScale: number
  // Animation speed along X. Used by 'custom' for horizontal scroll. Other
  // presets ignore X (their patterns aren't directional).
  noteAnimSpeedX: number
  // Animation speed along Y. Used by 'custom' for vertical scroll. Liquid
  // and gem use this as their generic time multiplier (flow / twinkle rate).
  noteAnimSpeedY: number
  // Static positional shift of the texture sample point. Positive X = image
  // moves right on the note; positive Y = image moves up. Texture wrap is
  // RepeatWrapping so values outside [-1,1] just tile through.
  noteTextureOffsetX: number
  noteTextureOffsetY: number
  // Gaussian-style blur radius (in UV space) applied to the custom-image
  // sample. 0 = single tap (no blur). Higher = wider 9-tap kernel — useful
  // for softening low-resolution source images. Beyond ~0.05 the discrete
  // taps become visible as ghosting.
  noteTextureBlur: number
  // Per-note random offset on the custom-image sample, in [0, 1]. 0 = every
  // note shows the image identically positioned. 1 = each note starts at a
  // hash-derived random spot, so adjacent notes look different.
  noteTextureVariation: number
  // Push factor on bright spots — higher = more contrast between dark and
  // highlight regions of the pattern.
  noteTextureContrast: number
  // Bright rim around the SDF edge — applies to every texture preset
  // (including 'solid'). The rim is a polished outline drawn on top of the
  // note's fill, intended for the "glassy edge" highlight regardless of
  // the surface treatment.
  rimEnabled: boolean
  noteRimColor: string
  // Rim thickness in world units. 0 = no rim.
  noteRimWidth: number
  // Rim brightness multiplier on the chosen color.
  noteRimIntensity: number
  // White flash that appears at the contact line while a note is held
  flashEnabled: boolean
  // When true, flash uses noteColor instead of the explicit flashColor.
  flashFollowNote: boolean
  // Lift the flash colour toward white. 0 = pure flashColor, 1 = pure white.
  // Lets a coloured flash keep a bright white core for that "spark" feel.
  flashBrightness: number
  flashIntensity: number
  flashSize: number
  flashWidth: number
  // Softness of the core falloff — larger = wider halo edge around the bright spot
  flashHaloWidth: number
  flashColor: string
  // Particles drifting up from the keyboard while a note is held. The
  // visual signature is a billboarded radial flame-wisp: the quad geometry
  // stays at fixed size, but the fragment's UV is radially dilated as the
  // particle ages so the bright core appears to shrink while the soft halo
  // expands. Motion is curl-noise driven (Bridson 2007), with per-particle
  // 3D position so the divergence-free vector field can produce internal
  // cluster width without horizontal spreading.
  particlesEnabled: boolean
  particleColor: string
  particleSize: number          // global scale on the radial falloff
  particleOpacity: number       // alpha multiplier on the final color
  particleBrightness: number    // lift toward white in `tex × (color + (1 − color) × brightness) × 1.4`
  particleLifetime: number      // seconds — visible duration of each particle
  particleSpeed: number         // multiplier on the initial upward drift velocity
  particleCount: number         // per-key per-frame emission count (stochastic-rounded)
  // Curl-noise wind field shape. Multi-octave FBM on top of a 3D Perlin
  // gradient sampled at 3 displaced bases (Bridson 2007's vector
  // potential ψ → curl(ψ) = divergence-free flow).
  particleTurbulence: number    // master strength of the curl contribution to velocity
  turbulenceFrequency: number   // spatial frequency of the curl field (smaller = larger features)
  flowSpeed: number        // rate the noise sample point slides along Z (= "wind landscape evolves")
  // Per-axis turbulence scales — applied BOTH as inverse feature-size
  // inside the domain transform (asymmetric noise) AND component-wise on
  // the curl output (per-axis amplitude).
  turbulenceX: number
  turbulenceY: number
  turbulenceZ: number
  // 0 = noise sample point pinned to the emitter (all particles in one
  // press follow the same wind in lockstep). 1 = sample purely at the
  // particle's current position (each drifts independently). Mid values
  // give intra-emission coherence within a single press.
  noiseLocality: number
  // FBM octave count and per-octave multipliers. octaveScale = lacunarity
  // (frequency multiplier per octave); octaveMultiplier = gain (amplitude
  // multiplier per octave).
  turbulenceOctaves: number
  octaveScale: number
  octaveMultiplier: number
  // Multiplicative drag rate on velocity per second. xy_speed and |vz|
  // are damped by `drag × C × min(speed, 1) × dt` per frame; xy_speed is
  // floored at a small minimum so particles don't completely stall in
  // zero-curl regions.
  drag: number
  // Rotational pull on velocity.xy angle AWAY from π/2 (= +Y, "up"). +Y
  // is an unstable equilibrium — particles starting purely upward stay
  // upward, but any horizontal perturbation grows over time, producing
  // a swirling-spread visual when this is dialled up.
  swirl: number
  // Initial outward kick on emission, in a direction deterministically
  // hashed from the spawn XY (so two particles spawned at the same XY
  // get the same launch direction). 0 = pure upward initial velocity.
  kick: number
  // Glowing laser line at the keyboard hit point — straight bar + animated wavy beam
  hitLineEnabled: boolean
  hitLineColor: string
  hitLineIntensity: number   // straight-bar brightness
  hitLineThickness: number   // straight-bar core thickness (fraction of plane height)
  hitLineWaveEnabled: boolean   // gates JUST the wavy laser overlay (the straight bar is gated by hitLineEnabled)
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
  bloomEnabled: boolean
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
  keyGlowEnabled: boolean
  // When true, keyboard press-glow uses noteColor. When false, the user's
  // explicit keyGlowColor is used instead.
  keyGlowFollowNote: boolean
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
  themeColor: '#5ad7ff',
  keyboardY: -2.0,
  cameraFov: 32,
  cameraPos: [0, 0, 12],
  cameraLookAt: [0, 0, 0],
  notesEnabled: true,
  fallDirection: 'down',
  fallDurationSec: 2.5,
  noteColor: '#5ad7ff',
  noteEmissive: 1.0,
  noteOpacity: 1.0,
  noteCornerRadius: 0.05,
  noteWidthScale: 1.0,
  noteMinLength: 0.15,
  noteTexture: 'solid',
  noteTextureScale: 3.0,
  noteAnimSpeedX: 0.0,
  noteAnimSpeedY: 0.0,
  noteTextureOffsetX: 0.0,
  noteTextureOffsetY: 0.0,
  noteTextureBlur: 0.0,
  noteTextureVariation: 0.0,
  noteTextureContrast: 2.5,
  rimEnabled: true,
  noteRimColor: '#ffffff',
  noteRimWidth: 0,
  noteRimIntensity: 1.0,
  flashEnabled: true,
  flashFollowNote: true,
  flashBrightness: 0.5,
  flashIntensity: 1.1,
  flashSize: 2.5,
  flashWidth: 2.5,
  flashHaloWidth: 0.5,
  flashColor: '#ffffff',
  particlesEnabled: true,
  particleColor: '#5ad7ff',
  particleSize: 0.80,
  particleOpacity: 0.15,
  particleBrightness: 0.15,
  particleLifetime: 0.70,
  particleSpeed: 1.00,
  particleCount: 8.00,
  particleTurbulence: 0.50,
  turbulenceFrequency: 1.40,
  flowSpeed: 4.75,
  turbulenceX: 0.5,
  turbulenceY: 0.70,
  turbulenceZ: 0.90,
  noiseLocality: 0.80,
  turbulenceOctaves: 3,
  octaveScale: 1.1,
  octaveMultiplier: 0.0,
  drag: 0.10,
  swirl: 0.10,
  kick: 0,
  hitLineEnabled: true,
  hitLineColor: '#5ad7ff',
  hitLineIntensity: 2.5,
  hitLineThickness: 0.3,
  hitLineWaveEnabled: true,
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
  bloomEnabled: true,
  bloomIntensity: 0.5,
  bloomThreshold: 0.2,
  bloomRadius: 0.7,
  bloomSmoothing: 0.4,
  backgroundColor: '#05060a',
  whiteKeyColor: '#f5f5f5',
  blackKeyColor: '#161616',
  keyboardBrightness: 0.5,
  keyGlowEnabled: true,
  keyGlowFollowNote: true,
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

  // When true, pressing Record plays a 4-beat metronome count-in before
  // the recorder actually starts capturing input. Lets the user prepare
  // the first downbeat instead of scrambling into the first note.
  countInEnabled: boolean
  setCountInEnabled: (b: boolean) => void
  // Current beat number during a count-in (1..N). 0 when not counting in.
  // Driven by the audio click scheduler; the toolbar reads this to show
  // the countdown badge.
  countInBeat: number
  setCountInBeat: (n: number) => void

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

  countInEnabled: true,
  setCountInEnabled: (countInEnabled) => set({ countInEnabled }),

  countInBeat: 0,
  setCountInBeat: (countInBeat) => set({ countInBeat }),

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
