import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import * as THREE from 'three'
import { useCallback, useEffect, useRef } from 'react'
import { useStore } from '../store'
import { Keyboard } from '../keyboard/Keyboard'
import { FallingNotes } from '../notes/FallingNotes'
import { LandingFlashes } from '../notes/LandingFlashes'
import { HitParticles } from '../notes/HitParticles'
import { HitLine } from '../notes/HitLine'
import { WHITE_KEY_LENGTH } from '../keyboard/layout'
import { audioEngine } from '../audio/engine'
import { pauseSong, playSong, togglePlayback } from '../audio/playback'

export function Scene() {
  const s = useStore((st) => st.settings)
  return (
    <Canvas
      dpr={[1, 2]}
      gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
      camera={{ position: s.cameraPos, fov: s.cameraFov, near: 0.1, far: 100 }}
      onCreated={({ camera }) => {
        camera.lookAt(...s.cameraLookAt)
      }}
    >
      <color attach="background" args={[s.backgroundColor]} />
      <SceneContents />
      {s.bloomEnabled && (
        <EffectComposer>
          <Bloom
            intensity={s.bloomIntensity}
            luminanceThreshold={s.bloomThreshold}
            luminanceSmoothing={s.bloomSmoothing}
            radius={s.bloomRadius}
            mipmapBlur
          />
        </EffectComposer>
      )}
    </Canvas>
  )
}

function SceneContents() {
  const s = useStore((st) => st.settings)
  return (
    <>
      <ambientLight intensity={0.35} />
      <directionalLight position={[2, 6, 4]} intensity={0.8} />
      <CameraSync pos={s.cameraPos} lookAt={s.cameraLookAt} fov={s.cameraFov} />
      <PlayToggleArea />
      <Keyboard />
      {s.notesEnabled && <FallingNotes />}
      {s.flashEnabled && <LandingFlashes />}
      <HitParticles />
      <HitLine />
    </>
  )
}

/**
 * Invisible click regions above and below the keyboard. Short click toggles
 * play/pause; pressing-and-holding (>200ms) temporarily doubles the playback
 * rate and releasing restores the slider value. Sits behind the notes
 * (z < note z); notes have no event handlers so the raycast falls through.
 */
const HOLD_THRESHOLD_MS = 200

function PlayToggleArea() {
  const s = useStore((st) => st.settings)
  const camDistance = Math.abs(s.cameraPos[2])
  const halfVisHeight = camDistance * Math.tan((s.cameraFov * Math.PI) / 360)
  const visibleTopY = s.cameraLookAt[1] + halfVisHeight
  const visibleBottomY = s.cameraLookAt[1] - halfVisHeight
  const topOfKeyboard = s.keyboardY + WHITE_KEY_LENGTH
  const bottomOfKeyboard = s.keyboardY
  // Above-keyboard region (where falling notes appear)
  const upperHeight = visibleTopY - topOfKeyboard
  const upperCenterY = (visibleTopY + topOfKeyboard) / 2
  // Below-keyboard region
  const lowerHeight = bottomOfKeyboard - visibleBottomY
  const lowerCenterY = (bottomOfKeyboard + visibleBottomY) / 2
  // Wide enough to cover any reasonable aspect ratio at this camera distance.
  const width = halfVisHeight * 4

  const holdTimer = useRef<number | null>(null)
  const fastForwardActive = useRef(false)
  // Whether the song was already playing when the hold began. If false the
  // hold actively starts playback for the duration of the hold and the song
  // is paused again on release (preview / scrubbing behaviour).
  const wasPlayingBeforeHold = useRef(false)
  // Token to invalidate the async playSong() if the user releases mid-await.
  const holdToken = useRef(0)

  const stopFastForward = useCallback(() => {
    holdToken.current++
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
    if (fastForwardActive.current) {
      fastForwardActive.current = false
      // Restore to whatever the slider currently says — user may have
      // changed it mid-hold.
      audioEngine.setRate(useStore.getState().settings.playbackRate)
      useStore.getState().setFastForward(false)
      // If we started playback because the hold began from a paused state,
      // pause it again now that the hold is over.
      if (!wasPlayingBeforeHold.current) {
        pauseSong()
      }
    }
  }, [])

  // Window-level cleanup so the rate always restores even if the pointer
  // leaves the mesh, the tab loses focus, or pointercancel fires.
  useEffect(() => {
    const onUp = () => stopFastForward()
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('blur', onUp)
    return () => {
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', onUp)
      stopFastForward()
    }
  }, [stopFastForward])

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    if (holdTimer.current !== null || fastForwardActive.current) return
    holdTimer.current = window.setTimeout(async () => {
      holdTimer.current = null
      const token = ++holdToken.current
      const { transport, settings } = useStore.getState()
      wasPlayingBeforeHold.current = transport === 'playing'
      audioEngine.setRate(settings.playbackRate * 2)
      fastForwardActive.current = true
      useStore.getState().setFastForward(true)
      if (!wasPlayingBeforeHold.current) {
        await playSong()
        // If the user released while playSong was awaiting (sample load /
        // AudioContext resume), the cleanup pauseSong already ran but
        // playSong then re-set transport to 'playing' — undo that.
        if (holdToken.current !== token) {
          pauseSong()
        }
      }
    }, HOLD_THRESHOLD_MS)
  }

  const onPointerUp = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    const wasArmed = holdTimer.current !== null
    const wasFastForward = fastForwardActive.current
    stopFastForward()
    // Short click (released before the hold timer fired) → treat as toggle.
    if (wasArmed && !wasFastForward) {
      void togglePlayback()
    }
  }

  return (
    <>
      {upperHeight > 0 && (
        <mesh
          position={[0, upperCenterY, 0.01]}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
        >
          <planeGeometry args={[width, upperHeight]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
      {lowerHeight > 0 && (
        <mesh
          position={[0, lowerCenterY, 0.01]}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
        >
          <planeGeometry args={[width, lowerHeight]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </>
  )
}

function CameraSync({
  pos,
  lookAt,
  fov,
}: {
  pos: [number, number, number]
  lookAt: [number, number, number]
  fov: number
}) {
  const { camera } = useThree()
  useEffect(() => {
    camera.position.set(...pos)
    if ('fov' in camera) {
      ;(camera as THREE.PerspectiveCamera).fov = fov
      ;(camera as THREE.PerspectiveCamera).updateProjectionMatrix()
    }
    camera.lookAt(...lookAt)
  }, [camera, pos, lookAt, fov])
  // also follow each frame in case other code moves camera
  useFrame(() => {
    camera.lookAt(...lookAt)
  })
  return null
}
