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

// PC keyboard → MIDI mapping. ZXCV/ASDF rows = lower octave (white/sharps),
// QWERTY/digit rows = upper octave. Some pitches reachable from multiple
// keys (e.g. q/, both = C4); distinct keys trigger separate voices.
const PC_KEY_NOTES: Record<string, number> = {
  KeyZ: 48, KeyX: 50, KeyC: 52, KeyV: 53, KeyB: 55, KeyN: 57, KeyM: 59,
  Comma: 60, Period: 62, Slash: 64,
  KeyS: 49, KeyD: 51, KeyG: 54, KeyH: 56, KeyJ: 58, KeyL: 61, Semicolon: 63,
  KeyQ: 60, KeyW: 62, KeyE: 64, KeyR: 65, KeyT: 67, KeyY: 69, KeyU: 71,
  KeyI: 72, KeyO: 74, KeyP: 76, BracketLeft: 77, BracketRight: 79,
  Digit2: 61, Digit3: 63, Digit5: 66, Digit6: 68, Digit7: 70, Digit9: 73,
  Digit0: 75, Equal: 78,
};

// Press animation: each key's group sits at the rear edge; press dips
// `position.z = -PIVOT_DIP × p` and tilts `rotation.x = ANGLE × p`.
// PIVOT_DIP gives the whole key a "settle" without which the rear reads
// as rigidly fixed. ANGLE is derived so total front-tip drop = PRESS_DEPTH.
const PRESS_TC = 0.022;
const WHITE_PRESS_DEPTH = 0.12;
const BLACK_PRESS_DEPTH = 0.08;
const WHITE_PIVOT_DIP = 0.018;
const BLACK_PIVOT_DIP = 0.022;
const WHITE_PRESS_ANGLE =
  (WHITE_PRESS_DEPTH - WHITE_PIVOT_DIP) / WHITE_KEY_LENGTH;
const BLACK_PRESS_ANGLE =
  (BLACK_PRESS_DEPTH - BLACK_PIVOT_DIP) / BLACK_KEY_LENGTH;

// Wood chassis below the white cap, visible through the 4% inter-key gap.
const WHITE_BODY_HEIGHT = 0.12;
const WOOD_COLOR = "#c8a878";
const WOOD_TOP_GAP = 0.001;
const WHITE_CAP_THICKNESS = 0.01;
const WHITE_CAP_CORNER_RADIUS = 0.025;

// Black-key slope angle from horizontal — 60° gives a slightly more
// gradual player-facing bevel than the textbook 70°.
const BLACK_SLOPE_ANGLE_DEG = 60;
const BLACK_SLOPE_Y =
  BLACK_KEY_THICKNESS / Math.tan((BLACK_SLOPE_ANGLE_DEG * Math.PI) / 180);
const BLACK_KEY_PIERCE = 0.06;
// Top-face inset and fillet radius (in cross-section). The slope ends at
// `t - INSET` and a quarter-circle fillet ring of this radius wraps the
// remaining height up to z = t. Hard upper bound: `(BLACK_KEY_WIDTH *
// 0.96) / 2 ≈ 0.066` — above that the top has negative half-width.
const BLACK_TOP_INSET = 0.02;
// Top-face back-corner radius. Must be ≤ (halfW - INSET).
const BLACK_TOP_CORNER_R = 0.012;
// Top-face front-corner radius. The two corners where slope meets top use
// this larger value, so those ends read as visibly rounded and the straight
// portion of the front edge is correspondingly shorter than the key width.
// Must be ≤ (halfW - INSET) ≈ 0.046.
const BLACK_FRONT_TOP_CORNER_R = 0.03;
// Fillet curve smoothness. 1 = single-segment chamfer (angular); ≥4 reads
// as a smooth round-over.
const BLACK_FILLET_SEGMENTS = 4;
// Slope profile tessellation: the slope's yz cross-section is a quarter
// ellipse (vertical tangent at z=0 so it joins the front-vertical face
// smoothly, horizontal tangent at z=skirtZ so it rolls into the top
// fillet). 8 strips read as a clean curve.
const BLACK_SLOPE_PROFILE_SEGMENTS = 8;
const BLACK_INNER_FILL_INSET = 0.001;

// Derived dims, hoisted so JSX (gray marker line) can reuse them without
// re-deriving from BLACK_SLOPE_Y etc.
const BLACK_HALF_W = (BLACK_KEY_WIDTH * 0.96) / 2;
const BLACK_HALF_L = BLACK_KEY_LENGTH / 2;
const BLACK_SKIRT_Z = BLACK_KEY_THICKNESS - BLACK_TOP_INSET;
const BLACK_SLOPE_END_Y =
  -BLACK_HALF_L + BLACK_SLOPE_Y * (BLACK_SKIRT_Z / BLACK_KEY_THICKNESS);
const BLACK_TOP_FRONT_Y = BLACK_SLOPE_END_Y + BLACK_TOP_INSET;
const BLACK_TOP_HALF_W = BLACK_HALF_W - BLACK_TOP_INSET;

/**
 * Black-key geometry — body up to z=skirtZ (slope at front, rectangular
 * back/sides), then a quarter-circle FILLET RING wraps the perimeter from
 * z=skirtZ to z=t. The top face at z=t is a rounded rectangle inset by
 * BLACK_TOP_INSET on all 4 sides with corner radius BLACK_TOP_CORNER_R.
 *
 * The slope ends at z=skirtZ instead of z=t (so it doesn't protrude past
 * the inset top). The fillet's outer outline at z=skirtZ matches the
 * body's outer outline; its inner outline at z=t matches the rectangular
 * portion of the top face's outline. Small flat corner-fans (in z=t plane)
 * fill the gap between the rectangular fillet end and the top face's
 * rounded corner arcs.
 *
 * An inner solid fill backs the body so every sub-pixel seam resolves to
 * black instead of revealing the white-key cap.
 *
 * Mesh-local: x ∈ ±halfW, y ∈ [-halfL, +halfL] (front → back),
 * z ∈ [-PIERCE, t]. PIERCE region hidden inside the white-key chassis.
 */
function createChamferedBlackGeometry(): THREE.BufferGeometry {
  const halfW = BLACK_HALF_W;
  const halfL = BLACK_HALF_L;
  const t = BLACK_KEY_THICKNESS;
  const sy = BLACK_SLOPE_Y;
  const p = BLACK_KEY_PIERCE;
  const b = BLACK_TOP_INSET;
  const Rb = BLACK_TOP_CORNER_R;
  const Rf = BLACK_FRONT_TOP_CORNER_R;
  const N = BLACK_FILLET_SEGMENTS;
  const skirtZ = BLACK_SKIRT_Z;

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

  // ── Body below the fillet (z ∈ [-PIERCE, skirtZ]) ─────────────────────
  // Bottom + front-vertical (hidden behind the white-key chassis).
  quad([
    [-halfW, -halfL, -p],
    [-halfW, +halfL, -p],
    [+halfW, +halfL, -p],
    [+halfW, -halfL, -p],
  ]);
  quad([
    [-halfW, -halfL, -p],
    [+halfW, -halfL, -p],
    [+halfW, -halfL, 0],
    [-halfW, -halfL, 0],
  ]);
  // Slope (front-facing rolled chamfer) — emits as material group 1 so it
  // can be rendered with a slightly brighter color than the rest of the
  // body. The yz cross-section is a quarter ellipse from (y=-halfL, z=0)
  // with vertical tangent (joining the front-vertical face below) to
  // (y=topFrontY, z=t) with horizontal tangent (joining the top face
  // smoothly). The slope replaces both the original flat slope AND the
  // front strip of the fillet ring — they unify into one continuous curve.
  // hRad and vRad are the ellipse semi-axes.
  // Includes side caps at x=±halfW (fans from the back-bottom apex
  // (topFrontY, 0) along the slope's curve) so the whole front rounded
  // chamfer reads as one tonal region.
  const M = BLACK_SLOPE_PROFILE_SEGMENTS;
  const topFrontY = BLACK_TOP_FRONT_Y;
  const hRad = topFrontY + halfL;
  const vRad = t;
  // Width taper: x narrows for z ∈ [skirtZ, t] so the slope's outline at
  // each z matches the fillet ring's inset (= b - sqrt(b² - (z-skirtZ)²),
  // which is the fillet's inset(θ) inverted onto z). For z ≤ skirtZ the
  // slope is at full body width; tapering kicks in only above skirtZ. The
  // formulas agree at z=skirtZ (both 0) and z=t (both b), and the slope's
  // tapered edge ends up coincident with the fillet ring's outer-front
  // edge — so the slope and fillet share an edge instead of leaving a
  // hole at the front-side corners.
  const slopeTaperX = (z: number): number => {
    if (z <= skirtZ) return 0;
    const dz = z - skirtZ;
    if (dz >= b) return b;
    return b - Math.sqrt(b * b - dz * dz);
  };
  // Slope's y as a function of z (inverse of the curve parametrization).
  // Used by the side caps + body's left/right walls + fillet ring's
  // left/right strips so they all share the slope's curve at z=z(θ).
  const slopeYAtZ = (z: number): number => {
    const sinS = Math.min(1, Math.max(0, z / vRad));
    const cosS = Math.sqrt(Math.max(0, 1 - sinS * sinS));
    return topFrontY - hRad * cosS;
  };
  // s value where z = skirtZ on the slope's quarter-ellipse curve. Used
  // by the side caps (which only need to span z ∈ [0, skirtZ]) and by the
  // body's left/right above-z=0 walls.
  const sSkirt = Math.asin(Math.min(1, skirtZ / vRad));
  const slopeIdxStart = indices.length;
  for (let m = 0; m < M; m++) {
    const s0 = (m / M) * (Math.PI / 2);
    const s1 = ((m + 1) / M) * (Math.PI / 2);
    const y0 = topFrontY - hRad * Math.cos(s0);
    const z0 = vRad * Math.sin(s0);
    const y1 = topFrontY - hRad * Math.cos(s1);
    const z1 = vRad * Math.sin(s1);
    const tx0 = slopeTaperX(z0);
    const tx1 = slopeTaperX(z1);
    quad([
      [-halfW + tx0, y0, z0],
      [+halfW - tx0, y0, z0],
      [+halfW - tx1, y1, z1],
      [-halfW + tx1, y1, z1],
    ]);
  }
  // Side caps at x=±halfW: only the lower portion of the slope curve where
  // the slope is at full width (z ∈ [0, skirtZ]; above this the slope tapers
  // and shares an edge with the fillet ring instead). Apex at the back-y
  // of the curve at z=skirtZ so the fan closes naturally.
  const sideApexY = slopeYAtZ(skirtZ);
  const apexL: [number, number, number] = [-halfW, sideApexY, 0];
  const apexR: [number, number, number] = [+halfW, sideApexY, 0];
  for (let m = 0; m < M; m++) {
    const s0 = (m / M) * sSkirt;
    const s1 = ((m + 1) / M) * sSkirt;
    const y0 = topFrontY - hRad * Math.cos(s0);
    const z0 = vRad * Math.sin(s0);
    const y1 = topFrontY - hRad * Math.cos(s1);
    const z1 = vRad * Math.sin(s1);
    tri([apexL, [-halfW, y0, z0], [-halfW, y1, z1]]);
    tri([apexR, [+halfW, y1, z1], [+halfW, y0, z0]]);
  }
  const slopeIdxEnd = indices.length;
  // Back face.
  quad([
    [+halfW, +halfL, -p],
    [-halfW, +halfL, -p],
    [-halfW, +halfL, skirtZ],
    [+halfW, +halfL, skirtZ],
  ]);
  // Left side: piercing portion (z<0) + above-z=0 polygon. The above-z=0
  // polygon's front edge follows the slope's curve (in yz at x=-halfW)
  // from (y=-halfL, z=0) to (y=slopeYAtZ(skirtZ), z=skirtZ); fan from
  // the front-bottom apex.
  quad([
    [-halfW, +halfL, -p],
    [-halfW, -halfL, -p],
    [-halfW, -halfL, 0],
    [-halfW, +halfL, 0],
  ]);
  const M_WALL = 6;
  const wallApexL: [number, number, number] = [-halfW, -halfL, 0];
  // Back rectangle (apex → back-bottom → back-top).
  tri([wallApexL, [-halfW, +halfL, 0], [-halfW, +halfL, skirtZ]]);
  // Top edge to curve top.
  tri([
    wallApexL,
    [-halfW, +halfL, skirtZ],
    [-halfW, slopeYAtZ(skirtZ), skirtZ],
  ]);
  // Fan along the slope's curve from sSkirt down toward apex (s=0). m=0
  // would be degenerate (curve at s=0 IS the apex), so iterate down to m=1.
  for (let m = M_WALL - 1; m >= 1; m--) {
    const s0 = (m / M_WALL) * sSkirt;
    const s1 = ((m + 1) / M_WALL) * sSkirt;
    const y0 = topFrontY - hRad * Math.cos(s0);
    const z0 = vRad * Math.sin(s0);
    const y1 = topFrontY - hRad * Math.cos(s1);
    const z1 = vRad * Math.sin(s1);
    tri([wallApexL, [-halfW, y1, z1], [-halfW, y0, z0]]);
  }
  // Right side: piercing + above-z=0 polygon. Apex at the back-bottom
  // corner (mirrors original quad's apex choice).
  quad([
    [+halfW, -halfL, -p],
    [+halfW, +halfL, -p],
    [+halfW, +halfL, 0],
    [+halfW, -halfL, 0],
  ]);
  const wallApexR: [number, number, number] = [+halfW, +halfL, 0];
  // Bottom edge from apex toward front-bottom, then up the curve.
  // m=0 segment: apex → (-halfL, 0) → curve(s_1).
  for (let m = 0; m < M_WALL; m++) {
    const s0 = (m / M_WALL) * sSkirt;
    const s1 = ((m + 1) / M_WALL) * sSkirt;
    const y0 = topFrontY - hRad * Math.cos(s0);
    const z0 = vRad * Math.sin(s0);
    const y1 = topFrontY - hRad * Math.cos(s1);
    const z1 = vRad * Math.sin(s1);
    tri([wallApexR, [+halfW, y0, z0], [+halfW, y1, z1]]);
  }
  // Curve-top → back-top.
  tri([
    wallApexR,
    [+halfW, slopeYAtZ(skirtZ), skirtZ],
    [+halfW, +halfL, skirtZ],
  ]);

  // ── Fillet ring (z ∈ [skirtZ, t]) ─────────────────────────────────────
  // 3 strips: back / left / right. NO front strip — the unified slope
  // already curves smoothly up to z=t at the front, so the fillet only
  // needs to handle the back/sides inset transition.
  // The left/right strips' front-y (where they meet the slope) tracks
  // slopeYAtZ at each θ so they share an edge with the slope along its
  // curve, instead of starting at the obsolete flat-slope endY.
  for (let k = 0; k < N; k++) {
    const t0 = (k / N) * (Math.PI / 2);
    const t1 = ((k + 1) / N) * (Math.PI / 2);
    const i0 = b * (1 - Math.cos(t0));
    const i1 = b * (1 - Math.cos(t1));
    const z0 = skirtZ + b * Math.sin(t0);
    const z1 = skirtZ + b * Math.sin(t1);
    const f0 = slopeYAtZ(z0);
    const f1 = slopeYAtZ(z1);
    const k0 = halfL - i0;
    const k1 = halfL - i1;
    const w0 = halfW - i0;
    const w1 = halfW - i1;
    // Back strip (y = halfL - inset; outward +Y).
    quad([
      [-w0, k0, z0],
      [-w1, k1, z1],
      [+w1, k1, z1],
      [+w0, k0, z0],
    ]);
    // Left strip (outward -X).
    quad([
      [-w0, f0, z0],
      [-w1, f1, z1],
      [-w1, k1, z1],
      [-w0, k0, z0],
    ]);
    // Right strip (outward +X).
    quad([
      [+w0, k0, z0],
      [+w1, k1, z1],
      [+w1, f1, z1],
      [+w0, f0, z0],
    ]);
  }

  // ── Top face: rounded rectangle at z=t, fan-triangulated ──────────────
  // Outline parameters (after inset b on all sides). Front corners use the
  // larger Rf; back corners use Rb.
  const topFront = BLACK_TOP_FRONT_Y;
  const topBack = halfL - b;
  const topHalfW = BLACK_TOP_HALF_W;
  const cFR: [number, number] = [topHalfW - Rf, topFront + Rf];
  const cBR: [number, number] = [topHalfW - Rb, topBack - Rb];
  const cBL: [number, number] = [-topHalfW + Rb, topBack - Rb];
  const cFL: [number, number] = [-topHalfW + Rf, topFront + Rf];

  // Generate outline points CCW (viewed from +Z): right edge → BR arc →
  // back edge → BL arc → left edge → FL arc → front edge → FR arc → close.
  const outline: [number, number][] = [];
  outline.push([+topHalfW, topFront + Rf]);
  outline.push([+topHalfW, topBack - Rb]);
  for (let j = 1; j <= N; j++) {
    const phi = (j / N) * (Math.PI / 2);
    outline.push([cBR[0] + Rb * Math.cos(phi), cBR[1] + Rb * Math.sin(phi)]);
  }
  outline.push([-topHalfW + Rb, topBack]);
  for (let j = 1; j <= N; j++) {
    const phi = Math.PI / 2 + (j / N) * (Math.PI / 2);
    outline.push([cBL[0] + Rb * Math.cos(phi), cBL[1] + Rb * Math.sin(phi)]);
  }
  outline.push([-topHalfW, topFront + Rf]);
  for (let j = 1; j <= N; j++) {
    const phi = Math.PI + (j / N) * (Math.PI / 2);
    outline.push([cFL[0] + Rf * Math.cos(phi), cFL[1] + Rf * Math.sin(phi)]);
  }
  outline.push([+topHalfW - Rf, topFront]);
  for (let j = 1; j <= N; j++) {
    const phi = (3 * Math.PI) / 2 + (j / N) * (Math.PI / 2);
    outline.push([cFR[0] + Rf * Math.cos(phi), cFR[1] + Rf * Math.sin(phi)]);
  }
  // Fan from center; polygon is convex so the fan tessellation is valid.
  const cTop: [number, number] = [0, (topFront + topBack) / 2];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const c = outline[(i + 1) % outline.length];
    tri([
      [cTop[0], cTop[1], t],
      [a[0], a[1], t],
      [c[0], c[1], t],
    ]);
  }

  // ── Corner gap-fill triangles (z=t plane) ─────────────────────────────
  // The fillet ring's inner outline at z=t is a rectangle (sharp corners
  // at ±topHalfW × {topFront, topBack}); the top face's outline has
  // rounded arcs there. The small region between the sharp corner and
  // the rounded arc is a flat triangle fan in the z=t plane.
  const cornerFan = (
    apex: [number, number],
    center: [number, number],
    phi0: number,
    radius: number,
  ) => {
    for (let j = 0; j < N; j++) {
      const a = phi0 + (j / N) * (Math.PI / 2);
      const c = phi0 + ((j + 1) / N) * (Math.PI / 2);
      tri([
        [apex[0], apex[1], t],
        [center[0] + radius * Math.cos(c), center[1] + radius * Math.sin(c), t],
        [center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a), t],
      ]);
    }
  };
  cornerFan([+topHalfW, topBack], cBR, 0, Rb);
  cornerFan([-topHalfW, topBack], cBL, Math.PI / 2, Rb);
  cornerFan([-topHalfW, topFront], cFL, Math.PI, Rf);
  cornerFan([+topHalfW, topFront], cFR, (3 * Math.PI) / 2, Rf);

  // ── Inner solid fill ──────────────────────────────────────────────────
  // Backs the body's interior so any sub-pixel seam in the outer shell
  // resolves to black. Inset from outer faces by BLACK_INNER_FILL_INSET;
  // slanted front face parallel to the outer slope.
  const ifW = halfW - BLACK_INNER_FILL_INSET;
  const ifBack = halfL - BLACK_INNER_FILL_INSET;
  const ifBottom = -p + BLACK_INNER_FILL_INSET;
  const ifTop = skirtZ - BLACK_INNER_FILL_INSET;
  const ifFV = -halfL + BLACK_INNER_FILL_INSET;
  const ifST = ifFV + (sy / t) * ifTop;

  quad([
    [-ifW, ifST, ifTop],
    [+ifW, ifST, ifTop],
    [+ifW, ifBack, ifTop],
    [-ifW, ifBack, ifTop],
  ]);
  quad([
    [-ifW, ifBack, ifBottom],
    [+ifW, ifBack, ifBottom],
    [+ifW, ifFV, ifBottom],
    [-ifW, ifFV, ifBottom],
  ]);
  quad([
    [+ifW, ifBack, ifBottom],
    [-ifW, ifBack, ifBottom],
    [-ifW, ifBack, ifTop],
    [+ifW, ifBack, ifTop],
  ]);
  quad([
    [-ifW, ifFV, ifBottom],
    [+ifW, ifFV, ifBottom],
    [+ifW, ifFV, 0],
    [-ifW, ifFV, 0],
  ]);
  quad([
    [-ifW, ifFV, 0],
    [+ifW, ifFV, 0],
    [+ifW, ifST, ifTop],
    [-ifW, ifST, ifTop],
  ]);
  // Pentagon side fans.
  tri([
    [-ifW, ifFV, ifBottom],
    [-ifW, ifFV, 0],
    [-ifW, ifST, ifTop],
  ]);
  tri([
    [-ifW, ifFV, ifBottom],
    [-ifW, ifST, ifTop],
    [-ifW, ifBack, ifTop],
  ]);
  tri([
    [-ifW, ifFV, ifBottom],
    [-ifW, ifBack, ifTop],
    [-ifW, ifBack, ifBottom],
  ]);
  tri([
    [+ifW, ifFV, ifBottom],
    [+ifW, ifST, ifTop],
    [+ifW, ifFV, 0],
  ]);
  tri([
    [+ifW, ifFV, ifBottom],
    [+ifW, ifBack, ifTop],
    [+ifW, ifST, ifTop],
  ]);
  tri([
    [+ifW, ifFV, ifBottom],
    [+ifW, ifBack, ifBottom],
    [+ifW, ifBack, ifTop],
  ]);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geom.setIndex(indices);
  // Material groups: 0 = body, 1 = slope (so the slope can use a slightly
  // brighter material in JSX). Slope indices are contiguous between
  // slopeIdxStart and slopeIdxEnd, so two non-slope ranges sandwich them.
  const totalIdx = indices.length;
  geom.addGroup(0, slopeIdxStart, 0);
  geom.addGroup(slopeIdxStart, slopeIdxEnd - slopeIdxStart, 1);
  geom.addGroup(slopeIdxEnd, totalIdx - slopeIdxEnd, 0);
  geom.computeVertexNormals();
  return geom;
}

const BLACK_KEY_GEOMETRY = createChamferedBlackGeometry();

// Gray marker on the top-face/slope junction. Length = the straight portion
// of the top face's front edge (= 2 × (topHalfW - frontCornerR)); shorter
// than the key width by the rounded ends on both sides. Sits just above the
// top face so it doesn't z-fight.
const BLACK_TOP_FRONT_LINE_GEOMETRY = new THREE.BoxGeometry(
  2 * (BLACK_TOP_HALF_W - BLACK_FRONT_TOP_CORNER_R),
  0.006,
  0.002,
);
const BLACK_TOP_FRONT_LINE_MATERIAL = new THREE.MeshBasicMaterial({
  color: "#3a3a3a",
  toneMapped: false,
});

// Slope tint: per-frame, slope material's color = lerp(blackKeyColor, white,
// FACTOR). 0.12 is "若干明るい" — a perceptible but not dramatic step up.
const SLOPE_TINT_TARGET = new THREE.Color(1, 1, 1);
const SLOPE_TINT_FACTOR = 0.12;

// White cap — rounded-corner extruded solid. Visible top at mesh-local
// z=0; cap extends to z=-WHITE_CAP_THICKNESS where the wood chassis
// takes over.
function createRoundedWhiteGeometry(): THREE.BufferGeometry {
  const halfW = (WHITE_KEY_WIDTH * 0.96) / 2;
  const halfL = WHITE_KEY_LENGTH / 2;
  const r = WHITE_CAP_CORNER_RADIUS;
  const shape = new THREE.Shape();
  shape.moveTo(-halfW + r, -halfL);
  shape.lineTo(+halfW - r, -halfL);
  shape.quadraticCurveTo(+halfW, -halfL, +halfW, -halfL + r);
  shape.lineTo(+halfW, +halfL - r);
  shape.quadraticCurveTo(+halfW, +halfL, +halfW - r, +halfL);
  shape.lineTo(-halfW + r, +halfL);
  shape.quadraticCurveTo(-halfW, +halfL, -halfW, +halfL - r);
  shape.lineTo(-halfW, -halfL + r);
  shape.quadraticCurveTo(-halfW, -halfL, -halfW + r, -halfL);
  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: WHITE_CAP_THICKNESS,
    bevelEnabled: false,
    curveSegments: 6,
  });
  // Shift so the +Z (visible top) face lands at z=0 in mesh-local.
  geom.translate(0, 0, -WHITE_CAP_THICKNESS);
  return geom;
}

const WHITE_KEY_GEOMETRY = createRoundedWhiteGeometry();
const WHITE_BODY_GEOMETRY = new THREE.BoxGeometry(
  WHITE_KEY_WIDTH,
  WHITE_KEY_LENGTH,
  WHITE_BODY_HEIGHT,
);
// Wood-body top face uses a darker material than its sides so the inter-key
// gap reads as black-between-the-keys instead of a yellow stripe.
// BoxGeometry face order is [+X, -X, +Y, -Y, +Z, -Z].
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

// Flash → keyboard illumination. The shader treats each active flash as a
// point light at (key.x, WHITE_KEY_LENGTH, LIGHT_Z) projecting every black
// key's silhouette as shadow on the white-key surface.
const LIGHT_Z = 0.4;
// `exp(-(dx²·X + dy²·Y))`. X dominates so a fragment off to the side dims
// visibly even though the back-edge light is always ≥1 wu in front of it.
const LIGHT_FALLOFF_X = 1.5;
const LIGHT_FALLOFF_Y = 1.0;
const LIGHT_BOOST = 1.7;
const SHADOW_FEATHER = 0.005;
const SHADOW_HALO = 0.01;
// >1.0 pushes the lit-area formula negative inside the silhouette so the
// surface is actively darkened, not just stripped of the additive boost.
const SHADOW_OPACITY = 1.0;
// Per-fragment cost is MAX_LIGHTS × BLACK_KEY_COUNT (= 6 × 36 = 216 ops).
const MAX_LIGHTS = 6;
// World-unit silhouette growth per unit of per-key glow. Active keys cast
// a thicker shadow than idle ones.
const ACTIVE_SHADOW_GROW = -0.03;

// Black-key bounds packed flat as (xMin, xMax, yMin, yMax, ...) for a
// single vec4[BLACK_KEY_COUNT] shader uniform. BLACK_KEY_INDICES parallels
// it, mapping each entry back to KEYBOARD_LAYOUT.keys[].
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
  uLightStrength: { value: number };
  uBlackGlow: { value: Float32Array };
  uActiveShadowGrow: { value: number };
};

// Patch MeshStandardMaterial: ADD per-flash light + black-key shadow
// contribution after gl_FragColor has been computed. Standard PBR + the
// emissive glow channel still flow through unchanged.
function patchWhiteKeyMaterial(
  material: THREE.MeshStandardMaterial,
  perMesh: WhiteKeyUniforms,
  shared: SharedLightUniforms,
) {
  material.onBeforeCompile = (shader) => {
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

        // Reverse-project this fragment through L onto z=uBlackKeyTop and
        // SDF-test against the black key's xy bounds. Returns 1 deep
        // inside the silhouette, smoothstep-feathered out across HALO.
        float keyShadowAmount(vec4 bounds, vec2 L) {
          float lz = uLightZ;
          if (lz <= uBlackKeyTop) return 0.0;
          float t = (uBlackKeyTop - lz) / (-lz);
          vec2 hit = L + t * (vGroupXY - L);
          vec2 q = vec2(
            max(bounds.x - hit.x, hit.x - bounds.y),
            max(bounds.z - hit.y, hit.y - bounds.w)
          );
          float sdf = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0);
          return 1.0 - smoothstep(
            -${SHADOW_FEATHER.toFixed(4)},
            ${SHADOW_HALO.toFixed(4)},
            sdf
          );
        }

        // Strongest silhouette across all black keys; per-key glow
        // inflates bounds so active keys cast thicker shadows.
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
        // r157 renamed <output_fragment> → <opaque_fragment>; using the
        // wrong name silently no-ops the patch (compiles but never runs).
        "#include <opaque_fragment>",
        /* glsl */ `
        #include <opaque_fragment>
        if (uLightStrength > 0.001) {
          vec3 totalContribution = vec3(0.0);
          for (int li = 0; li < MAX_LIGHTS; li++) {
            float intensity = uLightIntensities[li];
            if (intensity < 0.005) continue;
            vec2 L = uLightXYs[li];
            float dx = vGroupXY.x - L.x;
            float dy = vGroupXY.y - L.y;
            float falloff = exp(
              -dx * dx * ${LIGHT_FALLOFF_X.toFixed(3)}
              -dy * dy * ${LIGHT_FALLOFF_Y.toFixed(3)}
            );
            float shadow = maxShadow(L);
            float effective = intensity * falloff * (
              1.0 - shadow * falloff * ${SHADOW_OPACITY.toFixed(3)}
            );
            totalContribution += vec3(${LIGHT_BOOST.toFixed(3)}) * uLightStrength * effective;
          }
          // Clamp: protects against stacked shadows crushing to black /
          // dense chords saturating to white.
          gl_FragColor.rgb += clamp(totalContribution, vec3(-0.6), vec3(2.5));
        }
        `,
      );
  };
  // Share one compiled program across all white-key materials.
  material.customProgramCacheKey = () => "white-key-shadow-multi";
}

export function Keyboard() {
  const settings = useStore((s) => s.settings);
  const setLoadStatus = useStore((s) => s.setLoadStatus);
  const { gl } = useThree();

  // Hover counter + deferred reset: a horizontal cursor sweep across
  // adjacent key meshes fires OUT(prev) → OVER(next) pairs in either
  // order (R3F's order depends on raycast). Naively setting/clearing
  // the cursor flickers; counting+deferring keeps it stable.
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
  const press = useMemo(() => new Float32Array(KEY_COUNT), []);
  // Scratch buffer for top-K light selection; allocated once to keep
  // useFrame allocation-free.
  const claimed = useMemo(() => new Uint8Array(KEY_COUNT), []);

  const meshRefs = useRef<(THREE.Mesh | null)[]>([]);
  // Group wraps each key with its origin at the rear pivot; animating the
  // group's rotation+position tilts/dips the key during press.
  const keyGroupRefs = useRef<(THREE.Group | null)[]>([]);
  const matRefs = useRef<(THREE.MeshStandardMaterial | null)[]>([]);
  // Slope-only material per black key (material slot 1). Tinted slightly
  // brighter than the body so the slope reads as a distinct surface.
  const slopeMatRefs = useRef<(THREE.MeshStandardMaterial | null)[]>([]);

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

  // Shared across every white-key material; in-place Float32Array updates
  // in useFrame propagate to all 52 materials via the {value} reference.
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
    // Initial colour from settings; later updates flow through useFrame's
    // color.set(). settings excluded so changes don't recreate materials.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whiteKeyUniforms, sharedLightUniforms]);

  useEffect(
    () => () => {
      for (const m of whiteKeyMaterials) m?.dispose();
    },
    [whiteKeyMaterials],
  );

  // Mirror imperatively-created white-key materials into matRefs[] so the
  // per-frame color/emissive loop reaches them like declarative refs do.
  useEffect(() => {
    for (let i = 0; i < KEY_COUNT; i++) {
      const m = whiteKeyMaterials[i];
      if (m) matRefs.current[i] = m;
    }
  }, [whiteKeyMaterials]);

  const activePointers = useRef<
    Map<number, { midi: number; release: () => void }>
  >(new Map());
  // Pending midi during async audio init; cleared on pointerup so a release
  // during loading doesn't leak a stuck note.
  const pendingMidi = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    // held[] is a refcount, not a flag — back-to-back retriggers may emit
    // on/off in either order within a frame; counting handles overlap.
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
      if (prev.midi === midi) return;
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

      // Release implicit pointer capture (touch sets it automatically) so
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

      // Track intent through async load. pointerEnter may update the desired
      // midi; pointerup clears the entry so we trigger nothing on release.
      pendingMidi.current.set(id, midi);
      const ready = await ensureAudio();
      if (!pendingMidi.current.has(id)) return;
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
      if (pendingMidi.current.has(id)) {
        pendingMidi.current.set(id, midi);
        return;
      }
      if (activePointers.current.has(id)) {
        triggerForPointer(id, midi);
      }
    },
    [triggerForPointer],
  );

  // PC keyboard input — same lifecycle as touch.
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
      // Shift is reserved for global shortcuts (e.g. Shift+R for record).
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (isEditable(e.target)) return;
      const baseMidi = PC_KEY_NOTES[e.code];
      if (baseMidi === undefined) return;
      e.preventDefault();
      if (pressed.has(e.code) || pending.has(e.code)) return;

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
      if (!pending.has(e.code)) return;
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
    // Drop everything on tab switch so keys don't get stuck.
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

      const pressTarget = held[i] ? 1 : 0;
      press[i] += (pressTarget - press[i]) * pressK;

      const mat = matRefs.current[i];
      const k = KEYBOARD_LAYOUT.keys[i];
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
        mat.emissive.set(
          settings.keyGlowFollowNote
            ? settings.noteColor
            : settings.keyGlowColor,
        );
        mat.emissiveIntensity = e * settings.keyGlowIntensity * brightness;
      } else {
        mat.emissiveIntensity = 0;
      }

      // Slope material: lerp the base color toward white so the slope reads
      // as a slightly brighter shade than the body. Mirror emissive so glow
      // remains coherent across the whole black key.
      const slopeMat = slopeMatRefs.current[i];
      if (slopeMat) {
        slopeMat.color
          .set(baseColor)
          .lerp(SLOPE_TINT_TARGET, SLOPE_TINT_FACTOR)
          .multiplyScalar(brightness);
        slopeMat.emissive.copy(mat.emissive);
        slopeMat.emissiveIntensity = mat.emissiveIntensity;
      }
    }

    const lightXYs = sharedLightUniforms.uLightXYs.value;
    const lightIntensities = sharedLightUniforms.uLightIntensities.value;
    const blackGlow = sharedLightUniforms.uBlackGlow.value;
    sharedLightUniforms.uLightStrength.value = settings.flashEnabled
      ? settings.flashBrightness
      : 0;
    for (let bk = 0; bk < BLACK_KEY_COUNT; bk++) {
      blackGlow[bk] = Math.min(1, glow[BLACK_KEY_INDICES[bk]]);
    }
    if (settings.flashEnabled) {
      claimed.fill(0);
      // Top-K selection sort: 6 × 88 = 528 comparisons per frame.
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

  // X positions of B→C octave boundaries.
  const octaveDividerXs = useMemo(() => {
    const xs: number[] = [];
    for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
      if (((midi % 12) + 12) % 12 !== 11) continue;
      const k = KEYBOARD_LAYOUT.keys[midi - MIDI_MIN];
      xs.push(k.x + WHITE_KEY_WIDTH / 2);
    }
    return xs;
  }, []);

  // Divider length: keyboard back edge → top of visible camera frustum.
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
        // Group is anchored at the rear pivot; press animation drives
        // group.position.z + rotation.x to tilt + settle the key.
        return (
          <group
            key={k.midi}
            ref={(g) => (keyGroupRefs.current[i] = g)}
            position={[k.x, k.yLocal + k.length / 2, 0]}
          >
            <mesh
              ref={(m) => (meshRefs.current[i] = m)}
              position={[0, -k.length / 2, 0]}
              onPointerDown={(e) => onPointerDown(e, k.midi)}
              onPointerEnter={(e) => onPointerEnter(e, k.midi)}
              onPointerOver={onKeyPointerOver}
              onPointerOut={onKeyPointerOut}
              // White: imperative material (shadow-projection patch).
              // Black: declarative material child below.
              material={isBlack ? undefined : (customMat ?? undefined)}
              geometry={isBlack ? BLACK_KEY_GEOMETRY : WHITE_KEY_GEOMETRY}
            >
              {isBlack && (
                <>
                  <meshStandardMaterial
                    attach="material-0"
                    ref={(mat) => (matRefs.current[i] = mat)}
                    color={settings.blackKeyColor}
                    roughness={0.4}
                    metalness={0.05}
                  />
                  <meshStandardMaterial
                    attach="material-1"
                    ref={(mat) => (slopeMatRefs.current[i] = mat)}
                    color={settings.blackKeyColor}
                    roughness={0.4}
                    metalness={0.05}
                  />
                </>
              )}
            </mesh>
            {!isBlack && (
              <mesh
                position={[
                  0,
                  -k.length / 2,
                  -WHITE_CAP_THICKNESS -
                    WOOD_TOP_GAP -
                    WHITE_BODY_HEIGHT / 2,
                ]}
                geometry={WHITE_BODY_GEOMETRY}
                material={WHITE_BODY_MATERIALS}
              />
            )}
            {isBlack && (
              <mesh
                position={[
                  0,
                  -k.length / 2 + BLACK_TOP_FRONT_Y,
                  BLACK_KEY_THICKNESS + 0.0015,
                ]}
                geometry={BLACK_TOP_FRONT_LINE_GEOMETRY}
                material={BLACK_TOP_FRONT_LINE_MATERIAL}
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
