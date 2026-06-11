import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useSettingsSlice } from '../store'

const HIT_PARTICLES_KEYS = [
  'cameraFov',
  'cameraLookAt',
  'cameraPos',
  'drag',
  'fallDurationSec',
  'flowSpeed',
  'keyboardY',
  'kick',
  'noiseLocality',
  'noteMinLength',
  'octaveMultiplier',
  'octaveScale',
  'particleBrightness',
  'particleColor',
  'particleCount',
  'particleLifetime',
  'particleOpacity',
  'particlesEnabled',
  'particleSize',
  'particleSpeed',
  'particleTurbulence',
  'swirl',
  'trackColors',
  'turbulenceFrequency',
  'turbulenceOctaves',
  'turbulenceX',
  'turbulenceY',
  'turbulenceZ',
] as const
import { audioEngine } from '../audio/engine'
import { now } from '../audio/clock'
import { getResolvedSettings } from '../scene/automatedSettings'
import { KEYBOARD_LAYOUT, KEY_COUNT, MIDI_MIN, WHITE_KEY_LENGTH, WHITE_KEY_WIDTH } from '../keyboard/layout'
import { sampleCurl, dirFromXY } from './curlNoise'
import { noteDeathFx } from './noteDeathFx'

// How long a single death event keeps emitting particles. Spreading
// emission over a window — instead of dumping everything in one frame —
// reproduces the "particles streaming out of a held key" look exactly,
// because we're literally running the same per-frame emit logic the
// held-key path uses, just at the death position. Net particle count
// across the window matches what the user would see if the note had
// played for this duration.
const DEATH_EMIT_DURATION = 0.35

// Curl-noise-driven keyboard particles. Per particle, per frame:
//
//   domainPos = pos × movesWith + emitterPos × (1 − movesWith)
//   domainPos = (domainPos × turbFreq) / (turbX, turbY, turbZ)
//   domainPos.z += t × flowSpeed
//   curl = sampleCurl(domainPos, octaves, octaveScale, octaveMultiplier)
//   curl ⊙= (turbX, turbY, turbZ)
//   velocity += curl × turbulence × dt
//   // Optional rotational pull on velocity angle (swirl > 0):
//   //   destabilises +Y so any horizontal perturbation grows over time
//   // Optional drag (drag > 0):
//   //   xy_speed -= drag × DRAG_RATE × min(xy_speed, 1) × dt
//   //   xy_speed lower-bounded at MIN_XY_SPEED so particles don't stall
//   pos += velocity × dt
//
// Particles live in true 3D space (per-particle Z) so the curl field can
// produce internal cluster width — two particles at (sameX, sameY,
// differentZ) sample different curl voxels and drift differently. A 2D
// curl with any per-particle perturbation we tried produced either a
// thin coherent strand (no perturbation) or a too-wide spread (any
// perturbation), so 3D is load-bearing here.
//
// Visual rendering (per-pixel circle clip, age-based UV dilation, alpha
// envelope, color blend, size pop-in) is in the fragment shader below.

// Slot count for the per-particle InstancedBufferGeometry. The hot loop
// iterates every slot (skipping dead ones via the age check), so this is
// the practical cap on simultaneous live particles. Sized to handle ~10
// polyphonic keys at default Count + Lifetime: 10 × 10 × 60 × (0.8 × 5)
// = 24000 peak. When the user pushes Count or holds many keys, the slots
// recycle in FIFO order — once full, older particles get overwritten
// mid-fade, producing a visible "particles vanish in sequence" artefact.
// Bumping further trades memory + per-frame loop overhead for headroom
// (~60 bytes/slot for the per-particle Float32Arrays).
const MAX_PARTICLES = 32768
// Calibration constants tuning the per-particle world units to read well
// at our default keyboard / camera scale.
const BASE_UP_SPEED = 1.0
const BASE_PARTICLE_SIZE = 0.032
const LIFETIME_SCALE = 5.0
// Constant per-key emitter width — same column thickness for black and
// white keys so the visual columns line up regardless of which key fired.
const EMITTER_WIDTH = WHITE_KEY_WIDTH * 0.9
// Quick puff on note-on for visible ignition independent of the steady
// per-frame emission rate.
const ATTACK_BURST = 3
// Lower bound on horizontal speed when air friction is active — prevents
// particles stalling completely in zero-curl regions. Expressed as a
// fraction of the unit-speed reference rather than a raw decimal so the
// "5%" intent is explicit.
const MIN_XY_SPEED = 1 / 20
// Per-second drag rate. Multiplied by the user-tuned `drag` setting and
// by the integration `dt`, giving the per-frame velocity reduction.
// Tuned so that with drag = 1.0 a unit-speed particle loses about half
// its speed every 230 ms.
const DRAG_RATE_PER_SEC = 3.0
// Time constant (seconds) of the horizontal-confinement relaxation.
// Off-vertical velocity components (x and z) decay exponentially toward
// 0 with this τ, turning the curl forcing's unbounded random walk into
// a bounded wiggle: sideways speed saturates at ≈ forcing × τ instead
// of accumulating with age. Without this, older (= higher) particles
// carry ever-larger |vx| and the plume fans out as it rises; with it
// the column meanders at a roughly constant width. vy is untouched so
// the upward drift is preserved (the user-facing `drag` damps the full
// xy speed, rise included, so it can't serve this role).
const HORIZ_CONFINE_TAU = 0.4
// Per-second angular bend rate at maximum deviation from vertical.
// Multiplied by `swirl`, `dt`, and the deviation factor; produces the
// swirling-spread when the user dials it up.
const ANGULAR_BEND_RATE_PER_SEC = 2.4
// Time constant (seconds) PER STAGE of the two-stage cascaded EMA that
// low-passes the per-particle curl forcing. The raw curl sample at a
// particle's position flutters at ≈ flowSpeed Hz (the Z-axis time slide
// crosses that many noise cells per second — ~5 Hz at the default 4.75),
// plus extra chatter when the particle crosses lattice cells. Integrated
// into velocity, that flutter reads as a fine left-right shake. A single
// pole (−6 dB/oct) lets too much of the ~5 Hz band through at any τ that
// keeps the swirl responsive; cascading two stages gives −12 dB/oct, so
// at τ = 0.10 the 5 Hz flutter drops to ~9% while ~1 Hz swirl keeps ~60%.
const CURL_SMOOTHING_TAU = 0.10
const TWO_OVER_PI = 2.0 / Math.PI
const HALF_PI = Math.PI / 2

const VERTEX_SHADER = /* glsl */ `
  attribute float aBirth;
  attribute float aLifetime;
  attribute vec3  aPosition;   // current world XYZ — written every frame from CPU integration
  attribute float aBaseSize;
  attribute vec3  aColor;

  uniform float uTime;
  uniform float uSize;          // global Inspector-driven size scale

  varying vec2  vUv;
  varying float vAge;
  varying float vWorldY;
  varying vec3  vColor;
  varying float vEffectiveSize;

  void main() {
    float age = uTime - aBirth;
    if (age < 0.0 || age > aLifetime) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vAge = 0.0;
      vUv = vec2(0.0);
      vWorldY = 0.0;
      vColor = vec3(0.0);
      vEffectiveSize = 0.0;
      return;
    }
    float t = age / aLifetime;
    vAge = t;
    vColor = aColor;
    vUv = position.xy + 0.5;

    // Pop-in: particles emerge at ~48% of their full size and ramp to
    // 100% over the first 10% of life. Adds a quick attack flick rather
    // than the bare appearance of full-size points.
    float popIn = mix(0.483, 1.0, smoothstep(0.0, 0.10, t));
    float worldSize = aBaseSize * uSize * popIn;
    vEffectiveSize = aBaseSize;

    // Camera-aligned billboard. Quad always faces the camera regardless
    // of where the user moves it via the Inspector.
    mat3 invViewRot = transpose(mat3(viewMatrix));
    vec3 right = invViewRot[0];
    vec3 up    = invViewRot[1];
    vec3 worldCorner = aPosition
                       + right * position.x * worldSize
                       + up    * position.y * worldSize;
    vWorldY = worldCorner.y;

    gl_Position = projectionMatrix * viewMatrix * vec4(worldCorner, 1.0);
  }
`

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec2  vUv;
  varying float vAge;
  varying float vWorldY;
  varying vec3  vColor;
  varying float vEffectiveSize;

  uniform float uHitY;
  uniform float uOpacity;
  uniform float uBrightness;
  uniform float uSize;

  void main() {
    // Per-pixel keyboard discard — particles only render above the hit
    // line. The 1.001 bias keeps the keyboard's own top edge from
    // fighting the discard at the seam.
    if (vWorldY < uHitY * 1.001) discard;

    // Base UV in [-0.5, 0.5] — used for the silhouette circle clip so the
    // particle is always round regardless of how the size-ratio + age
    // dilation rescale the falloff. Without this clip, sizeRatio < 1 and
    // dilateFactor ≈ 1 (young particles) leaves the entire square quad
    // visible because the procedural radial falloff exp(-r² × 14) never
    // quite reaches 0.
    vec2 baseUv = vUv - 0.5;
    float baseR = length(baseUv);
    if (baseR > 0.5) discard;
    // Smooth anti-aliased circle edge.
    float circleMask = 1.0 - smoothstep(0.45, 0.50, baseR);

    // Scaled UV drives the age-based dilation falloff (independent of
    // the silhouette clip above). As the particle ages, the same screen
    // pixel maps further from the texture center → bright core appears
    // to shrink while soft tail extends.
    vec2 uv = baseUv;
    float sizeRatio = vEffectiveSize / max(uSize * 0.08, 0.001);
    uv *= sizeRatio;

    float dilateDenom = max(1.15 - vAge, 0.001);
    float dilateFactor = vAge > 0.25 ? 0.9 / dilateDenom : 1.0;
    uv *= dilateFactor;

    float r = length(uv);
    float texAlpha = exp(-r * r * 14.0) * circleMask;

    // Smoothstep alpha cap — flat 1.0 until age 0.5, then S-curve fade
    // to 0 at age 1.0. Smoother than a hard linear ramp at the tail.
    float alphaCap = 1.0 - smoothstep(0.5, 1.0, vAge);

    float alpha = texAlpha * alphaCap * uOpacity;
    if (alpha < 0.001) discard;

    // Color lift: blend toward white as brightness goes up, then
    // multiply by a fixed boost. With brightness > 1 the channel that
    // started lowest grows fastest, which intentionally produces a hue
    // shift past white.
    vec3 lift = vColor + (1.0 - vColor) * uBrightness;
    vec3 rgb = lift * 1.4;

    gl_FragColor = vec4(rgb, alpha);
  }
`

export function HitParticles() {
  const settings = useSettingsSlice(HIT_PARTICLES_KEYS)

  const births = useMemo(() => {
    const a = new Float32Array(MAX_PARTICLES)
    a.fill(-1000)
    return a
  }, [])
  const lifetimes = useMemo(() => new Float32Array(MAX_PARTICLES), [])
  // Per-particle world position (vec3) — written every frame.
  const positions = useMemo(() => new Float32Array(MAX_PARTICLES * 3), [])
  // Internal state (never reaches the GPU):
  // - velocities: current velocity used for position integration
  // - emitterPositions: where the particle was spawned, used for the
  //   "moves with" mix term (`pos × movesWith + emit × (1 − movesWith)`)
  //   so noise sampling can be partially anchored to the emitter and
  //   give intra-emission coherence within a single press.
  const velocities = useMemo(() => new Float32Array(MAX_PARTICLES * 3), [])
  const emitterPositions = useMemo(() => new Float32Array(MAX_PARTICLES * 3), [])
  // Per-particle low-pass-filtered curl velocity — two cascaded EMA
  // stages (see CURL_SMOOTHING_TAU). Stage 2 replaces the raw sample in
  // the velocity update so the curl field's temporal flutter doesn't
  // show as a fine left-right shake. Both stages initialise to 0 on
  // emit so the first few frames ramp into the wind smoothly.
  const smoothedCurl = useMemo(() => new Float32Array(MAX_PARTICLES * 3), [])
  const smoothedCurl2 = useMemo(() => new Float32Array(MAX_PARTICLES * 3), [])
  const baseSizes = useMemo(() => new Float32Array(MAX_PARTICLES), [])
  const colors = useMemo(() => new Float32Array(MAX_PARTICLES * 3), [])

  const birthAttr = useMemo(
    () => new THREE.InstancedBufferAttribute(births, 1).setUsage(THREE.DynamicDrawUsage),
    [births],
  )
  const lifetimeAttr = useMemo(
    () => new THREE.InstancedBufferAttribute(lifetimes, 1).setUsage(THREE.DynamicDrawUsage),
    [lifetimes],
  )
  const positionAttr = useMemo(
    () => new THREE.InstancedBufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage),
    [positions],
  )
  const baseSizeAttr = useMemo(
    () => new THREE.InstancedBufferAttribute(baseSizes, 1).setUsage(THREE.DynamicDrawUsage),
    [baseSizes],
  )
  const colorAttr = useMemo(
    () => new THREE.InstancedBufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage),
    [colors],
  )

  const geometry = useMemo(() => {
    const base = new THREE.PlaneGeometry(1, 1)
    const g = new THREE.InstancedBufferGeometry()
    g.index = base.index
    g.setAttribute('position', base.getAttribute('position'))
    g.setAttribute('uv', base.getAttribute('uv'))
    g.setAttribute('aBirth', birthAttr)
    g.setAttribute('aLifetime', lifetimeAttr)
    g.setAttribute('aPosition', positionAttr)
    g.setAttribute('aBaseSize', baseSizeAttr)
    g.setAttribute('aColor', colorAttr)
    g.instanceCount = MAX_PARTICLES
    base.dispose()
    return g
  }, [birthAttr, lifetimeAttr, positionAttr, baseSizeAttr, colorAttr])
  useEffect(() => () => geometry.dispose(), [geometry])

  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uHitY: { value: 0 },
        uSize: { value: settings.particleSize },
        uOpacity: { value: settings.particleOpacity },
        uBrightness: { value: settings.particleBrightness },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
    // settings excluded — sync below via per-field useEffects
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => () => material.dispose(), [material])

  // particleSize / particleOpacity / particleBrightness are animatable
  // and get pushed into the uniforms every frame from the pin-resolved
  // settings inside useFrame (so they follow pins + animate under the
  // export's advance() loop). With zero pins these equal the live
  // settings, so the value written is identical to the old effects'.

  const mesh = useMemo(() => {
    const m = new THREE.Mesh(geometry, material)
    m.frustumCulled = false
    return m
  }, [geometry, material])

  const heldCount = useMemo(() => new Uint8Array(KEY_COUNT), [])
  const lastVelocity = useMemo(() => new Float32Array(KEY_COUNT), [])
  // Track index of the most recent note-on per key (-1 = no track /
  // live input). Read at emission time to look up the per-track tint
  // — gives the particle plume the same colour as the falling note
  // that triggered it. Sustained-emit loop and the attack burst both
  // read from here, so a key held across a track switch picks up the
  // new colour cleanly on the next press.
  const lastTrack = useMemo(() => {
    const a = new Int32Array(KEY_COUNT)
    a.fill(-1)
    return a
  }, [])
  const emitAccum = useMemo(() => new Float32Array(KEY_COUNT), [])
  const pendingBurst = useMemo(() => new Uint8Array(KEY_COUNT), [])
  // Per-key timestamp of the most recent note-on, used to enforce a
  // minimum sustained emission window matching the falling-note
  // `noteMinLength` — staccato notes still spawn particles for as long
  // as the visual bar is on screen, so the key glow, the bar, and the
  // particles all have synchronised durations. -Infinity = no past note.
  const noteOnTime = useMemo(() => {
    const a = new Float32Array(KEY_COUNT)
    a.fill(-Infinity)
    return a
  }, [])
  const writeIdx = useRef(0)
  const lastFrame = useRef(now())
  // Wall-clock moment of the latest-dying still-active particle. Used
  // as a cheap "are any particles alive?" gate so the per-particle
  // integration loop doesn't burn CPU at idle when every slot is dead.
  // Updated at emission time; once `now()` advances past this, the
  // next frame skips the integration pass entirely.
  const maxDeathTime = useRef(0)
  // Compacted index of alive particle slots. Replacing the naive
  // O(MAX_PARTICLES) walk with O(aliveCount) is the difference between
  // 32 768 iterations/frame (heavy CPU spike on a few held keys) and
  // a couple thousand at most. `aliveFlags[slot]` is the parallel
  // membership bitmap so the ring-buffer recycle path can detect "this
  // slot is already in aliveIndices, don't double-add".
  const aliveIndices = useMemo(() => new Int32Array(MAX_PARTICLES), [])
  const aliveFlags = useMemo(() => new Uint8Array(MAX_PARTICLES), [])
  const aliveCountRef = useRef(0)
  const colorVec = useMemo(() => new THREE.Color(), [])
  // Reused scratch buffers — avoid per-frame allocation in the hot loop.
  const curlScratch = useMemo<[number, number, number]>(() => [0, 0, 0], [])
  const dirScratch = useMemo<[number, number]>(() => [0, 0], [])

  useEffect(() => {
    const off = audioEngine.addKeyListener((ev) => {
      const idx = ev.midi - MIDI_MIN
      if (idx < 0 || idx >= KEY_COUNT) return
      if (ev.type === 'on') {
        heldCount[idx]++
        lastVelocity[idx] = ev.velocity
        lastTrack[idx] = ev.track ?? -1
        pendingBurst[idx] += ATTACK_BURST
        emitAccum[idx] = 0
        noteOnTime[idx] = now()
      } else {
        heldCount[idx] = Math.max(0, heldCount[idx] - 1)
      }
    })
    return off
  }, [heldCount, lastVelocity, lastTrack, pendingBurst, emitAccum, noteOnTime])

  // Active "death emitters" — each death event spawns one of these and it
  // emits particles for DEATH_EMIT_DURATION using the same per-frame rate
  // a held key would. That's how the puff matches a real hit's feel:
  // we're literally running the held-key emission logic at the deletion
  // position for a brief window, then letting it expire.
  type DeathEmitter = {
    x: number
    centerY: number
    width: number
    length: number
    velocity: number
    startTime: number
    emitAccum: number
    // The attack-burst on first tick mirrors what a real key press
    // does — without it the death puff would be missing the brief
    // "pop" of slightly-larger particles at the very start.
    burstFired: boolean
    /** Source track of the deleted note; -1 if the dying note had no
     *  track tag (e.g. recorder-built song). Resolves to a per-track
     *  tint in `resolveTrackRGB`. */
    track: number
  }
  const deathEmittersRef = useRef<DeathEmitter[]>([])
  useEffect(() => {
    const off = noteDeathFx.subscribe((d) => {
      deathEmittersRef.current.push({
        x: d.x,
        centerY: d.centerY,
        width: d.width,
        length: d.length,
        velocity: d.velocity,
        startTime: now(),
        emitAccum: 0,
        burstFired: false,
        track: d.track ?? -1,
      })
    })
    return off
  }, [])

  useFrame(() => {
    const nowSec = now()
    const dt = Math.min(0.05, nowSec - lastFrame.current)
    lastFrame.current = nowSec

    // Pin-resolved settings for every animatable particle parameter.
    // `particlesEnabled` / `turbulenceOctaves` are non-animatable so
    // they keep reading the React `settings` slice. Zero pins ⇒ `rs`
    // is the live settings object by reference, so every read below is
    // bit-identical to the pre-pin code.
    const rs = getResolvedSettings()

    // Push the pin-resolved global uniforms (formerly per-field
    // useEffects). Idempotent with zero pins.
    material.uniforms.uSize.value = rs.particleSize
    material.uniforms.uOpacity.value = rs.particleOpacity
    material.uniforms.uBrightness.value = rs.particleBrightness
    material.uniforms.uTime.value = nowSec
    material.uniforms.uHitY.value = rs.keyboardY + WHITE_KEY_LENGTH

    if (!settings.particlesEnabled) return

    const hitY = rs.keyboardY + WHITE_KEY_LENGTH
    // Minimum emission duration in seconds, derived from the falling-note
    // `noteMinLength` (world units) using the same fall-distance ↔ time
    // conversion FallingNotes uses. Recomputed per frame so changes to
    // camera / keyboard / fall duration take effect immediately, including
    // for notes already in their min-emit window.
    const camDistance = Math.abs(rs.cameraPos[2])
    const halfVisHeight = camDistance * Math.tan((rs.cameraFov * Math.PI) / 360)
    const visibleTop = rs.cameraLookAt[1] + halfVisHeight
    const fallDistance = Math.max(0.5, visibleTop - hitY) + 1.0  // SPAWN_BUFFER = 1.0
    const minEmitDurationSec = Math.max(0, rs.noteMinLength) / fallDistance * rs.fallDurationSec

    colorVec.set(rs.particleColor)
    const cr = colorVec.r
    const cg = colorVec.g
    const cb = colorVec.b
    // Per-track RGB cache, built lazily as we emit. A track with no
    // override resolves to the global particleColor (cr/cg/cb), so
    // particles for live input / un-tracked notes look unchanged from
    // before this feature.
    const trackColors = rs.trackColors
    const trackColorCache = new Map<number, readonly [number, number, number]>()
    const resolveTrackRGB = (
      trackIdx: number,
    ): readonly [number, number, number] => {
      if (trackIdx < 0) return [cr, cg, cb]
      const cached = trackColorCache.get(trackIdx)
      if (cached) return cached
      const override = trackColors[String(trackIdx)]
      if (!override) {
        const v: [number, number, number] = [cr, cg, cb]
        trackColorCache.set(trackIdx, v)
        return v
      }
      colorVec.set(override)
      const v: [number, number, number] = [colorVec.r, colorVec.g, colorVec.b]
      trackColorCache.set(trackIdx, v)
      return v
    }
    const userSpeed = rs.particleSpeed
    const userLifetime = rs.particleLifetime
    const userCount = rs.particleCount
    const turbStrength = rs.particleTurbulence
    const turbFreq = rs.turbulenceFrequency
    const flowSpeed = rs.flowSpeed
    // Per-axis turbulence scales — applied both as inverse feature-size
    // inside the domain transform (`/ turbX` etc.) AND as component-wise
    // amplitude on the curl output. Floor at small ε so divide-by-zero
    // doesn't blow up when the user dials an axis to 0.
    const tx = Math.max(rs.turbulenceX, 1e-6)
    const ty = Math.max(rs.turbulenceY, 1e-6)
    const tz = Math.max(rs.turbulenceZ, 1e-6)
    const locality = rs.noiseLocality
    const oneMinusLocality = 1 - locality
    const octaves = Math.max(1, Math.floor(settings.turbulenceOctaves))
    const octScale = rs.octaveScale
    const octMul = rs.octaveMultiplier
    const drag = rs.drag
    const swirl = rs.swirl
    const kick = rs.kick
    // dt × 60 — turns per-60Hz-frame coefficients (friction, angle bend)
    // into framerate-independent rates. = 1.0 at 60fps; 2.0 at 30fps.
    const dtFactor = dt * 60.0
    // Z-axis time evolution — slides the noise sample point so the wind
    // landscape drifts over time. flowSpeed = 0 freezes the field.
    const tNoise = nowSec * flowSpeed
    // Frame-rate-independent EMA blending coefficient for the curl
    // smoothing filter. α = 1 − exp(−dt/τ); at 60fps with τ=60ms this
    // is ≈ 0.245.
    const smoothingAlpha = 1 - Math.exp(-dt / CURL_SMOOTHING_TAU)
    // Per-frame horizontal-confinement decay factor (see HORIZ_CONFINE_TAU).
    const horizRelax = Math.exp(-dt / HORIZ_CONFINE_TAU)

    let positionDirty = false
    // Skip the per-particle integration pass entirely when no particle
    // is still alive. `maxDeathTime` is bumped at emit so any new key
    // press or death-burst (handled after this block) will refresh it
    // and the loop resumes next frame.
    const anyAlive = nowSec < maxDeathTime.current && aliveCountRef.current > 0
    let aliveCount = anyAlive ? aliveCountRef.current : 0
    for (let k = 0; k < aliveCount; ) {
      const i = aliveIndices[k]
      const birth = births[i]
      const age = nowSec - birth
      if (age < 0 || age > lifetimes[i]) {
        // Expired — swap-remove from the alive list. `aliveFlags`
        // clears so the ring buffer can re-add this slot cleanly.
        aliveFlags[i] = 0
        aliveCount--
        aliveIndices[k] = aliveIndices[aliveCount]
        continue
      }

      const i3 = i * 3
      let px = positions[i3 + 0]
      let py = positions[i3 + 1]
      let pz = positions[i3 + 2]
      let vx = velocities[i3 + 0]
      let vy = velocities[i3 + 1]
      let vz = velocities[i3 + 2]
      const ex = emitterPositions[i3 + 0]
      const ey = emitterPositions[i3 + 1]
      const ez = emitterPositions[i3 + 2]

      if (turbStrength > 0) {
        // Domain transform — mix particle + emitter by locality.
        // locality = 1 → pure particle position (each particle drifts
        // independently). locality = 0 → noise sampled at emitter (all
        // particles from one press follow the same wind in lockstep).
        // Mid values give partial coherence within a single emission.
        const dxBase = px * locality + ex * oneMinusLocality
        const dyBase = py * locality + ey * oneMinusLocality
        const dzBase = pz * locality + ez * oneMinusLocality
        // Apply per-axis scale: smaller tx/ty/tz value → larger feature
        // size on that axis → smoother variation in that direction.
        const dx = dxBase * turbFreq / tx
        const dy = dyBase * turbFreq / ty
        const dz = dzBase * turbFreq / tz + tNoise

        // Multi-octave curl noise sample.
        sampleCurl(dx, dy, dz, octaves, octScale, octMul, curlScratch)

        // Two-stage cascaded EMA on the raw curl (−12 dB/oct) to filter
        // out the temporal flutter from the Z-axis time slide and
        // lattice-cell crossings — a single pole left enough of the
        // ~5 Hz band through to read as a fine left-right shake.
        const s1x = smoothedCurl[i3 + 0]
        const s1y = smoothedCurl[i3 + 1]
        const s1z = smoothedCurl[i3 + 2]
        const n1x = s1x + smoothingAlpha * (curlScratch[0] - s1x)
        const n1y = s1y + smoothingAlpha * (curlScratch[1] - s1y)
        const n1z = s1z + smoothingAlpha * (curlScratch[2] - s1z)
        smoothedCurl[i3 + 0] = n1x
        smoothedCurl[i3 + 1] = n1y
        smoothedCurl[i3 + 2] = n1z
        const s2x = smoothedCurl2[i3 + 0]
        const s2y = smoothedCurl2[i3 + 1]
        const s2z = smoothedCurl2[i3 + 2]
        const nsx = s2x + smoothingAlpha * (n1x - s2x)
        const nsy = s2y + smoothingAlpha * (n1y - s2y)
        const nsz = s2z + smoothingAlpha * (n1z - s2z)
        smoothedCurl2[i3 + 0] = nsx
        smoothedCurl2[i3 + 1] = nsy
        smoothedCurl2[i3 + 2] = nsz

        // Component-multiply by per-axis amplitudes so TurbX/Y/Z also
        // weight the OUTPUT, giving asymmetric noise when the user dials
        // them away from each other.
        const dv = turbStrength * dt
        vx += nsx * tx * dv
        vy += nsy * ty * dv
        vz += nsz * tz * dv
      }

      // Optional rotational pull on velocity.xy angle. +Y is the
      // unstable equilibrium — perturbations grow over time, producing
      // a swirling spread when enabled. Most useful when paired with
      // friction so particles don't spin out indefinitely.
      if (swirl > 0) {
        const xySpeed = Math.sqrt(vx * vx + vy * vy)
        if (xySpeed > 1e-6) {
          const angle = Math.atan2(vy, vx)
          const dev = Math.abs(HALF_PI - angle) * TWO_OVER_PI
          const devClamped = dev < 1 ? dev : 1
          const sign = HALF_PI > angle ? 1 : -1
          const newAngle = angle - sign * swirl * ANGULAR_BEND_RATE_PER_SEC * devClamped * dt
          vx = xySpeed * Math.cos(newAngle)
          vy = xySpeed * Math.sin(newAngle)
        }
      }

      // Drag — multiplicative damping on xy_speed and |vz|. The
      // `min(speed, 1)` factor bends the damping curve so high-speed
      // particles slow proportionally faster. xy_speed is floored so
      // particles never fully stall in zero-curl regions.
      if (drag > 0) {
        const dragStep = drag * DRAG_RATE_PER_SEC * dt
        const xySpeed = Math.sqrt(vx * vx + vy * vy)
        if (xySpeed > 1e-6) {
          const damp = xySpeed < 1 ? xySpeed : 1
          const newXySpeed = Math.max(xySpeed - dragStep * damp, MIN_XY_SPEED)
          const scale = newXySpeed / xySpeed
          vx *= scale
          vy *= scale
        }
        const vzAbs = Math.abs(vz)
        if (vzAbs > 1e-6) {
          const dampZ = vzAbs < 1 ? vzAbs : 1
          const newVzAbs = Math.max(vzAbs - dragStep * dampZ, 0)
          vz *= newVzAbs / vzAbs
        }
      }

      // Horizontal confinement — bleed off the sideways components so
      // curl-accumulated drift saturates instead of widening with age.
      vx *= horizRelax
      vz *= horizRelax

      // Integrate position.
      px += vx * dt
      py += vy * dt
      pz += vz * dt

      positions[i3 + 0] = px
      positions[i3 + 1] = py
      positions[i3 + 2] = pz
      velocities[i3 + 0] = vx
      velocities[i3 + 1] = vy
      velocities[i3 + 2] = vz
      positionDirty = true
      k++
    }
    aliveCountRef.current = aliveCount

    let emissionDirty = false

    // Lower-level primitive: stamp one particle into the next pool slot
    // at a given world position with a given color/velocity profile.
    // emitOne (key-derived) and the death-burst loop both go through this.
    const emitParticleAt = (
      ox: number,
      oy: number,
      oz: number,
      vel: number,
      isBurst: boolean,
      r: number,
      g: number,
      b: number,
      sizeMul: number,
      upwardSpeed: number,
      lifetimeSec: number,
    ) => {
      const velFactor = 0.55 + vel * 0.6
      const sizeJitter = 0.9 + Math.random() * 0.2
      const burstSize = isBurst ? 1.25 : 1.0

      const slot = writeIdx.current
      writeIdx.current = (writeIdx.current + 1) % MAX_PARTICLES
      const i3 = slot * 3

      births[slot] = nowSec
      lifetimes[slot] = lifetimeSec
      const deathAt = nowSec + lifetimeSec
      if (deathAt > maxDeathTime.current) maxDeathTime.current = deathAt
      // Add to the alive-index list (or leave alone if the ring buffer
      // is recycling a slot whose previous particle was still alive —
      // it's already in the list and we just overwrote its data).
      if (aliveFlags[slot] === 0) {
        aliveFlags[slot] = 1
        aliveIndices[aliveCountRef.current++] = slot
      }
      positions[i3 + 0] = ox
      positions[i3 + 1] = oy
      positions[i3 + 2] = oz
      emitterPositions[i3 + 0] = ox
      emitterPositions[i3 + 1] = oy
      emitterPositions[i3 + 2] = oz

      let kickX = 0
      let kickY = 0
      if (kick > 0) {
        dirFromXY(ox, oy, dirScratch)
        kickX = dirScratch[0] * kick
        kickY = dirScratch[1] * kick
      }
      velocities[i3 + 0] = kickX
      velocities[i3 + 1] = upwardSpeed * velFactor + kickY
      velocities[i3 + 2] = 0
      smoothedCurl[i3 + 0] = 0
      smoothedCurl[i3 + 1] = 0
      smoothedCurl[i3 + 2] = 0
      smoothedCurl2[i3 + 0] = 0
      smoothedCurl2[i3 + 1] = 0
      smoothedCurl2[i3 + 2] = 0
      baseSizes[slot] = BASE_PARTICLE_SIZE * sizeJitter * velFactor * burstSize * sizeMul
      colors[i3 + 0] = r
      colors[i3 + 1] = g
      colors[i3 + 2] = b
      emissionDirty = true
      positionDirty = true
    }

    const emitOne = (keyIdx: number, vel: number, isBurst: boolean) => {
      const key = KEYBOARD_LAYOUT.keys[keyIdx]
      const ox = key.x + (Math.random() - 0.5) * EMITTER_WIDTH
      const oy = hitY + (Math.random() - 0.5) * 0.02
      const [tr, tg, tb] = resolveTrackRGB(lastTrack[keyIdx])
      emitParticleAt(
        ox,
        oy,
        0,
        vel,
        isBurst,
        tr,
        tg,
        tb,
        1.0,
        BASE_UP_SPEED * userSpeed,
        userLifetime * LIFETIME_SCALE,
      )
    }

    for (let i = 0; i < KEY_COUNT; i++) {
      while (pendingBurst[i] > 0) {
        pendingBurst[i]--
        emitOne(i, lastVelocity[i], true)
      }

      // Effective "still emitting" = key physically held OR within the
      // min-emission window since the last note-on. Lets staccato notes
      // produce a particle plume that lasts as long as the falling-note
      // visual bar (which is also extended to noteMinLength).
      const effectiveHeld = heldCount[i] > 0 || nowSec < noteOnTime[i] + minEmitDurationSec
      if (!effectiveHeld) continue

      // Stochastic-rounded emission count this frame so per-frame rates
      // that aren't integer multiples of fps don't lose or double counts.
      const target = userCount * dtFactor * (0.55 + lastVelocity[i] * 0.6)
      emitAccum[i] += target
      while (emitAccum[i] >= 1.0) {
        emitAccum[i] -= 1.0
        emitOne(i, lastVelocity[i], false)
      }
      if (emitAccum[i] > 0 && Math.random() < emitAccum[i]) {
        emitAccum[i] -= 1.0
        emitOne(i, lastVelocity[i], false)
      }
    }

    // Drive the active death emitters. Each one is a "phantom hit" that
    // runs the same per-frame emission rate as a held key for
    // DEATH_EMIT_DURATION seconds, scattered inside the deleted note's
    // visual rectangle. By using the held-key formula here (target =
    // userCount * dtFactor * velFactor) every Inspector setting that
    // shapes the hit column — count, size, lifetime, curl noise — also
    // shapes the death puff identically. Particles fly off in the same
    // physics, so the result reads as "this note got pressed for a
    // moment and then disappeared".
    const deathEmitters = deathEmittersRef.current
    for (let e = deathEmitters.length - 1; e >= 0; e--) {
      const em = deathEmitters[e]
      const age = nowSec - em.startTime
      if (age >= DEATH_EMIT_DURATION) {
        deathEmitters.splice(e, 1)
        continue
      }
      const [emR, emG, emB] = resolveTrackRGB(em.track)
      // First-tick attack burst (matches a real key press's ATTACK_BURST).
      if (!em.burstFired) {
        em.burstFired = true
        for (let b = 0; b < ATTACK_BURST; b++) {
          const ox = em.x + (Math.random() - 0.5) * em.width
          const oy = em.centerY + (Math.random() - 0.5) * em.length
          emitParticleAt(
            ox,
            oy,
            0,
            em.velocity,
            true,
            emR,
            emG,
            emB,
            1.0,
            BASE_UP_SPEED * userSpeed,
            userLifetime * LIFETIME_SCALE,
          )
        }
      }
      const target = userCount * dtFactor * (0.55 + em.velocity * 0.6)
      em.emitAccum += target
      while (em.emitAccum >= 1.0) {
        em.emitAccum -= 1.0
        const ox = em.x + (Math.random() - 0.5) * em.width
        const oy = em.centerY + (Math.random() - 0.5) * em.length
        emitParticleAt(
          ox,
          oy,
          0,
          em.velocity,
          false,
          emR,
          emG,
          emB,
          1.0,
          BASE_UP_SPEED * userSpeed,
          userLifetime * LIFETIME_SCALE,
        )
      }
      if (em.emitAccum > 0 && Math.random() < em.emitAccum) {
        em.emitAccum -= 1.0
        const ox = em.x + (Math.random() - 0.5) * em.width
        const oy = em.centerY + (Math.random() - 0.5) * em.length
        emitParticleAt(
          ox,
          oy,
          0,
          em.velocity,
          false,
          emR,
          emG,
          emB,
          1.0,
          BASE_UP_SPEED * userSpeed,
          userLifetime * LIFETIME_SCALE,
        )
      }
    }

    if (emissionDirty) {
      birthAttr.needsUpdate = true
      lifetimeAttr.needsUpdate = true
      baseSizeAttr.needsUpdate = true
      colorAttr.needsUpdate = true
    }
    if (positionDirty) {
      positionAttr.needsUpdate = true
    }
  })

  return <primitive object={mesh} />
}
