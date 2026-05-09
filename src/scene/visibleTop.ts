import * as THREE from 'three'

// Hard cap on how far above the hit line the "visible top" is allowed
// to grow. Without it, steep look-up angles produce ray-plane misses
// (the top NDC ray runs past the horizon) or massive intersection
// distances that would spawn / persist huge counts of falling notes
// off-screen. The cap converts that into a steady ceiling.
export const MAX_LIVE_VISIBLE_ABOVE_HIT = 30

const _pos = new THREE.Vector3()
const _target = new THREE.Vector3()
const _view = new THREE.Vector3()
const _right = new THREE.Vector3()
const _camUp = new THREE.Vector3()
const _rayDir = new THREE.Vector3()
const _worldUp = new THREE.Vector3(0, 1, 0)

/**
 * World-Y of the highest point the camera can see at depth `noteZ`.
 *
 * Computed by reconstructing the camera's view basis from settings
 * (pos / lookAt / FOV), forming the top-center NDC ray
 * (view + camUp · tan(fovV/2)), and intersecting it with the plane
 * z = noteZ. Returns a hard cap (`hitY + MAX_LIVE_VISIBLE_ABOVE_HIT`)
 * when the ray runs past the horizon, so callers see a smooth ceiling
 * instead of a snap-shorter when the camera tilts steeply upward.
 *
 * Aspect is irrelevant — only the vertical FOV affects how far up the
 * top of the frustum reaches. Doesn't need the THREE camera object,
 * so it's safe to call during React render as well as useFrame.
 */
export function computeLiveVisibleTop(
  cameraPos: readonly [number, number, number],
  cameraLookAt: readonly [number, number, number],
  cameraFov: number,
  noteZ: number,
  hitY: number,
): number {
  const cap = hitY + MAX_LIVE_VISIBLE_ABOVE_HIT
  _pos.set(cameraPos[0], cameraPos[1], cameraPos[2])
  _target.set(cameraLookAt[0], cameraLookAt[1], cameraLookAt[2])
  _view.copy(_target).sub(_pos)
  if (_view.lengthSq() < 1e-12) return cap
  _view.normalize()
  _right.crossVectors(_view, _worldUp)
  if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0)
  _right.normalize()
  _camUp.crossVectors(_right, _view).normalize()
  const tanHalfV = Math.tan((cameraFov * Math.PI) / 360)
  _rayDir.copy(_view).addScaledVector(_camUp, tanHalfV)
  if (Math.abs(_rayDir.z) > 1e-4) {
    const tHit = (noteZ - _pos.z) / _rayDir.z
    if (tHit > 0 && Number.isFinite(tHit)) {
      return Math.min(cap, _pos.y + tHit * _rayDir.y)
    }
  }
  return cap
}
