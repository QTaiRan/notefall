import { useMemo, useRef, useEffect, useCallback } from "react";
import * as THREE from "three";
import * as Tone from "tone";
import { useFrame } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import {
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

/**
 * Flat top-down keyboard. Each key is a thin box in the XY plane viewed
 * straight on. Per-key glow is animated via material emissive.
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

  const glow = useMemo(() => new Float32Array(KEY_COUNT), []);
  const held = useMemo(() => new Uint8Array(KEY_COUNT), []);

  const meshRefs = useRef<(THREE.Mesh | null)[]>([]);
  const matRefs = useRef<(THREE.MeshStandardMaterial | null)[]>([]);

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
      const transpose = useStore.getState().settings.transpose
      const midi = baseMidi + transpose
      if (midi < 0 || midi > 127) return

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
    for (let i = 0; i < KEY_COUNT; i++) {
      const decay = settings.keyGlowDecay;
      const target = held[i] ? Math.max(glow[i], 0.6) : 0;
      const k1 = 1 - Math.exp(-delta / Math.max(0.01, decay));
      glow[i] += (target - glow[i]) * k1;

      const mat = matRefs.current[i];
      const k = KEYBOARD_LAYOUT.keys[i];
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
        mat.emissive.set(settings.keyGlowFollowNote ? settings.noteColor : settings.keyGlowColor);
        // brightness also scales the glow so darkening the keyboard dims its emission too
        mat.emissiveIntensity = e * settings.keyGlowIntensity * brightness;
      } else {
        mat.emissiveIntensity = 0;
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
      {KEYBOARD_LAYOUT.keys.map((k, i) => (
        <mesh
          key={k.midi}
          ref={(m) => (meshRefs.current[i] = m)}
          position={[k.x, k.yLocal, k.zCenter]}
          onPointerDown={(e) => onPointerDown(e, k.midi)}
          onPointerEnter={(e) => onPointerEnter(e, k.midi)}
        >
          <planeGeometry args={[k.width * 0.96, k.length]} />
          <meshStandardMaterial
            ref={(mat) => (matRefs.current[i] = mat)}
            color={k.isBlack ? settings.blackKeyColor : settings.whiteKeyColor}
            roughness={k.isBlack ? 0.4 : 0.55}
            metalness={0.05}
          />
        </mesh>
      ))}
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
