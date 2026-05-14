import { useMemo, useRef, useEffect } from 'react'
import * as THREE from 'three'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { useStore, useSettingsSlice, defaultSettings } from '../store'
import { computeLiveVisibleTop } from '../scene/visibleTop'
import { audioEngine } from '../audio/engine'
import { now } from '../audio/clock'
import { KEYBOARD_LAYOUT, MIDI_MIN, KEY_COUNT, noteHitYWorld } from '../keyboard/layout'
import { useCustomTexture } from './customTexture'
import { deleteNotes, moveNotes, splitNote } from '../midi/edit'
import { ensureSamplerLoaded, previewNote } from '../audio/preview'
import {
  clickXToMidi,
  clickYToTime,
  fallDistance,
  noteVisualBounds,
  type TimeContext,
} from './positions'
import { buildSpeedMap, midiToTimeline } from '../midi/speedMap'
import { noteDeathFx, FADE_DURATION as DEATH_FADE_DURATION } from './noteDeathFx'

const MAX_INSTANCES = 4096
// Buffer in world units between the visible top edge of the camera frustum
// and the note spawn line — keeps notes off-screen when they're created so
// they can slide in from above instead of popping into view mid-screen.
const SPAWN_BUFFER = 1.0


// Fall trajectory length, frozen against the *default* camera framing so
// the rendered height of a note for a given duration stays constant when
// the user orbits / zooms / pans. Without this, the per-frame layout
// would re-derive FALL_DISTANCE from the live camera and notes would
// stretch / shrink as the camera moved.
const FALL_REFERENCE_DISTANCE =
  Math.max(
    0.5,
    defaultSettings.cameraLookAt[1] +
      Math.abs(defaultSettings.cameraPos[2]) *
        Math.tan((defaultSettings.cameraFov * Math.PI) / 360) -
      noteHitYWorld(defaultSettings.keyboardY),
  ) + SPAWN_BUFFER

// Shared in/out object for `computeRisingRect`. Reused across notes so
// the per-frame layout pass doesn't allocate thousands of objects.
const _risingRect: { topY: number; bottomY: number } = { topY: 0, bottomY: 0 }

/**
 * Geometry of a rising trail (head leads upward, tail follows). Used
 * identically by recorded-MIDI 'up' notes and live MIDI input notes —
 * the two paths feed in different time origins (`t - n.time` vs
 * `liveNow - startTime`) and different durations (`n.duration` vs
 * `endTime - startTime`), but everything downstream (visualLength,
 * head/tail Y, cull math) must stay byte-for-byte identical, so the
 * geometry lives in one place.
 *
 * Returns null when the head hasn't crossed the hit line yet
 * (`headT < 0`). Otherwise mutates and returns the shared object.
 */
function computeRisingRect(
  headT: number,
  duration: number,
  hitY: number,
  fall: number,
  fallDistance: number,
  minLength: number,
): { topY: number; bottomY: number } | null {
  if (headT < 0) return null
  const tailT = headT - duration
  const headY = hitY + (headT / fall) * fallDistance
  const tailY = hitY + (tailT / fall) * fallDistance
  const visualLength = Math.max(minLength, headY - tailY)
  _risingRect.topY = headY
  _risingRect.bottomY = headY - visualLength
  return _risingRect
}

const VERTEX_SHADER = /* glsl */ `
  attribute vec2 instanceSize;
  attribute vec2 instanceSeed;
  attribute float instanceSelected;
  // Per-instance opacity multiplier. 1.0 for normal notes; ramped down
  // 1 → 0 over FADE_DURATION for the dying-note ghosts the renderer
  // appends after the live-note pass.
  attribute float instanceAlpha;
  // Per-instance RGB tint. Resolved from settings.trackColors[note.track]
  // with fallback to settings.noteColor — populated each frame on the
  // CPU side. The fragment shader uses this in place of a uColor uniform
  // so different tracks can show different colours simultaneously.
  attribute vec3 instanceTint;
  varying vec2 vUv;
  varying vec2 vSize;
  varying vec2 vSeed;
  varying float vSelected;
  varying float vAlpha;
  varying float vWorldY;
  varying vec3 vTint;
  void main() {
    vUv = uv;
    vSize = instanceSize;
    vSeed = instanceSeed;
    vSelected = instanceSelected;
    vAlpha = instanceAlpha;
    vTint = instanceTint;
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
const TEXTURE_CUSTOM = 3

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  varying vec2 vSize;
  varying vec2 vSeed;
  varying float vSelected;
  varying float vAlpha;
  varying float vWorldY;
  varying vec3 vTint;
  uniform float uEmissive;
  uniform float uOpacity;
  uniform float uRadius;
  uniform float uHitY;
  uniform float uTime;
  // Texture preset selector — branched in main(). See TEXTURE_* constants
  // (CPU side) for the value mapping.
  uniform int uTextureMode;
  uniform float uTextureScale;
  // X/Y animation speed. Custom uses both axes for UV scroll; liquid and
  // gem use only Y as their generic time multiplier (their patterns have
  // no inherent direction).
  uniform vec2 uAnimSpeed;
  // Static positional shift on the texture sample point. Subtracted from
  // the UV so positive offset visually moves the image in the positive
  // direction (right / up) on the note.
  uniform vec2 uTextureOffset;
  // LOD bias applied to the custom-image sampler. Each unit doubles the
  // effective blur radius — the GPU's trilinear mipmap filter handles the
  // smoothing in hardware, so even large values stay artifact-free
  // (compared to a multi-tap blur, which ghosts at wide radii).
  uniform float uTextureBlur;
  // Custom-preset per-note offset weight in [0, 1]. Multiplies the vSeed
  // component so 0 = every note identical, 1 = full random offset per note.
  uniform float uTextureVariation;
  uniform float uTextureContrast;
  uniform vec3 uEdgeColor;
  uniform float uEdgeWidth;
  uniform float uEdgeIntensity;
  // 'custom' preset — user image. uHasCustomTexture is 1 when a real texture
  // is bound, 0 otherwise (so the shader can fall back to the tint colour
  // and not display the placeholder 1x1 default).
  uniform sampler2D uCustomTexture;
  uniform float uHasCustomTexture;

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
    vec2 uv = p * uTextureScale + vSeed * 100.0 - uTextureOffset;
    vec2 i = floor(uv);
    vec2 f = fract(uv);
    float t = uTime * uAnimSpeed.y;

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

    vec3 base = vTint * (facet * 1.4 + 0.12);
    // Sparkle flashes the facet toward pure white — the hallmark of a real
    // gem reflection.
    base = mix(base, vec3(1.0), spark * 0.9);
    // Edges blend toward white where they actually catch light.
    base = mix(base, vec3(1.0), edgeMask * edgeStrength * 0.9);
    return base;
  }

  // 'custom': user-uploaded image.
  // - UV is per-note local: vUv * vSize gives a coordinate in world units
  //   from the note's bottom-left corner. Multiplied by uTextureScale, the
  //   image tiles within the note. Every note starts the image at the
  //   same origin → identical appearance across notes.
  // - uTextureScale = "tiles per world unit". Higher = smaller tiles
  //   (image repeats more times within the note). Both axes scale
  //   uniformly so the source aspect ratio is preserved.
  // - uAnimSpeed (X, Y) scrolls the UV per axis. Same world-unit
  //   semantics as the position term, so motion looks consistent
  //   regardless of scale.
  // - uTextureOffset shifts the image inside each note (positive = right
  //   / up).
  // - Per-note vSeed offset is gated by uTextureVariation: 0 = all notes
  //   show the image identically, 1 = each note starts at its own random
  //   spot. (Liquid / gem always use vSeed, since their patterns are
  //   abstract and benefit from variation.)
  // - Contrast pushes pixel values away from mid gray (1 = identity).
  // - Tinted by uColor (set Color = white for pass-through).
  // Texture wrap is RepeatWrapping in customTexture.ts so values outside
  // [0,1] tile naturally.
  vec3 textureCustom(vec2 p, float d) {
    vec2 uv = (vUv * vSize + uTime * uAnimSpeed) * uTextureScale + vSeed * 100.0 * uTextureVariation - uTextureOffset;
    // Single tap with LOD bias — the texture is configured with mipmaps
    // and trilinear filtering, so the bias selects a progressively-blurred
    // mip level. This is what GPU hardware is built to do, and produces a
    // smooth gaussian-like blur with no ghosting at any radius.
    vec3 sampled = texture2D(uCustomTexture, uv, uTextureBlur).rgb;
    sampled = clamp((sampled - 0.5) * uTextureContrast + 0.5, 0.0, 1.0);
    // When no image is bound yet, fall back to the tint color so the user
    // doesn't see a black rectangle while picking a file.
    return mix(vTint, sampled * vTint, uHasCustomTexture);
  }

  // 'liquid': domain-warped FBM (molten metal flow). Edge is composited in
  // main() so it isn't subject to uEmissive.
  vec3 textureLiquid(vec2 p, float d) {
    // Per-note offset so each note samples a different region of the noise
    // field — otherwise every note shows the same flow pattern.
    vec2 uv = p * uTextureScale + vSeed * 100.0 - uTextureOffset;
    float t = uTime * uAnimSpeed.y;
    // Domain warp — feeding noise into noise's input gives the swirling
    // "lava lamp" / molten gold look.
    vec2 q = vec2(fbm(uv + vec2(0.0, t * 0.4)),
                  fbm(uv + vec2(5.2, 1.3) - t * 0.3));
    float pattern = fbm(uv + 4.0 * q + vec2(0.0, t * 0.6));
    // Push contrast — bright streaks become "highlights", dark areas darken.
    float lit = pow(clamp(pattern, 0.0, 1.0), max(0.1, uTextureContrast));
    return vTint * (lit * 1.4 + 0.18);
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

    // Texture functions return JUST the fill — edge is composited below so
    // the user's Edge Color / Intensity are not magnified by the note's
    // Emissive setting (which is meant to drive Bloom on the note body).
    vec3 fill;
    if (uTextureMode == ${TEXTURE_LIQUID}) {
      fill = textureLiquid(p, d);
    } else if (uTextureMode == ${TEXTURE_GEM}) {
      fill = textureGem(p, d);
    } else if (uTextureMode == ${TEXTURE_CUSTOM}) {
      fill = textureCustom(p, d);
    } else {
      // 'solid' — flat tint.
      fill = vTint;
    }
    // Emissive boost feeds Bloom — applies only to the fill so edge stays
    // strictly user-controlled via its own Color + Intensity.
    fill *= (1.0 + uEmissive);

    float edge = smoothstep(uEdgeWidth, 0.0, abs(d));
    vec3 edgeCol = uEdgeColor * edge * uEdgeIntensity;

    vec3 finalColor = fill + edgeCol;

    // Selection treatment. Has to remain perceptible against every
    // possible fill colour AND luminance — a single-colour treatment
    // (white halo, black halo, even adaptive luminance shift) all
    // collapse on certain colours: white halo vanishes on white fills,
    // dark halo on black fills, luminance shift on mid-greys (~#A1A1A1)
    // where neither "brighten" nor "darken" produces meaningful
    // contrast. Three composited layers cover the whole spectrum:
    //   1. Adaptive luminance shift — brighten dark fills, dim bright
    //      fills. Carries most of the cue for high-contrast colours.
    //   2. Soft inner halo with HDR-adaptive accent — feeds Bloom into
    //      a glow when Bloom is on, contributes a subtle tint when off.
    //   3. Dual-edge stroke (bright stripe + dark stripe placed a few
    //      antialiased pixels apart) — guarantees that AT LEAST one
    //      stripe contrasts strongly with the underlying fill no matter
    //      what its luminance is. This is the "always works" layer
    //      that catches grey/mid-tone fills the other layers miss.
    //      Same principle as macOS / Windows focus rings.
    if (vSelected > 0.5) {
      float fillLum = dot(fill, vec3(0.299, 0.587, 0.114));
      float brightT = smoothstep(0.5, 0.7, fillLum);   // 0 dark → 1 bright
      float edgeDepth = min(halfSize.x, halfSize.y) * 0.18;
      float edgeT = smoothstep(-edgeDepth, 0.0, d);    // 0 inside → 1 at edge

      // 1. Uniform luminance shift.
      finalColor += fill * (1.0 - brightT);   // up to +1× for very dark fills
      finalColor *= mix(1.0, 0.5, brightT);   // down to ×0.5 for very bright fills

      // 2. Soft inner halo with adaptive accent.
      vec3 accent = mix(vec3(2.0), vec3(0.0), brightT);
      finalColor = mix(finalColor, accent, edgeT * 0.5);

      // 3. Dual-edge stroke. Two parallel ~1px stripes inset from the
      // edge: a bright HDR stripe near the outside, a dark stripe just
      // inside it. Pixel-scale offsets via fwidth keep both stripes a
      // consistent screen width at any zoom.
      float aaW = fwidth(d);
      float brightStrokeMid = -aaW * 2.0;
      float darkStrokeMid = -aaW * 5.0;
      float brightMask = 1.0 - smoothstep(aaW * 0.5, aaW * 1.5, abs(d - brightStrokeMid));
      float darkMask = 1.0 - smoothstep(aaW * 0.5, aaW * 1.5, abs(d - darkStrokeMid));
      finalColor = mix(finalColor, vec3(2.5), brightMask * 0.9);
      finalColor = mix(finalColor, vec3(0.0), darkMask * 0.9);
    }

    gl_FragColor = vec4(finalColor, alpha * uOpacity * vAlpha);
  }
`

const TEXTURE_MODE: Record<string, number> = {
  solid: TEXTURE_SOLID,
  liquid: TEXTURE_LIQUID,
  gem: TEXTURE_GEM,
  custom: TEXTURE_CUSTOM,
}

// 1x1 transparent placeholder so the sampler2D uniform always has a valid
// texture bound (an unbound sampler reads black on some drivers + warns).
// The shader uses uHasCustomTexture to ignore samples from this placeholder.
const PLACEHOLDER_TEXTURE = new THREE.DataTexture(
  new Uint8Array([255, 255, 255, 255]),
  1,
  1,
  THREE.RGBAFormat,
)
PLACEHOLDER_TEXTURE.needsUpdate = true

// Keys FallingNotes actually reads from settings. Selecting these with
// `useShallow` means an Inspector slider drag on an unrelated key (e.g.
// any Audio / Reverb / Particles slider) does NOT re-render this
// component — and therefore doesn't trigger Three.js / R3F
// reconciliation on the instanced mesh.
const FALLING_NOTES_KEYS = [
  'cameraFov',
  'cameraLookAt',
  'cameraPos',
  'edgeEnabled',
  'fallDirection',
  'fallDurationSec',
  'keyboardY',
  'midiOffsetSec',
  'midiSpeedAutomation',
  'midiTrimEndSec',
  'midiTrimStartSec',
  'noteAnimSpeedX',
  'noteAnimSpeedY',
  'noteColor',
  'noteCornerRadius',
  'noteEdgeColor',
  'noteEdgeIntensity',
  'noteEdgeWidth',
  'noteEmissive',
  'noteMinLength',
  'noteOpacity',
  'noteTexture',
  'noteTextureBlur',
  'noteTextureContrast',
  'noteTextureOffsetX',
  'noteTextureOffsetY',
  'noteTextureScale',
  'noteTextureVariation',
  'noteWidthScale',
  'trackColors',
  'transpose',
] as const

export function FallingNotes() {
  const settings = useSettingsSlice(FALLING_NOTES_KEYS)
  const song = useStore((s) => s.song)
  const customTexture = useCustomTexture((s) => s.texture)
  const transport = useStore((s) => s.transport)
  // Speed automation map — memoised against the breakpoint array so
  // useFrame re-uses the same instance until the user actually
  // edits the curve. With no automation this is `EMPTY_SPEED_MAP`,
  // which makes `midiToTimeline` an identity (zero cost).
  const speedMap = useMemo(
    () => buildSpeedMap(settings.midiSpeedAutomation),
    [settings.midiSpeedAutomation],
  )
  // Shared geometry context handed to the per-note helpers. Built
  // here so the per-frame closure / per-event handlers don't need
  // to thread the speed map + offset through every call site.
  const timeCtx: TimeContext = useMemo(
    () => ({ speedMap, midiOffset: settings.midiOffsetSec }),
    [speedMap, settings.midiOffsetSec],
  )

  const meshRef = useRef<THREE.InstancedMesh>(null)
  const dummy = useMemo(() => new THREE.Object3D(), [])
  // Scratch Color used to parse hex strings into linear RGB once per
  // track per frame. Reused across all calls in the resolveTint cache
  // so we don't allocate per note.
  const tmpColor = useMemo(() => new THREE.Color(), [])
  const { camera, gl } = useThree()

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
  // per-instance selection flag (0 / 1). Drives the bright white outline in
  // the fragment shader. Filled in the same useFrame pass that builds size
  // and seed, since the per-frame instance ↔ note mapping is built there.
  const selectedAttrData = useMemo(() => new Float32Array(MAX_INSTANCES), [])
  const selectedAttr = useMemo(() => {
    const a = new THREE.InstancedBufferAttribute(selectedAttrData, 1)
    a.setUsage(THREE.DynamicDrawUsage)
    return a
  }, [selectedAttrData])
  // per-instance opacity multiplier. 1.0 for normal notes; ramps 1 → 0
  // over DEATH_FADE_DURATION for dying-note ghosts that the renderer
  // appends after the live-note pass.
  const alphaAttrData = useMemo(() => {
    const a = new Float32Array(MAX_INSTANCES)
    a.fill(1)
    return a
  }, [])
  const alphaAttr = useMemo(() => {
    const a = new THREE.InstancedBufferAttribute(alphaAttrData, 1)
    a.setUsage(THREE.DynamicDrawUsage)
    return a
  }, [alphaAttrData])
  // Per-instance RGB tint. Resolved each frame from the note's track →
  // settings.trackColors[trackIdx], with fallback to settings.noteColor.
  // Live notes / dying ghosts (which have no track index) use the
  // global noteColor as well.
  const tints = useMemo(() => new Float32Array(MAX_INSTANCES * 3), [])
  const tintAttr = useMemo(() => {
    const a = new THREE.InstancedBufferAttribute(tints, 3)
    a.setUsage(THREE.DynamicDrawUsage)
    return a
  }, [tints])
  // Maps the per-frame instance slot back to the song's note id. Click
  // handling reads from this; useFrame writes it.
  const instanceToNoteId = useRef<number[]>([])

  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uEmissive: { value: settings.noteEmissive },
        uOpacity: { value: settings.noteOpacity },
        uRadius: { value: settings.noteCornerRadius },
        uHitY: { value: 0 },
        uTime: { value: 0 },
        uTextureMode: { value: TEXTURE_MODE[settings.noteTexture] ?? TEXTURE_SOLID },
        uTextureScale: { value: settings.noteTextureScale },
        uAnimSpeed: { value: new THREE.Vector2(settings.noteAnimSpeedX, settings.noteAnimSpeedY) },
        uTextureOffset: { value: new THREE.Vector2(settings.noteTextureOffsetX, settings.noteTextureOffsetY) },
        uTextureBlur: { value: settings.noteTextureBlur },
        uTextureVariation: { value: settings.noteTextureVariation },
        uTextureContrast: { value: settings.noteTextureContrast },
        uEdgeColor: { value: new THREE.Color(settings.noteEdgeColor) },
        uEdgeWidth: { value: settings.noteEdgeWidth },
        uEdgeIntensity: { value: settings.noteEdgeIntensity },
        uCustomTexture: { value: PLACEHOLDER_TEXTURE },
        uHasCustomTexture: { value: 0 },
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
    material.uniforms.uEmissive.value = settings.noteEmissive
    material.uniforms.uOpacity.value = settings.noteOpacity
    material.uniforms.uRadius.value = settings.noteCornerRadius
    material.uniforms.uTextureMode.value = TEXTURE_MODE[settings.noteTexture] ?? TEXTURE_SOLID
    material.uniforms.uTextureScale.value = settings.noteTextureScale
    material.uniforms.uAnimSpeed.value.set(settings.noteAnimSpeedX, settings.noteAnimSpeedY)
    material.uniforms.uTextureOffset.value.set(settings.noteTextureOffsetX, settings.noteTextureOffsetY)
    material.uniforms.uTextureBlur.value = settings.noteTextureBlur
    material.uniforms.uTextureVariation.value = settings.noteTextureVariation
    material.uniforms.uTextureContrast.value = settings.noteTextureContrast
    material.uniforms.uEdgeColor.value.set(settings.noteEdgeColor)
    // Edge is gated by zeroing width/intensity instead of unmounting; this
    // keeps the user's slider values intact for a clean re-enable.
    material.uniforms.uEdgeWidth.value = settings.edgeEnabled ? settings.noteEdgeWidth : 0
    material.uniforms.uEdgeIntensity.value = settings.edgeEnabled ? settings.noteEdgeIntensity : 0
  }, [
    material,
    settings.noteEmissive,
    settings.noteOpacity,
    settings.noteCornerRadius,
    settings.noteTexture,
    settings.noteTextureScale,
    settings.noteAnimSpeedX,
    settings.noteAnimSpeedY,
    settings.noteTextureOffsetX,
    settings.noteTextureOffsetY,
    settings.noteTextureBlur,
    settings.noteTextureVariation,
    settings.noteTextureContrast,
    settings.edgeEnabled,
    settings.noteEdgeColor,
    settings.noteEdgeWidth,
    settings.noteEdgeIntensity,
  ])

  useEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return
    mesh.geometry.setAttribute('instanceSize', sizeAttr)
    mesh.geometry.setAttribute('instanceSeed', seedAttr)
    mesh.geometry.setAttribute('instanceSelected', selectedAttr)
    mesh.geometry.setAttribute('instanceAlpha', alphaAttr)
    mesh.geometry.setAttribute('instanceTint', tintAttr)
    // Pin a large bounding sphere so raycasting never short-circuits.
    // Three.js's InstancedMesh.raycast() does an early-reject against the
    // mesh's bounding sphere, but auto-computes it ONCE (lazily, on first
    // raycast) from whatever instances happened to be visible then. Notes
    // that arrive later — at the screen edges, far above / below — would
    // then sit outside that stale sphere and silently become unclickable
    // (selecting "some notes, not others"). A fixed sphere larger than any
    // realistic camera frame keeps every instance in scope; the per-
    // instance triangle test is what actually decides hits.
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1000)
    return () => {
      mesh.geometry.deleteAttribute('instanceSize')
      mesh.geometry.deleteAttribute('instanceSeed')
      mesh.geometry.deleteAttribute('instanceSelected')
      mesh.geometry.deleteAttribute('instanceAlpha')
      mesh.geometry.deleteAttribute('instanceTint')
    }
  }, [sizeAttr, seedAttr, selectedAttr, alphaAttr, tintAttr])

  useEffect(() => () => material.dispose(), [material])

  // Bind the user-uploaded texture (or the placeholder) to the shader's
  // sampler whenever it changes. uHasCustomTexture lets the shader ignore
  // samples from the placeholder so a not-yet-uploaded 'custom' preset
  // gracefully falls back to the tint colour.
  useEffect(() => {
    material.uniforms.uCustomTexture.value = customTexture ?? PLACEHOLDER_TEXTURE
    material.uniforms.uHasCustomTexture.value = customTexture ? 1 : 0
  }, [material, customTexture])

  useFrame(() => {
    audioEngine.tick()

    const mesh = meshRef.current
    if (!mesh) return

    // Falling-note placement is in TL_audio (wall-clock × rate) and
    // each note's "fire moment" is `midiOffset + map(n.time)`. This
    // keeps the descent rate constant in wall-clock seconds — speed
    // automation only changes WHEN audio fires, not how fast the
    // visual moves. Without automation the map collapses to identity
    // and this reduces to the legacy `n.time` vs `currentSongTime`.
    const tl = audioEngine.currentSongTime()
    const midiOffset = settings.midiOffsetSec
    const hitY = noteHitYWorld(settings.keyboardY)
    const isDown = settings.fallDirection === 'down'
    const fall = settings.fallDurationSec
    const widthScale = settings.noteWidthScale
    const minLength = Math.max(0.01, settings.noteMinLength)
    // Sit in front of the 3D black keys (top face at z=BLACK_KEY_THICKNESS
    // = 0.09) so notes don't appear stuck inside them at the moment they
    // cross the hit line. Hit-line clipping happens per-pixel in the
    // fragment shader, so geometry below hitY is invisible. Parallax vs.
    // the keys at this z offset (camera at z=12) is sub-pixel.
    const noteZ = 0.1
    material.uniforms.uHitY.value = hitY
    // Wall clock — used by texture presets (e.g. liquid flow). Pause-friendly
    // (keeps animating) since the texture should breathe even when stopped.
    material.uniforms.uTime.value = now()

    // FALL_DISTANCE is locked to the *default* camera framing
    // (FALL_REFERENCE_DISTANCE) — re-deriving it from the live camera
    // would resize every note's visual length the moment the user
    // orbits / zooms, breaking the user's spatial timing reference.
    const FALL_DISTANCE = FALL_REFERENCE_DISTANCE
    // Visible-range bound for spawn / cull — derived from the live
    // camera so song notes (down spawn), 'up' history trails, and live
    // notes all rise / appear up to the user's actual viewport. Capped
    // (see scene/visibleTop.ts) so steep look-up angles don't blow it
    // up unboundedly. Floored to the reference trajectory cap so
    // zoom-in / look-down can't shrink it and cull notes mid-travel.
    const liveVisibleTop = computeLiveVisibleTop(
      settings.cameraPos,
      settings.cameraLookAt,
      settings.cameraFov,
      noteZ,
      hitY,
    )
    const visibleTop = Math.max(liveVisibleTop, hitY + FALL_DISTANCE)
    // Spawn cutoff (in seconds-into-future) for 'down' notes. Default
    // is `fall`, but when the visible top sits above hitY+FALL_DISTANCE
    // we need to spawn earlier so notes appear right at the top edge
    // of the user's view rather than popping in mid-frame. The +1 wu
    // buffer mirrors SPAWN_BUFFER so the note slides in instead of
    // appearing exactly on the visible edge.
    const downSpawnCutoff = Math.max(
      fall,
      ((visibleTop - hitY + SPAWN_BUFFER) * fall) / FALL_DISTANCE,
    )

    // Pitch shift in semitones — keeps the falling-note position aligned
    // with the audio engine's transposed playback so the user sees the
    // notes land on the keys that will actually sound.
    const transpose = settings.transpose

    // Selection set is read once per frame so the per-instance flag fill
    // doesn't pay a Map lookup cost per song note (could be thousands).
    const selection = useStore.getState().selection
    const noteIds = instanceToNoteId.current

    // Per-track tint cache, populated on demand. The cache resets every
    // frame so changes to `noteColor` / `trackColors` apply immediately.
    // For a song with N tracks (typically <5), this saves the per-note
    // hex parse cost.
    const trackColors = settings.trackColors
    const defaultTintColor = tmpColor.set(settings.noteColor)
    const defaultR = defaultTintColor.r
    const defaultG = defaultTintColor.g
    const defaultB = defaultTintColor.b
    const trackTintCache = new Map<number, readonly [number, number, number]>()
    const resolveTint = (trackIdx: number | undefined): readonly [number, number, number] => {
      if (trackIdx == null) return [defaultR, defaultG, defaultB]
      const cached = trackTintCache.get(trackIdx)
      if (cached) return cached
      const override = trackColors[String(trackIdx)]
      if (!override) {
        const v: [number, number, number] = [defaultR, defaultG, defaultB]
        trackTintCache.set(trackIdx, v)
        return v
      }
      tmpColor.set(override)
      const v: [number, number, number] = [tmpColor.r, tmpColor.g, tmpColor.b]
      trackTintCache.set(trackIdx, v)
      return v
    }

    let count = 0
    const notes = song?.notes ?? []
    // Non-destructive trim window — notes outside `[trimStart, trimEnd)`
    // are skipped on the canvas, mirroring the engine's playback
    // filter so what the user sees matches what they hear.
    const trimStart = settings.midiTrimStartSec
    const trimEnd =
      settings.midiTrimEndSec ?? song?.duration ?? Number.POSITIVE_INFINITY
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i]
      if (n.time < trimStart) continue
      if (n.time >= trimEnd) continue
      // Clamp duration to the trim window so a note whose natural
      // release sits past trimEnd visually shortens to land its tail
      // at the trim point (mirroring the audio engine's clamped
      // note-off).
      const effEndMidi = Math.min(n.time + n.duration, trimEnd)
      // Each note's head/tail FIRE MOMENT in TL_audio (= when audio
      // will play that point). With the speed map, this stretches /
      // compresses the visual note length to match audio duration in
      // wall-clock seconds; outside automation, the map is identity
      // and this collapses to `midiOffset + n.time`.
      const headFire = midiOffset + midiToTimeline(speedMap, n.time)
      const tailFire = midiOffset + midiToTimeline(speedMap, effEndMidi)
      let topY: number
      let bottomY: number

      if (isDown) {
        // Future notes fall from above onto the keyboard. `headT` is
        // TL_audio seconds until the note's audio fires; under the
        // engine's wall × rate clock it shrinks at constant rate so
        // the visual descent stays at `FALL_DISTANCE / fall` per
        // wall-second regardless of the speed curve.
        const headT = headFire - tl
        const tailT = tailFire - tl
        if (headT > downSpawnCutoff) break // sorted by time → no later notes are visible yet
        const headY = hitY + (headT / fall) * FALL_DISTANCE
        const tailY = hitY + (tailT / fall) * FALL_DISTANCE
        const visualLength = Math.max(minLength, tailY - headY)
        bottomY = headY
        topY = bottomY + visualLength
        // Skip once the entire visual rect is at or below the hit line.
        if (topY <= hitY) continue
      } else {
        // Past notes rise from the keyboard upward (history trail).
        // Same geometry as the live-note path below — see computeRisingRect.
        const audioDuration = tailFire - headFire
        const rect = computeRisingRect(
          tl - headFire,
          audioDuration,
          hitY,
          fall,
          FALL_DISTANCE,
          minLength,
        )
        if (rect === null) break // not yet emerged (sorted → no later notes either)
        if (rect.bottomY >= visibleTop) continue
        if (rect.topY <= hitY) continue
        topY = rect.topY
        bottomY = rect.bottomY
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

      selectedAttrData[count] = selection.has(n.id) ? 1 : 0
      alphaAttrData[count] = 1
      noteIds[count] = n.id

      const tint = resolveTint(n.track)
      tints[count * 3] = tint[0]
      tints[count * 3 + 1] = tint[1]
      tints[count * 3 + 2] = tint[2]

      count++
      if (count >= MAX_INSTANCES) break
    }

    // Live notes (touch/click) — always render as rising trails, sharing
    // the exact same `computeRisingRect` geometry as the song 'up' branch
    // above. The only thing that differs is the timeline source: songs
    // use `t = currentSongTime()`, live uses `liveNow = now()`, with the
    // live note's `endTime` (or `liveNow` while held) playing the role of
    // `n.duration`.
    const liveNotes = audioEngine.getLiveNotes()
    if (liveNotes.length > 0) {
      const liveNow = now()
      for (let i = 0; i < liveNotes.length; i++) {
        const ln = liveNotes[i]
        const noteDuration = (ln.endTime ?? liveNow) - ln.startTime
        const rect = computeRisingRect(liveNow - ln.startTime, noteDuration, hitY, fall, FALL_DISTANCE, minLength)
        if (rect === null) continue
        if (rect.bottomY >= visibleTop) continue
        if (rect.topY <= hitY) continue
        const topY = rect.topY
        const bottomY = rect.bottomY

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
        // Live notes are user-played performance, never editable, so they're
        // never selected and the noteId map gets a sentinel.
        selectedAttrData[count] = 0
        alphaAttrData[count] = 1
        noteIds[count] = -1
        // Live notes have no track — fall back to noteColor.
        tints[count * 3] = defaultR
        tints[count * 3 + 1] = defaultG
        tints[count * 3 + 2] = defaultB

        count++
        if (count >= MAX_INSTANCES) break
      }
    }

    // Dying-note ghosts (right-click delete + eraser drag). Renders the
    // same shader as a regular note with a per-instance alpha multiplier
    // ramped 1 → 0 over DEATH_FADE_DURATION on a plain linear curve.
    const nowSec = now()
    noteDeathFx.prune(nowSec)
    const dying = noteDeathFx.list()
    for (let i = 0; i < dying.length; i++) {
      if (count >= MAX_INSTANCES) break
      const d = dying[i]
      const ageNorm = (nowSec - d.startTime) / DEATH_FADE_DURATION
      if (ageNorm >= 1) continue
      const fadeAlpha = 1 - Math.max(0, Math.min(1, ageNorm))

      dummy.position.set(d.x, d.centerY, noteZ)
      dummy.rotation.set(0, 0, 0)
      dummy.scale.set(d.width, d.length, 1)
      dummy.updateMatrix()
      mesh.setMatrixAt(count, dummy.matrix)
      sizes[count * 2] = d.width
      sizes[count * 2 + 1] = d.length
      // Reuse a high low-discrepancy seed so the ghost's texture sample
      // is stable for its lifetime instead of crawling each frame.
      const seedBase = (i + 7919) // arbitrary prime offset
      seeds[count * 2] = (seedBase * 0.6180339887498949) % 1
      seeds[count * 2 + 1] = (seedBase * 0.7548776662466927) % 1
      selectedAttrData[count] = 0
      alphaAttrData[count] = fadeAlpha
      noteIds[count] = -1 // not editable / not selectable
      // Preserve the deleted note's track tint so the fade-out reads
      // as "this exact note is dissolving" instead of flashing back
      // to the global noteColor for its final 0.12s.
      const ghostTint = resolveTint(d.track)
      tints[count * 3] = ghostTint[0]
      tints[count * 3 + 1] = ghostTint[1]
      tints[count * 3 + 2] = ghostTint[2]
      count++
    }

    mesh.count = count
    mesh.instanceMatrix.needsUpdate = true
    sizeAttr.needsUpdate = true
    seedAttr.needsUpdate = true
    selectedAttr.needsUpdate = true
    alphaAttr.needsUpdate = true
    tintAttr.needsUpdate = true
  })

  // Project a screen-space pointer to the falling-note z plane (z = 0.1).
  // Used during drag tracking via window-level pointermove (which is in
  // client coords, not three event coords). Returns null if the canvas has
  // disappeared mid-drag (e.g. the user navigated away).
  const noteZ = 0.1
  const screenToWorld = (clientX: number, clientY: number): THREE.Vector3 | null => {
    const canvas = gl.domElement
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1),
    )
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, camera)
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -noteZ)
    const out = new THREE.Vector3()
    if (!raycaster.ray.intersectPlane(plane, out)) return null
    return out
  }

  // Brief audible cue when the user selects a note. Goes through the
  // editor-only `previewNote` helper so it does NOT light up the keyboard
  // press-glow / landing flash / hit particles — those are reserved for
  // real performance input.
  const previewSelectedNote = (noteId: number) => {
    const state = useStore.getState()
    if (!state.song) return
    const n = state.song.notes.find((x) => x.id === noteId)
    if (!n) return
    void previewNote(n.midi + state.settings.transpose, n.velocity, 200)
  }

  // Cached "we are hovering this note's top/bottom edge". Updated every
  // pointermove over the InstancedMesh and consumed at pointerdown to
  // decide whether the click should resize the note's duration instead
  // of selecting / starting a move-drag. Also drives the `ns-resize`
  // canvas cursor so the user gets a hint before clicking.
  const hoveredEdgeRef = useRef<{
    noteId: number
    edge: 'head' | 'tail'
  } | null>(null)
  // World-space proximity threshold for "is the cursor near this edge".
  // Scaled so 1080p height ≈ 12 px at default camera; small enough that
  // it doesn't accidentally trigger on the body of short notes, large
  // enough to grab without pixel-perfect aim.
  const EDGE_PROXIMITY = 0.08

  // Drag state. Lives on a ref so the closure handlers can mutate without
  // causing React re-renders, which would interrupt the pointer capture.
  const dragRef = useRef<{
    snapshot: import('../midi/types').ParsedSong
    ids: Set<number>
    anchorMidi: number
    anchorOriginalDisplayedX: number
    startWorld: THREE.Vector3
    startClient: { x: number; y: number }
    moved: boolean
    pushedHistory: boolean
    lastDeltaSemis: number
  } | null>(null)

  const beginDrag = (
    startWorld: THREE.Vector3,
    startClient: { x: number; y: number },
    anchorNoteId: number,
  ) => {
    const state = useStore.getState()
    if (!state.song) return
    const anchor = state.song.notes.find((n) => n.id === anchorNoteId)
    if (!anchor) return
    // Drag every currently-selected note. The anchor is just the click
    // target — its delta drives everyone else's delta uniformly so the
    // selection's relative shape is preserved.
    const ids = new Set<number>(state.selection)
    if (!ids.has(anchorNoteId)) ids.add(anchorNoteId)
    const anchorIdx = anchor.midi + state.settings.transpose - MIDI_MIN
    if (anchorIdx < 0 || anchorIdx >= KEY_COUNT) return
    dragRef.current = {
      snapshot: state.song,
      ids,
      anchorMidi: anchor.midi + state.settings.transpose,
      anchorOriginalDisplayedX: KEYBOARD_LAYOUT.keys[anchorIdx].x,
      startWorld,
      startClient,
      moved: false,
      pushedHistory: false,
      lastDeltaSemis: 0,
    }

    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      // Threshold so a tiny accidental jitter on click doesn't push history
      // and doesn't reposition the note. ~5 px before drag starts.
      if (!drag.moved) {
        const cdx = ev.clientX - drag.startClient.x
        const cdy = ev.clientY - drag.startClient.y
        if (cdx * cdx + cdy * cdy < 25) return
        drag.moved = true
        // Stay on the four-way 'move' cursor through the drag — it
        // already represents both the hover affordance and the active
        // gesture (no need for a separate "grabbing" variant).
        gl.domElement.style.cursor = 'move'
      }
      const world = screenToWorld(ev.clientX, ev.clientY)
      if (!world) return
      const dx = world.x - drag.startWorld.x
      const dy = world.y - drag.startWorld.y

      const settings = useStore.getState().settings
      const fd = fallDistance(settings)
      // Y → time. In 'down', notes higher up are later → +ΔY = +ΔTime.
      // In 'up', notes higher up are older → +ΔY = −ΔTime.
      const dirSign = settings.fallDirection === 'down' ? 1 : -1
      const deltaTime = dirSign * (dy / fd) * settings.fallDurationSec

      // X → semitones. Compute via the anchor's snapped position so the
      // black/white key X spacing is honoured naturally — clickXToMidi
      // already finds the nearest key by absolute X distance.
      const newAnchorDisplayedMidi = clickXToMidi(drag.anchorOriginalDisplayedX + dx, 0)
      const deltaSemis = newAnchorDisplayedMidi - drag.anchorMidi

      if (!drag.pushedHistory) {
        useStore.getState().pushUndoSnapshot(drag.snapshot)
        drag.pushedHistory = true
      }

      // Audible confirmation when the snapped pitch crosses to a new key.
      if (deltaSemis !== drag.lastDeltaSemis) {
        drag.lastDeltaSemis = deltaSemis
        // Preview the anchor at its new pitch — uses `previewNote` so the
        // keyboard glow / flash stay quiet while dragging through pitches.
        const anchorVel =
          drag.snapshot.notes.find((n) => n.id === anchorNoteId)?.velocity ?? 0.7
        void previewNote(drag.anchorMidi + deltaSemis, anchorVel, 150)
      }

      const next = moveNotes(drag.snapshot, drag.ids, deltaTime, deltaSemis)
      useStore.getState().setSongPreview(next)
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      dragRef.current = null
      // Drop the grabbing cursor — the next pointermove will decide
      // whether the cursor sits over a note again and re-establish
      // the right hover cursor.
      gl.domElement.style.cursor = ''
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // Edge-resize gesture. Drags one end of a note's time interval while
  // keeping the other end fixed. Direction-aware: "head" edge moves
  // note.time (and inversely adjusts duration so the tail stays put);
  // "tail" edge changes note.duration only.
  //
  // Collision behavior — same "solid blocks" model as moveNotes: extending
  // into a same-pitch neighbour is BLOCKED, not allowed-with-clipping.
  // The neighbour's edge becomes a hard stop so resize feels symmetric
  // with move (you can't carve out room from another note by accident).
  const beginResizeDrag = (
    noteId: number,
    edge: 'head' | 'tail',
    startWorld: THREE.Vector3,
    startClient: { x: number; y: number },
  ) => {
    const cur = useStore.getState()
    if (!cur.song) return
    const note = cur.song.notes.find((n) => n.id === noteId)
    if (!note) return
    const initialTime = note.time
    const initialDuration = note.duration
    const initialEnd = initialTime + initialDuration
    const snapshot = cur.song

    // Pre-compute the nearest same-pitch obstacles. They don't change
    // during the drag because nothing else moves and overlap is
    // forbidden anyway, so caching here is safe and avoids per-frame
    // re-scanning of the whole song.
    let prevObstacleEnd = 0
    let nextObstacleStart = Number.POSITIVE_INFINITY
    for (const o of snapshot.notes) {
      if (o.id === noteId || o.midi !== note.midi) continue
      const oEnd = o.time + o.duration
      if (oEnd <= initialTime && oEnd > prevObstacleEnd) prevObstacleEnd = oEnd
      if (o.time >= initialEnd && o.time < nextObstacleStart) nextObstacleStart = o.time
    }
    const MIN_DUR = 0.02

    let pushedHistory = false
    let started = false

    const onMove = (ev: PointerEvent) => {
      if (!started) {
        const cdx = ev.clientX - startClient.x
        const cdy = ev.clientY - startClient.y
        if (cdx * cdx + cdy * cdy < 25) return
        started = true
      }
      const w = screenToWorld(ev.clientX, ev.clientY)
      if (!w) return
      const dy = w.y - startWorld.y
      const settings = useStore.getState().settings
      const fd = fallDistance(settings)
      // For 'down', +Y on screen is later in time; for 'up', +Y is older.
      const dirSign = settings.fallDirection === 'down' ? 1 : -1
      const deltaTimeOnAxis = dirSign * (dy / fd) * settings.fallDurationSec

      let newTime = initialTime
      let newDuration = initialDuration
      if (edge === 'head') {
        // Head moves; tail stays at initialEnd.
        // Lower bound: prevObstacleEnd (and >= 0).
        // Upper bound: initialEnd - MIN_DUR (so duration stays positive).
        const requested = initialTime + deltaTimeOnAxis
        const lower = Math.max(0, prevObstacleEnd)
        const upper = initialEnd - MIN_DUR
        newTime = Math.max(lower, Math.min(upper, requested))
        newDuration = initialEnd - newTime
      } else {
        // Tail moves; head stays at initialTime.
        // Upper bound: nextObstacleStart - initialTime (so the new end
        // doesn't cross into the next neighbour).
        const requested = initialDuration + deltaTimeOnAxis
        const maxDur = nextObstacleStart - initialTime
        newDuration = Math.max(MIN_DUR, Math.min(maxDur, requested))
      }

      if (newTime === initialTime && newDuration === initialDuration) return

      if (!pushedHistory) {
        useStore.getState().pushUndoSnapshot(snapshot)
        pushedHistory = true
      }

      const updated = snapshot.notes.map((n) =>
        n.id === noteId ? { ...n, time: newTime, duration: newDuration } : n,
      )
      // No resolveOverlaps — the clamp above keeps the resized note
      // inside its allowed window, so neighbour notes are never touched.
      useStore.getState().setSongPreview({ ...snapshot, notes: updated })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      // Clear the resize cursor — the next pointermove over a note will
      // decide whether to put it back.
      gl.domElement.style.cursor = ''
      hoveredEdgeRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // Hover detection. Three cursor states based on where on the note the
  // pointer is sitting:
  //   - within EDGE_PROXIMITY of top/bottom → 'ns-resize' (drag the
  //     time-extent of the note)
  //   - anywhere else inside the note rectangle → 'move' (the body
  //     drag is 2D — vertical for time, horizontal for pitch — so the
  //     four-way 'move' cursor is more honest than 'grab')
  //   - off the note → cleared by onPointerOutNote
  const onPointerMoveNote = (e: ThreeEvent<PointerEvent>) => {
    if (transport === 'playing') {
      hoveredEdgeRef.current = null
      gl.domElement.style.cursor = ''
      return
    }
    // Note planes extend below the hit line geometrically (the SDF-clip in
    // the fragment shader hides those fragments visually, but raycasts
    // still hit the geometry). Reject hits whose world-y is below the hit
    // line so clicks on the keyboard area don't grab visually-hidden
    // notes; let the event fall through for other handlers to pick up.
    if (e.point.y < noteHitYWorld(settings.keyboardY)) return
    const instId = e.instanceId
    if (instId === undefined) return
    const noteId = instanceToNoteId.current[instId]
    if (noteId === undefined || noteId < 0) return
    // Own this pointermove so EditTools' empty-area cursor handler
    // doesn't run after us and overwrite our grab/ns-resize cursor
    // with crosshair.
    e.stopPropagation()
    const state = useStore.getState()
    if (!state.song) return
    const note = state.song.notes.find((n) => n.id === noteId)
    if (!note) return
    const tl = audioEngine.currentSongTime()
    const b = noteVisualBounds(note, tl, state.settings, timeCtx)
    if (!b) {
      hoveredEdgeRef.current = null
      gl.domElement.style.cursor = ''
      return
    }

    // Map screen-edge → semantic head/tail edge based on fall direction.
    // 'down': bottom = head, top = tail. 'up': top = head, bottom = tail.
    const isDownFall = state.settings.fallDirection === 'down'
    const distTop = Math.abs(e.point.y - b.yMax)
    const distBottom = Math.abs(e.point.y - b.yMin)
    // Scale the edge-grab zone for short notes so the centre stays
    // reachable for body-drag / pitch-change. Each edge gets at most
    // 30 % of the note's visual height — guarantees the middle 40 %
    // always falls through as a body hit even for sub-EDGE_PROXIMITY
    // (≈ 16-pixel-tall) notes.
    const noteHeight = Math.max(0.001, b.yMax - b.yMin)
    const edgeReach = Math.min(EDGE_PROXIMITY, noteHeight * 0.3)
    const nearTop = distTop < edgeReach && distTop <= distBottom
    const nearBottom = distBottom < edgeReach && distBottom < distTop

    if (nearTop) {
      hoveredEdgeRef.current = { noteId, edge: isDownFall ? 'tail' : 'head' }
      gl.domElement.style.cursor = 'ns-resize'
    } else if (nearBottom) {
      hoveredEdgeRef.current = { noteId, edge: isDownFall ? 'head' : 'tail' }
      gl.domElement.style.cursor = 'ns-resize'
    } else {
      hoveredEdgeRef.current = null
      gl.domElement.style.cursor = 'move'
    }
  }

  const onPointerOutNote = () => {
    // Cursor leaves the note's hit area — clear any resize/grab state.
    // (Without this the cursor can stick on ns-resize / grab when the
    // user moves off a note quickly.)
    hoveredEdgeRef.current = null
    gl.domElement.style.cursor = ''
  }

  const onPointerDownNote = (e: ThreeEvent<PointerEvent>) => {
    // While playing, click-on-note shouldn't preempt the play/pause toggle.
    // We let the event continue past us so PlayToggleArea handles it.
    if (transport === 'playing') return
    // Skip hits whose world-y is below the hit line. The note plane
    // extends below it geometrically (clipped per-fragment in the shader),
    // so without this guard a click on the keyboard area would land on a
    // visually-hidden note. Don't stopPropagation — let the event reach
    // EditTools / Keyboard as if we missed.
    if (e.point.y < noteHitYWorld(settings.keyboardY)) return
    // In edit mode we own every click on the note plane geometry. Stop
    // propagation up-front so EditTools' empty-area clear-selection
    // handler can't fire on the same gesture even if the instance lookup
    // below bails out (e.g. instanceId race during a buffer-rebuild).
    e.stopPropagation()
    // Edit gestures require the sampler to be ready — see EditTools'
    // matching guard for the rationale (silent drag + queued-preview
    // burst on ready). Swallow this click and kick off the load so a
    // subsequent click works normally.
    if (!audioEngine.isReady()) {
      void ensureSamplerLoaded()
      return
    }
    const instId = e.instanceId
    if (instId === undefined) return
    const noteId = instanceToNoteId.current[instId]
    // Live notes (id === -1) and stale slots can't be edited.
    if (noteId === undefined || noteId < 0) return
    const state = useStore.getState()
    if (!state.song) return

    const native = e.nativeEvent

    // Middle button is reserved for camera orbit/pan
    // (see scene/CameraControls.tsx) — let it pass through.
    if (native.button === 1) return

    // Right-click → delete just this single note, even when it's part
    // of a multi-selection. Bulk deletion of the whole selection is
    // intentionally reserved for the Delete / Backspace key, so a stray
    // right-click can't wipe out a multi-note selection in one action.
    // Browser default contextmenu is suppressed by the canvas-level
    // handler in Viewport.
    if (native.button === 2) {
      const targetNote = state.song.notes.find((n) => n.id === noteId)
      const next = deleteNotes(state.song, [noteId])
      if (next !== state.song) {
        // Capture the note's visible rectangle BEFORE applying the edit
        // so the death FX can puff out from the spot the note actually
        // occupied (querying after the delete would find nothing).
        if (targetNote) {
          const tl = audioEngine.currentSongTime()
          const b = noteVisualBounds(targetNote, tl, state.settings, timeCtx)
          if (b) {
            noteDeathFx.emit({
              midi: targetNote.midi + state.settings.transpose,
              velocity: targetNote.velocity,
              x: (b.xMin + b.xMax) / 2,
              centerY: (b.yMin + b.yMax) / 2,
              width: b.xMax - b.xMin,
              length: b.yMax - b.yMin,
              track: targetNote.track,
            })
          }
        }
        state.applySongEdit(next)
        if (state.selection.has(noteId)) {
          const trimmed = new Set(state.selection)
          trimmed.delete(noteId)
          state.replaceSelection(trimmed)
        }
      }
      return
    }

    // Alt+click splits the note at the click position. The split time uses
    // the click's world Y so the cut lands exactly where the user pointed.
    if (native.altKey) {
      const splitTime = clickYToTime(
        e.point.y,
        audioEngine.currentSongTime(),
        state.settings,
        timeCtx,
      )
      const result = splitNote(state.song, noteId, splitTime)
      if (result) {
        state.applySongEdit(result.song)
        state.replaceSelection([noteId, result.tailId])
      }
      return
    }

    // Ctrl/Cmd+click toggles this note's selection without disturbing the
    // others. No drag is started — additive selection is a discrete action.
    if (native.ctrlKey || native.metaKey) {
      state.toggleSelection(noteId)
      previewSelectedNote(noteId)
      return
    }

    // Edge hover takes precedence over move-drag for plain clicks. The
    // hover state was set in onPointerMoveNote; we read it here so the
    // pointerdown that converts the hover into a gesture starts a
    // resize instead of a move. Only single-note resize for now —
    // multi-note resize is a power feature we can add later.
    const hovered = hoveredEdgeRef.current
    if (hovered && hovered.noteId === noteId) {
      if (!state.selection.has(noteId)) {
        state.replaceSelection([noteId])
      }
      beginResizeDrag(
        noteId,
        hovered.edge,
        e.point.clone(),
        { x: native.clientX, y: native.clientY },
      )
      return
    }

    // Plain click: collapse selection to this note (unless it's already
    // part of a multi-selection — preserve the group so the drag carries
    // everyone). Then arm a drag.
    if (!state.selection.has(noteId)) {
      state.replaceSelection([noteId])
    }
    previewSelectedNote(noteId)
    beginDrag(e.point.clone(), { x: native.clientX, y: native.clientY }, noteId)
  }

  // Double-click → open the per-note context menu at the cursor. The two
  // pointerdowns that precede the dblclick already select the note (via
  // the regular click handler), so by the time we open the menu the
  // selection is up to date. We still defensively replace selection here
  // in case some intermediate event (e.g. ctrl-click toggle) cleared it
  // between the first and second click.
  const onDoubleClickNote = (e: ThreeEvent<MouseEvent>) => {
    if (transport === 'playing') return
    if (e.point.y < noteHitYWorld(settings.keyboardY)) return
    e.stopPropagation()
    if (!audioEngine.isReady()) {
      void ensureSamplerLoaded()
      return
    }
    const instId = e.instanceId
    if (instId === undefined) return
    const noteId = instanceToNoteId.current[instId]
    if (noteId === undefined || noteId < 0) return
    const state = useStore.getState()
    if (!state.song) return
    if (!state.selection.has(noteId)) {
      state.replaceSelection([noteId])
    }
    state.setContextMenu({ x: e.nativeEvent.clientX, y: e.nativeEvent.clientY })
  }

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, MAX_INSTANCES]}
      frustumCulled={false}
      material={material}
      count={0}
      // Force notes to draw AFTER the hit-line bar so the note body
      // visually sits in front of the line as it falls past. Without
      // this, three.js's transparent-object sort lands the bar (z=0.14)
      // on top of the notes (z=0.1) and the bar's additive blend
      // brightens / overlays the note where they overlap.
      renderOrder={2}
      onPointerDown={onPointerDownNote}
      onPointerMove={onPointerMoveNote}
      onPointerOut={onPointerOutNote}
      onDoubleClick={onDoubleClickNote}
    >
      <planeGeometry args={[1, 1]} />
    </instancedMesh>
  )
}
