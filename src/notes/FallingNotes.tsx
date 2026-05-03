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
  attribute vec2 instanceSeed;
  varying vec2 vUv;
  varying vec2 vSize;
  varying vec2 vSeed;
  varying float vWorldY;
  void main() {
    vUv = uv;
    vSize = instanceSize;
    vSeed = instanceSeed;
    vec4 worldPos = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vWorldY = worldPos.y;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`

// Texture mode IDs. Keep in sync with TEXTURE_MODE in this file and the
// NoteTexture union in store.ts. Adding a new preset = new constant + new
// branch in the fragment shader's main() + new entry in TEXTURE_MODE map +
// new option in the Inspector SelectRow.
const TEXTURE_SOLID = 0
const TEXTURE_LIQUID = 1
const TEXTURE_GEM = 2

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  varying vec2 vSize;
  varying vec2 vSeed;
  varying float vWorldY;
  uniform vec3 uColor;
  uniform float uEmissive;
  uniform float uOpacity;
  uniform float uRadius;
  uniform float uHitY;
  uniform float uTime;
  // Texture preset selector — branched in main(). See TEXTURE_* constants
  // (CPU side) for the value mapping.
  uniform int uTextureMode;
  uniform float uTextureScale;
  uniform float uTextureSpeed;
  uniform float uTextureContrast;
  uniform float uRimWidth;
  uniform float uRimIntensity;

  float sdRoundedBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + vec2(r);
    return min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0))) - r;
  }

  // Cheap value-noise primitives — shared across texture presets.
  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
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
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * vnoise(p);
      p *= 2.02;
      a *= 0.5;
    }
    return v;
  }

  // 2D hash → vec2 for Voronoi cell sites.
  vec2 hash22(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
  }

  // 'gem': Voronoi-cell faceting. Each cell is a polygonal facet with its
  // own brightness; the boundary between cells lights up as a thin specular
  // line — together this gives the "cut crystal" feel where light catches
  // different facets at different angles.
  vec3 textureGem(vec2 p, float d) {
    // Per-note offset (vSeed in 0..1 scaled by 100) shifts the Voronoi
    // tiling sample window so each note shows a different cell layout.
    vec2 uv = p * uTextureScale + vSeed * 100.0;
    vec2 i = floor(uv);
    vec2 f = fract(uv);
    float t = uTime * uTextureSpeed;

    // 3x3 neighborhood is mandatory for correct Voronoi (a pixel's nearest
    // site can live in a diagonal neighbor). Tracks the smallest and 2nd-
    // smallest distances so the gap between them gives us a clean edge,
    // AND tracks BOTH adjacent cell IDs so edge brightness can react to the
    // brightness of cells on either side (dark/dark boundaries stay dim).
    float dMin = 1e10;
    float dSecond = 1e10;
    vec2 cellId = vec2(0.0);
    vec2 cellId2 = vec2(0.0);
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 c = vec2(float(x), float(y));
        vec2 site = c + hash22(i + c);
        float dist = length(site - f);
        if (dist < dMin) {
          dSecond = dMin;
          cellId2 = cellId;
          dMin = dist;
          cellId = i + c;
        } else if (dist < dSecond) {
          dSecond = dist;
          cellId2 = i + c;
        }
      }
    }

    // Per-facet brightness — gamma-curved so most facets stay dark with
    // occasional bright "lit" facets (matches a real gem catching light).
    float h = hash22(cellId).x;
    float facet = pow(h, max(0.5, uTextureContrast));

    // Sharp per-facet sparkle. Each cell has its own phase (hash-derived) so
    // different facets flash at different moments. Two superposed sine waves
    // raised to a high power produce a sharp spike whenever both terms
    // approach 1, simulating a diamond catching light. uTextureSpeed scales
    // the phase progression — speed 0 freezes the pattern, higher = more
    // frequent twinkling.
    float phase = h * 31.4 + t * 2.0;
    float spark = max(
      pow(0.5 + 0.5 * sin(phase), 14.0),
      pow(0.5 + 0.5 * sin(phase * 1.7 + 2.1), 10.0)
    );

    // Brightness of the facet across the boundary. Used to taper edge
    // intensity — a dim facet's seam doesn't catch as much light.
    float h2 = hash22(cellId2).x;
    float facet2 = pow(h2, max(0.5, uTextureContrast));

    // Per-edge random hash. The combine (a + b + a*b) is symmetric in a/b
    // so the same edge gets the same hash regardless of which side of the
    // boundary the pixel is on. Drives both edge thickness and visibility,
    // breaking the uniform "every seam is white" look.
    vec2 edgeKey = cellId + cellId2 + cellId * cellId2;
    float edgeHash = hash22(edgeKey).x;

    // Edge mask from the dist gap. Width varies per edge so seams have
    // different sharpness — some razor-thin, some softer.
    float edgeWidth = mix(0.015, 0.06, edgeHash);
    float edgeMask = 1.0 - smoothstep(0.0, edgeWidth, dSecond - dMin);

    // Edge brightness: scale by the brighter of the two adjacent facets
    // (dark ⨯ dark = barely visible) and by a per-edge random (some seams
    // mostly hidden, some prominent). Sparkle promotes the edge too so a
    // flashing facet's perimeter joins in.
    float edgeStrength = max(facet, facet2) * mix(0.15, 1.0, edgeHash);
    edgeStrength = max(edgeStrength, spark);

    // SDF rim — same treatment as 'liquid' for visual consistency.
    float rim = smoothstep(uRimWidth, 0.0, abs(d));

    vec3 base = uColor * (facet * 1.4 + 0.12);
    // Sparkle flashes the facet toward pure white — the hallmark of a real
    // gem reflection.
    base = mix(base, vec3(1.0), spark * 0.9);
    // Edges blend toward white where they actually catch light.
    base = mix(base, vec3(1.0), edgeMask * edgeStrength * 0.9);
    vec3 rimCol = mix(uColor, vec3(1.0), 0.7) * rim * uRimIntensity;
    return base + rimCol;
  }

  // 'liquid': domain-warped FBM (molten metal flow) + bright SDF rim.
  vec3 textureLiquid(vec2 p, float d) {
    // Per-note offset so each note samples a different region of the noise
    // field — otherwise every note shows the same flow pattern.
    vec2 uv = p * uTextureScale + vSeed * 100.0;
    float t = uTime * uTextureSpeed;
    // Domain warp — feeding noise into noise's input gives the swirling
    // "lava lamp" / molten gold look.
    vec2 q = vec2(fbm(uv + vec2(0.0, t * 0.4)),
                  fbm(uv + vec2(5.2, 1.3) - t * 0.3));
    float pattern = fbm(uv + 4.0 * q + vec2(0.0, t * 0.6));
    // Push contrast — bright streaks become "highlights", dark areas darken.
    float lit = pow(clamp(pattern, 0.0, 1.0), max(0.1, uTextureContrast));
    // Rim from SDF distance. d < 0 inside; |d| is distance to the nearest edge.
    float rim = smoothstep(uRimWidth, 0.0, abs(d));
    vec3 base = uColor * (lit * 1.4 + 0.18);
    // White-ish rim approximating polished glass / metal edge highlight.
    vec3 rimCol = mix(uColor, vec3(1.0), 0.7) * rim * uRimIntensity;
    return base + rimCol;
  }

  void main() {
    if (vWorldY < uHitY) discard;
    if (vSize.x < 0.0001 || vSize.y < 0.0001) discard;
    vec2 halfSize = vSize * 0.5;
    vec2 p = (vUv - 0.5) * vSize;
    float r = min(uRadius, min(halfSize.x, halfSize.y) - 0.0001);
    r = max(r, 0.0);
    float d = sdRoundedBox(p, halfSize, r);
    if (d > 0.001) discard;
    float aa = max(fwidth(d), 0.0001);
    float alpha = clamp(-d / aa + 0.5, 0.0, 1.0);

    vec3 col;
    if (uTextureMode == ${TEXTURE_LIQUID}) {
      col = textureLiquid(p, d);
    } else if (uTextureMode == ${TEXTURE_GEM}) {
      col = textureGem(p, d);
    } else {
      // 'solid' — flat tint, the legacy look.
      col = uColor;
    }
    // Emissive boost feeds Bloom uniformly across all presets.
    col *= (1.0 + uEmissive);
    gl_FragColor = vec4(col, alpha * uOpacity);
  }
`

const TEXTURE_MODE: Record<string, number> = {
  solid: TEXTURE_SOLID,
  liquid: TEXTURE_LIQUID,
  gem: TEXTURE_GEM,
}

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
  // per-instance noise seed (vec2). Derived from the note's stable id each
  // frame so a given note keeps the same texture pattern even if its slot
  // in the instance buffer shifts as earlier notes scroll past.
  const seeds = useMemo(() => new Float32Array(MAX_INSTANCES * 2), [])
  const seedAttr = useMemo(() => {
    const a = new THREE.InstancedBufferAttribute(seeds, 2)
    a.setUsage(THREE.DynamicDrawUsage)
    return a
  }, [seeds])

  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(settings.noteColor) },
        uEmissive: { value: settings.noteEmissive },
        uOpacity: { value: settings.noteOpacity },
        uRadius: { value: settings.noteCornerRadius },
        uHitY: { value: 0 },
        uTime: { value: 0 },
        uTextureMode: { value: TEXTURE_MODE[settings.noteTexture] ?? TEXTURE_SOLID },
        uTextureScale: { value: settings.noteTextureScale },
        uTextureSpeed: { value: settings.noteTextureSpeed },
        uTextureContrast: { value: settings.noteTextureContrast },
        uRimWidth: { value: settings.noteRimWidth },
        uRimIntensity: { value: settings.noteRimIntensity },
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
    material.uniforms.uTextureMode.value = TEXTURE_MODE[settings.noteTexture] ?? TEXTURE_SOLID
    material.uniforms.uTextureScale.value = settings.noteTextureScale
    material.uniforms.uTextureSpeed.value = settings.noteTextureSpeed
    material.uniforms.uTextureContrast.value = settings.noteTextureContrast
    material.uniforms.uRimWidth.value = settings.noteRimWidth
    material.uniforms.uRimIntensity.value = settings.noteRimIntensity
  }, [
    material,
    settings.noteColor,
    settings.noteEmissive,
    settings.noteOpacity,
    settings.noteCornerRadius,
    settings.noteTexture,
    settings.noteTextureScale,
    settings.noteTextureSpeed,
    settings.noteTextureContrast,
    settings.noteRimWidth,
    settings.noteRimIntensity,
  ])

  useEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return
    mesh.geometry.setAttribute('instanceSize', sizeAttr)
    mesh.geometry.setAttribute('instanceSeed', seedAttr)
    return () => {
      mesh.geometry.deleteAttribute('instanceSize')
      mesh.geometry.deleteAttribute('instanceSeed')
    }
  }, [sizeAttr, seedAttr])

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
    // Sit at the same z plane as the keys (slightly in front so they layer
    // cleanly). Hit-line clipping happens per-pixel in the fragment shader,
    // so the note's bottom can extend below hitY in geometry without showing
    // visually — and there's no perspective parallax between note and key.
    const noteZ = 0.05
    material.uniforms.uHitY.value = hitY
    // Wall clock — used by texture presets (e.g. liquid flow). Pause-friendly
    // (keeps animating) since the texture should breathe even when stopped.
    material.uniforms.uTime.value = performance.now() / 1000

    // Compute how far above the keyboard a note spawns so that the spawn line
    // sits comfortably outside the visible frustum. Approximate the visible
    // top from camera distance + FOV; assumes the camera looks roughly toward
    // the keyboard plane (true for our setup).
    const camDistance = Math.abs(settings.cameraPos[2])
    const halfVisHeight = camDistance * Math.tan((settings.cameraFov * Math.PI) / 360)
    const visibleTop = settings.cameraLookAt[1] + halfVisHeight
    const FALL_DISTANCE = Math.max(0.5, visibleTop - hitY) + SPAWN_BUFFER

    // Pitch shift in semitones — keeps the falling-note position aligned
    // with the audio engine's transposed playback so the user sees the
    // notes land on the keys that will actually sound.
    const transpose = settings.transpose

    let count = 0
    const notes = song?.notes ?? []
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i]
      let topY: number
      let bottomY: number

      if (isDown) {
        // Future notes fall from above onto the keyboard.
        // headT positive = head still in the future; negative = head has crossed
        // the hit line. The fragment shader clips pixels with worldY < hitY,
        // so geometry below the hit line is invisible.
        const headT = n.time - t
        const tailT = headT + n.duration
        if (headT > fall) break // sorted by time → no later notes are visible yet
        const headY = hitY + (headT / fall) * FALL_DISTANCE
        const tailY = hitY + (tailT / fall) * FALL_DISTANCE
        const visualLength = Math.max(minLength, tailY - headY)
        bottomY = headY
        topY = bottomY + visualLength
        // Skip once the entire visual rect is at or below the hit line.
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

      const idx = (n.midi + transpose) - MIDI_MIN
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

      // Per-note stable noise seed (vec2 in 0..1) so each note's texture
      // samples a different region. Golden-ratio + sqrt(3/2) decimals are
      // low-discrepancy so adjacent ids produce well-separated seeds.
      const sid = n.id + 1
      seeds[count * 2] = (sid * 0.6180339887498949) % 1
      seeds[count * 2 + 1] = (sid * 0.7548776662466927) % 1

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
        // Live ids use a separate counter; offset to avoid colliding with
        // song ids in seed space (so a song note + a live note triggered
        // simultaneously won't accidentally share a pattern).
        const lsid = ln.id + 1_000_003
        seeds[count * 2] = (lsid * 0.6180339887498949) % 1
        seeds[count * 2 + 1] = (lsid * 0.7548776662466927) % 1

        count++
        if (count >= MAX_INSTANCES) break
      }
    }

    mesh.count = count
    mesh.instanceMatrix.needsUpdate = true
    sizeAttr.needsUpdate = true
    seedAttr.needsUpdate = true
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
