import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  Slider,
  SliderOutput,
  SliderThumb,
  SliderTrack,
  Label,
  Switch,
  Select,
  SelectValue,
  Popover,
  ListBox,
  ListBoxItem,
  Button,
  ColorPicker,
  ColorArea,
  ColorSlider,
  ColorThumb,
  ColorField,
  ColorSwatch,
  Input,
  DialogTrigger,
  Dialog,
} from 'react-aria-components'
import type { Key } from 'react-aria-components'
import { useStore } from '../store'

/**
 * Wrap an atomic settings mutation in a begin/end pair so it produces
 * exactly one undo entry. Use for switches, selects, single-shot button
 * presses; for continuous gestures (slider drag, color popover session)
 * call begin/end directly around the gesture span instead.
 */
const commitAtomic = (apply: () => void): void => {
  const s = useStore.getState()
  s.beginSettingsEdit()
  apply()
  s.endSettingsEdit()
}

const isMacPlatform = () =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '')

/**
 * Floating context menu rendered at viewport coordinates. Used by slider
 * tracks to expose the reset gesture as a discoverable right-click action,
 * with the keyboard shortcut shown alongside.
 */
function SliderContextMenu({
  x,
  y,
  value,
  min,
  max,
  step,
  defaultValue,
  defaultLabel,
  onChange,
  onClose,
}: {
  x: number
  y: number
  value: number
  min: number
  max: number
  step: number
  defaultValue: number | undefined
  defaultLabel: string | undefined
  onChange: (v: number) => void
  onClose: () => void
}) {
  // Two-step UX: the menu first shows action items; clicking "Enter
  // Value…" swaps the body for the numeric input. Keeps the resting menu
  // visually clean while still surfacing the input affordance.
  const [mode, setMode] = useState<'menu' | 'input'>('menu')
  // Input is editable raw numeric text. Initial value uses a precision that
  // matches the slider's step — integer steps show no fractional digits,
  // sub-unit steps round to enough digits to represent the step.
  const decimals =
    step >= 1 ? 0 : step >= 0.01 ? 2 : step >= 0.001 ? 3 : 4
  const [text, setText] = useState(() =>
    Number.isFinite(value) ? value.toFixed(decimals) : '',
  )
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (mode === 'input') {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [mode])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest('[data-slider-context-menu]')) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    // Defer attaching mousedown by a tick — the right-click that opened
    // the menu would otherwise immediately hit this handler and close it.
    const t = window.setTimeout(() => window.addEventListener('mousedown', onDown), 0)
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const commit = () => {
    const parsed = parseFloat(text)
    if (Number.isFinite(parsed)) {
      const clamped = Math.max(min, Math.min(max, parsed))
      onChange(clamped)
    }
    onClose()
  }

  const valueText = Number.isFinite(value) ? value.toFixed(decimals) : ''
  const handleCopy = () => {
    void navigator.clipboard?.writeText(valueText)
    onClose()
  }
  const handlePaste = async () => {
    try {
      const t = await navigator.clipboard?.readText()
      const parsed = parseFloat(t ?? '')
      if (Number.isFinite(parsed)) {
        onChange(Math.max(min, Math.min(max, parsed)))
      }
    } catch {
      // Permission denied / unsupported — silently ignore. The user will
      // see the menu close and the value unchanged, no toast needed.
    }
    onClose()
  }

  const shortcut = isMacPlatform() ? '⌘ Click' : 'Ctrl Click'
  const W = 224
  // Rough vertical estimate per mode for edge-clamping. Menu mode has
  // input + copy/paste + min/max + (optional reset) + 2 separators.
  const H =
    mode === 'input'
      ? 110
      : 36 + 36 + 36 + (defaultValue !== undefined ? 36 : 0) + 18
  const PAD = 8
  const left = Math.max(PAD, Math.min(x, window.innerWidth - W - PAD))
  const top = Math.max(PAD, Math.min(y, window.innerHeight - H - PAD))

  const itemClass =
    'flex w-full items-center justify-between gap-4 rounded px-2 py-1.5 text-left text-xs text-neutral-200 outline-none hover:bg-neutral-800 focus-visible:bg-neutral-800'
  const hintClass = 'text-[10px] tabular-nums text-neutral-500'
  const Separator = () => <div className="my-1 h-px bg-neutral-800" />

  return (
    <div
      data-slider-context-menu
      className="fixed z-[100] w-[14rem] rounded-md bg-neutral-900 p-1 shadow-lg ring-1 ring-white/10"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {mode === 'menu' ? (
        <>
          <button
            type="button"
            onClick={() => setMode('input')}
            className={itemClass}
          >
            <span>Enter Value…</span>
            <span className={hintClass}>{valueText}</span>
          </button>
          <Separator />
          <button type="button" onClick={handleCopy} className={itemClass}>
            <span>Copy</span>
            <span className={hintClass}>{valueText}</span>
          </button>
          <button type="button" onClick={handlePaste} className={itemClass}>
            <span>Paste</span>
          </button>
          {defaultValue !== undefined && (
            <>
              <Separator />
              <button
                type="button"
                onClick={() => {
                  onChange(defaultValue)
                  onClose()
                }}
                className={itemClass}
              >
                <span>
                  Reset to default
                  {defaultLabel !== undefined && (
                    <span className="ml-1 text-[10px] tabular-nums text-neutral-500">
                      ({defaultLabel})
                    </span>
                  )}
                </span>
                <span className="text-[10px] tracking-wider text-neutral-500">
                  {shortcut}
                </span>
              </button>
            </>
          )}
        </>
      ) : (
        <div className="px-2 pt-1.5 pb-1">
          <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-neutral-500">
            <span>Value</span>
            <span className="tabular-nums normal-case tracking-normal">
              {min}…{max}
            </span>
          </div>
          <input
            ref={inputRef}
            type="text"
            inputMode="decimal"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setMode('menu')
              }
            }}
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs tabular-nums text-neutral-100 outline-none focus:border-sky-500"
          />
          <div className="mt-1 flex items-center justify-between text-[9px] text-neutral-600">
            <span>Enter to apply</span>
            <button
              type="button"
              onClick={() => setMode('menu')}
              className="rounded px-1 py-0.5 text-neutral-500 outline-none hover:bg-neutral-800 hover:text-neutral-300"
            >
              ← Back
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Returns a ref to attach to a SliderTrack — when the user Cmd/Ctrl+clicks
 * inside it, the slider snaps to `defaultValue` instead of jumping to the
 * click position. Right-clicks open a small context menu offering the same
 * reset, with the keyboard shortcut shown.
 *
 * Implementation: registers a NATIVE pointerdown listener in the capture
 * phase + stopImmediatePropagation, so react-aria's own pointerdown
 * (which would jump-to-click) never sees the event. React's synthetic
 * onPointerDownCapture isn't strong enough here — react-aria attaches its
 * handlers via direct DOM listeners that React can't pre-empt.
 */
function useSliderTrackGestures({
  value,
  min,
  max,
  step,
  defaultValue,
  onChange,
  format,
}: {
  value: number
  min: number
  max: number
  step: number
  defaultValue: number | undefined
  onChange: (v: number) => void
  format?: (v: number) => string
}): { ref: React.RefObject<HTMLDivElement>; menuNode: ReactNode } {
  const ref = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  // Keep latest values in a ref so the listener (registered once) sees fresh
  // closures without re-attaching on every render.
  const latest = useRef({ defaultValue, onChange })
  latest.current = { defaultValue, onChange }
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const downHandler = (e: PointerEvent) => {
      // Right-click: swallow the pointerdown so react-aria's slider doesn't
      // jump to the click position — the contextmenu handler below will
      // open our menu instead.
      if (e.button === 2) {
        e.preventDefault()
        e.stopImmediatePropagation()
        return
      }
      if (e.button !== 0) return
      const { defaultValue, onChange } = latest.current
      if (defaultValue === undefined) return
      if (!(e.metaKey || e.ctrlKey)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      commitAtomic(() => onChange(defaultValue))
    }
    const ctxHandler = (e: MouseEvent) => {
      e.preventDefault()
      // On macOS, Ctrl+click fires contextmenu but is already handled as
      // the reset gesture via pointerdown when a default exists. Don't
      // open the menu in that case.
      if (e.ctrlKey && latest.current.defaultValue !== undefined) return
      setMenu({ x: e.clientX, y: e.clientY })
    }
    el.addEventListener('pointerdown', downHandler, true)
    el.addEventListener('contextmenu', ctxHandler)
    return () => {
      el.removeEventListener('pointerdown', downHandler, true)
      el.removeEventListener('contextmenu', ctxHandler)
    }
  }, [])

  const menuNode = menu ? (
    <SliderContextMenu
      x={menu.x}
      y={menu.y}
      value={value}
      min={min}
      max={max}
      step={step}
      defaultValue={defaultValue}
      defaultLabel={
        defaultValue !== undefined
          ? format
            ? format(defaultValue)
            : defaultValue.toFixed(step < 1 ? 2 : 0)
          : undefined
      }
      onChange={(v) => commitAtomic(() => latest.current.onChange(v))}
      onClose={() => setMenu(null)}
    />
  ) : null

  return { ref, menuNode }
}

type SliderRowProps = {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  format?: (v: number) => string
  /** Double-clicking the label / value row resets to this. */
  defaultValue?: number
}

export function SliderRow({ label, value, min, max, step = 0.01, onChange, format, defaultValue }: SliderRowProps) {
  const { ref: trackRef, menuNode } = useSliderTrackGestures({
    value,
    min,
    max,
    step,
    defaultValue,
    onChange,
    format,
  })
  // Bracket the gesture (drag OR keyboard nudge) so the whole interaction
  // produces one undo entry. begin is idempotent — first onChange opens
  // the gesture; onChangeEnd closes it. react-aria fires onChangeEnd for
  // both pointer release AND keyboard arrows, so each press of an arrow
  // key also commits as its own entry.
  const gestureOpen = useRef(false)
  return (
    <Slider
      value={value}
      minValue={min}
      maxValue={max}
      step={step}
      onChange={(v) => {
        if (!gestureOpen.current) {
          gestureOpen.current = true
          useStore.getState().beginSettingsEdit()
        }
        onChange(typeof v === 'number' ? v : v[0])
      }}
      onChangeEnd={() => {
        if (gestureOpen.current) {
          gestureOpen.current = false
          useStore.getState().endSettingsEdit()
        }
      }}
      className="flex flex-col gap-1 py-1"
    >
      <div className="flex items-center justify-between text-xs select-none">
        <Label className="text-neutral-400">{label}</Label>
        <SliderOutput className="text-neutral-200 tabular-nums">
          {format ? format(value) : value.toFixed(step < 1 ? 2 : 0)}
        </SliderOutput>
      </div>
      <SliderTrack
        ref={trackRef}
        className="relative flex h-4 w-full cursor-pointer items-center"
      >
        {({ state, isHovered }) => {
          const expanded = isHovered || state.isThumbDragging(0)
          return (
            <>
              <div
                className={`relative w-full overflow-hidden rounded-full transition-all duration-150 ${
                  expanded ? 'h-2 bg-neutral-700' : 'h-1.5 bg-neutral-800'
                }`}
              >
                <div
                  className={`h-full transition-colors duration-150 ${
                    expanded ? 'bg-sky-400' : 'bg-sky-500/80'
                  }`}
                  style={{ width: `${state.getThumbPercent(0) * 100}%` }}
                />
              </div>
              <SliderThumb
                className={`top-1/2 h-3 w-3 rounded-full bg-white shadow ring-1 ring-neutral-900 outline-none transition-all duration-150 ${
                  expanded ? 'scale-100 opacity-100' : 'scale-0 opacity-0'
                } data-[dragging]:scale-125 focus-visible:scale-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-sky-400`}
              />
            </>
          )
        }}
      </SliderTrack>
      {menuNode}
    </Slider>
  )
}

type SwitchRowProps = {
  label: string
  value: boolean
  onChange: (v: boolean) => void
  /** Double-clicking the label resets to this. */
  defaultValue?: boolean
}

export function SwitchRow({ label, value, onChange, defaultValue }: SwitchRowProps) {
  return (
    <Switch
      isSelected={value}
      onChange={(v) => commitAtomic(() => onChange(v))}
      className="group relative flex items-center justify-between gap-2 py-1.5 text-xs cursor-pointer"
    >
      <span
        className="text-neutral-400 select-none"
        // Stop the propagating click so the toggle doesn't flip on the
        // double-click; then apply the default. preventDefault for good
        // measure since react-aria's Switch listens for label-like clicks.
        onDoubleClick={
          defaultValue !== undefined
            ? (e) => {
                e.preventDefault()
                e.stopPropagation()
                commitAtomic(() => onChange(defaultValue))
              }
            : undefined
        }
        title={defaultValue !== undefined ? 'Double-click to reset' : undefined}
      >
        {label}
      </span>
      <span className="relative inline-block h-4 w-7 rounded-full bg-neutral-700 transition group-data-[selected]:bg-sky-500">
        <span className="absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white transition group-data-[selected]:translate-x-3" />
      </span>
    </Switch>
  )
}

type ColorRowProps = {
  label: string
  value: string
  onChange: (v: string) => void
  /** Double-clicking the label resets to this. */
  defaultValue?: string
}

export function ColorRow({ label, value, onChange, defaultValue }: ColorRowProps) {
  const reset =
    defaultValue !== undefined
      ? () => commitAtomic(() => onChange(defaultValue))
      : undefined
  return (
    <div className="flex items-center justify-between py-1 text-xs">
      <span
        className={`text-neutral-400 select-none ${reset ? 'cursor-pointer' : ''}`}
        onDoubleClick={reset}
        title={reset ? 'Double-click to reset' : undefined}
      >
        {label}
      </span>
      <ColorPicker
        value={value}
        onChange={(color) => onChange(color.toString('hex'))}
      >
        <DialogTrigger
          onOpenChange={(open) => {
            // A whole color-picker session (popover open → close) is one
            // undo entry, regardless of how many drags / hex-field edits
            // happened inside. Drags inside the popover fire onChange
            // ~60×/s, so per-change history would saturate the stack.
            const s = useStore.getState()
            if (open) s.beginSettingsEdit()
            else s.endSettingsEdit()
          }}
        >
          <Button
            aria-label={`Edit ${label} color`}
            className="flex items-center gap-2 rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 outline-none hover:border-neutral-600 focus-visible:border-sky-500"
          >
            <ColorSwatch className="h-4 w-4 rounded ring-1 ring-neutral-700" />
            <span className="font-mono text-[10px] uppercase text-neutral-300">{value}</span>
          </Button>
          <Popover
            placement="bottom end"
            className="rounded-lg border border-neutral-700 bg-neutral-900 p-3 shadow-xl outline-none data-[entering]:animate-in data-[entering]:fade-in data-[entering]:duration-150"
          >
            <Dialog className="flex flex-col gap-3 outline-none">
              <ColorArea
                colorSpace="hsb"
                xChannel="saturation"
                yChannel="brightness"
                className="relative h-44 w-44 rounded"
              >
                <ColorThumb className="z-10 h-4 w-4 rounded-full border-2 border-white shadow-md ring-1 ring-black/40 outline-none data-[focus-visible]:h-5 data-[focus-visible]:w-5" />
              </ColorArea>
              <ColorSlider colorSpace="hsb" channel="hue" className="flex flex-col gap-1">
                <SliderTrack className="relative h-3 w-44 rounded">
                  <ColorThumb className="top-1/2 h-4 w-4 rounded-full border-2 border-white shadow-md ring-1 ring-black/40 outline-none data-[focus-visible]:h-5 data-[focus-visible]:w-5" />
                </SliderTrack>
              </ColorSlider>
              <ColorField className="flex items-center gap-2">
                <Label className="text-[10px] uppercase tracking-wider text-neutral-500">Hex</Label>
                <Input className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 font-mono text-xs uppercase text-neutral-200 outline-none focus-visible:border-sky-500" />
              </ColorField>
            </Dialog>
          </Popover>
        </DialogTrigger>
      </ColorPicker>
    </div>
  )
}

type SelectRowProps<T extends string> = {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  /** Double-clicking the label resets to this. */
  defaultValue?: T
}

export function SelectRow<T extends string>({ label, value, options, onChange, defaultValue }: SelectRowProps<T>) {
  const reset =
    defaultValue !== undefined
      ? () => commitAtomic(() => onChange(defaultValue))
      : undefined
  return (
    <div className="flex items-center justify-between py-1 text-xs">
      <span
        className={`text-neutral-400 select-none ${reset ? 'cursor-pointer' : ''}`}
        onDoubleClick={reset}
        title={reset ? 'Double-click to reset' : undefined}
      >
        {label}
      </span>
      <Select
        selectedKey={value}
        onSelectionChange={(k: Key | null) =>
          k && commitAtomic(() => onChange(String(k) as T))
        }
      >
        <Button className="flex items-center gap-2 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-200 outline-none focus-visible:border-sky-500">
          <SelectValue />
          <span className="text-neutral-500">▾</span>
        </Button>
        <Popover className="rounded border border-neutral-700 bg-neutral-900 p-1 shadow-xl">
          <ListBox className="outline-none">
            {options.map((o) => (
              <ListBoxItem
                key={o.value}
                id={o.value}
                className="cursor-pointer rounded px-2 py-1 text-neutral-200 outline-none data-[focused]:bg-neutral-800"
              >
                {o.label}
              </ListBoxItem>
            ))}
          </ListBox>
        </Popover>
      </Select>
    </div>
  )
}

export function SectionTitle({
  children,
  action,
}: {
  children: React.ReactNode
  /** Optional right-aligned slot — typically a section-scoped reset button. */
  action?: React.ReactNode
}) {
  return (
    <div className="mt-3 mb-1 flex items-center justify-between px-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
      <span>{children}</span>
      {action}
    </div>
  )
}

type VerticalSliderBandsProps = {
  values: number[]
  labels: string[]
  min: number
  max: number
  step?: number
  onChange: (index: number, value: number) => void
  /** Pixel height of the slider track. */
  trackHeight?: number
  /** Per-band default — double-clicking the band's readout resets it. */
  defaultValues?: number[]
}

/**
 * Graphic-EQ-style row of vertical sliders. Each slider shows a value
 * readout above and a frequency / category label below. The fill grows
 * from a center line at value=0 in either direction so the user can see
 * cuts and boosts symmetrically (mixer convention).
 *
 * Range is symmetric around 0 (e.g. min=-12, max=+12); the center-line
 * fill assumes that. Asymmetric ranges will still work but the fill won't
 * align with "neutral".
 */
export function VerticalSliderBands({
  values,
  labels,
  min,
  max,
  step = 0.5,
  onChange,
  trackHeight = 96,
  defaultValues,
}: VerticalSliderBandsProps) {
  return (
    <div className="flex items-stretch justify-between gap-1 py-2">
      {labels.map((label, i) => (
        <Band
          key={label}
          label={label}
          value={values[i] ?? 0}
          min={min}
          max={max}
          step={step}
          trackHeight={trackHeight}
          defaultValue={defaultValues?.[i]}
          onChange={(v) => onChange(i, v)}
        />
      ))}
    </div>
  )
}

type BandProps = {
  label: string
  value: number
  min: number
  max: number
  step: number
  trackHeight: number
  defaultValue?: number
  onChange: (v: number) => void
}

/**
 * Single column inside VerticalSliderBands. Split out so each band can own
 * its own ref + reset listener (the modifier-click hook needs a stable ref
 * per element, which doesn't compose with the .map() in the parent).
 */
function Band({ label, value, min, max, step, trackHeight, defaultValue, onChange }: BandProps) {
  const fmt = (v: number) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1))
  const { ref: trackRef, menuNode } = useSliderTrackGestures({
    value,
    min,
    max,
    step,
    defaultValue,
    onChange,
    format: fmt,
  })
  const gestureOpen = useRef(false)
  return (
    <div className="flex flex-1 flex-col items-center gap-1">
      <span className="text-[9px] tabular-nums text-neutral-400 select-none">
        {fmt(value)}
      </span>
      <Slider
        orientation="vertical"
        value={value}
        minValue={min}
        maxValue={max}
        step={step}
        onChange={(v) => {
          if (!gestureOpen.current) {
            gestureOpen.current = true
            useStore.getState().beginSettingsEdit()
          }
          onChange(typeof v === 'number' ? v : v[0])
        }}
        onChangeEnd={() => {
          if (gestureOpen.current) {
            gestureOpen.current = false
            useStore.getState().endSettingsEdit()
          }
        }}
      >
        <SliderTrack
          ref={trackRef}
          className="relative w-2 cursor-pointer"
          style={{ height: trackHeight }}
        >
          {({ state, isHovered }) => {
            const percent = state.getThumbPercent(0)
            const expanded = isHovered || state.isThumbDragging(0)
            // Fill from the 50% line out to the thumb position.
            // percent: 0 = bottom (min), 1 = top (max), 0.5 = center.
            const fillStyle: CSSProperties =
              percent >= 0.5
                ? { bottom: '50%', height: `${(percent - 0.5) * 100}%` }
                : { top: '50%', height: `${(0.5 - percent) * 100}%` }
            return (
              <>
                <div
                  className={`absolute inset-0 rounded-full transition-colors duration-150 ${
                    expanded ? 'bg-neutral-700' : 'bg-neutral-800'
                  }`}
                />
                {/* Center reference line (0 dB) */}
                <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-neutral-600" />
                <div
                  className={`absolute inset-x-0 rounded-full transition-colors duration-150 ${
                    expanded ? 'bg-sky-400' : 'bg-sky-500/80'
                  }`}
                  style={fillStyle}
                />
                <SliderThumb
                  className={`left-1/2 h-3 w-3 rounded-full bg-white shadow ring-1 ring-neutral-900 outline-none transition-all duration-150 ${
                    expanded ? 'scale-100 opacity-100' : 'scale-0 opacity-0'
                  } data-[dragging]:scale-125 focus-visible:scale-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-sky-400`}
                />
              </>
            )
          }}
        </SliderTrack>
      </Slider>
      <span className="text-[9px] text-neutral-500">{label}</span>
      {menuNode}
    </div>
  )
}
