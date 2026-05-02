import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useStore } from '../store'
import { audioEngine } from '../audio/engine'
import { KEYBOARD_LAYOUT, KEY_COUNT, MIDI_MIN, WHITE_KEY_LENGTH } from '../keyboard/layout'

const MAX_PARTICLES = 65536
// Puffs per second per held key at rate 1.0. Each puff drops a small cluster
// of particles, so the on-screen particle count is roughly puffs × cluster size.
const BASE_PUFF_RATE = 14
// Particles in a single puff. Sharing position+seed makes them visually
// cohere into a "wisp" rather than scattered specks.
const PUFF_SIZE_MIN = 3
const PUFF_SIZE_MAX = 7
// Bonus puffs fired immediately on attack — gives the landing visual punch.
const ATTACK_PUFFS = 3

const VERTEX_SHADER = /* glsl */ `
  attribute float aBirth;
  attribute float aSeed;
  attribute float aSpeed;
  attribute float aSwayAmp;
  attribute float aSwayFreq;
  attribute vec3 aColor;

  uniform float uTime;
  uniform float uLifetime;
  uniform float uSize;
  uniform float uPixelRatio;
  uniform float uWind;
  uniform float uWindScale;
  uniform float uWindSpeed;
  uniform float uHaloSize;

  varying float vAlpha;
  varying vec3 vColor;

  // Cheap value-noise + 2-octave FBM. We need spatial coherence (so nearby
  // particles see the same wind value and drift together as a cluster) and
  // smooth temporal evolution (so the field "breathes" like a candle flame
  // instead of jumping between discrete states).
  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float fbm(vec2 p) {
    return vnoise(p) * 0.65 + vnoise(p * 2.13 + 4.7) * 0.35;
  }

  void main() {
    vColor = aColor;
    float age = uTime - aBirth;
    if (age < 0.0 || age > uLifetime) {
      // Push outside the clip volume AND zero point size — both belts and
      // suspenders so dead slots can't ever rasterize a stray pixel.
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      vAlpha = 0.0;
      return;
    }
    float t = age / uLifetime;

    // Upward motion with mild deceleration → buoyant, not constant-velocity.
    float yOffset = aSpeed * age * (1.0 - 0.25 * t);
    vec2 here = position.xy + vec2(0.0, yOffset);

    // Sample the wind field at the particle's current position. Default
    // spatial frequency (0.55 / 0.32) means a flow cell spans many keys so
    // a tight emission cluster sees roughly the same wind and drifts together.
    // uWindScale is divided in (so larger user value = larger gusts = more
    // cohesive cluster motion). uWindSpeed multiplies the time advance —
    // higher = faster, more flickery; lower = slow candle-flame breathing.
    vec2 np = vec2(here.x * 0.55, here.y * 0.32) / max(uWindScale, 0.01)
              + uTime * vec2(0.22, 0.18) * uWindSpeed;
    float wx = fbm(np) * 2.0 - 1.0;
    float wy = fbm(np + vec2(11.7, 4.3)) * 2.0 - 1.0;
    // Wind builds with age — particles disperse from the puff slowly rather
    // than instantly, so the cluster reads as cohesive at first then
    // gradually opens up as it rises.
    float windScale = uWind * (0.25 + t * 0.85);
    vec2 wind = vec2(wx, wy * 0.35) * windScale;

    // Tiny per-particle micro-jitter (much smaller than wind). Adds the
    // high-frequency flicker on top of the slow flow without overwhelming it.
    float phase = aSeed * 6.2831;
    float micro = sin(age * aSwayFreq + phase) * aSwayAmp * 0.35;

    vec3 finalPos = vec3(here.x + wind.x + micro, here.y + wind.y, position.z);
    vec4 worldPos = modelMatrix * vec4(finalPos, 1.0);
    vec4 mvPos = viewMatrix * worldPos;
    gl_Position = projectionMatrix * mvPos;

    // Fast in, gradual out so attack feels instantaneous and decay is soft.
    float fadeIn = smoothstep(0.0, 0.04, t);
    float fadeOut = 1.0 - smoothstep(0.55, 1.0, t);
    vAlpha = fadeIn * fadeOut;

    // Size shrinks with age + perspective attenuation. The 300.0 constant
    // matches PointsMaterial's sizeAttenuation at the default camera distance.
    // Inflated by (1 + uHaloSize) so there's room around the core for the
    // halo to render — fragment shader compensates so the core stays the
    // same physical size regardless of halo.
    float ageScale = mix(1.0, 0.4, t);
    float haloScale = 1.0 + uHaloSize;
    gl_PointSize = uSize * uPixelRatio * ageScale * haloScale * (300.0 / -mvPos.z);
  }
`

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying float vAlpha;
  varying vec3 vColor;
  uniform float uIntensity;
  uniform float uHaloIntensity;
  uniform float uHaloSize;
  void main() {
    if (vAlpha < 0.001) discard;
    vec2 p = gl_PointCoord - 0.5;
    float r = length(p);
    if (r > 0.5) discard;

    // The vertex shader inflated the point by (1 + uHaloSize) to make room
    // for the halo. Multiply r back to the original (un-inflated) coord
    // space so the bright core stays the same physical size as it would
    // with no halo — just sitting in the center of a now-larger sprite.
    float haloScale = 1.0 + uHaloSize;
    float coreR = r * haloScale;

    // Sharp center, soft rim — a spark that bloom amplifies into a dot of
    // light without revealing the underlying square.
    float core = 1.0 - smoothstep(0.0, 0.5, coreR);
    core = pow(core, 1.4);

    // Soft halo gaussian across the entire (inflated) sprite. Falls off
    // smoothly to roughly 13% brightness at the sprite edge with the
    // -8.0 r² coefficient — wide enough to read as a glow rather than a
    // second hard-edged ring.
    float halo = exp(-r * r * 8.0) * uHaloIntensity;

    float a = (core + halo) * vAlpha;
    if (a < 0.001) discard;
    gl_FragColor = vec4(vColor * uIntensity * a, a);
  }
`

/**
 * Drift particles rising from each key while it sounds. GPU-resident:
 * per-particle attributes are written once on emission; the vertex shader
 * runs an FBM-driven wind field per frame so the particles cluster and
 * sway together with candle-flame irregularity instead of each one wobbling
 * on its own metronome.
 */
export function HitParticles() {
  const settings = useStore((s) => s.settings)

  const positions = useMemo(() => new Float32Array(MAX_PARTICLES * 3), [])
  const births = useMemo(() => {
    // Sentinel "long-dead" so freshly-allocated slots don't render anything
    // before the first emission writes them.
    const a = new Float32Array(MAX_PARTICLES)
    a.fill(-1000)
    return a
  }, [])
  const seeds = useMemo(() => new Float32Array(MAX_PARTICLES), [])
  const speeds = useMemo(() => new Float32Array(MAX_PARTICLES), [])
  const swayAmps = useMemo(() => new Float32Array(MAX_PARTICLES), [])
  const swayFreqs = useMemo(() => new Float32Array(MAX_PARTICLES), [])
  const colors = useMemo(() => new Float32Array(MAX_PARTICLES * 3), [])

  const positionAttr = useMemo(() => {
    const a = new THREE.BufferAttribute(positions, 3)
    a.setUsage(THREE.DynamicDrawUsage)
    return a
  }, [positions])
  const birthAttr = useMemo(() => {
    const a = new THREE.BufferAttribute(births, 1)
    a.setUsage(THREE.DynamicDrawUsage)
    return a
  }, [births])
  const seedAttr = useMemo(() => {
    const a = new THREE.BufferAttribute(seeds, 1)
    a.setUsage(THREE.DynamicDrawUsage)
    return a
  }, [seeds])
  const speedAttr = useMemo(() => {
    const a = new THREE.BufferAttribute(speeds, 1)
    a.setUsage(THREE.DynamicDrawUsage)
    return a
  }, [speeds])
  const swayAmpAttr = useMemo(() => {
    const a = new THREE.BufferAttribute(swayAmps, 1)
    a.setUsage(THREE.DynamicDrawUsage)
    return a
  }, [swayAmps])
  const swayFreqAttr = useMemo(() => {
    const a = new THREE.BufferAttribute(swayFreqs, 1)
    a.setUsage(THREE.DynamicDrawUsage)
    return a
  }, [swayFreqs])
  const colorAttr = useMemo(() => {
    const a = new THREE.BufferAttribute(colors, 3)
    a.setUsage(THREE.DynamicDrawUsage)
    return a
  }, [colors])

  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uLifetime: { value: settings.particleLifetime },
        uSize: { value: settings.particleSize },
        uIntensity: { value: settings.particleIntensity },
        uWind: { value: settings.particleWind },
        uWindScale: { value: settings.particleWindScale },
        uWindSpeed: { value: settings.particleWindSpeed },
        uHaloIntensity: { value: settings.particleHaloIntensity },
        uHaloSize: { value: settings.particleHaloSize },
        uPixelRatio: { value: window.devicePixelRatio || 1 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
    // settings deliberately excluded — uniforms mutated below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => () => material.dispose(), [material])

  useEffect(() => {
    material.uniforms.uLifetime.value = settings.particleLifetime
  }, [material, settings.particleLifetime])
  useEffect(() => {
    material.uniforms.uSize.value = settings.particleSize
  }, [material, settings.particleSize])
  useEffect(() => {
    material.uniforms.uIntensity.value = settings.particleIntensity
  }, [material, settings.particleIntensity])
  useEffect(() => {
    material.uniforms.uWind.value = settings.particleWind
  }, [material, settings.particleWind])
  useEffect(() => {
    material.uniforms.uWindScale.value = settings.particleWindScale
  }, [material, settings.particleWindScale])
  useEffect(() => {
    material.uniforms.uWindSpeed.value = settings.particleWindSpeed
  }, [material, settings.particleWindSpeed])
  useEffect(() => {
    material.uniforms.uHaloIntensity.value = settings.particleHaloIntensity
  }, [material, settings.particleHaloIntensity])
  useEffect(() => {
    material.uniforms.uHaloSize.value = settings.particleHaloSize
  }, [material, settings.particleHaloSize])

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', positionAttr)
    g.setAttribute('aBirth', birthAttr)
    g.setAttribute('aSeed', seedAttr)
    g.setAttribute('aSpeed', speedAttr)
    g.setAttribute('aSwayAmp', swayAmpAttr)
    g.setAttribute('aSwayFreq', swayFreqAttr)
    g.setAttribute('aColor', colorAttr)
    g.setDrawRange(0, MAX_PARTICLES)
    return g
  }, [positionAttr, birthAttr, seedAttr, speedAttr, swayAmpAttr, swayFreqAttr, colorAttr])
  useEffect(() => () => geometry.dispose(), [geometry])

  const points = useMemo(() => {
    const p = new THREE.Points(geometry, material)
    p.frustumCulled = false
    return p
  }, [geometry, material])

  const heldCount = useMemo(() => new Uint8Array(KEY_COUNT), [])
  // Countdown to the next puff event for each key. Stays > 0 while the next
  // puff is pending; reset to a randomized interval after each puff fires.
  const puffTimer = useMemo(() => new Float32Array(KEY_COUNT), [])
  // Queued attack puffs to fire on the next useFrame.
  const pendingAttackPuffs = useMemo(() => new Uint8Array(KEY_COUNT), [])
  const lastVelocity = useMemo(() => new Float32Array(KEY_COUNT), [])
  const writeIdx = useRef(0)
  const lastFrame = useRef(performance.now() / 1000)
  const colorVec = useMemo(() => new THREE.Color(), [])

  useEffect(() => {
    const off = audioEngine.addKeyListener((ev) => {
      const idx = ev.midi - MIDI_MIN
      if (idx < 0 || idx >= KEY_COUNT) return
      if (ev.type === 'on') {
        heldCount[idx]++
        lastVelocity[idx] = ev.velocity
        // Fire several puffs on the next frame so the attack reads as a burst.
        pendingAttackPuffs[idx] += ATTACK_PUFFS
        // Reset the sustain timer so the first sustained puff isn't immediate
        // on top of the attack burst.
        puffTimer[idx] = 1 / BASE_PUFF_RATE
      } else {
        heldCount[idx] = Math.max(0, heldCount[idx] - 1)
      }
    })
    return off
  }, [heldCount, lastVelocity, pendingAttackPuffs, puffTimer])

  useFrame(() => {
    const now = performance.now() / 1000
    const dt = Math.min(0.05, now - lastFrame.current)
    lastFrame.current = now
    material.uniforms.uTime.value = now

    if (!settings.particlesEnabled) return

    const hitY = settings.keyboardY + WHITE_KEY_LENGTH
    // In front of the keys (0/0.04) but behind the falling-note plane (0.05)
    // so particles read as emitted from beneath the bars, not on top of them.
    const noteZ = 0.045
    colorVec.set(settings.particleColor)
    const cr = colorVec.r
    const cg = colorVec.g
    const cb = colorVec.b
    const rate = Math.max(0.0001, settings.particleRate)
    const speedScale = settings.particleSpeed

    let dirty = false

    const emitPuff = (keyIdx: number, vel: number) => {
      const key = KEYBOARD_LAYOUT.keys[keyIdx]
      const puffSize = PUFF_SIZE_MIN + Math.floor(Math.random() * (PUFF_SIZE_MAX - PUFF_SIZE_MIN + 1))
      // Center the puff at a random spot within the key's width so successive
      // puffs from a held key originate from different points (you see
      // multiple wisps over time, not a single stream from one spot).
      const cx = key.x + (Math.random() - 0.5) * key.width * 0.7
      // Shared seed → all particles in this puff march to the same micro-sway
      // phase. Combined with their tight start positions (and shared wind
      // sampling), they read as one coherent wisp.
      const sharedSeed = Math.random()
      // Base speed shared across the puff with small individual variance —
      // keeps the cluster cohering as it rises rather than smearing apart.
      const baseSpeed = (0.45 + Math.random() * 0.85) * (0.6 + vel * 0.5) * speedScale

      for (let j = 0; j < puffSize; j++) {
        const slot = writeIdx.current
        writeIdx.current = (writeIdx.current + 1) % MAX_PARTICLES

        // Tight cluster around the puff center — small jitter so individual
        // particles are visible but they overlap meaningfully.
        const xJ = (Math.random() - 0.5) * 0.06
        const yJ = (Math.random() - 0.5) * 0.04
        positions[slot * 3 + 0] = cx + xJ
        positions[slot * 3 + 1] = hitY + yJ
        positions[slot * 3 + 2] = noteZ

        births[slot] = now
        seeds[slot] = sharedSeed
        // Small individual deviations from the shared base.
        speeds[slot] = baseSpeed * (0.85 + Math.random() * 0.3)
        swayAmps[slot] = 0.03 + Math.random() * 0.06
        swayFreqs[slot] = 2.0 + Math.random() * 3.0

        colors[slot * 3 + 0] = cr
        colors[slot * 3 + 1] = cg
        colors[slot * 3 + 2] = cb
      }
      dirty = true
    }

    for (let i = 0; i < KEY_COUNT; i++) {
      // Fire any queued attack puffs first (independent of the sustain timer).
      while (pendingAttackPuffs[i] > 0) {
        pendingAttackPuffs[i]--
        emitPuff(i, lastVelocity[i])
      }

      if (heldCount[i] === 0) continue

      puffTimer[i] -= dt
      // Loop in case multiple puffs are due (long frame, high rate).
      while (puffTimer[i] <= 0) {
        emitPuff(i, lastVelocity[i])
        // Schedule next puff at base interval × 0.6..1.6 → irregular timing
        // is half of what makes this read as natural rather than mechanical.
        const interval = (1 / (BASE_PUFF_RATE * rate)) * (0.6 + Math.random() * 1.0)
        puffTimer[i] += interval
      }
    }

    if (dirty) {
      positionAttr.needsUpdate = true
      birthAttr.needsUpdate = true
      seedAttr.needsUpdate = true
      speedAttr.needsUpdate = true
      swayAmpAttr.needsUpdate = true
      swayFreqAttr.needsUpdate = true
      colorAttr.needsUpdate = true
    }
  })

  return <primitive object={points} />
}
