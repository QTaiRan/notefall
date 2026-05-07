import { useMemo, useRef, useEffect, useCallback } from "react";
import * as THREE from "three";
import * as Tone from "tone";
import { useFrame, useThree } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import {
  BLACK_KEY_LENGTH,
  BLACK_KEY_THICKNESS,
  BLACK_KEY_WIDTH,
  KEYBOARD_LAYOUT,
  KEY_COUNT,
  MIDI_MAX,
  MIDI_MIN,
  WHITE_KEY_LENGTH,
  WHITE_KEY_WIDTH,
} from "./layout";
import { useStore } from "../store";
import { audioEngine } from "../audio/engine";

// PC keyboard → MIDI mapping.
//   ZXCV row  z.../  : C3..E4 white keys
//   ASDF row  s..;   : sharps for the ZXCV row (s=C#3, ;=D#4)
//   QWERTY    q...]  : C4..G5 white keys
//   Digit row 1...=  : chromatic continuation A5..G#6 (so 2=A#5)
// Some pitches are reachable from multiple keys (e.g. q/, both = C4); that
// overlap is intentional and harmless — distinct keys trigger separate voices.
const PC_KEY_NOTES: Record<string, number> = {
  // Bottom row — bottom octave white keys
  KeyZ: 48,
  KeyX: 50,
  KeyC: 52,
  KeyV: 53,
  KeyB: 55,
  KeyN: 57,
  KeyM: 59,
  Comma: 60,
  Period: 62,
  Slash: 64,
  // Home row — sharps for the bottom octave (skip 'f' for E#, 'k' for B#)
  KeyS: 49,
  KeyD: 51,
  KeyG: 54,
  KeyH: 56,
  KeyJ: 58,
  KeyL: 61,
  Semicolon: 63,
  // Top row — top octave white keys
  KeyQ: 60,
  KeyW: 62,
  KeyE: 64,
  KeyR: 65,
  KeyT: 67,
  KeyY: 69,
  KeyU: 71,
  KeyI: 72,
  KeyO: 74,
  KeyP: 76,
  BracketLeft: 77,
  BracketRight: 79,
  // Digit row — chromatic above the top row
  Digit2: 61,
  Digit3: 63,
  Digit5: 66,
  Digit6: 68,
  Digit7: 70,
  Digit9: 73,
  Digit0: 75,
  Equal: 78,
};

// Press-down animation: keys pivot around their rear edge and the pivot
// itself dips slightly when held. Both kinds (white + black) follow the
// same model — group is positioned at the rear edge, animated via
// `group.position.z = -PIVOT_DIP × press` and `group.rotation.x = ANGLE × press`.
// PRESS_TC is the exponential smoothing time constant (smaller = snappier).
const PRESS_TC = 0.022;
// Front-tip drop at full press, in world units. The group dips by
// PIVOT_DIP plus the rotation contribution `length × sin(angle)`, and the
// angle is derived so the sum equals PRESS_DEPTH.
const WHITE_PRESS_DEPTH = 0.12;
const BLACK_PRESS_DEPTH = 0.08;
// How much the rear pivot itself drops at full press (the whole key
// translates down by this amount on top of the rotation). Without it the
// rear edge stays exactly fixed, which reads as too rigid; a small dip
// gives the whole-key "settle into the bed" feel of a real action.
const WHITE_PIVOT_DIP = 0.018;
const BLACK_PIVOT_DIP = 0.022;
// Rotation angle (radians) at full press. Because the pivot itself dips by
// PIVOT_DIP, the rotation only needs to account for the REMAINING tip
// travel — small-angle θ ≈ (depth − pivot dip) / length.
const WHITE_PRESS_ANGLE =
  (WHITE_PRESS_DEPTH - WHITE_PIVOT_DIP) / WHITE_KEY_LENGTH;
const BLACK_PRESS_ANGLE =
  (BLACK_PRESS_DEPTH - BLACK_PIVOT_DIP) / BLACK_KEY_LENGTH;

// White-key body — a wood-coloured slab below the white coating plane.
// Visible through the small inter-key gap left by the 0.96-width white
// plane on top, mimicking the wood you can see between the keys of a real
// piano. Height isn't strictly visible from the default head-on camera
// but extends enough that any future angled view shows real depth.
const WHITE_BODY_HEIGHT = 0.12;
// Hex colour for the wooden chassis. Matches the warm tan visible between
// real white keys; tweak here if a different finish (mahogany etc.) is
// preferred.
const WOOD_COLOR = "#c8a878";
// Vertical offset of the wood body's top surface below the white plane.
// Just enough to dodge z-fighting where the two planes coincide.
const WOOD_TOP_GAP = 0.001;

// Black-key front chamfer. Real piano black keys have a sloped face at
// the player-facing tip. SLOPE_ANGLE_DEG is the angle of that slope from
// horizontal — 70° produces a steep, short bevel (≈ 3.3 cm of forward
// footprint at the THICKNESS = 0.09 height). The slope only spans the
// VISIBLE portion above the white surface; below z=0 the front face is
// vertical (it disappears into the white-key body).
const BLACK_SLOPE_ANGLE_DEG = 70;
const BLACK_SLOPE_Y =
  BLACK_KEY_THICKNESS / Math.tan((BLACK_SLOPE_ANGLE_DEG * Math.PI) / 180);
// How far each black key pierces below the white-key surface, in world
// units. 0 leaves the bottom flush with z=0 (sitting on top of the white
// plane); positive values let the black-key body extend down into the
// white chassis like a real piano action where the wooden lever continues
// past the white surface line.
const BLACK_KEY_PIERCE = 0.06;
// World-unit chamfer cut on each top edge of the black-key body. Manually
// applied INWARD so the outer footprint stays exactly the same — the
// previous ExtrudeGeometry-based bevel grew the key visibly thicker with
// each unit of bevel size, even with `bevelOffset = -bevelSize`. With this
// version raising the constant only insets the corners further; it never
// expands beyond the original outline.
const BLACK_CORNER_BEVEL = 0.0006;

/**
 * Custom black-key geometry. Above the white surface (z ≥ 0) the body has
 * a flat top face inset by BLACK_CORNER_BEVEL on every side, with bevel
 * strips connecting the inset top to the un-inset side faces — that's
 * the visible "rounded corner" effect. The slope at the front and the
 * vertical piercing face below z = 0 stay full width since they're
 * either intentionally angled (slope) or hidden inside the white-key
 * chassis (piercing).
 *
 * Mesh-local coordinate convention (mesh.position.z = 0):
 *   x: lateral half-extent ±halfW
 *   y: front (−halfL) → back (+halfL)
 *   z: bottom (−PIERCE) → top (+t)
 */
function createChamferedBlackGeometry(): THREE.BufferGeometry {
  const halfW = (BLACK_KEY_WIDTH * 0.96) / 2;
  const halfL = BLACK_KEY_LENGTH / 2;
  const t = BLACK_KEY_THICKNESS;
  const sy = BLACK_SLOPE_Y;
  const p = BLACK_KEY_PIERCE;
  const b = BLACK_CORNER_BEVEL;
  // Top face inset bounds. The slope-top edge is NOT inset on the y axis
  // (it inherits its position from the slope angle), only the x axis.
  const innerW = halfW - b;
  const innerYBack = halfL - b;
  const slopeTopY = -halfL + sy;
  // Top of the chamfer skirt — the side-face top edge sits b below the
  // top face. Combined with the inset on the top face, this produces a
  // ~45° chamfer ring around the top.
  const skirtZ = t - b;

  const positions: number[] = [];
  const indices: number[] = [];
  let count = 0;
  const quad = (verts: Array<[number, number, number]>) => {
    const start = count;
    for (const v of verts) positions.push(v[0], v[1], v[2]);
    count += 4;
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  };
  const tri = (verts: Array<[number, number, number]>) => {
    const start = count;
    for (const v of verts) positions.push(v[0], v[1], v[2]);
    count += 3;
    indices.push(start, start + 1, start + 2);
  };

  // Top face (inset on left/right/back; full width on the slope-top side).
  quad([
    [-innerW, slopeTopY, t],
    [+innerW, slopeTopY, t],
    [+innerW, innerYBack, t],
    [-innerW, innerYBack, t],
  ]);

  // Bottom face (full footprint, hidden).
  quad([
    [-halfW, -halfL, -p],
    [-halfW, +halfL, -p],
    [+halfW, +halfL, -p],
    [+halfW, -halfL, -p],
  ]);

  // Slope (front face above the white surface). Goes from full-width
  // front-bottom at z=0 up to full-width slope-top at z=t — slope is
  // not chamfered (its angle is the visual feature).
  quad([
    [-halfW, -halfL, 0],
    [+halfW, -halfL, 0],
    [+halfW, slopeTopY, t],
    [-halfW, slopeTopY, t],
  ]);

  // Front-vertical face (below the white surface, hidden inside chassis).
  quad([
    [-halfW, -halfL, -p],
    [+halfW, -halfL, -p],
    [+halfW, -halfL, 0],
    [-halfW, -halfL, 0],
  ]);

  // Back side: full footprint up to the chamfer skirt at z = skirtZ.
  quad([
    [+halfW, +halfL, -p],
    [-halfW, +halfL, -p],
    [-halfW, +halfL, skirtZ],
    [+halfW, +halfL, skirtZ],
  ]);

  // Left side. Two quads: one for the piercing portion (below z=0) and
  // one for the visible upper portion (z=0 to skirtZ).
  quad([
    [-halfW, +halfL, -p],
    [-halfW, -halfL, -p],
    [-halfW, -halfL, 0],
    [-halfW, +halfL, 0],
  ]);
  quad([
    [-halfW, +halfL, 0],
    [-halfW, slopeTopY, 0],
    [-halfW, slopeTopY, skirtZ],
    [-halfW, +halfL, skirtZ],
  ]);

  // Right side (mirror of left).
  quad([
    [+halfW, -halfL, -p],
    [+halfW, +halfL, -p],
    [+halfW, +halfL, 0],
    [+halfW, -halfL, 0],
  ]);
  quad([
    [+halfW, +halfL, 0],
    [+halfW, +halfL, skirtZ],
    [+halfW, slopeTopY, skirtZ],
    [+halfW, slopeTopY, 0],
  ]);

  // ── Chamfer strips around the perimeter of the top face ──
  // Each strip joins the side-face top edge (at skirtZ) to the inset
  // top face (at z = t), producing a small ~45° cut where the corner
  // used to be sharp. The slope-top edge is not chamfered (it's already
  // at z = t and the slope itself provides the visual transition).

  // Back chamfer strip.
  quad([
    [-halfW, +halfL, skirtZ],
    [-innerW, innerYBack, t],
    [+innerW, innerYBack, t],
    [+halfW, +halfL, skirtZ],
  ]);
  // Left chamfer strip (along the visible upper-side from slope-top
  // back to the back-top corner). Vertex order chosen so the cross-product
  // normal points -X (outward from the left side); reversing them turned
  // the strip inside-out and let the camera see straight through into
  // the white-key body via backface culling.
  quad([
    [-innerW, slopeTopY, t],
    [-innerW, innerYBack, t],
    [-halfW, +halfL, skirtZ],
    [-halfW, slopeTopY, skirtZ],
  ]);
  // Right chamfer strip — mirror of left, normal points +X.
  quad([
    [+innerW, innerYBack, t],
    [+innerW, slopeTopY, t],
    [+halfW, slopeTopY, skirtZ],
    [+halfW, +halfL, skirtZ],
  ]);

  // ── Slope-side triangles ──
  // Without these the slope's left/right edges have no neighbouring face,
  // leaving the body open along the slanted slope-side and the camera can
  // see past the chamfer ring straight onto whatever sits behind the
  // black key. Each triangle closes the slanted left/right wall of the
  // slope between the slope's left/right edge, the LEFT/RIGHT side face's
  // front edge (at z=0), and the slope's top-left/right corner.
  // Left slope side — outward normal -X.
  tri([
    [-halfW, -halfL, 0],
    [-halfW, slopeTopY, t],
    [-halfW, slopeTopY, 0],
  ]);
  // Right slope side — outward normal +X.
  tri([
    [+halfW, -halfL, 0],
    [+halfW, slopeTopY, 0],
    [+halfW, slopeTopY, t],
  ]);

  // ── Slope-top corner triangles ──
  // At y=slopeTopY the slope reaches z=t at full width (±halfW), but the
  // chamfer ring's outer edge sits at z=skirtZ and the top face's front
  // edge is inset to ±innerW. These three points form a small triangle
  // in the y=slopeTopY plane that needs explicit coverage; otherwise
  // there's a gap right at the front-left/right slope-top corner.
  // Left corner — outward normal -Y (faces front).
  tri([
    [-halfW, slopeTopY, t],
    [-halfW, slopeTopY, skirtZ],
    [-innerW, slopeTopY, t],
  ]);
  // Right corner — outward normal -Y.
  tri([
    [+halfW, slopeTopY, t],
    [+innerW, slopeTopY, t],
    [+halfW, slopeTopY, skirtZ],
  ]);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

const BLACK_KEY_GEOMETRY = createChamferedBlackGeometry();
// Single shared geometry for every white key's wooden body — keys are all
// identical-sized so a per-key clone would just waste memory.
const WHITE_BODY_GEOMETRY = new THREE.BoxGeometry(
  WHITE_KEY_WIDTH,
  WHITE_KEY_LENGTH,
  WHITE_BODY_HEIGHT,
);
// The wood body's TOP face peeks through the 4 % gap left by the
// 0.96-width white plane on top. Colouring it the same wood as the sides
// made the gaps look distinctly yellow from a head-on view, so we split
// the body's materials: the visible top face is dark (matches the
// surrounding "between the keys" feel), while the sides remain wood for
// future angled views. BoxGeometry creates one group per face in the
// canonical order [+X, -X, +Y, -Y, +Z, -Z], so the +Z face is index 4.
const WHITE_BODY_TOP_COLOR = "#0a0a0a";
const WHITE_BODY_WOOD_MATERIAL = new THREE.MeshStandardMaterial({
  color: WOOD_COLOR,
  roughness: 0.85,
  metalness: 0,
});
const WHITE_BODY_TOP_MATERIAL = new THREE.MeshStandardMaterial({
  color: WHITE_BODY_TOP_COLOR,
  roughness: 0.7,
  metalness: 0,
});
const WHITE_BODY_MATERIALS: THREE.Material[] = [
  WHITE_BODY_WOOD_MATERIAL, // +X
  WHITE_BODY_WOOD_MATERIAL, // -X
  WHITE_BODY_WOOD_MATERIAL, // +Y
  WHITE_BODY_WOOD_MATERIAL, // -Y
  WHITE_BODY_TOP_MATERIAL,  // +Z (the visible top through the gap)
  WHITE_BODY_WOOD_MATERIAL, // -Z
];

// Light position used for the black-key shadow projection. Conceptually
// "where the flash burst sits in 3D" — the flash sprite is a flat 2D
// additive at the back edge, but for shadow math we treat it as a point
// light slightly above the keyboard. lightZ is tuned by eye: too low →
// shadow stretches off-screen; too high → shadow shrinks to the black key
// footprint. Y matches the flash plane (the back edge of the keyboard).
// 0.4 keeps the shadow inside the visible white surface while still
// projecting noticeably forward of the black-key footprint.
const LIGHT_Z = 0.4;
// Spatial spread of the flash's illumination as it falls on the keyboard,
// split anisotropically into horizontal and vertical so the lateral fade
// reads independently of the (always large) Y-distance from the back-edge
// light source. Implemented as `exp(-(dx²·X + dy²·Y))`.
//   X = 2.5  → half-power at |dx| ≈ 0.53 wu (~2 white keys laterally)
//   Y = 1.0  → half-power at |dy| ≈ 0.83 wu (~front-third of a white key)
// Without the X bias the front-of-key fragments all sit at dy ≈ 1, so a
// fragment 4 keys away (dx ≈ 1) read almost the same brightness as the
// fragment directly in front of the flash — horizontal attenuation got
// drowned out by the dominant vertical term.
const LIGHT_FALLOFF_X = 3.5;
const LIGHT_FALLOFF_Y = 1.0;
// Maximum brightness of a flash's additive contribution to the lit surface
// (i.e. the value at flashBrightness = 1.0). The actual strength used per
// frame is `LIGHT_BOOST × settings.flashBrightness` so the user controls
// keyboard illumination strength via the same Inspector slider that
// already lifts the flash colour toward white. At default flashBrightness
// = 0.5 this gives ~0.375 effective, which reads as a clear lit patch
// without saturating; pushing the slider to 1.0 reaches full strength.
const LIGHT_BOOST = 1.5;
// Inside-edge feather, in world units. Kept tight (~5 mm) so the silhouette
// body stays solid and the original black-key shape remains recognisable
// rather than bleeding inward. Mostly serves as sub-pixel AA on the edge.
const SHADOW_FEATHER = 0.005;
// How far the shadow's halo bleeds past the projected silhouette edge, in
// world units (~2.5 cm). Within this band the shadow's strength tapers
// smoothly to zero. Tight enough to read as "soft outline around the
// silhouette" rather than "blurry diffuse blob".
const SHADOW_HALO = 0.025;
// Coefficient on the shadow's blocking factor inside the lit-area formula
// `(1 - shadow * falloff * SHADOW_OPACITY)`. At 1.0 the shadow merely
// cancels the additive light boost; >1.0 pushes the term negative inside
// the silhouette so the surface is actively darkened beneath the
// "expected" base colour. Combined with the falloff scaling this keeps
// far-from-light shadows soft while pulling near-the-flash shadows
// notably deeper.
const SHADOW_OPACITY = 1.0;
// Maximum number of simultaneously-active flashes that contribute to the
// shader. Six covers most chord densities; a 7th held key's shadow simply
// won't render until one of the active ones decays. Per-fragment cost is
// MAX_LIGHTS × BLACK_KEY_COUNT iterations (= 6 × 36 = 216 ops here).
const MAX_LIGHTS = 6;
// How much a black key's silhouette inflates while the key itself is being
// played, in world units. Bounds expand by this × per-key glow on every
// side before the SDF / halo evaluation, so an active black key casts a
// visibly thicker (and slightly longer) shadow than its inactive
// neighbours. 0 disables the effect; 0.012 ≈ 1.2 cm extra on each side
// reads as a noticeable "press emphasis" without making the shadow
// disconnect from the silhouette.
const ACTIVE_SHADOW_GROW = -0.03;

// Static bounds of every black key in keyboard-local coords, packed flat as
// (xMin, xMax, yMin, yMax, ...) so the shader sees a single vec4[BLACK_KEY_COUNT]
// uniform. Built once at module load — black-key positions are fixed by the
// 88-key layout. BLACK_KEY_INDICES parallels this list, holding the
// KEYBOARD_LAYOUT.keys[] index of each black key so the per-frame update
// loop can sample the corresponding glow[] entry without rescanning.
const { BLACK_KEY_BOUNDS, BLACK_KEY_INDICES } = (() => {
  const flat: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < KEYBOARD_LAYOUT.keys.length; i++) {
    const k = KEYBOARD_LAYOUT.keys[i];
    if (!k.isBlack) continue;
    idx.push(i);
    flat.push(
      k.x - k.width / 2,
      k.x + k.width / 2,
      k.yLocal - k.length / 2,
      k.yLocal + k.length / 2,
    );
  }
  return {
    BLACK_KEY_BOUNDS: new Float32Array(flat),
    BLACK_KEY_INDICES: idx,
  };
})();
const BLACK_KEY_COUNT = BLACK_KEY_BOUNDS.length / 4;

type WhiteKeyUniforms = {
  uMeshOriginXY: { value: THREE.Vector2 };
  uLightZ: { value: number };
  uBlackKeyTop: { value: number };
};

type SharedLightUniforms = {
  uBlackBounds: { value: Float32Array };
  uLightXYs: { value: Float32Array };
  uLightIntensities: { value: Float32Array };
  // Master strength of the flash's spill onto the keyboard. Mirrors
  // settings.flashBrightness — same slider that lifts the flash colour
  // toward white in LandingFlashes also drives how much light reaches the
  // white-key surface. 0 = no spill (only the flash sprite itself glows).
  uLightStrength: { value: number };
  // Per-black-key glow [0..1]. Drives the active-key shadow inflation:
  // a held black key casts a visibly thicker silhouette than its idle
  // neighbours. Indexed parallel to BLACK_KEY_BOUNDS / BLACK_KEY_INDICES.
  uBlackGlow: { value: Float32Array };
  // World-unit growth applied to each black-key bound on every side per
  // unit of glow. Mirrors ACTIVE_SHADOW_GROW; passed as a uniform so a
  // future Inspector slider can drive it without recompiling.
  uActiveShadowGrow: { value: number };
};

/**
 * Patch a MeshStandardMaterial so its fragment shader simulates several
 * simultaneous flash bursts spilling light onto the white-key surface,
 * with EVERY black key on the keyboard projecting its silhouette through
 * each light to form shadows. Standard PBR lighting (ambient + directional
 * in the scene) plus the `emissive` glow channel still flow through
 * unchanged — we only ADD the per-light contribution after gl_FragColor
 * has been finalised.
 *
 * Per-fragment math:
 *   For each of the top-K active flashes:
 *     1. Anisotropic falloff = `exp(-(dx² × X + dy² × Y))`. Lateral
 *        attenuation is stronger than vertical so a fragment off to the
 *        side of the flash reads dimmer even though the back-edge light
 *        is always ≥1 wu in front of it (vertical distance dominates an
 *        isotropic 2D falloff and would hide the lateral fade).
 *     2. For each of the BLACK_KEY_COUNT black keys: reverse-project this
 *        fragment through the light onto z = uBlackKeyTop. If the projected
 *        point falls inside the black key's xy footprint, that key's
 *        silhouette blocks this fragment. `max` over all 36 keys yields
 *        the strongest occluder — soft-feathered via smoothstep across
 *        SHADOW_FEATHER world units so the edge reads as diffused.
 *     3. Effective light = falloff × (1 − shadow) × intensity. Sum across
 *        lights, then add to gl_FragColor: lit patches brighten, shadow
 *        regions stay at base colour, and the contrast reads as multiple
 *        soft black-key shadows within the spreading flash.
 */
function patchWhiteKeyMaterial(
  material: THREE.MeshStandardMaterial,
  perMesh: WhiteKeyUniforms,
  shared: SharedLightUniforms,
) {
  material.onBeforeCompile = (shader) => {
    // Per-mesh uniforms (uMeshOriginXY etc.) live on this material; the
    // shared light/black-key uniforms reference module-level Float32Arrays
    // so a single per-frame CPU update propagates to every white key.
    Object.assign(shader.uniforms, perMesh, shared);

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `
        #include <common>
        uniform vec2 uMeshOriginXY;
        varying vec2 vGroupXY;
        `,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `
        #include <begin_vertex>
        // Group-local (== keyboard-local) xy of this vertex. Mesh local
        // position is centred on the key; adding the mesh's origin lifts
        // it into the keyboard group's coordinate frame, where the
        // black-key bounds and the light positions live.
        vGroupXY = uMeshOriginXY + position.xy;
        `,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `
        #include <common>
        #define BLACK_KEY_COUNT ${BLACK_KEY_COUNT}
        #define MAX_LIGHTS ${MAX_LIGHTS}
        uniform vec4 uBlackBounds[BLACK_KEY_COUNT];
        uniform float uBlackGlow[BLACK_KEY_COUNT];
        uniform vec2 uLightXYs[MAX_LIGHTS];
        uniform float uLightIntensities[MAX_LIGHTS];
        uniform float uLightZ;
        uniform float uBlackKeyTop;
        uniform float uLightStrength;
        uniform float uActiveShadowGrow;
        varying vec2 vGroupXY;

        // Returns 1.0 deep inside the black key's projected silhouette as
        // seen from light L, with a soft halo that extends SHADOW_HALO
        // past the silhouette edge fading to 0. Built from a 2D SDF so
        // the halo wraps the silhouette uniformly (not just along the
        // closest axis).
        float keyShadowAmount(vec4 bounds, vec2 L) {
          float lz = uLightZ;
          if (lz <= uBlackKeyTop) return 0.0;
          // Reverse-project: ray from L to fragment F hits z=bh at
          // t = (bh - lz) / (fz - lz). Receiver plane is z=0.
          float t = (uBlackKeyTop - lz) / (-lz);
          vec2 hit = L + t * (vGroupXY - L);
          // Signed distance from hit to the axis-aligned box defined by
          // bounds (xMin=bounds.x, xMax=bounds.y, yMin=bounds.z, yMax=bounds.w).
          // Standard SDF: outside contribution is the euclidean distance
          // from the box; inside contribution is the negative distance to
          // the nearest edge. Net sdf < 0 inside, > 0 outside.
          vec2 q = vec2(
            max(bounds.x - hit.x, hit.x - bounds.y),
            max(bounds.z - hit.y, hit.y - bounds.w)
          );
          float outsideDist = length(max(q, vec2(0.0)));
          float insideDist = min(max(q.x, q.y), 0.0);
          float sdf = outsideDist + insideDist;
          // 1 deep inside (sdf ≤ -FEATHER), tapering through the edge,
          // and fading to 0 by SHADOW_HALO outside. Using one smoothstep
          // across the full -FEATHER..HALO range lets the silhouette body
          // and its surrounding halo share the same falloff curve, so the
          // boundary doesn't visually pop.
          return 1.0 - smoothstep(
            -${SHADOW_FEATHER.toFixed(4)},
            ${SHADOW_HALO.toFixed(4)},
            sdf
          );
        }

        // Strongest silhouette from any black key, given a light position.
        // Loop is over all 36 black keys — most return 0 because the
        // projected hit lands outside their bounds, so max() captures only
        // those whose silhouette actually covers this fragment. Per-key
        // glow inflates the bounds before SDF evaluation: an active black
        // key casts a thicker silhouette so its press reads as emphasised
        // on the keyboard without affecting idle neighbours.
        float maxShadow(vec2 L) {
          float s = 0.0;
          for (int i = 0; i < BLACK_KEY_COUNT; i++) {
            vec4 b = uBlackBounds[i];
            float grow = uActiveShadowGrow * uBlackGlow[i];
            b = vec4(b.x - grow, b.y + grow, b.z - grow, b.w + grow);
            s = max(s, keyShadowAmount(b, L));
          }
          return s;
        }
        `,
      )
      .replace(
        // three.js r157 renamed <output_fragment> → <opaque_fragment>; we
        // are on r169. Picking the wrong include name silently no-ops the
        // patch: the shader still compiles, but the shadow code never runs.
        "#include <opaque_fragment>",
        /* glsl */ `
        #include <opaque_fragment>
        if (uLightStrength > 0.001) {
          vec3 totalContribution = vec3(0.0);
          for (int li = 0; li < MAX_LIGHTS; li++) {
            float intensity = uLightIntensities[li];
            if (intensity < 0.005) continue;
            vec2 L = uLightXYs[li];
            // Anisotropic falloff: the X axis attenuates faster than Y so
            // moving sideways visibly dims the light + shadow, even though
            // Y-distance from the back-edge light source is always ≥ ~1 wu
            // for visible white-surface fragments.
            float dx = vGroupXY.x - L.x;
            float dy = vGroupXY.y - L.y;
            float falloff = exp(
              -dx * dx * ${LIGHT_FALLOFF_X.toFixed(3)}
              -dy * dy * ${LIGHT_FALLOFF_Y.toFixed(3)}
            );
            float shadow = maxShadow(L);
            // Shadow's blocking power scales with the same distance falloff
            // as the light itself, and is multiplied by SHADOW_OPACITY > 1
            // so the silhouette doesn't merely cancel the additive light —
            // it actively darkens the surface beneath. The falloff term
            // keeps far-from-light shadows soft.
            float effective = intensity * falloff * (
              1.0 - shadow * falloff * ${SHADOW_OPACITY.toFixed(3)}
            );
            totalContribution += vec3(${LIGHT_BOOST.toFixed(3)}) * uLightStrength * effective;
          }
          // Clamp positive overshoot (dense chord overlap saturating to
          // white) and negative overshoot (multiple shadows compounding to
          // pure black). Tone mapping shapes the lit side; the lower bound
          // protects against a stack of overlapping shadows pulling the
          // surface to crushed black.
          gl_FragColor.rgb += clamp(totalContribution, vec3(-0.6), vec3(2.5));
        }
        `,
      );
  };
  // Force all white keys to share a single compiled shader program even
  // though each mesh holds its own uniforms object. Without this every
  // material gets a fresh program.
  material.customProgramCacheKey = () => "white-key-shadow-multi";
}

/**
 * Flat top-down keyboard. White keys are flat planes in the XY plane;
 * black keys are short boxes that protrude in +Z, so the flash light at
 * the hit line can cast their silhouette as shadow on the adjacent white
 * surfaces (computed analytically in the white-key shader; no shadow
 * mapping). Pressing a key translates it slightly into -Z and springs
 * back.
 *
 * Pointer interaction:
 * - pointerdown on a key triggers a note (loading the sampler if needed)
 * - dragging into another key while held switches to that key (mouse + touch)
 * - releasing or cancelling the pointer stops the note
 *
 * Multi-touch is supported via pointerId tracking. Touch's implicit pointer
 * capture is released on pointerdown so drag-over reaches sibling keys.
 */
export function Keyboard() {
  const settings = useStore((s) => s.settings);
  const setLoadStatus = useStore((s) => s.setLoadStatus);
  const { gl } = useThree();

  // Hover affordance: hovering any key shows the standard "this is
  // clickable" pointer cursor. The keyboard is N adjacent meshes
  // (white + black) so a horizontal cursor sweep generates a string
  // of OUT(prev) → OVER(next) event pairs. Naively setting/clearing
  // the cursor in each handler causes a 1-frame visual flicker every
  // time the cursor crosses a black/white boundary because Out can
  // fire after Over (R3F event ordering depends on raycast results).
  // We defend with a hover counter + deferred reset:
  //   - Over: bump counter, cancel pending reset, force "pointer"
  //   - Out:  decrement counter; if it hits zero, schedule a reset on
  //           the next macrotask so an immediately-following Over from
  //           the next key can re-bump the counter without ever
  //           dropping the cursor visually.
  const hoverCountRef = useRef(0);
  const resetTimerRef = useRef<number | null>(null);
  const onKeyPointerOver = useCallback(() => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    hoverCountRef.current++;
    gl.domElement.style.cursor = "pointer";
  }, [gl]);
  const onKeyPointerOut = useCallback(() => {
    hoverCountRef.current = Math.max(0, hoverCountRef.current - 1);
    if (hoverCountRef.current === 0) {
      if (resetTimerRef.current !== null)
        window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => {
        resetTimerRef.current = null;
        if (hoverCountRef.current === 0) gl.domElement.style.cursor = "";
      }, 0);
    }
  }, [gl]);

  const glow = useMemo(() => new Float32Array(KEY_COUNT), []);
  const held = useMemo(() => new Uint8Array(KEY_COUNT), []);
  // Smoothed [0..1] press depth per key. Same shape as glow but driven by
  // held[] alone (no velocity weighting); used for the translate-down
  // animation and as a stand-in for "flash intensity nearby" when feeding
  // the white-key shadow shader.
  const press = useMemo(() => new Float32Array(KEY_COUNT), []);
  // Scratch buffer reused each frame for top-K light selection. Marks
  // which key indices have already been claimed by a higher-priority slot
  // so the next selection pass skips them. Allocated once to avoid GC
  // pressure inside useFrame.
  const claimed = useMemo(() => new Uint8Array(KEY_COUNT), []);

  const meshRefs = useRef<(THREE.Mesh | null)[]>([]);
  // Group wrapper per key — the inner mesh is offset back to its original
  // position relative to the group, and the group sits at the key's rear
  // pivot point. Animating `group.rotation.x` tilts the tip down (real
  // grand-piano action) and `group.position.z` lets the whole key dip
  // slightly so even the rear isn't perfectly stationary.
  const keyGroupRefs = useRef<(THREE.Group | null)[]>([]);
  const matRefs = useRef<(THREE.MeshStandardMaterial | null)[]>([]);

  // Per-white-key uniforms — only the mesh origin varies per key. The
  // black-key bounds + light state are shared across all white keys (see
  // sharedLightUniforms below).
  const whiteKeyUniforms = useMemo(() => {
    const arr: (WhiteKeyUniforms | null)[] = new Array(KEY_COUNT).fill(null);
    for (let i = 0; i < KEY_COUNT; i++) {
      const k = KEYBOARD_LAYOUT.keys[i];
      if (k.isBlack) continue;
      arr[i] = {
        uMeshOriginXY: { value: new THREE.Vector2(k.x, k.yLocal) },
        uLightZ: { value: LIGHT_Z },
        uBlackKeyTop: { value: BLACK_KEY_THICKNESS },
      };
    }
    return arr;
  }, []);

  // Light state shared across every white-key material. Updating these
  // Float32Arrays in-place during useFrame propagates to all 52 materials
  // via the {value: ...} reference each material's uniforms object holds.
  const sharedLightUniforms = useMemo<SharedLightUniforms>(
    () => ({
      uBlackBounds: { value: BLACK_KEY_BOUNDS },
      uLightXYs: { value: new Float32Array(MAX_LIGHTS * 2) },
      uLightIntensities: { value: new Float32Array(MAX_LIGHTS) },
      uLightStrength: { value: 0 },
      uBlackGlow: { value: new Float32Array(BLACK_KEY_COUNT) },
      uActiveShadowGrow: { value: ACTIVE_SHADOW_GROW },
    }),
    [],
  );

  // Per-white-key MeshStandardMaterial instances with the shadow patch.
  // Black keys keep a single shared default material (created lazily in
  // the JSX since they don't need patching).
  const whiteKeyMaterials = useMemo(() => {
    const arr: (THREE.MeshStandardMaterial | null)[] = new Array(
      KEY_COUNT,
    ).fill(null);
    for (let i = 0; i < KEY_COUNT; i++) {
      const k = KEYBOARD_LAYOUT.keys[i];
      if (k.isBlack) continue;
      const u = whiteKeyUniforms[i];
      if (!u) continue;
      const mat = new THREE.MeshStandardMaterial({
        color: settings.whiteKeyColor,
        roughness: 0.55,
        metalness: 0.05,
      });
      patchWhiteKeyMaterial(mat, u, sharedLightUniforms);
      arr[i] = mat;
    }
    return arr;
    // Initial colour comes from settings; later updates flow through the
    // useFrame loop's color.set() call. eslint-disable so adding settings
    // to deps doesn't recreate every material on every settings change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whiteKeyUniforms, sharedLightUniforms]);

  useEffect(
    () => () => {
      for (const m of whiteKeyMaterials) m?.dispose();
    },
    [whiteKeyMaterials],
  );

  // Mirror the imperatively-created white-key materials into matRefs[] so
  // the per-frame color / emissive update loop reaches them just like the
  // declarative <meshStandardMaterial ref={...}> path used for black keys.
  useEffect(() => {
    for (let i = 0; i < KEY_COUNT; i++) {
      const m = whiteKeyMaterials[i];
      if (m) matRefs.current[i] = m;
    }
  }, [whiteKeyMaterials]);

  // pointerId → currently-playing note for that pointer
  const activePointers = useRef<
    Map<number, { midi: number; release: () => void }>
  >(new Map());
  // pointerId → midi the user wants to play once async audio init resolves
  // (cleared on pointerup, so releases during loading don't leak a stuck note)
  const pendingMidi = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    // held[] is a reference count of active voices on each pitch, not a flag.
    // When the same midi is retriggered (note A's off and note B's on may
    // arrive in either order within a tick), set/clear semantics would lose
    // the new note's "down" state. Counting handles overlap correctly.
    const off = audioEngine.addKeyListener((ev) => {
      const idx = ev.midi - MIDI_MIN;
      if (idx < 0 || idx >= KEY_COUNT) return;
      if (ev.type === "on") {
        glow[idx] = Math.max(glow[idx], 0.5 + ev.velocity * 0.6);
        held[idx]++;
      } else {
        held[idx] = Math.max(0, held[idx] - 1);
      }
    });
    return off;
  }, [glow, held]);

  // Window-level release so dragging off the canvas still stops the note.
  useEffect(() => {
    const onUp = (e: PointerEvent) => {
      const id = e.pointerId;
      const entry = activePointers.current.get(id);
      if (entry) {
        entry.release();
        activePointers.current.delete(id);
      }
      pendingMidi.current.delete(id);
    };
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  const ensureAudio = useCallback(async () => {
    if (audioEngine.isReady()) return true;
    const status = useStore.getState().loadStatus;
    if (status.state === "loading") {
      // wait for the in-flight load to settle
      while (useStore.getState().loadStatus.state === "loading") {
        await new Promise((r) => setTimeout(r, 50));
      }
      return audioEngine.isReady();
    }
    setLoadStatus({ state: "loading", loaded: 0, total: 1 });
    try {
      await audioEngine.init((p) =>
        setLoadStatus({ state: "loading", loaded: p.loaded, total: p.total }),
      );
      setLoadStatus({ state: "ready" });
      return true;
    } catch {
      setLoadStatus({ state: "idle" });
      return false;
    }
  }, [setLoadStatus]);

  const triggerForPointer = useCallback((pointerId: number, midi: number) => {
    const prev = activePointers.current.get(pointerId);
    if (prev) {
      if (prev.midi === midi) return; // same key, no retrigger
      prev.release();
      activePointers.current.delete(pointerId);
    }
    const handle = audioEngine.triggerKey(midi, 0.78);
    if (!handle) return;
    activePointers.current.set(pointerId, { midi, release: handle.release });
  }, []);

  const onPointerDown = useCallback(
    async (e: ThreeEvent<PointerEvent>, midi: number) => {
      e.stopPropagation();
      const id = e.pointerId;

      // Release implicit pointer capture (set automatically for touch) so
      // pointerEnter on sibling keys fires while dragging.
      const target = e.nativeEvent.target as Element | null;
      if (
        target &&
        typeof target.hasPointerCapture === "function" &&
        target.hasPointerCapture(id)
      ) {
        try {
          target.releasePointerCapture(id);
        } catch {
          /* ignored */
        }
      }

      // Unlock the AudioContext within the user gesture
      if (Tone.getContext().state !== "running") {
        try {
          await Tone.start();
        } catch {
          /* ignored */
        }
      }

      if (audioEngine.isReady()) {
        triggerForPointer(id, midi);
        return;
      }

      // Audio not ready — record this pointer's intent and await loading.
      // pointerEnter may update the desired midi during the wait; pointerup
      // will clear the entry, in which case we trigger nothing.
      pendingMidi.current.set(id, midi);
      const ready = await ensureAudio();
      if (!pendingMidi.current.has(id)) return; // released during loading
      const targetMidi = pendingMidi.current.get(id)!;
      pendingMidi.current.delete(id);
      if (!ready) return;
      triggerForPointer(id, targetMidi);
    },
    [ensureAudio, triggerForPointer],
  );

  const onPointerEnter = useCallback(
    (e: ThreeEvent<PointerEvent>, midi: number) => {
      const id = e.pointerId;
      // While loading, just remember which key the pointer is currently over.
      if (pendingMidi.current.has(id)) {
        pendingMidi.current.set(id, midi);
        return;
      }
      // Otherwise, if the pointer already has an active note, switch keys (slide).
      if (activePointers.current.has(id)) {
        triggerForPointer(id, midi);
      }
    },
    [triggerForPointer],
  );

  // PC keyboard input. Same lifecycle as touch: hold to sustain, release to stop,
  // and a key pressed during sample loading is honoured (or cancelled) once ready.
  useEffect(() => {
    const pressed = new Map<string, () => void>();
    const pending = new Set<string>();

    const isEditable = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el.isContentEditable
      );
    };

    const onDown = async (e: KeyboardEvent) => {
      // Shift is reserved for global shortcuts (e.g. Shift+R for record),
      // so PC-keyboard piano input ignores it to avoid double-firing the
      // mapped note on top of the shortcut.
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (isEditable(e.target)) return;
      const baseMidi = PC_KEY_NOTES[e.code];
      if (baseMidi === undefined) return;
      e.preventDefault();
      if (pressed.has(e.code) || pending.has(e.code)) return;

      // Apply the global transpose to the PC keyboard input so it matches
      // the song / external-MIDI behaviour. Out-of-range notes are silently
      // dropped (same convention as midiInput.ts).
      const transpose = useStore.getState().settings.transpose;
      const midi = baseMidi + transpose;
      if (midi < 0 || midi > 127) return;

      if (Tone.getContext().state !== "running") {
        try {
          await Tone.start();
        } catch {
          /* ignored */
        }
      }

      if (audioEngine.isReady()) {
        const handle = audioEngine.triggerKey(midi, 0.78);
        if (handle) pressed.set(e.code, handle.release);
        return;
      }

      pending.add(e.code);
      const ready = await ensureAudio();
      if (!pending.has(e.code)) return; // released during loading
      pending.delete(e.code);
      if (!ready) return;
      const handle = audioEngine.triggerKey(midi, 0.78);
      if (handle) pressed.set(e.code, handle.release);
    };

    const onUp = (e: KeyboardEvent) => {
      const release = pressed.get(e.code);
      if (release) {
        release();
        pressed.delete(e.code);
      }
      pending.delete(e.code);
    };

    const releaseAll = () => {
      for (const r of pressed.values()) r();
      pressed.clear();
      pending.clear();
    };

    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    // window blur / tab switch: drop everything so keys don't get stuck
    window.addEventListener("blur", releaseAll);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", releaseAll);
      releaseAll();
    };
  }, [ensureAudio]);

  useFrame((_, delta) => {
    const brightness = settings.keyboardBrightness;
    const pressK = 1 - Math.exp(-delta / Math.max(0.005, PRESS_TC));
    for (let i = 0; i < KEY_COUNT; i++) {
      const decay = settings.keyGlowDecay;
      const target = held[i] ? Math.max(glow[i], 0.6) : 0;
      const k1 = 1 - Math.exp(-delta / Math.max(0.01, decay));
      glow[i] += (target - glow[i]) * k1;

      // Press depth: 1 while held, 0 otherwise, exponentially smoothed so
      // the press has a subtle ease-in/ease-out instead of snapping.
      const pressTarget = held[i] ? 1 : 0;
      press[i] += (pressTarget - press[i]) * pressK;

      const mat = matRefs.current[i];
      const k = KEYBOARD_LAYOUT.keys[i];
      // Both white and black keys pivot around their rear edge AND the
      // pivot itself dips slightly. Rotation tilts the tip; translation
      // lets the whole key settle into the keyboard bed.
      const group = keyGroupRefs.current[i];
      if (group) {
        const pivotDip = k.isBlack ? BLACK_PIVOT_DIP : WHITE_PIVOT_DIP;
        const angle = k.isBlack ? BLACK_PRESS_ANGLE : WHITE_PRESS_ANGLE;
        group.position.z = -pivotDip * press[i];
        group.rotation.x = angle * press[i];
      }
      if (!mat) continue;

      const baseColor = k.isBlack
        ? settings.blackKeyColor
        : settings.whiteKeyColor;
      mat.color.set(baseColor).multiplyScalar(brightness);
      const e = glow[i];
      if (e > 0.001 && settings.keyGlowEnabled) {
        // Glow color either follows the note color (default — keeps the
        // keyboard's press highlight in sync with the falling notes) or uses
        // a user-chosen colour.
        mat.emissive.set(
          settings.keyGlowFollowNote
            ? settings.noteColor
            : settings.keyGlowColor,
        );
        // brightness also scales the glow so darkening the keyboard dims its emission too
        mat.emissiveIntensity = e * settings.keyGlowIntensity * brightness;
      } else {
        mat.emissiveIntensity = 0;
      }
    }

    // Top-K active flashes drive the shared light uniforms. Each light
    // illuminates a wide patch of the keyboard (LIGHT_FALLOFF) and casts
    // shadows from every black key on the board (looped in the shader),
    // so a chord lights multiple regions and produces overlapping black
    // silhouettes instead of just the immediate-neighbour shadow.
    const lightXYs = sharedLightUniforms.uLightXYs.value;
    const lightIntensities = sharedLightUniforms.uLightIntensities.value;
    const blackGlow = sharedLightUniforms.uBlackGlow.value;
    // flashBrightness drives both the flash sprite's white-tint AND the
    // amount of light that spills onto the keyboard. Zero = no spill, the
    // shader's lit/shadow contribution is skipped entirely.
    sharedLightUniforms.uLightStrength.value = settings.flashEnabled
      ? settings.flashBrightness
      : 0;
    // Per-black-key glow. Drives the active-key shadow inflation in the
    // shader so a held black key casts a thicker silhouette while pressed,
    // shrinking back as glow decays. Sampled directly off glow[] (already
    // smoothed by keyGlowDecay above).
    for (let bk = 0; bk < BLACK_KEY_COUNT; bk++) {
      blackGlow[bk] = Math.min(1, glow[BLACK_KEY_INDICES[bk]]);
    }
    if (settings.flashEnabled) {
      claimed.fill(0);
      // K passes of selection sort. K = MAX_LIGHTS = 6, N = 88 → 528
      // comparisons per frame. Allocation-free.
      for (let slot = 0; slot < MAX_LIGHTS; slot++) {
        let bestI = -1;
        let bestVal = 0.005;
        for (let i = 0; i < KEY_COUNT; i++) {
          if (claimed[i]) continue;
          const v = glow[i];
          if (v > bestVal) {
            bestVal = v;
            bestI = i;
          }
        }
        if (bestI < 0) {
          // No more eligible keys — clear remaining slots and stop.
          for (let s = slot; s < MAX_LIGHTS; s++) lightIntensities[s] = 0;
          break;
        }
        claimed[bestI] = 1;
        lightIntensities[slot] = Math.min(1, bestVal);
        lightXYs[slot * 2] = KEYBOARD_LAYOUT.keys[bestI].x;
        lightXYs[slot * 2 + 1] = WHITE_KEY_LENGTH;
      }
    } else {
      for (let slot = 0; slot < MAX_LIGHTS; slot++) {
        lightIntensities[slot] = 0;
      }
    }
  });

  // X positions of the B→C octave boundaries (right edge of each B key).
  const octaveDividerXs = useMemo(() => {
    const xs: number[] = [];
    for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
      // pitch class 11 = B
      if (((midi % 12) + 12) % 12 !== 11) continue;
      const k = KEYBOARD_LAYOUT.keys[midi - MIDI_MIN];
      xs.push(k.x + WHITE_KEY_WIDTH / 2);
    }
    return xs;
  }, []);

  // Length of each divider: from the back edge of the keyboard up to the top
  // of the visible camera frustum (matches the FallingNotes spawn region).
  const camDistance = Math.abs(settings.cameraPos[2]);
  const halfVisHeight =
    camDistance * Math.tan((settings.cameraFov * Math.PI) / 360);
  const visibleTopWorld = settings.cameraLookAt[1] + halfVisHeight;
  const dividerLength = Math.max(
    0,
    visibleTopWorld - (settings.keyboardY + WHITE_KEY_LENGTH),
  );

  return (
    <group position={[0, settings.keyboardY, 0]}>
      {KEYBOARD_LAYOUT.keys.map((k, i) => {
        const isBlack = k.isBlack;
        const customMat = whiteKeyMaterials[i];
        // Both kinds wrap in a group anchored at the rear pivot (back
        // edge of the key's footprint on the white-surface plane). The
        // inner mesh is offset so its centre lands at the original
        // (k.x, k.yLocal, k.zCenter) when the group sits at rotation = 0
        // and position.z = 0. Press animation drives the group's
        // position.z + rotation.x so the tip tilts down and the whole
        // key settles slightly into the bed.
        return (
          <group
            key={k.midi}
            ref={(g) => (keyGroupRefs.current[i] = g)}
            position={[k.x, k.yLocal + k.length / 2, 0]}
          >
            <mesh
              ref={(m) => (meshRefs.current[i] = m)}
              // Black keys use the new chamfered+pierced geometry whose
              // vertices already encode the full z-extent (bottom below
              // the white surface, top above), so its mesh.position.z = 0.
              // White keys keep their original plane offset.
              position={[0, -k.length / 2, isBlack ? 0 : k.zCenter]}
              onPointerDown={(e) => onPointerDown(e, k.midi)}
              onPointerEnter={(e) => onPointerEnter(e, k.midi)}
              onPointerOver={onKeyPointerOver}
              onPointerOut={onKeyPointerOut}
              // White keys carry the imperatively-built MeshStandardMaterial
              // (with the shadow-projection onBeforeCompile patch). Black
              // keys declare their material as a child below.
              material={isBlack ? undefined : (customMat ?? undefined)}
              // Black keys use the shared chamfered geometry built once at
              // module load (not declared as a child element).
              geometry={isBlack ? BLACK_KEY_GEOMETRY : undefined}
            >
              {!isBlack && (
                <planeGeometry args={[k.width * 0.96, k.length]} />
              )}
              {isBlack && (
                <meshStandardMaterial
                  ref={(mat) => (matRefs.current[i] = mat)}
                  color={settings.blackKeyColor}
                  roughness={0.4}
                  metalness={0.05}
                />
              )}
            </mesh>
            {/* Wood-coloured chassis under each white key. Visible through
                the small gap left by the 0.96-width white plane on top,
                mimicking the wood you can see between real keys. Lives
                inside the same group so it pivots and dips with the press
                animation as one unit. */}
            {!isBlack && (
              <mesh
                position={[
                  0,
                  -k.length / 2,
                  -WHITE_BODY_HEIGHT / 2 - WOOD_TOP_GAP,
                ]}
                geometry={WHITE_BODY_GEOMETRY}
                // Top face is dark so the 4 % gap reads as black-between-
                // the-keys rather than a yellow stripe; sides stay wood
                // for any oblique camera angle.
                material={WHITE_BODY_MATERIALS}
              />
            )}
          </group>
        );
      })}
      {dividerLength > 0 &&
        octaveDividerXs.map((x, i) => (
          <mesh
            key={`octave-divider-${i}`}
            position={[x, WHITE_KEY_LENGTH + dividerLength / 2, 0.02]}
          >
            <planeGeometry args={[0.008, dividerLength]} />
            <meshBasicMaterial
              color="#3a3a3a"
              transparent
              opacity={0.45}
              toneMapped={false}
              depthWrite={false}
            />
          </mesh>
        ))}
    </group>
  );
}
