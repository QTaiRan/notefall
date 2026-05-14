import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { rowMatchesQuery, useSearchQuery } from './controls'
import {
  DEFAULT_VELOCITY_CURVE,
  clampVelocityCurve,
  evaluateVelocityCurve,
  velocityCurvesEqual,
  type VelocityCurve,
  type VelocityCurvePoint,
} from '../audio/velocityCurve'

const W = 248
const H = 120
const PAD_X = 8
const PAD_Y = 6
const PLOT_W = W - PAD_X * 2
const PLOT_H = H - PAD_Y * 2

const TICK_XS: number[] = (() => {
  const xs: number[] = []
  for (let i = 0; i < 88; i++) xs.push(i / 87)
  return xs
})()

const SAMPLE_STEPS = 64

type HandleKey = 'p0' | 'p1' | 'p2' | 'p3' | 'p4'
const ALL_HANDLES: readonly HandleKey[] = ['p0', 'p1', 'p2', 'p3', 'p4'] as const

function buildPathD(sample: number[]): string {
  let d = ''
  for (let i = 0; i < sample.length; i++) {
    const x = PAD_X + (i / (sample.length - 1)) * PLOT_W
    const y = PAD_Y + (1 - sample[i]) * PLOT_H
    d += i === 0 ? `M${x.toFixed(2)} ${y.toFixed(2)}` : ` L${x.toFixed(2)} ${y.toFixed(2)}`
  }
  return d
}

type DragState = {
  pointerId: number
  handle: HandleKey
  moved: boolean
}

// Endpoints are pinned on the X axis — only their Y is movable. Interior
// points are free in both axes (clamped by `clampVelocityCurve`).
function applyHandleDrag(
  curve: VelocityCurve,
  handle: HandleKey,
  pos: VelocityCurvePoint,
): VelocityCurve {
  switch (handle) {
    case 'p0':
      return { ...curve, p0: { x: 0, y: pos.y } }
    case 'p1':
      return { ...curve, p1: pos }
    case 'p2':
      return { ...curve, p2: pos }
    case 'p3':
      return { ...curve, p3: pos }
    case 'p4':
      return { ...curve, p4: { x: 1, y: pos.y } }
  }
}

export function VelocityCurveEditor() {
  const curve = useStore((s) => s.settings.velocityCurve)
  const update = useStore((s) => s.updateSettings)
  const begin = useStore((s) => s.beginSettingsEdit)
  const end = useStore((s) => s.endSettingsEdit)

  const svgRef = useRef<SVGSVGElement | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  // Drag state ref so window listeners always see the latest curve+drag
  // (avoids re-binding on every move).
  const curveRef = useRef(curve)
  curveRef.current = curve
  const labelId = useId()

  const sampled = useMemo(() => {
    const out: number[] = new Array(SAMPLE_STEPS + 1)
    for (let i = 0; i <= SAMPLE_STEPS; i++) {
      out[i] = evaluateVelocityCurve(curve, i / SAMPLE_STEPS)
    }
    return out
  }, [curve])

  const pathD = useMemo(() => buildPathD(sampled), [sampled])

  const clientToCurve = (clientX: number, clientY: number): VelocityCurvePoint | null => {
    const svg = svgRef.current
    if (!svg) return null
    const pt = svg.createSVGPoint()
    pt.x = clientX
    pt.y = clientY
    const ctm = svg.getScreenCTM()
    if (!ctm) return null
    const local = pt.matrixTransform(ctm.inverse())
    return {
      x: (local.x - PAD_X) / PLOT_W,
      y: 1 - (local.y - PAD_Y) / PLOT_H,
    }
  }

  const onPointerDown = (handle: HandleKey) => (e: React.PointerEvent) => {
    e.stopPropagation()
    // Cmd/Ctrl + click resets just this handle to its default position
    // (the same value the identity curve has for that index). No drag
    // is started — release behaves like a normal click.
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault()
      const def = DEFAULT_VELOCITY_CURVE[handle]
      if (curveRef.current[handle].x === def.x && curveRef.current[handle].y === def.y) return
      begin()
      update({ velocityCurve: clampVelocityCurve({ ...curveRef.current, [handle]: def }) })
      end()
      return
    }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    begin()
    setDrag({ pointerId: e.pointerId, handle, moved: false })
  }

  useEffect(() => {
    if (!drag) return
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== drag.pointerId) return
      const pos = clientToCurve(e.clientX, e.clientY)
      if (!pos) return
      if (!drag.moved) drag.moved = true
      const next = applyHandleDrag(curveRef.current, drag.handle, pos)
      update({ velocityCurve: clampVelocityCurve(next) })
    }
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== drag.pointerId) return
      setDrag(null)
      end()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [drag, update, end])

  // Double-click on the empty plot resets the whole curve to identity.
  const onDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as Element).hasAttribute('data-handle')) return
    if (velocityCurvesEqual(curve, DEFAULT_VELOCITY_CURVE)) return
    begin()
    update({ velocityCurve: DEFAULT_VELOCITY_CURVE })
    end()
  }

  const handlePx: Record<HandleKey, { x: number; y: number }> = {
    p0: { x: PAD_X + curve.p0.x * PLOT_W, y: PAD_Y + (1 - curve.p0.y) * PLOT_H },
    p1: { x: PAD_X + curve.p1.x * PLOT_W, y: PAD_Y + (1 - curve.p1.y) * PLOT_H },
    p2: { x: PAD_X + curve.p2.x * PLOT_W, y: PAD_Y + (1 - curve.p2.y) * PLOT_H },
    p3: { x: PAD_X + curve.p3.x * PLOT_W, y: PAD_Y + (1 - curve.p3.y) * PLOT_H },
    p4: { x: PAD_X + curve.p4.x * PLOT_W, y: PAD_Y + (1 - curve.p4.y) * PLOT_H },
  }

  const q = useSearchQuery()
  if (!rowMatchesQuery('Velocity Curve', q)) return null
  return (
    <div data-search-label="Velocity Curve" className="flex flex-col gap-2 py-1">
      <div className="flex items-center text-xs select-none">
        <span id={labelId} className="text-neutral-400">Velocity Curve</span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        aria-labelledby={labelId}
        className="w-full select-none rounded bg-neutral-900/60 ring-1 ring-neutral-800"
        style={{ aspectRatio: `${W} / ${H}`, touchAction: 'none' }}
        onDoubleClick={onDoubleClick}
      >
        {TICK_XS.map((tx, i) => {
          const idx = Math.round(tx * SAMPLE_STEPS)
          const v = sampled[idx]
          const x = PAD_X + tx * PLOT_W
          const h = v * PLOT_H
          return (
            <rect
              key={i}
              x={x - 1}
              y={PAD_Y + (PLOT_H - h)}
              width={2}
              height={h}
              fill="#525252"
            />
          )
        })}
        <path
          d={pathD}
          fill="none"
          stroke="#60a5fa"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {ALL_HANDLES.map((key) => {
          const px = handlePx[key]
          return (
            <g key={key}>
              <circle
                data-handle={key}
                cx={px.x}
                cy={px.y}
                r={12}
                fill="transparent"
                style={{
                  cursor: drag?.handle === key
                    ? 'grabbing'
                    : key === 'p0' || key === 'p4'
                      ? 'ns-resize'
                      : 'grab',
                }}
                onPointerDown={onPointerDown(key)}
              />
              <circle
                cx={px.x}
                cy={px.y}
                r={5}
                fill="#e5e7eb"
                stroke="#0a0a0a"
                strokeWidth={1.5}
                pointerEvents="none"
              />
            </g>
          )
        })}
      </svg>
    </div>
  )
}
