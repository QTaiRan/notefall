import { useStore, defaultSettings } from '../store'
import { ColorRow, SectionTitle, SelectRow, SliderRow, SwitchRow } from './controls'
import { Button } from 'react-aria-components'

export function Inspector() {
  const s = useStore((st) => st.settings)
  const update = useStore((st) => st.updateSettings)
  const reset = useStore((st) => st.resetSettings)

  return (
    <aside className="flex h-full w-72 flex-col border-l border-neutral-800 bg-neutral-950">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2 text-xs font-medium text-neutral-300">
        <span>Inspector</span>
        <Button
          onPress={() => reset()}
          className="rounded px-2 py-0.5 text-[10px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          Reset
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-6">
        <SectionTitle>Camera</SectionTitle>
        <SliderRow label="FOV" value={s.cameraFov} min={20} max={80} step={1} onChange={(v) => update({ cameraFov: v })} />
        <SliderRow label="Position X" value={s.cameraPos[0]} min={-10} max={10} step={0.1} onChange={(v) => update({ cameraPos: [v, s.cameraPos[1], s.cameraPos[2]] })} />
        <SliderRow label="Position Y" value={s.cameraPos[1]} min={-2} max={10} step={0.1} onChange={(v) => update({ cameraPos: [s.cameraPos[0], v, s.cameraPos[2]] })} />
        <SliderRow label="Position Z" value={s.cameraPos[2]} min={1} max={20} step={0.1} onChange={(v) => update({ cameraPos: [s.cameraPos[0], s.cameraPos[1], v] })} />
        <SliderRow label="LookAt Y" value={s.cameraLookAt[1]} min={-3} max={3} step={0.1} onChange={(v) => update({ cameraLookAt: [s.cameraLookAt[0], v, s.cameraLookAt[2]] })} />

        <SectionTitle>Layout</SectionTitle>
        <SliderRow label="Keyboard Y" value={s.keyboardY} min={-3} max={2} step={0.05} onChange={(v) => update({ keyboardY: v })} />

        <SectionTitle>Notes</SectionTitle>
        <SelectRow
          label="Direction"
          value={s.fallDirection}
          options={[
            { value: 'down', label: 'Top → Bottom' },
            { value: 'up', label: 'Bottom → Top' },
          ]}
          onChange={(v) => update({ fallDirection: v })}
        />
        <SliderRow label="Fall Time (s)" value={s.fallDurationSec} min={0.5} max={8} step={0.1} onChange={(v) => update({ fallDurationSec: v })} />
        <ColorRow label="Color" value={s.noteColor} onChange={(v) => update({ noteColor: v })} />
        <SliderRow label="Emissive" value={s.noteEmissive} min={0} max={5} step={0.05} onChange={(v) => update({ noteEmissive: v })} />
        <SliderRow label="Opacity" value={s.noteOpacity} min={0} max={1} step={0.01} onChange={(v) => update({ noteOpacity: v })} />
        <SliderRow label="Width" value={s.noteWidthScale} min={0.2} max={1.5} step={0.01} onChange={(v) => update({ noteWidthScale: v })} />
        <SliderRow label="Corner Radius" value={s.noteCornerRadius} min={0} max={0.2} step={0.005} onChange={(v) => update({ noteCornerRadius: v })} />

        <SectionTitle>Bloom</SectionTitle>
        <SliderRow label="Intensity" value={s.bloomIntensity} min={0} max={4} step={0.05} onChange={(v) => update({ bloomIntensity: v })} />
        <SliderRow label="Threshold" value={s.bloomThreshold} min={0} max={1} step={0.01} onChange={(v) => update({ bloomThreshold: v })} />
        <SliderRow label="Radius" value={s.bloomRadius} min={0} max={1} step={0.01} onChange={(v) => update({ bloomRadius: v })} />
        <SliderRow label="Smoothing" value={s.bloomSmoothing} min={0} max={1} step={0.01} onChange={(v) => update({ bloomSmoothing: v })} />

        <SectionTitle>Scene</SectionTitle>
        <ColorRow label="Background" value={s.backgroundColor} onChange={(v) => update({ backgroundColor: v })} />

        <SectionTitle>Keyboard</SectionTitle>
        <SliderRow label="Brightness" value={s.keyboardBrightness} min={0} max={2} step={0.01} onChange={(v) => update({ keyboardBrightness: v })} />
        <ColorRow label="White Keys" value={s.whiteKeyColor} onChange={(v) => update({ whiteKeyColor: v })} />
        <ColorRow label="Black Keys" value={s.blackKeyColor} onChange={(v) => update({ blackKeyColor: v })} />
        <ColorRow label="Press Glow" value={s.keyGlowColor} onChange={(v) => update({ keyGlowColor: v })} />
        <SliderRow label="Glow Intensity" value={s.keyGlowIntensity} min={0} max={5} step={0.05} onChange={(v) => update({ keyGlowIntensity: v })} />
        <SliderRow label="Glow Decay (s)" value={s.keyGlowDecay} min={0.05} max={2} step={0.01} onChange={(v) => update({ keyGlowDecay: v })} />

        <SectionTitle>Audio</SectionTitle>
        <SliderRow label="Volume (dB)" value={s.volume} min={-40} max={6} step={0.5} onChange={(v) => update({ volume: v })} />
        <SliderRow label="Speed" value={s.playbackRate} min={0.25} max={2} step={0.05} onChange={(v) => update({ playbackRate: v })} />
        <SwitchRow label="Pedal Enabled" value={s.pedalEnabled} onChange={(v) => update({ pedalEnabled: v })} />

        <div className="mt-4 px-2 text-[10px] text-neutral-600">
          Default colors: {defaultSettings.noteColor}
        </div>
      </div>
    </aside>
  )
}
