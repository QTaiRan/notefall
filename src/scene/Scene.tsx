import { Canvas } from '@react-three/fiber'
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import * as THREE from 'three'
import { useStore } from '../store'
import { Keyboard } from '../keyboard/Keyboard'
import { FallingNotes } from '../notes/FallingNotes'

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
      <EffectComposer>
        <Bloom
          intensity={s.bloomIntensity}
          luminanceThreshold={s.bloomThreshold}
          luminanceSmoothing={s.bloomSmoothing}
          radius={s.bloomRadius}
          mipmapBlur
        />
      </EffectComposer>
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
      <Keyboard />
      <FallingNotes />
    </>
  )
}

import { useThree, useFrame } from '@react-three/fiber'
import { useEffect } from 'react'

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
