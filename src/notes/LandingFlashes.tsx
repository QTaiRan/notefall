import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useSettingsSlice } from '../store'

const LANDING_FLASHES_KEYS = [
  'flashBrightness',
  'flashColor',
  'flashFollowNote',
  'flashHaloWidth',
  'flashIntensity',
  'flashSize',
  'flashWidth',
  'keyboardY',
  'noteColor',
  'trackColors',
] as const
import { audioEngine } from '../audio/engine'
import { now } from '../audio/clock'
import { getResolvedSettings } from '../scene/automatedSettings'
import { KEYBOARD_LAYOUT, KEY_COUNT, MIDI_MIN, WHITE_KEY_LENGTH } from '../keyboard/layout'

const VERTEX_SHADER = /* glsl */ `
  attribute float instanceIntensity;
  // Per-key RGB tint. Resolved from settings.trackColors[lastTrack[key]]
  // with fallback to flashColor / noteColor — populated each frame on
  // the CPU side. The shader uses this in place of a uColor uniform so
  // simultaneously-flashing keys can show different track colours.
  attribute vec3 instanceTint;
  varying vec2 vUv;
  varying float vIntensity;
  varying vec3 vTint;
  void main() {
    vUv = uv;
    vIntensity = instanceIntensity;
    vTint = instanceTint;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  varying float vIntensity;
  varying vec3 vTint;
  // 1.0 = default core softness. Larger value = wider, softer halo edge
  // around the bright spot. Smaller = tighter, sharper edge.
  uniform float uHaloWidth;
  // 0 = pure tint, 1 = pure white. Lifts the flash colour toward white
  // so a coloured flash can still have a hot bright core.
  uniform float uBrightness;
  void main() {
    if (vIntensity < 0.005) discard;
    vec2 p = (vUv - 0.5) * 2.0;
    // Mild upward bias: same flash extends a bit further into the falling
    // note region than into the keys.
    float py = p.y > 0.0 ? p.y * 0.55 : p.y * 1.6;
    float r = length(vec2(p.x, py));
    // Bright spark with controllable softness. Falloff coefficient scales
    // inversely with halo width so the soft edge widens proportionally.
    // Clamp to avoid division by zero — at uHaloWidth = 0 the falloff becomes
    // so steep that the flash effectively vanishes.
    float w = max(uHaloWidth, 0.001);
    float coeff = 22.0 / (w * w);
    float core = exp(-r * r * coeff);
    // Edge fade prevents any plane-corner artifacts even when bloom amplifies.
    float edgeFade = 1.0 - smoothstep(0.7, 1.0, length(p));
    float a = core * edgeFade * vIntensity;
    if (a < 0.001) discard;
    vec3 tinted = mix(vTint, vec3(1.0), uBrightness);
    gl_FragColor = vec4(tinted * a * 1.5, a);
  }
`

// Minimum visible hold time after a note-on, even if note-off arrives almost
// immediately. Without this, sub-frame staccato notes never get a chance to
// reach the GPU and look unlit.
const MIN_HOLD_SECONDS = 0.08
// Plane size as a multiple of the key's width. Chosen so a default-size
// flash covers about 2.6 key widths of halo (matches the reference visual).
const BASE_PLANE_SCALE = 2.6

/**
 * Soft white burst at the keyboard hit line, one per key. Triggered by the
 * audio engine's note-on event and held for the entire duration the key is
 * sounding. Plane is square per key — `flashSize` scales it uniformly so
 * the aspect ratio never changes.
 */
export function LandingFlashes() {
  const settings = useSettingsSlice(LANDING_FLASHES_KEYS)
  const meshRef = useRef<THREE.InstancedMesh>(null)
  const dummy = useMemo(() => new THREE.Object3D(), [])

  const intensities = useMemo(() => new Float32Array(KEY_COUNT), [])
  const intensityAttr = useMemo(() => {
    const a = new THREE.InstancedBufferAttribute(intensities, 1)
    a.setUsage(THREE.DynamicDrawUsage)
    return a
  }, [intensities])
  // Per-key RGB tint, re-uploaded each frame (cheap — 88 × 3 floats).
  const tints = useMemo(() => new Float32Array(KEY_COUNT * 3), [])
  const tintAttr = useMemo(() => {
    const a = new THREE.InstancedBufferAttribute(tints, 3)
    a.setUsage(THREE.DynamicDrawUsage)
    return a
  }, [tints])
  // Track index of the most recent note-on per key (-1 = no track /
  // live input). Read in the per-frame tint update loop.
  const lastTrack = useMemo(() => {
    const a = new Int32Array(KEY_COUNT)
    a.fill(-1)
    return a
  }, [])
  const heldCount = useMemo(() => new Uint8Array(KEY_COUNT), [])
  const sustainLevels = useMemo(() => new Float32Array(KEY_COUNT), [])
  // Earliest wall-clock time at which a key can fade to off. Bumped on every
  // note-on so very short notes still show for at least MIN_HOLD_SECONDS.
  const heldUntil = useMemo(() => new Float32Array(KEY_COUNT), [])

  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uHaloWidth: { value: settings.flashHaloWidth },
        uBrightness: { value: settings.flashBrightness },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
    // settings deliberately excluded — uniforms mutated in the effect below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => () => material.dispose(), [material])

  // uHaloWidth / uBrightness are animatable — pushed per-frame from the
  // pin-resolved settings inside useFrame instead of via these effects,
  // so they follow pins + animate under the export advance() loop.
  // Zero pins ⇒ identical written values.

  // Press / release tracking. The flash snaps to its sustain level on
  // note-on (no fade-in) and snaps back to 0 once the key is released
  // AND the minimum-hold window has elapsed (no fade-out).
  useEffect(() => {
    const off = audioEngine.addKeyListener((ev) => {
      const idx = ev.midi - MIDI_MIN
      if (idx < 0 || idx >= KEY_COUNT) return
      if (ev.type === 'on') {
        heldCount[idx]++
        // Pin-resolved flashIntensity at the instant of note-on so the
        // sustain level tracks any active automation.
        const base = getResolvedSettings().flashIntensity
        const sustain = base * (0.7 + ev.velocity * 0.3)
        if (sustainLevels[idx] < sustain) sustainLevels[idx] = sustain
        // Instant on — no rise time. Also extend the minimum-visible window.
        intensities[idx] = sustainLevels[idx]
        heldUntil[idx] = now() + MIN_HOLD_SECONDS
        lastTrack[idx] = ev.track ?? -1
        intensityAttr.needsUpdate = true
      } else {
        heldCount[idx] = Math.max(0, heldCount[idx] - 1)
        // useFrame handles the off transition once heldUntil has elapsed.
      }
    })
    return off
  }, [heldCount, sustainLevels, heldUntil, lastTrack, intensities, intensityAttr])

  // Attribute wiring only. The per-instance transforms used to be
  // rebuilt here on flashSize / flashWidth change, but those are
  // animatable — the rebuild now runs inside useFrame (guarded so it
  // only fires when the resolved size/width actually changes) so pins
  // animate and the export advance() loop picks the values up.
  useEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return
    mesh.geometry.setAttribute('instanceIntensity', intensityAttr)
    mesh.geometry.setAttribute('instanceTint', tintAttr)
    mesh.count = KEY_COUNT
    return () => {
      mesh.geometry.deleteAttribute('instanceIntensity')
      mesh.geometry.deleteAttribute('instanceTint')
    }
  }, [intensityAttr, tintAttr])
  // Last applied size/width so the per-frame matrix rebuild is skipped
  // when nothing changed (zero-pin steady state ⇒ rebuilt exactly once).
  const lastFlashSize = useRef<number>(NaN)
  const lastFlashWidth = useRef<number>(NaN)
  const groupRef = useRef<THREE.Group>(null)

  // Scratch THREE.Color reused inside the per-frame tint resolver to
  // parse hex strings without allocating.
  const tmpColor = useMemo(() => new THREE.Color(), [])

  useFrame(() => {
    const nowSec = now()
    const rs = getResolvedSettings()

    // Pin-resolved global uniforms (formerly per-field useEffects).
    material.uniforms.uHaloWidth.value = rs.flashHaloWidth
    material.uniforms.uBrightness.value = rs.flashBrightness

    // Pin-resolved group placement (keyboardY is non-animatable but the
    // resolver passes it straight through, so this is correct with or
    // without pins; zero pins ⇒ same Y the JSX prop sets).
    if (groupRef.current) groupRef.current.position.y = rs.keyboardY

    // Rebuild the per-instance scale matrices only when the resolved
    // flashSize / flashWidth changed. With zero pins these are constant,
    // so this runs exactly once (parity with the old mount-time effect).
    const mesh = meshRef.current
    if (
      mesh &&
      (rs.flashSize !== lastFlashSize.current ||
        rs.flashWidth !== lastFlashWidth.current)
    ) {
      lastFlashSize.current = rs.flashSize
      lastFlashWidth.current = rs.flashWidth
      for (let i = 0; i < KEY_COUNT; i++) {
        const k = KEYBOARD_LAYOUT.keys[i]
        const baseScale = k.width * BASE_PLANE_SCALE * rs.flashSize
        const planeWidth = baseScale * rs.flashWidth
        const planeHeight = baseScale
        dummy.position.set(k.x, WHITE_KEY_LENGTH, 0.105)
        dummy.scale.set(planeWidth, planeHeight, 1)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
      }
      mesh.instanceMatrix.needsUpdate = true
    }

    let dirty = false
    for (let i = 0; i < KEY_COUNT; i++) {
      if (intensities[i] === 0) continue
      // Snap off only when the key has been released AND the minimum hold
      // window has elapsed. Otherwise hold the current intensity steady.
      if (heldCount[i] === 0 && nowSec >= heldUntil[i]) {
        intensities[i] = 0
        sustainLevels[i] = 0
        dirty = true
      }
    }
    if (dirty) intensityAttr.needsUpdate = true

    // Per-track RGB cache for this frame. Only keys with intensity > 0
    // get a fresh tint write — saves cost when the keyboard is idle.
    // Colours are pin-resolved; flashFollowNote is non-animatable.
    const fallbackHex = settings.flashFollowNote
      ? rs.noteColor
      : rs.flashColor
    tmpColor.set(fallbackHex)
    const defaultR = tmpColor.r
    const defaultG = tmpColor.g
    const defaultB = tmpColor.b
    const trackColors = rs.trackColors
    const trackRgbCache = new Map<number, readonly [number, number, number]>()
    const resolveTint = (
      trackIdx: number,
    ): readonly [number, number, number] => {
      if (trackIdx < 0 || !settings.flashFollowNote)
        return [defaultR, defaultG, defaultB]
      const cached = trackRgbCache.get(trackIdx)
      if (cached) return cached
      const override = trackColors[String(trackIdx)]
      if (!override) {
        const v: [number, number, number] = [defaultR, defaultG, defaultB]
        trackRgbCache.set(trackIdx, v)
        return v
      }
      tmpColor.set(override)
      const v: [number, number, number] = [tmpColor.r, tmpColor.g, tmpColor.b]
      trackRgbCache.set(trackIdx, v)
      return v
    }
    let tintDirty = false
    for (let i = 0; i < KEY_COUNT; i++) {
      if (intensities[i] === 0) continue
      const [r, g, b] = resolveTint(lastTrack[i])
      const o = i * 3
      if (tints[o] !== r || tints[o + 1] !== g || tints[o + 2] !== b) {
        tints[o] = r
        tints[o + 1] = g
        tints[o + 2] = b
        tintDirty = true
      }
    }
    if (tintDirty) tintAttr.needsUpdate = true
  })

  return (
    <group ref={groupRef} position={[0, settings.keyboardY, 0]}>
      <instancedMesh
        ref={meshRef}
        args={[undefined, undefined, KEY_COUNT]}
        frustumCulled={false}
        material={material}
        count={KEY_COUNT}
      >
        <planeGeometry args={[1, 1]} />
      </instancedMesh>
    </group>
  )
}
