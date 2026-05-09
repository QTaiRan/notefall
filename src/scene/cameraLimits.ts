// Shared camera limits — Inspector sliders and CameraControls mouse
// gestures both clamp against these so the two input paths can never
// drift the camera into a state the other can't represent.

export const CAMERA_LIMITS = {
  distance: { min: 0.5, max: 50 },
  horizontalDeg: { min: -90, max: 90 },
  verticalDeg: { min: -90, max: 90 },
  pivotX: { min: -10, max: 10 },
  pivotY: { min: -10, max: 10 },
  pivotZ: { min: -10, max: 10 },
} as const

export const clamp = (v: number, min: number, max: number) =>
  Math.max(min, Math.min(max, v))
