import { useMemo, useRef, useEffect } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useStore } from '../store'
import { audioEngine } from '../audio/engine'
import { KEYBOARD_LAYOUT, MIDI_MIN, KEY_COUNT, noteHitYWorld } from '../keyboard/layout'

const MAX_INSTANCES = 4096
// Buffer in world units between the visible top edge of the camera frustum
// and the note spawn line — keeps notes off-screen when they're created so
// they can slide in from above instead of popping into view mid-screen.
const SPAWN_BUFFER = 1.0

const VERTEX_SHADER = /* glsl */ `
  attribute vec2 instanceSize;
  varying vec2 vUv;
  varying vec2 vSize;
  void main() {
    vUv = uv;
    vSize = instanceSize;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  varying vec2 vSize;
  uniform vec3 uColor;
  uniform float uEmissive;
  uniform float uOpacity;
  uniform float uRadius;

  float sdRoundedBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + vec2(r);
    return min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0))) - r;
  }

  void main() {
    // Reject uninitialised instances (vSize=0) explicitly — the SDF degenerates
    // to d=0 at the origin and would otherwise render a bright square.
    if (vSize.x < 0.0001 || vSize.y < 0.0001) discard;
    vec2 halfSize = vSize * 0.5;
    vec2 p = (vUv - 0.5) * vSize;
    float r = min(uRadius, min(halfSize.x, halfSize.y) - 0.0001);
    r = max(r, 0.0);
    float d = sdRoundedBox(p, halfSize, r);
    if (d > 0.001) discard;
    float aa = max(fwidth(d), 0.0001);
    float alpha = clamp(-d / aa + 0.5, 0.0, 1.0);
    // Additive emissive: at uEmissive=0 the note is rendered at its chosen
    // color (visible, no bloom). Higher uEmissive adds extra brightness on
    // top, which the Bloom pass picks up as glow. This way Opacity controls
    // transparency independently — the two controls are orthogonal.
    vec3 col = uColor * (1.0 + uEmissive);
    gl_FragColor = vec4(col, alpha * uOpacity);
  }
`

export function FallingNotes() {
  const settings = useStore((s) => s.settings)
  const song = useStore((s) => s.song)

  const meshRef = useRef<THREE.InstancedMesh>(null)
  const dummy = useMemo(() => new THREE.Object3D(), [])

  // per-instance world size attribute (width, length)
  const sizes = useMemo(() => new Float32Array(MAX_INSTANCES * 2), [])
  const sizeAttr = useMemo(() => {
    const a = new THREE.InstancedBufferAttribute(sizes, 2)
    a.setUsage(THREE.DynamicDrawUsage)
    return a
  }, [sizes])

  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(settings.noteColor) },
        uEmissive: { value: settings.noteEmissive },
        uOpacity: { value: settings.noteOpacity },
        uRadius: { value: settings.noteCornerRadius },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    })
    // we intentionally don't include settings in deps — uniforms are mutated via the effect below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    material.uniforms.uColor.value.set(settings.noteColor)
    material.uniforms.uEmissive.value = settings.noteEmissive
    material.uniforms.uOpacity.value = settings.noteOpacity
    material.uniforms.uRadius.value = settings.noteCornerRadius
  }, [
    material,
    settings.noteColor,
    settings.noteEmissive,
    settings.noteOpacity,
    settings.noteCornerRadius,
  ])

  useEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return
    mesh.geometry.setAttribute('instanceSize', sizeAttr)
    return () => {
      mesh.geometry.deleteAttribute('instanceSize')
    }
  }, [sizeAttr])

  useEffect(() => () => material.dispose(), [material])

  useFrame(() => {
    audioEngine.tick()

    const mesh = meshRef.current
    if (!mesh) return

    const t = audioEngine.currentSongTime()
    const hitY = noteHitYWorld(settings.keyboardY)
    const isDown = settings.fallDirection === 'down'
    const fall = settings.fallDurationSec
    const widthScale = settings.noteWidthScale
    const minLength = Math.max(0.01, settings.noteMinLength)
    // Notes sit BEHIND the keyboard (z < 0) so the keys' opaque depth buffer
    // occludes the portion of a note that has crossed the hit line. This is
    // what produces the "slide under the keyboard" effect on landing.
    const noteZ = -0.1

    // Compute how far above the keyboard a note spawns so that the spawn line
    // sits comfortably outside the visible frustum. Approximate the visible
    // top from camera distance + FOV; assumes the camera looks roughly toward
    // the keyboard plane (true for our setup).
    const camDistance = Math.abs(settings.cameraPos[2])
    const halfVisHeight = camDistance * Math.tan((settings.cameraFov * Math.PI) / 360)
    const visibleTop = settings.cameraLookAt[1] + halfVisHeight
    const FALL_DISTANCE = Math.max(0.5, visibleTop - hitY) + SPAWN_BUFFER

    let count = 0
    const notes = song?.notes ?? []
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i]
      let topY: number
      let bottomY: number

      if (isDown) {
        // Future notes fall from above onto the keyboard.
        // headT positive = head still in the future; negative = head has crossed
        // the hit line and the visual is sliding behind the keyboard.
        const headT = n.time - t
        const tailT = headT + n.duration
        if (headT > fall) break // sorted by time → no later notes are visible yet
        // Don't clamp progress — let head go below the hit line so it slides
        // into the keyboard area (where the keys' depth buffer hides it).
        const headY = hitY + (headT / fall) * FALL_DISTANCE
        const tailY = hitY + (tailT / fall) * FALL_DISTANCE
        const visualLength = Math.max(minLength, tailY - headY)
        const naturalTopY = headY + visualLength
        // Clamp the visible bottom at the keyboard's front edge. For long
        // notes the head naturally descends well past the keyboard; without
        // this the unhidden strip below the keyboard would leak the note.
        bottomY = Math.max(headY, settings.keyboardY)
        topY = naturalTopY
        // Skip once the entire visual rect is at or below the hit line —
        // the backdrop would hide it completely anyway.
        if (topY <= hitY) continue
      } else {
        // Past notes rise from the keyboard upward (history trail).
        const headT = t - n.time
        const tailT = headT - n.duration
        if (headT < 0) break // not yet emerged
        const headY = hitY + (headT / fall) * FALL_DISTANCE
        const tailY = hitY + (tailT / fall) * FALL_DISTANCE
        // For 'up', head is the upper edge (rising away from keyboard).
        topY = headY
        const visualLength = Math.max(minLength, headY - tailY)
        bottomY = topY - visualLength
        // Skip once the visual rect has fully risen above the visible top.
        if (bottomY >= visibleTop) continue
        // Skip while head hasn't crossed the hit line yet (entirely hidden).
        if (topY <= hitY) continue
      }

      const length = topY - bottomY
      const centerY = (topY + bottomY) / 2

      const idx = n.midi - MIDI_MIN
      if (idx < 0 || idx >= KEY_COUNT) continue
      const key = KEYBOARD_LAYOUT.keys[idx]
      const width = key.width * widthScale

      dummy.position.set(key.x, centerY, noteZ)
      dummy.rotation.set(0, 0, 0)
      dummy.scale.set(width, length, 1)
      dummy.updateMatrix()
      mesh.setMatrixAt(count, dummy.matrix)

      // store world size so the fragment shader can compute the SDF correctly
      sizes[count * 2] = width
      sizes[count * 2 + 1] = length

      count++
      if (count >= MAX_INSTANCES) break
    }

    // Live notes (touch/click) — always render in 'up' (rising trail) mode,
    // independent of the song direction setting.
    const liveNotes = audioEngine.getLiveNotes()
    if (liveNotes.length > 0) {
      const liveNow = performance.now() / 1000
      for (let i = 0; i < liveNotes.length; i++) {
        const ln = liveNotes[i]
        const headT = liveNow - ln.startTime
        const noteDuration = (ln.endTime ?? liveNow) - ln.startTime
        const tailT = headT - noteDuration
        if (headT < 0) continue

        const headY = hitY + (headT / fall) * FALL_DISTANCE
        const tailY = hitY + (tailT / fall) * FALL_DISTANCE
        const topY = headY
        const visualLength = Math.max(minLength, headY - tailY)
        const bottomY = topY - visualLength
        if (bottomY >= visibleTop) continue
        if (topY <= hitY) continue

        const length = topY - bottomY
        const centerY = (topY + bottomY) / 2

        const idx = ln.midi - MIDI_MIN
        if (idx < 0 || idx >= KEY_COUNT) continue
        const key = KEYBOARD_LAYOUT.keys[idx]
        const width = key.width * widthScale

        dummy.position.set(key.x, centerY, noteZ)
        dummy.rotation.set(0, 0, 0)
        dummy.scale.set(width, length, 1)
        dummy.updateMatrix()
        mesh.setMatrixAt(count, dummy.matrix)
        sizes[count * 2] = width
        sizes[count * 2 + 1] = length

        count++
        if (count >= MAX_INSTANCES) break
      }
    }

    mesh.count = count
    mesh.instanceMatrix.needsUpdate = true
    sizeAttr.needsUpdate = true
  })

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, MAX_INSTANCES]}
      frustumCulled={false}
      material={material}
      count={0}
    >
      <planeGeometry args={[1, 1]} />
    </instancedMesh>
  )
}
