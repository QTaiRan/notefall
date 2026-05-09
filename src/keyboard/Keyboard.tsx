import { useMemo, useRef, useEffect, useCallback } from "react";
import * as THREE from "three";
import * as Tone from "tone";
import { useFrame, useThree } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import {
  BLACK_KEY_LENGTH,
  BLACK_KEY_THICKNESS,
  KEYBOARD_LAYOUT,
  KEY_COUNT,
  MIDI_MAX,
  MIDI_MIN,
  WHITE_KEY_LENGTH,
  WHITE_KEY_WIDTH,
} from "./layout";
import {
  BLACK_KEY_GEOMETRY,
  WHITE_BODY_FRONT_MATERIAL,
  WHITE_BODY_MATERIALS,
  WHITE_BODY_WOOD_MATERIAL,
  WHITE_CAP_THICKNESS,
  whiteBodyGeometryFor,
  whiteKeyGeometryFor,
  WOOD_TOP_GAP,
} from "./geometry";
import {
  ACTIVE_SHADOW_GROW,
  BLACK_KEY_BOUNDS,
  BLACK_KEY_COUNT,
  BLACK_KEY_INDICES,
  DEFAULT_FLASH_HALO,
  DEFAULT_FLASH_INTENSITY,
  DEFAULT_FLASH_SIZE,
  DEFAULT_FLASH_WIDTH,
  LIGHT_BOOST_BASE,
  LIGHT_FALLOFF_X_BASE,
  LIGHT_FALLOFF_Y_BASE,
  LIGHT_Z,
  MAX_LIGHTS,
  SHADOW_HALO_BASE,
  SHADOW_HALO_RESPONSE,
  patchWhiteKeyMaterial,
  type SharedLightUniforms,
  type WhiteKeyUniforms,
} from "./whiteKeyShader";
import { usePcKeyboardInput } from "./pcInput";
import { useStore } from "../store";
import { audioEngine } from "../audio/engine";

// Press animation: each key's group sits at the rear edge; press dips
// `position.z = -PIVOT_DIP × p` and tilts `rotation.x = ANGLE × p`.
// PIVOT_DIP gives the whole key a "settle" without which the rear reads
// as rigidly fixed. ANGLE is derived so total front-tip drop = PRESS_DEPTH.
const PRESS_TC = 0.022;
const WHITE_PRESS_DEPTH = 0.12;
const BLACK_PRESS_DEPTH = 0.08;
const WHITE_PIVOT_DIP = 0.035;
const BLACK_PIVOT_DIP = 0.05;
const WHITE_PRESS_ANGLE =
  (WHITE_PRESS_DEPTH - WHITE_PIVOT_DIP) / WHITE_KEY_LENGTH;
const BLACK_PRESS_ANGLE =
  (BLACK_PRESS_DEPTH - BLACK_PIVOT_DIP) / BLACK_KEY_LENGTH;

// Slope tint: per-frame, slope material's color = lerp(blackKeyColor, white,
// FACTOR). 0.12 is "若干明るい" — a perceptible but not dramatic step up.
const SLOPE_TINT_TARGET = new THREE.Color(1, 1, 1);
const SLOPE_TINT_FACTOR = 0.12;

// Front-fillet ("seam" between slope and top face) base color — a fixed
// gray, multiplied by keyboardBrightness in useFrame. Static, not derived
// from blackKeyColor, so the seam stays visible regardless of theme.
const FILLET_FRONT_COLOR = new THREE.Color("#808080");

// Black-key press tint: when held, lerp every surface (body / slope /
// fillet-front) toward the glow color by `glow × this`. Without this,
// only the emissive channel carried the press color, which read as
// "lit from inside" on the flat top but barely registered on the
// slope / sides because their dark base color dominated under shading.
// Tinting the actual base color makes the entire key visibly take on
// the press color, not just the most directly-lit face.
const BLACK_PRESS_TINT_STRENGTH = 0.85;
// Reusable scratch instance — lerping the press tint allocates nothing.
const PRESS_TINT_SCRATCH = new THREE.Color();

// Target the shader light color is lerped toward by flashBrightness, so
// the keyboard glow's "spark" core matches the LandingFlashes plane's
// brightness-lifted look.
const WHITE_LIGHT_TARGET = new THREE.Color(1, 1, 1);

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
  // Front-fillet material per black key (material slot 2). Fixed gray;
  // emissive mirrors the body so the seam glows along with key presses.
  const filletMatRefs = useRef<(THREE.MeshStandardMaterial | null)[]>([]);

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
      uLightBoost: { value: LIGHT_BOOST_BASE },
      uFalloffX: { value: LIGHT_FALLOFF_X_BASE },
      uFalloffY: { value: LIGHT_FALLOFF_Y_BASE },
      uShadowHalo: { value: SHADOW_HALO_BASE },
      uLightColor: { value: new THREE.Color(1, 1, 1) },
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
      // Middle button is reserved for camera orbit/pan
      // (see scene/CameraControls.tsx) — don't trigger the key.
      if (e.nativeEvent.button === 1) return;
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

  usePcKeyboardInput(ensureAudio);

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
      const glowOn = e > 0.001 && settings.keyGlowEnabled;
      const glowColorHex = settings.keyGlowFollowNote
        ? settings.noteColor
        : settings.keyGlowColor;
      // Black-key surface tint: bring the actual color toward the glow
      // color, scaled brightness. White keys keep their pristine surface
      // (the additive emissive already reads cleanly off light gray).
      if (glowOn && k.isBlack) {
        PRESS_TINT_SCRATCH.set(glowColorHex).multiplyScalar(brightness);
        mat.color.lerp(
          PRESS_TINT_SCRATCH,
          Math.min(1, e * BLACK_PRESS_TINT_STRENGTH),
        );
      }
      if (glowOn) {
        mat.emissive.set(glowColorHex);
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
        if (glowOn) {
          PRESS_TINT_SCRATCH.set(glowColorHex).multiplyScalar(brightness);
          slopeMat.color.lerp(
            PRESS_TINT_SCRATCH,
            Math.min(1, e * BLACK_PRESS_TINT_STRENGTH),
          );
        }
        slopeMat.emissive.copy(mat.emissive);
        slopeMat.emissiveIntensity = mat.emissiveIntensity;
      }
      // Front-fillet material: fixed gray (theme-independent), brightness
      // applied. Emissive follows the body so the seam glows on press.
      const filletMat = filletMatRefs.current[i];
      if (filletMat) {
        filletMat.color.copy(FILLET_FRONT_COLOR).multiplyScalar(brightness);
        if (glowOn) {
          PRESS_TINT_SCRATCH.set(glowColorHex).multiplyScalar(brightness);
          filletMat.color.lerp(
            PRESS_TINT_SCRATCH,
            Math.min(1, e * BLACK_PRESS_TINT_STRENGTH),
          );
        }
        filletMat.emissive.copy(mat.emissive);
        filletMat.emissiveIntensity = mat.emissiveIntensity;
      }
    }

    // Wood chassis tint — single shared material, single color.set per
    // frame. Brightness multiplied so it dims with the rest of the keys.
    WHITE_BODY_WOOD_MATERIAL.color
      .set(settings.woodColor)
      .multiplyScalar(brightness);
    // White-coated front face follows whiteKeyColor. Front-face normals
    // are forced to +Z (see tagWhiteBodyFrontFace) so the surface gets
    // the same N·L diffuse contribution as the cap top. We dim by 0.85
    // so the front still reads slightly darker than the top.
    WHITE_BODY_FRONT_MATERIAL.color
      .set(settings.whiteKeyColor)
      .multiplyScalar(brightness * 0.85);

    const lightXYs = sharedLightUniforms.uLightXYs.value;
    const lightIntensities = sharedLightUniforms.uLightIntensities.value;
    const blackGlow = sharedLightUniforms.uBlackGlow.value;
    sharedLightUniforms.uLightStrength.value = settings.flashEnabled
      ? settings.flashBrightness
      : 0;
    // Mirror flash UI sliders into the white-key shadow shader so the
    // glow on the white surface matches the LandingFlashes plane visually.
    // Mapping is calibrated so each slider's *default* reproduces the
    // pre-uniform hardcoded look.
    sharedLightUniforms.uLightBoost.value =
      LIGHT_BOOST_BASE * (settings.flashIntensity / DEFAULT_FLASH_INTENSITY);
    sharedLightUniforms.uFalloffX.value =
      LIGHT_FALLOFF_X_BASE * (DEFAULT_FLASH_WIDTH / Math.max(0.01, settings.flashWidth));
    sharedLightUniforms.uFalloffY.value =
      LIGHT_FALLOFF_Y_BASE * (DEFAULT_FLASH_SIZE / Math.max(0.01, settings.flashSize));
    sharedLightUniforms.uShadowHalo.value =
      SHADOW_HALO_BASE *
      Math.pow(settings.flashHaloWidth / DEFAULT_FLASH_HALO, SHADOW_HALO_RESPONSE);
    // Light color follows the same source as the LandingFlashes plane —
    // noteColor when "Follows Note" is on, otherwise the explicit
    // flashColor — and is then lifted toward white by flashBrightness so
    // a saturated colour can still keep a bright "spark" core.
    sharedLightUniforms.uLightColor.value
      .set(settings.flashFollowNote ? settings.noteColor : settings.flashColor)
      .lerp(WHITE_LIGHT_TARGET, settings.flashBrightness);
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
              geometry={
                isBlack ? BLACK_KEY_GEOMETRY : whiteKeyGeometryFor(k.midi)
              }
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
                  <meshStandardMaterial
                    attach="material-2"
                    ref={(mat) => (filletMatRefs.current[i] = mat)}
                    color={FILLET_FRONT_COLOR}
                    roughness={0.4}
                    metalness={0.05}
                  />
                </>
              )}
            </mesh>
            {!isBlack && (
              <mesh
                // ExtrudeGeometry's top cap sits at mesh-local z=0 (after
                // translate); position the mesh so that lands at
                // -CAP-GAP, matching the cap's underside.
                position={[
                  0,
                  -k.length / 2,
                  -WHITE_CAP_THICKNESS - WOOD_TOP_GAP,
                ]}
                geometry={whiteBodyGeometryFor(k.midi)}
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
