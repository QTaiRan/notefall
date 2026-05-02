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
      <SliderTrack className="relative h-1.5 w-full rounded-full bg-neutral-800">
        {({ state }) => (
          <>
            <div
              className="absolute h-full rounded-full bg-sky-500/80"
              style={{ width: `${state.getThumbPercent(0) * 100}%` }}
            />
            <SliderThumb className="top-1/2 h-3.5 w-3.5 rounded-full bg-white shadow ring-1 ring-neutral-900 outline-none focus-visible:ring-2 focus-visible:ring-sky-400" />
          </>
        )}
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
    <label className="flex items-center justify-between py-1 text-xs">
      <span className="text-neutral-400">{label}</span>
      <span className="flex items-center gap-2">
        <span
          className="h-4 w-4 rounded ring-1 ring-neutral-700"
          style={{ background: value }}
        />
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-6 w-10 cursor-pointer rounded border border-neutral-700 bg-transparent"
        />
      </span>
    </label>
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
