import { useStore, defaultSettings } from '../store'
import { ColorRow, SectionTitle, SelectRow, SliderRow, SwitchRow, VerticalSliderBands } from './controls'
import { Button, FileTrigger, OverlayArrow, Tooltip, TooltipTrigger } from 'react-aria-components'
import { useCustomTexture } from '../notes/customTexture'

const EQ_LABELS = ['80', '250', '800', '2.5k', '6k', '12k']

// Short alias used for the per-row `defaultValue` props that wire up
// double-click-to-reset on every control.
const def = defaultSettings

export function Inspector() {
  const s = useStore((st) => st.settings)
  const update = useStore((st) => st.updateSettings)
  const reset = useStore((st) => st.resetSettings)
  const customFileName = useCustomTexture((st) => st.fileName)
  const setCustomFile = useCustomTexture((st) => st.setFromFile)

  return (
    <aside className="flex h-full w-72 flex-col border-l border-neutral-800 bg-neutral-950">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2 text-xs font-medium text-neutral-300">
        <span>Inspector</span>
        <TooltipTrigger delay={300}>
          <Button
            onPress={() => reset()}
            className="rounded px-2 py-0.5 text-[10px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          >
            Reset
          </Button>
          <Tooltip
            offset={6}
            className="rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1 text-[10px] text-neutral-200 shadow-lg outline-none data-[entering]:animate-in data-[entering]:fade-in data-[exiting]:animate-out data-[exiting]:fade-out"
          >
            <OverlayArrow>
              <svg viewBox="0 0 8 8" width={8} height={8} className="fill-neutral-800 stroke-neutral-700 group-data-[placement=bottom]/popover:rotate-180">
                <path d="M0 0 L4 4 L8 0" />
              </svg>
            </OverlayArrow>
            Reset all settings to defaults
          </Tooltip>
        </TooltipTrigger>
      </div>
      <div className="scroll-thin flex-1 overflow-y-auto px-3 pb-6">
        <SectionTitle>Camera</SectionTitle>
        <SliderRow label="FOV" value={s.cameraFov} min={20} max={80} step={1} onChange={(v) => update({ cameraFov: v })} defaultValue={def.cameraFov} />
        <SliderRow label="Position X" value={s.cameraPos[0]} min={-10} max={10} step={0.1} onChange={(v) => update({ cameraPos: [v, s.cameraPos[1], s.cameraPos[2]] })} defaultValue={def.cameraPos[0]} />
        <SliderRow label="Position Y" value={s.cameraPos[1]} min={-2} max={10} step={0.1} onChange={(v) => update({ cameraPos: [s.cameraPos[0], v, s.cameraPos[2]] })} defaultValue={def.cameraPos[1]} />
        <SliderRow label="Position Z" value={s.cameraPos[2]} min={1} max={20} step={0.1} onChange={(v) => update({ cameraPos: [s.cameraPos[0], s.cameraPos[1], v] })} defaultValue={def.cameraPos[2]} />
        <SliderRow label="LookAt Y" value={s.cameraLookAt[1]} min={-3} max={3} step={0.1} onChange={(v) => update({ cameraLookAt: [s.cameraLookAt[0], v, s.cameraLookAt[2]] })} defaultValue={def.cameraLookAt[1]} />

        <SectionTitle>Layout</SectionTitle>
        <SliderRow label="Keyboard Y" value={s.keyboardY} min={-3} max={2} step={0.05} onChange={(v) => update({ keyboardY: v })} defaultValue={def.keyboardY} />

        <SectionTitle>Notes</SectionTitle>
        <SelectRow
          label="Direction"
          value={s.fallDirection}
          options={[
            { value: 'down', label: 'Top → Bottom' },
            { value: 'up', label: 'Bottom → Top' },
          ]}
          onChange={(v) => update({ fallDirection: v })}
          defaultValue={def.fallDirection}
        />
        <SliderRow label="Fall Time (s)" value={s.fallDurationSec} min={0.5} max={8} step={0.1} onChange={(v) => update({ fallDurationSec: v })} defaultValue={def.fallDurationSec} />
        <ColorRow label="Color" value={s.noteColor} onChange={(v) => update({ noteColor: v })} defaultValue={def.noteColor} />
        <SliderRow label="Emissive" value={s.noteEmissive} min={0} max={20} step={0.1} onChange={(v) => update({ noteEmissive: v })} defaultValue={def.noteEmissive} />
        <SliderRow label="Opacity" value={s.noteOpacity} min={0} max={1} step={0.01} onChange={(v) => update({ noteOpacity: v })} defaultValue={def.noteOpacity} />
        <SliderRow label="Width" value={s.noteWidthScale} min={0.2} max={1.5} step={0.01} onChange={(v) => update({ noteWidthScale: v })} defaultValue={def.noteWidthScale} />
        <SliderRow label="Corner Radius" value={s.noteCornerRadius} min={0} max={0.2} step={0.005} onChange={(v) => update({ noteCornerRadius: v })} defaultValue={def.noteCornerRadius} />
        <SliderRow label="Min Length" value={s.noteMinLength} min={0} max={0.6} step={0.01} onChange={(v) => update({ noteMinLength: v })} defaultValue={def.noteMinLength} />
        <SelectRow
          label="Texture"
          value={s.noteTexture}
          options={[
            { value: 'solid', label: 'Solid' },
            { value: 'liquid', label: 'Liquid' },
            { value: 'gem', label: 'Gem' },
            { value: 'custom', label: 'Custom Image' },
          ]}
          onChange={(v) => update({ noteTexture: v })}
          defaultValue={def.noteTexture}
        />
        {s.noteTexture === 'custom' && (
          <div className="flex items-center gap-2 px-2 py-1">
            <FileTrigger
              acceptedFileTypes={['image/*']}
              onSelect={async (e) => {
                if (!e) return
                const file = Array.from(e)[0]
                if (file) await setCustomFile(file)
              }}
            >
              <Button className="rounded bg-neutral-800 px-2 py-1 text-[10px] text-neutral-200 hover:bg-neutral-700">
                Choose Image
              </Button>
            </FileTrigger>
            <span className="flex-1 truncate text-[10px] text-neutral-400">
              {customFileName ?? 'No image'}
            </span>
            {customFileName && (
              <Button
                onPress={() => setCustomFile(null)}
                className="rounded px-1.5 py-0.5 text-[10px] text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
              >
                Clear
              </Button>
            )}
          </div>
        )}
        {/* Texture Scale / Animation / Contrast only matter for the
            generative or image-based presets — Solid is a flat tint. Rim
            applies to every preset and is always shown below. */}
        {s.noteTexture !== 'solid' && (
          // Generative presets benefit from a wider range (denser cells /
          // tighter swirls); custom-image stays at 4 since beyond that the
          // image becomes nearly subpixel and reads as noise.
          <SliderRow
            label="Texture Scale"
            value={s.noteTextureScale}
            min={0.01}
            max={s.noteTexture === 'custom' ? 4 : 20}
            step={0.01}
            onChange={(v) => update({ noteTextureScale: v })}
            defaultValue={def.noteTextureScale}
          />
        )}
        {s.noteTexture !== 'solid' && (
          <>
            <SliderRow label="Offset X" value={s.noteTextureOffsetX} min={-3} max={3} step={0.01} onChange={(v) => update({ noteTextureOffsetX: v })} defaultValue={def.noteTextureOffsetX} />
            <SliderRow label="Offset Y" value={s.noteTextureOffsetY} min={-3} max={3} step={0.01} onChange={(v) => update({ noteTextureOffsetY: v })} defaultValue={def.noteTextureOffsetY} />
          </>
        )}
        {/* Custom: independent X/Y scroll. Liquid/Gem: a single rate (their
            patterns aren't directional) which we route through animSpeedY
            since that's the value their shader code reads. */}
        {s.noteTexture === 'custom' ? (
          <>
            <SliderRow label="Animation Speed X" value={s.noteAnimSpeedX} min={-3} max={3} step={0.05} onChange={(v) => update({ noteAnimSpeedX: v })} defaultValue={def.noteAnimSpeedX} />
            <SliderRow label="Animation Speed Y" value={s.noteAnimSpeedY} min={-3} max={3} step={0.05} onChange={(v) => update({ noteAnimSpeedY: v })} defaultValue={def.noteAnimSpeedY} />
          </>
        ) : (s.noteTexture === 'liquid' || s.noteTexture === 'gem') ? (
          <SliderRow label="Animation Speed" value={s.noteAnimSpeedY} min={0} max={3} step={0.05} onChange={(v) => update({ noteAnimSpeedY: v })} defaultValue={def.noteAnimSpeedY} />
        ) : null}
        {s.noteTexture === 'custom' && (
          <>
            <SliderRow label="Blur" value={s.noteTextureBlur} min={0} max={6} step={0.05} onChange={(v) => update({ noteTextureBlur: v })} defaultValue={def.noteTextureBlur} />
            <SliderRow label="Per-Note Variation" value={s.noteTextureVariation} min={0} max={1} step={0.01} onChange={(v) => update({ noteTextureVariation: v })} defaultValue={def.noteTextureVariation} />
          </>
        )}
        {s.noteTexture !== 'solid' && (
          <SliderRow label="Texture Contrast" value={s.noteTextureContrast} min={0.3} max={20} step={0.1} onChange={(v) => update({ noteTextureContrast: v })} defaultValue={def.noteTextureContrast} />
        )}

        <SectionTitle>Rim</SectionTitle>
        <ColorRow label="Color" value={s.noteRimColor} onChange={(v) => update({ noteRimColor: v })} defaultValue={def.noteRimColor} />
        <SliderRow label="Width" value={s.noteRimWidth} min={0} max={0.1} step={0.001} onChange={(v) => update({ noteRimWidth: v })} defaultValue={def.noteRimWidth} />
        <SliderRow label="Intensity" value={s.noteRimIntensity} min={0} max={5} step={0.05} onChange={(v) => update({ noteRimIntensity: v })} defaultValue={def.noteRimIntensity} />

        <SectionTitle>Flash</SectionTitle>
        <SliderRow label="Intensity" value={s.flashIntensity} min={0} max={2} step={0.05} onChange={(v) => update({ flashIntensity: v })} defaultValue={def.flashIntensity} />
        <SliderRow label="Size" value={s.flashSize} min={0.3} max={5} step={0.05} onChange={(v) => update({ flashSize: v })} defaultValue={def.flashSize} />
        <SliderRow label="Width" value={s.flashWidth} min={0.3} max={5} step={0.05} onChange={(v) => update({ flashWidth: v })} defaultValue={def.flashWidth} />
        <SliderRow label="Halo" value={s.flashHaloWidth} min={0} max={2} step={0.05} onChange={(v) => update({ flashHaloWidth: v })} defaultValue={def.flashHaloWidth} />
        <ColorRow label="Color" value={s.flashColor} onChange={(v) => update({ flashColor: v })} defaultValue={def.flashColor} />

        <SectionTitle>Particles</SectionTitle>
        <SwitchRow label="Enabled" value={s.particlesEnabled} onChange={(v) => update({ particlesEnabled: v })} defaultValue={def.particlesEnabled} />
        <ColorRow label="Color" value={s.particleColor} onChange={(v) => update({ particleColor: v })} defaultValue={def.particleColor} />
        <SliderRow label="Size" value={s.particleSize} min={0} max={2} step={0.01} onChange={(v) => update({ particleSize: v })} defaultValue={def.particleSize} />
        <SliderRow label="Opacity" value={s.particleOpacity} min={0} max={1} step={0.01} onChange={(v) => update({ particleOpacity: v })} defaultValue={def.particleOpacity} />
        <SliderRow label="Brightness" value={s.particleBrightness} min={0} max={2} step={0.01} onChange={(v) => update({ particleBrightness: v })} defaultValue={def.particleBrightness} />
        <SliderRow label="Lifetime" value={s.particleLifetime} min={0.1} max={3} step={0.05} onChange={(v) => update({ particleLifetime: v })} defaultValue={def.particleLifetime} />
        <SliderRow label="Speed" value={s.particleSpeed} min={0} max={3} step={0.05} onChange={(v) => update({ particleSpeed: v })} defaultValue={def.particleSpeed} />
        <SliderRow label="Count" value={s.particleCount} min={0} max={30} step={0.1} onChange={(v) => update({ particleCount: v })} defaultValue={def.particleCount} />
        <SliderRow label="Turbulence" value={s.particleTurbulence} min={0} max={2} step={0.05} onChange={(v) => update({ particleTurbulence: v })} defaultValue={def.particleTurbulence} />
        <SliderRow label="Turb Frequency" value={s.turbulenceFrequency} min={0} max={5} step={0.05} onChange={(v) => update({ turbulenceFrequency: v })} defaultValue={def.turbulenceFrequency} />
        <SliderRow label="Flow Speed" value={s.flowSpeed} min={0} max={16} step={0.05} onChange={(v) => update({ flowSpeed: v })} defaultValue={def.flowSpeed} />
        <SliderRow label="Turbulence X" value={s.turbulenceX} min={0} max={2} step={0.05} onChange={(v) => update({ turbulenceX: v })} defaultValue={def.turbulenceX} />
        <SliderRow label="Turbulence Y" value={s.turbulenceY} min={0} max={2} step={0.05} onChange={(v) => update({ turbulenceY: v })} defaultValue={def.turbulenceY} />
        <SliderRow label="Turbulence Z" value={s.turbulenceZ} min={0} max={2} step={0.05} onChange={(v) => update({ turbulenceZ: v })} defaultValue={def.turbulenceZ} />
        <SliderRow label="Locality" value={s.noiseLocality} min={0} max={1} step={0.01} onChange={(v) => update({ noiseLocality: v })} defaultValue={def.noiseLocality} />
        <SliderRow label="Octaves" value={s.turbulenceOctaves} min={1} max={4} step={1} onChange={(v) => update({ turbulenceOctaves: v })} defaultValue={def.turbulenceOctaves} />
        <SliderRow label="Octave Scale" value={s.octaveScale} min={0.5} max={3} step={0.05} onChange={(v) => update({ octaveScale: v })} defaultValue={def.octaveScale} />
        <SliderRow label="Octave Mul" value={s.octaveMultiplier} min={0} max={1} step={0.01} onChange={(v) => update({ octaveMultiplier: v })} defaultValue={def.octaveMultiplier} />
        <SliderRow label="Drag" value={s.drag} min={0} max={1} step={0.01} onChange={(v) => update({ drag: v })} defaultValue={def.drag} />
        <SliderRow label="Swirl" value={s.swirl} min={0} max={1} step={0.01} onChange={(v) => update({ swirl: v })} defaultValue={def.swirl} />
        <SliderRow label="Kick" value={s.kick} min={0} max={3} step={0.05} onChange={(v) => update({ kick: v })} defaultValue={def.kick} />

        <SectionTitle>Hit Line</SectionTitle>
        <SwitchRow label="Enabled" value={s.hitLineEnabled} onChange={(v) => update({ hitLineEnabled: v })} defaultValue={def.hitLineEnabled} />
        <ColorRow label="Color" value={s.hitLineColor} onChange={(v) => update({ hitLineColor: v })} defaultValue={def.hitLineColor} />
        <SliderRow label="Bar Intensity" value={s.hitLineIntensity} min={0} max={8} step={0.05} onChange={(v) => update({ hitLineIntensity: v })} defaultValue={def.hitLineIntensity} />
        <SliderRow label="Bar Y" value={s.hitLineBarY} min={-1} max={1} step={0.01} onChange={(v) => update({ hitLineBarY: v })} defaultValue={def.hitLineBarY} />
        <SliderRow label="Bar Thickness" value={s.hitLineThickness} min={0} max={1} step={0.01} onChange={(v) => update({ hitLineThickness: v })} defaultValue={def.hitLineThickness} />
        <SliderRow label="Bar Halo" value={s.hitLineBarHalo} min={0} max={6} step={0.05} onChange={(v) => update({ hitLineBarHalo: v })} defaultValue={def.hitLineBarHalo} />
        <SliderRow label="Wave Intensity" value={s.hitLineWaveIntensity} min={0} max={4} step={0.05} onChange={(v) => update({ hitLineWaveIntensity: v })} defaultValue={def.hitLineWaveIntensity} />
        <SliderRow label="Wave Y" value={s.hitLineWaveY} min={-1} max={1} step={0.01} onChange={(v) => update({ hitLineWaveY: v })} defaultValue={def.hitLineWaveY} />
        <SliderRow label="Wave Amplitude" value={s.hitLineWaveAmplitude} min={0} max={1} step={0.01} onChange={(v) => update({ hitLineWaveAmplitude: v })} defaultValue={def.hitLineWaveAmplitude} />
        <SliderRow label="Wave Scale" value={s.hitLineWaveScale} min={0.5} max={200} step={0.5} onChange={(v) => update({ hitLineWaveScale: v })} defaultValue={def.hitLineWaveScale} />
        <SliderRow label="Wave Scroll Speed" value={s.hitLineWaveScrollSpeed} min={-3} max={3} step={0.05} onChange={(v) => update({ hitLineWaveScrollSpeed: v })} defaultValue={def.hitLineWaveScrollSpeed} />
        <SliderRow label="Wave Morph Speed" value={s.hitLineWaveMorphSpeed} min={0} max={3} step={0.05} onChange={(v) => update({ hitLineWaveMorphSpeed: v })} defaultValue={def.hitLineWaveMorphSpeed} />
        <SliderRow label="Wave Thickness" value={s.hitLineWaveThickness} min={0} max={0.2} step={0.005} onChange={(v) => update({ hitLineWaveThickness: v })} defaultValue={def.hitLineWaveThickness} />
        <SliderRow label="Wave Halo" value={s.hitLineWaveHalo} min={0} max={3} step={0.05} onChange={(v) => update({ hitLineWaveHalo: v })} defaultValue={def.hitLineWaveHalo} />
        <SliderRow label="Wave Grain" value={s.hitLineWaveGrain} min={0} max={3} step={0.05} onChange={(v) => update({ hitLineWaveGrain: v })} defaultValue={def.hitLineWaveGrain} />

        {/* Bloom is a global post-process applied AFTER all the visual
            emitters above, so it sits at the end of that group rather than
            mixed into any single emitter's section. */}
        <SectionTitle>Bloom</SectionTitle>
        <SliderRow label="Intensity" value={s.bloomIntensity} min={0} max={4} step={0.05} onChange={(v) => update({ bloomIntensity: v })} defaultValue={def.bloomIntensity} />
        <SliderRow label="Threshold" value={s.bloomThreshold} min={0} max={1} step={0.01} onChange={(v) => update({ bloomThreshold: v })} defaultValue={def.bloomThreshold} />
        <SliderRow label="Radius" value={s.bloomRadius} min={0} max={1} step={0.01} onChange={(v) => update({ bloomRadius: v })} defaultValue={def.bloomRadius} />
        <SliderRow label="Smoothing" value={s.bloomSmoothing} min={0} max={1} step={0.01} onChange={(v) => update({ bloomSmoothing: v })} defaultValue={def.bloomSmoothing} />

        <SectionTitle>Scene</SectionTitle>
        <ColorRow label="Background" value={s.backgroundColor} onChange={(v) => update({ backgroundColor: v })} defaultValue={def.backgroundColor} />

        <SectionTitle>Keyboard</SectionTitle>
        <SliderRow label="Brightness" value={s.keyboardBrightness} min={0} max={2} step={0.01} onChange={(v) => update({ keyboardBrightness: v })} defaultValue={def.keyboardBrightness} />
        <ColorRow label="White Keys" value={s.whiteKeyColor} onChange={(v) => update({ whiteKeyColor: v })} defaultValue={def.whiteKeyColor} />
        <ColorRow label="Black Keys" value={s.blackKeyColor} onChange={(v) => update({ blackKeyColor: v })} defaultValue={def.blackKeyColor} />
        <ColorRow label="Press Glow" value={s.keyGlowColor} onChange={(v) => update({ keyGlowColor: v })} defaultValue={def.keyGlowColor} />
        <SliderRow label="Glow Intensity" value={s.keyGlowIntensity} min={0} max={5} step={0.05} onChange={(v) => update({ keyGlowIntensity: v })} defaultValue={def.keyGlowIntensity} />
        <SliderRow label="Glow Decay (s)" value={s.keyGlowDecay} min={0.05} max={2} step={0.01} onChange={(v) => update({ keyGlowDecay: v })} defaultValue={def.keyGlowDecay} />

        <SectionTitle>Audio</SectionTitle>
        <SliderRow label="Release (s)" value={s.releaseTime} min={0.01} max={1.5} step={0.01} onChange={(v) => update({ releaseTime: v })} defaultValue={def.releaseTime} />
        <SliderRow label="Detune (¢)" value={s.samplerDetune} min={-100} max={100} step={1} onChange={(v) => update({ samplerDetune: v })} defaultValue={def.samplerDetune} />
        <div className="px-2 pt-1 text-[10px] text-neutral-400">EQ (Hz)</div>
        <VerticalSliderBands
          values={s.eqBands}
          labels={EQ_LABELS}
          min={-12}
          max={12}
          step={0.5}
          onChange={(i, v) => {
            const next = s.eqBands.slice()
            next[i] = v
            update({ eqBands: next })
          }}
          defaultValues={def.eqBands}
        />
        <SliderRow label="Velocity Curve" value={s.velocityGamma} min={0.3} max={3} step={0.05} onChange={(v) => update({ velocityGamma: v })} defaultValue={def.velocityGamma} />
        <SliderRow label="Velocity Floor" value={s.velocityFloor} min={0} max={1} step={0.01} onChange={(v) => update({ velocityFloor: v })} defaultValue={def.velocityFloor} />
        <SliderRow label="Velocity Cap" value={s.velocityCap} min={0} max={1} step={0.01} onChange={(v) => update({ velocityCap: v })} defaultValue={def.velocityCap} />
        <SliderRow label="Transpose" value={s.transpose} min={-24} max={24} step={1} onChange={(v) => update({ transpose: v })} defaultValue={def.transpose} />
        <SwitchRow label="Pedal Enabled" value={s.pedalEnabled} onChange={(v) => update({ pedalEnabled: v })} defaultValue={def.pedalEnabled} />

        <SectionTitle>Reverb</SectionTitle>
        <SwitchRow label="Enabled" value={s.reverbEnabled} onChange={(v) => update({ reverbEnabled: v })} defaultValue={def.reverbEnabled} />
        <SliderRow label="Dry" value={s.reverbDry} min={0} max={2} step={0.01} onChange={(v) => update({ reverbDry: v })} defaultValue={def.reverbDry} />
        <SliderRow label="Wet" value={s.reverbWet} min={0} max={2} step={0.01} onChange={(v) => update({ reverbWet: v })} defaultValue={def.reverbWet} />
        <SliderRow label="Size (s)" value={s.reverbSize} min={0.3} max={5} step={0.1} onChange={(v) => update({ reverbSize: v })} defaultValue={def.reverbSize} />
        <SliderRow label="Decay Time (s)" value={s.reverbDecayTime} min={0.1} max={8} step={0.05} onChange={(v) => update({ reverbDecayTime: v })} defaultValue={def.reverbDecayTime} />
        <SliderRow label="Decay" value={s.reverbDecay} min={0} max={6} step={0.05} onChange={(v) => update({ reverbDecay: v })} defaultValue={def.reverbDecay} />
        <SliderRow label="Pre-Delay (ms)" value={s.reverbPreDelay * 1000} min={0} max={200} step={1} onChange={(v) => update({ reverbPreDelay: v / 1000 })} defaultValue={def.reverbPreDelay * 1000} />
        <SliderRow label="Damping" value={s.reverbDamping} min={0} max={0.99} step={0.01} onChange={(v) => update({ reverbDamping: v })} defaultValue={def.reverbDamping} />
        <SliderRow label="Hi Cut (Hz)" value={s.reverbHiCut} min={500} max={20000} step={100} onChange={(v) => update({ reverbHiCut: v })} defaultValue={def.reverbHiCut} />
        <SliderRow label="Low Cut (Hz)" value={s.reverbLowCut} min={20} max={1000} step={10} onChange={(v) => update({ reverbLowCut: v })} defaultValue={def.reverbLowCut} />

        <div className="mt-4 px-2 text-[10px] text-neutral-600">
          Default colors: {defaultSettings.noteColor}
        </div>
      </div>
    </aside>
  )
}
