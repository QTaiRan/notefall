import * as THREE from "three";
import { KEYBOARD_LAYOUT } from "./layout";

// Flash → keyboard illumination. The shader treats each active flash as a
// point light at (key.x, WHITE_KEY_LENGTH, LIGHT_Z) projecting every black
// key's silhouette as shadow on the white-key surface.
export const LIGHT_Z = 0.4;
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
export const MAX_LIGHTS = 6;
// World-unit silhouette growth per unit of per-key glow. Active keys cast
// a thicker shadow than idle ones.
export const ACTIVE_SHADOW_GROW = -0.03;

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

export { BLACK_KEY_BOUNDS, BLACK_KEY_INDICES, BLACK_KEY_COUNT };

export type WhiteKeyUniforms = {
  uMeshOriginXY: { value: THREE.Vector2 };
  uLightZ: { value: number };
  uBlackKeyTop: { value: number };
};

export type SharedLightUniforms = {
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
export function patchWhiteKeyMaterial(
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
