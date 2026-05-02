import { useMemo, useRef, useEffect, useCallback } from 'react'
import * as THREE from 'three'
import * as Tone from 'tone'
import { useFrame } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import { KEYBOARD_LAYOUT, KEY_COUNT, MIDI_MIN } from './layout'
import { useStore } from '../store'
import { audioEngine } from '../audio/engine'

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
  const settings = useStore((s) => s.settings)
  const setLoadStatus = useStore((s) => s.setLoadStatus)

  const glow = useMemo(() => new Float32Array(KEY_COUNT), [])
  const held = useMemo(() => new Uint8Array(KEY_COUNT), [])

  const meshRefs = useRef<(THREE.Mesh | null)[]>([])
  const matRefs = useRef<(THREE.MeshStandardMaterial | null)[]>([])

  // pointerId → currently-playing note for that pointer
  const activePointers = useRef<Map<number, { midi: number; release: () => void }>>(new Map())
  // pointerId → midi the user wants to play once async audio init resolves
  // (cleared on pointerup, so releases during loading don't leak a stuck note)
  const pendingMidi = useRef<Map<number, number>>(new Map())

  useEffect(() => {
    // held[] is a reference count of active voices on each pitch, not a flag.
    // When the same midi is retriggered (note A's off and note B's on may
    // arrive in either order within a tick), set/clear semantics would lose
    // the new note's "down" state. Counting handles overlap correctly.
    const off = audioEngine.addKeyListener((ev) => {
      const idx = ev.midi - MIDI_MIN
      if (idx < 0 || idx >= KEY_COUNT) return
      if (ev.type === 'on') {
        glow[idx] = Math.max(glow[idx], 0.5 + ev.velocity * 0.6)
        held[idx]++
      } else {
        held[idx] = Math.max(0, held[idx] - 1)
      }
    })
    return off
  }, [glow, held])

  // Window-level release so dragging off the canvas still stops the note.
  useEffect(() => {
    const onUp = (e: PointerEvent) => {
      const id = e.pointerId
      const entry = activePointers.current.get(id)
      if (entry) {
        entry.release()
        activePointers.current.delete(id)
      }
      pendingMidi.current.delete(id)
    }
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [])

  const ensureAudio = useCallback(async () => {
    if (audioEngine.isReady()) return true
    const status = useStore.getState().loadStatus
    if (status.state === 'loading') {
      // wait for the in-flight load to settle
      while (useStore.getState().loadStatus.state === 'loading') {
        await new Promise((r) => setTimeout(r, 50))
      }
      return audioEngine.isReady()
    }
    setLoadStatus({ state: 'loading', loaded: 0, total: 1 })
    try {
      await audioEngine.init((p) =>
        setLoadStatus({ state: 'loading', loaded: p.loaded, total: p.total }),
      )
      setLoadStatus({ state: 'ready' })
      return true
    } catch {
      setLoadStatus({ state: 'idle' })
      return false
    }
  }, [setLoadStatus])

  const triggerForPointer = useCallback((pointerId: number, midi: number) => {
    const prev = activePointers.current.get(pointerId)
    if (prev) {
      if (prev.midi === midi) return // same key, no retrigger
      prev.release()
      activePointers.current.delete(pointerId)
    }
    const handle = audioEngine.triggerKey(midi, 0.78)
    if (!handle) return
    activePointers.current.set(pointerId, { midi, release: handle.release })
  }, [])

  const onPointerDown = useCallback(
    async (e: ThreeEvent<PointerEvent>, midi: number) => {
      e.stopPropagation()
      const id = e.pointerId

      // Release implicit pointer capture (set automatically for touch) so
      // pointerEnter on sibling keys fires while dragging.
      const target = e.nativeEvent.target as Element | null
      if (target && typeof target.hasPointerCapture === 'function' && target.hasPointerCapture(id)) {
        try {
          target.releasePointerCapture(id)
        } catch {
          /* ignored */
        }
      }

      // Unlock the AudioContext within the user gesture
      if (Tone.getContext().state !== 'running') {
        try {
          await Tone.start()
        } catch {
          /* ignored */
        }
      }

      if (audioEngine.isReady()) {
        triggerForPointer(id, midi)
        return
      }

      // Audio not ready — record this pointer's intent and await loading.
      // pointerEnter may update the desired midi during the wait; pointerup
      // will clear the entry, in which case we trigger nothing.
      pendingMidi.current.set(id, midi)
      const ready = await ensureAudio()
      if (!pendingMidi.current.has(id)) return // released during loading
      const targetMidi = pendingMidi.current.get(id)!
      pendingMidi.current.delete(id)
      if (!ready) return
      triggerForPointer(id, targetMidi)
    },
    [ensureAudio, triggerForPointer],
  )

  const onPointerEnter = useCallback(
    (e: ThreeEvent<PointerEvent>, midi: number) => {
      const id = e.pointerId
      // While loading, just remember which key the pointer is currently over.
      if (pendingMidi.current.has(id)) {
        pendingMidi.current.set(id, midi)
        return
      }
      // Otherwise, if the pointer already has an active note, switch keys (slide).
      if (activePointers.current.has(id)) {
        triggerForPointer(id, midi)
      }
    },
    [triggerForPointer],
  )

  useFrame((_, delta) => {
    const brightness = settings.keyboardBrightness
    for (let i = 0; i < KEY_COUNT; i++) {
      const decay = settings.keyGlowDecay
      const target = held[i] ? Math.max(glow[i], 0.6) : 0
      const k1 = 1 - Math.exp(-delta / Math.max(0.01, decay))
      glow[i] += (target - glow[i]) * k1

      const mat = matRefs.current[i]
      const k = KEYBOARD_LAYOUT.keys[i]
      if (!mat) continue

      const baseColor = k.isBlack ? settings.blackKeyColor : settings.whiteKeyColor
      mat.color.set(baseColor).multiplyScalar(brightness)
      const e = glow[i]
      if (e > 0.001) {
        mat.emissive.set(settings.keyGlowColor)
        // brightness also scales the glow so darkening the keyboard dims its emission too
        mat.emissiveIntensity = e * settings.keyGlowIntensity * brightness
      } else {
        mat.emissiveIntensity = 0
      }
    }
  })

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
    </group>
  )
}
