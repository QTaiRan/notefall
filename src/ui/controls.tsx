import type { CSSProperties } from 'react'
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

type SliderRowProps = {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  format?: (v: number) => string
}

export function SliderRow({ label, value, min, max, step = 0.01, onChange, format }: SliderRowProps) {
  return (
    <Slider
      value={value}
      minValue={min}
      maxValue={max}
      step={step}
      onChange={(v) => onChange(typeof v === 'number' ? v : v[0])}
      className="flex flex-col gap-1 py-1"
    >
      <div className="flex items-center justify-between text-xs">
        <Label className="text-neutral-400">{label}</Label>
        <SliderOutput className="text-neutral-200 tabular-nums">
          {format ? format(value) : value.toFixed(step < 1 ? 2 : 0)}
        </SliderOutput>
      </div>
      <SliderTrack className="relative flex h-4 w-full cursor-pointer items-center">
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
    </Slider>
  )
}

type SwitchRowProps = {
  label: string
  value: boolean
  onChange: (v: boolean) => void
}

export function SwitchRow({ label, value, onChange }: SwitchRowProps) {
  return (
    <Switch
      isSelected={value}
      onChange={onChange}
      className="group relative flex items-center justify-between gap-2 py-1.5 text-xs cursor-pointer"
    >
      <span className="text-neutral-400">{label}</span>
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
}

export function ColorRow({ label, value, onChange }: ColorRowProps) {
  return (
    <div className="flex items-center justify-between py-1 text-xs">
      <span className="text-neutral-400">{label}</span>
      <ColorPicker
        value={value}
        onChange={(color) => onChange(color.toString('hex'))}
      >
        <DialogTrigger>
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
}

export function SelectRow<T extends string>({ label, value, options, onChange }: SelectRowProps<T>) {
  return (
    <div className="flex items-center justify-between py-1 text-xs">
      <span className="text-neutral-400">{label}</span>
      <Select
        selectedKey={value}
        onSelectionChange={(k: Key | null) => k && onChange(String(k) as T)}
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

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
      {children}
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
}: VerticalSliderBandsProps) {
  const fmt = (v: number) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1))
  return (
    <div className="flex items-stretch justify-between gap-1 py-2">
      {labels.map((label, i) => (
        <div key={label} className="flex flex-1 flex-col items-center gap-1">
          <span className="text-[9px] tabular-nums text-neutral-400">
            {fmt(values[i] ?? 0)}
          </span>
          <Slider
            orientation="vertical"
            value={values[i] ?? 0}
            minValue={min}
            maxValue={max}
            step={step}
            onChange={(v) => onChange(i, typeof v === 'number' ? v : v[0])}
          >
            <SliderTrack
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
        </div>
      ))}
    </div>
  )
}
