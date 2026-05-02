import { useEffect, useRef, useState } from 'react'
import { Scene } from '../scene/Scene'
import { useStore } from '../store'
import { audioEngine } from '../audio/engine'
import { parseMidi } from '../midi/parse'

const ASPECT = 16 / 9

export function Viewport() {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [dragOver, setDragOver] = useState(false)
  const setSong = useStore((s) => s.setSong)
  const setTransport = useStore((s) => s.setTransport)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      const containerAspect = r.width / r.height
      let w: number, h: number
      if (containerAspect > ASPECT) {
        h = r.height
        w = h * ASPECT
      } else {
        w = r.width
        h = w / ASPECT
      }
      setSize({ w, h })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    const buf = await file.arrayBuffer()
    const parsed = await parseMidi(buf, file.name)
    setSong(parsed)
    audioEngine.loadSong(parsed)
    setTransport('stopped')
  }

  return (
    <div
      ref={wrapRef}
      className="relative flex flex-1 items-center justify-center overflow-hidden bg-black"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div
        className="relative shadow-2xl"
        style={{ width: size.w, height: size.h, touchAction: 'none' }}
      >
        <Scene />
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-sky-500/10 ring-2 ring-inset ring-sky-400">
            <span className="rounded bg-neutral-950/80 px-3 py-1 text-sm text-sky-300">
              Drop MIDI file
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
