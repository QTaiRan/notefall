import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useStore } from '../store'
import { audioEngine } from '../audio/engine'
import { now } from '../audio/clock'
import { KEYBOARD_LAYOUT, KEY_COUNT, MIDI_MIN, WHITE_KEY_LENGTH } from '../keyboard/layout'

const VERTEX_SHADER = /* glsl */ `
  attribute float instanceIntensity;
  varying vec2 vUv;
  varying float vIntensity;
  void main() {
    vUv = uv;
    vIntensity = instanceIntensity;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  varying float vIntensity;
  uniform vec3 uColor;
  // 1.0 = default core softness. Larger value = wider, softer halo edge
  // around the bright spot. Smaller = tighter, sharper edge.
  uniform float uHaloWidth;
  // 0 = pure uColor, 1 = pure white. Lifts the flash colour toward white
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
    vec3 tinted = mix(uColor, vec3(1.0), uBrightness);
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
  const settings = useStore((s) => s.settings)
  const meshRef = useRef<THREE.InstancedMesh>(null)
  const dummy = useMemo(() => new THREE.Object3D(), [])

  const intensities = useMemo(() => new Float32Array(KEY_COUNT), [])
  const intensityAttr = useMemo(() => {
    const a = new THREE.InstancedBufferAttribute(intensities, 1)
    a.setUsage(THREE.DynamicDrawUsage)
    return a
  }, [intensities])
  const heldCount = useMemo(() => new Uint8Array(KEY_COUNT), [])
  const sustainLevels = useMemo(() => new Float32Array(KEY_COUNT), [])
  // Earliest wall-clock time at which a key can fade to off. Bumped on every
  // note-on so very short notes still show for at least MIN_HOLD_SECONDS.
  const heldUntil = useMemo(() => new Float32Array(KEY_COUNT), [])

  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(settings.flashFollowNote ? settings.noteColor : settings.flashColor) },
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

  useEffect(() => {
    material.uniforms.uColor.value.set(settings.flashFollowNote ? settings.noteColor : settings.flashColor)
  }, [material, settings.flashColor, settings.flashFollowNote, settings.noteColor])

  useEffect(() => {
    material.uniforms.uHaloWidth.value = settings.flashHaloWidth
  }, [material, settings.flashHaloWidth])

  useEffect(() => {
    material.uniforms.uBrightness.value = settings.flashBrightness
  }, [material, settings.flashBrightness])

  // Press / release tracking. The flash snaps to its sustain level on
  // note-on (no fade-in) and snaps back to 0 once the key is released
  // AND the minimum-hold window has elapsed (no fade-out).
  useEffect(() => {
    const off = audioEngine.addKeyListener((ev) => {
      const idx = ev.midi - MIDI_MIN
      if (idx < 0 || idx >= KEY_COUNT) return
      if (ev.type === 'on') {
        heldCount[idx]++
        const base = useStore.getState().settings.flashIntensity
        const sustain = base * (0.7 + ev.velocity * 0.3)
        if (sustainLevels[idx] < sustain) sustainLevels[idx] = sustain
        // Instant on — no rise time. Also extend the minimum-visible window.
        intensities[idx] = sustainLevels[idx]
        heldUntil[idx] = now() + MIN_HOLD_SECONDS
        intensityAttr.needsUpdate = true
      } else {
        heldCount[idx] = Math.max(0, heldCount[idx] - 1)
        // useFrame handles the off transition once heldUntil has elapsed.
      }
    })
    return off
  }, [heldCount, sustainLevels, heldUntil, intensities, intensityAttr])

  // Refresh per-instance transforms when size / width settings change.
  // `flashSize` is the uniform scale; `flashWidth` is an extra horizontal
  // multiplier so the user can stretch the flash sideways without changing
  // the height.
  useEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return
    mesh.geometry.setAttribute('instanceIntensity', intensityAttr)
    for (let i = 0; i < KEY_COUNT; i++) {
      const k = KEYBOARD_LAYOUT.keys[i]
      const baseScale = k.width * BASE_PLANE_SCALE * settings.flashSize
      const planeWidth = baseScale * settings.flashWidth
      const planeHeight = baseScale
      dummy.position.set(k.x, WHITE_KEY_LENGTH, 0.105)
      dummy.scale.set(planeWidth, planeHeight, 1)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
    mesh.count = KEY_COUNT
    return () => {
      mesh.geometry.deleteAttribute('instanceIntensity')
    }
  }, [intensityAttr, dummy, settings.flashSize, settings.flashWidth])

  useFrame(() => {
    const nowSec = now()
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
  })

  return (
    <group position={[0, settings.keyboardY, 0]}>
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
