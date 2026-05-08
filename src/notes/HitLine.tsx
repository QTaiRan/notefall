import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useStore } from '../store'
import { KEYBOARD_LAYOUT, WHITE_KEY_LENGTH } from '../keyboard/layout'

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

// Straight glowing bar at the hit line. Two layers in one pass: a tight
// bright core for the laser itself, plus a soft halo that extends past
// the core so the bar reads as a glow band, not a hard line.
const BAR_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uThickness;
  uniform float uHalo;
  void main() {
    // Distance from horizontal centerline of the plane (0 at center, 1 at edge).
    float d = abs(vUv.y - 0.5) * 2.0;
    float t = max(uThickness, 0.001);
    float core = 1.0 - smoothstep(0.0, t, d);
    // Gaussian halo around the bar. Coefficient is divided by uHalo² so a
    // larger halo value = wider falloff. Clamped to avoid divide-by-zero.
    float h = max(uHalo, 0.001);
    float halo = exp(-d * d * (12.0 / (h * h)));
    float a = core + halo * 0.35;
    if (a < 0.005) discard;
    gl_FragColor = vec4(uColor * uIntensity * a, a);
  }
`

// Wavy laser — animated noise-driven curve in the plane. Same idea as the
// straight bar but the centerline is displaced per-x by an FBM noise that
// evolves over time, so it reads as a glowing organic ribbon.
const WAVE_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uAmplitude;
  uniform float uThickness;
  uniform float uWaveScale;
  uniform float uScrollSpeed;
  uniform float uMorphSpeed;
  uniform float uHalo;
  uniform float uGrain;

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
  // 3-octave FBM gives the wave both broad sway and small ripples — the
  // small ripples are what reads as a "laser flicker" when the wave moves.
  float fbm(vec2 p) {
    return vnoise(p) * 0.55
         + vnoise(p * 2.13 + 4.7) * 0.30
         + vnoise(p * 4.5 + 8.3) * 0.15;
  }

  void main() {
    // Borrowed from HitParticles' wind logic. Two independent time inputs:
    //   - scroll: translates the noise sample along X so features visibly
    //     drift across the screen. Sign convention is "what the user sees":
    //     positive uScrollSpeed = visual moves rightward, negative = left.
    //     We achieve this by SUBTRACTING the offset (a feature at fixed
    //     noise coord c sits at xs = c + uScrollSpeed*time*scale).
    //   - morph: secondary-axis evolution so the shape isn't a perfectly
    //     periodic loop even at zero scroll.
    //
    // Two stacked octaves at different spatial scales / scroll multipliers
    // give a parallax effect — broad slow wave with small fast ripples
    // riding on it, which reads as the wind+particle quality from the
    // reference image.
    float xs = vUv.x * uWaveScale;
    float scroll = uTime * uScrollSpeed;
    float morph = uTime * uMorphSpeed;
    // Layer 1 — broad slow wave (the dominant shape)
    float n1 = fbm(vec2(xs - scroll * 4.0, morph)) - 0.5;
    // Layer 2 — parallax detail riding on top of layer 1
    float n2 = (vnoise(vec2(xs * 2.4 - scroll * 7.0, morph * 1.7)) - 0.5) * 0.35;
    // Layer 3 — high-frequency tremor for grain. Scales with uGrain so at
    // 0 the curve stays smooth; at 1+ it picks up jagged sub-features that
    // read as the line being made of vibrating particles rather than a
    // clean glow stroke.
    float n3 = (vnoise(vec2(xs * 8.0 - scroll * 12.0, morph * 2.5)) - 0.5) * 0.15 * uGrain;
    float n = (n1 + n2 + n3) * 2.0;
    float curveY = 0.5 + n * uAmplitude * 0.5;

    float dist = abs(vUv.y - curveY);
    float t = max(uThickness, 0.001);
    // Sharp laser core
    float core = 1.0 - smoothstep(0.0, t, dist);
    // Soft halo — gives the laser its glow. Coefficient divided by uHalo²
    // so larger value = wider, softer halo around the wavy line.
    float h = max(uHalo, 0.001);
    float halo = exp(-dist * dist * (25.0 / (h * h)));

    // Sparkle — per-x brightness modulation. High-frequency noise sharpened
    // by a power so most sections are dim and a few are bright; the line
    // visually breaks into a stream of "particles" instead of a continuous
    // laser. Scrolls faster than the main waves to feel like grains being
    // carried by the wind. Mixed in by uGrain so at 0 the line is uniformly
    // bright (smooth-laser look).
    float sparkleX = xs * 4.0 - scroll * 10.0;
    float sparkle = pow(vnoise(vec2(sparkleX, morph * 3.0)), 2.5);
    // mix() the modulation amount in by clamped uGrain so values > 1 only
    // affect the curve tremor (n3), not the brightness range.
    float brightness = mix(1.0, 0.3 + sparkle * 1.7, clamp(uGrain, 0.0, 1.0));

    float a = (core + halo * 0.4) * brightness;
    if (a < 0.005) discard;
    gl_FragColor = vec4(uColor * uIntensity * a, a);
  }
`

// World-space heights of the two planes. Tuned so the bar is a thin glow
// band and the wave plane is tall enough to contain a wave with full-amplitude
// swing without clipping at its top/bottom edges.
const BAR_PLANE_HEIGHT = 0.12
const WAVE_PLANE_HEIGHT = 0.7
// Extra width past the keyboard so the additive glow fades at the edges
// instead of cutting off in a hard rectangle.
const PLANE_WIDTH_PAD = 0.5

/**
 * Glowing horizontal laser at the keyboard hit line. Composed of a steady
 * straight bar plus an animated wavy beam. Both run as fragment shaders on
 * a single quad each — no per-frame CPU work beyond pushing uTime.
 */
export function HitLine() {
  const settings = useStore((s) => s.settings)

  const barMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(settings.hitLineColor) },
        uIntensity: { value: settings.hitLineIntensity },
        uThickness: { value: settings.hitLineThickness },
        uHalo: { value: settings.hitLineBarHalo },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: BAR_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
    // settings deliberately excluded — uniforms mutated below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => () => barMaterial.dispose(), [barMaterial])

  const waveMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(settings.hitLineColor) },
        uIntensity: { value: settings.hitLineWaveIntensity },
        uAmplitude: { value: settings.hitLineWaveAmplitude },
        uThickness: { value: settings.hitLineWaveThickness },
        uWaveScale: { value: settings.hitLineWaveScale },
        uScrollSpeed: { value: settings.hitLineWaveScrollSpeed },
        uMorphSpeed: { value: settings.hitLineWaveMorphSpeed },
        uHalo: { value: settings.hitLineWaveHalo },
        uGrain: { value: settings.hitLineWaveGrain },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: WAVE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => () => waveMaterial.dispose(), [waveMaterial])

  useEffect(() => {
    barMaterial.uniforms.uColor.value.set(settings.hitLineColor)
    waveMaterial.uniforms.uColor.value.set(settings.hitLineColor)
  }, [barMaterial, waveMaterial, settings.hitLineColor])
  useEffect(() => {
    barMaterial.uniforms.uIntensity.value = settings.hitLineIntensity
  }, [barMaterial, settings.hitLineIntensity])
  useEffect(() => {
    barMaterial.uniforms.uThickness.value = settings.hitLineThickness
  }, [barMaterial, settings.hitLineThickness])
  useEffect(() => {
    barMaterial.uniforms.uHalo.value = settings.hitLineBarHalo
  }, [barMaterial, settings.hitLineBarHalo])
  useEffect(() => {
    waveMaterial.uniforms.uIntensity.value = settings.hitLineWaveIntensity
  }, [waveMaterial, settings.hitLineWaveIntensity])
  useEffect(() => {
    waveMaterial.uniforms.uAmplitude.value = settings.hitLineWaveAmplitude
  }, [waveMaterial, settings.hitLineWaveAmplitude])
  useEffect(() => {
    waveMaterial.uniforms.uThickness.value = settings.hitLineWaveThickness
  }, [waveMaterial, settings.hitLineWaveThickness])
  useEffect(() => {
    waveMaterial.uniforms.uWaveScale.value = settings.hitLineWaveScale
  }, [waveMaterial, settings.hitLineWaveScale])
  useEffect(() => {
    waveMaterial.uniforms.uScrollSpeed.value = settings.hitLineWaveScrollSpeed
  }, [waveMaterial, settings.hitLineWaveScrollSpeed])
  useEffect(() => {
    waveMaterial.uniforms.uMorphSpeed.value = settings.hitLineWaveMorphSpeed
  }, [waveMaterial, settings.hitLineWaveMorphSpeed])
  useEffect(() => {
    waveMaterial.uniforms.uHalo.value = settings.hitLineWaveHalo
  }, [waveMaterial, settings.hitLineWaveHalo])
  useEffect(() => {
    waveMaterial.uniforms.uGrain.value = settings.hitLineWaveGrain
  }, [waveMaterial, settings.hitLineWaveGrain])

  // Wrap uTime so the shader's noise inputs stay in float32-precise
  // territory. `performance.now()` grows unboundedly per page session,
  // and once `uTime * scrollSpeed` (and the downstream `* 4.0`, `* 12.0`
  // multipliers feeding fbm/hash21) reaches the hundreds-of-thousands
  // range, GLSL's `sin()` argument reduction loses precision — the
  // hash output collapses toward a near-constant value, which manifests
  // as the wave drifting downward (mean of `n1` no longer ≈ 0.5),
  // halo/grain dynamic range dropping, and the line becoming flat.
  // Wrapping at a long-enough period keeps the inputs bounded; the
  // discontinuity at the wrap is one-frame and falls inside the wave's
  // continuous morph so users don't perceive it as a glitch.
  const TIME_WRAP_SECONDS = 600
  useFrame(() => {
    waveMaterial.uniforms.uTime.value =
      (performance.now() / 1000) % TIME_WRAP_SECONDS
  })

  if (!settings.hitLineEnabled) return null

  const hitY = settings.keyboardY + WHITE_KEY_LENGTH
  const planeWidth = KEYBOARD_LAYOUT.totalWidth + PLANE_WIDTH_PAD

  // z = 0.14 / 0.141: in front of the 3D black keys (top z ≈ 0.09),
  // falling notes (0.1) and landing flashes (0.105) so the laser
  // visibly sits over them. Layers use additive blending so render
  // order has no visual effect, but separating their z avoids
  // depth-sort flicker if it's ever enabled.
  return (
    <>
      {/* Sit in front of the now-3D black keys (top face at
          z=BLACK_KEY_THICKNESS = 0.125). Earlier these planes were at
          0.061/0.062 — fine when every key was a flat plane at z≈0, but
          the 3D black keys would have hidden the bar/wave behind their
          tops near the back edge. */}
      <mesh position={[0, hitY + settings.hitLineBarY, 0.14]}>
        <planeGeometry args={[planeWidth, BAR_PLANE_HEIGHT]} />
        <primitive object={barMaterial} attach="material" />
      </mesh>
      {settings.hitLineWaveEnabled && (
        <mesh position={[0, hitY + settings.hitLineWaveY, 0.141]}>
          <planeGeometry args={[planeWidth, WAVE_PLANE_HEIGHT]} />
          <primitive object={waveMaterial} attach="material" />
        </mesh>
      )}
    </>
  )
}
