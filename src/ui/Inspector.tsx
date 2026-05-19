import { useState } from 'react'
import { useStore, defaultSettings, type Settings } from '../store'
import {
  BoundColorRow,
  BoundSliderRow,
  BoundSwitchRow,
  ColorRow,
  SearchableBlock,
  SearchProvider,
  Section,
  SelectRow,
  SliderRow,
  VerticalSliderBands,
  useEffectiveSetting,
} from './controls'
import { VelocityCurveEditor } from './VelocityCurveEditor'
import { Button, FileTrigger, OverlayArrow, Tooltip, TooltipTrigger } from 'react-aria-components'
import { useCustomTexture } from '../notes/customTexture'
import { CAMERA_LIMITS } from '../scene/cameraLimits'

const EQ_LABELS = ['80', '250', '800', '2.5k', '6k', '12k']

// Short alias used for the per-row `defaultValue` props that wire up
// double-click-to-reset on every control.
const def = defaultSettings

// ── Atomic settings mutation helpers ─────────────────────────────────
//
// Each section below mutates settings by name without going through a
// shared `update(patch)` closure — that closure captured the whole
// `settings` object and forced Inspector to subscribe to all of it. The
// Bound* row wrappers subscribe per-key internally, and these helpers
// give the few hand-rolled callsites the same begin/end bracketing
// without forcing a wide subscription on the parent component.
function atomicUpdate(patch: Partial<Settings>): void {
  const s = useStore.getState()
  s.beginSettingsEdit()
  s.updateSettings(patch)
  s.endSettingsEdit()
}

// ── Camera section ───────────────────────────────────────────────────
function CameraSection() {
  const cameraPos = useEffectiveSetting('cameraPos')
  const cameraLookAt = useEffectiveSetting('cameraLookAt')
  // Re-express the cartesian camera state as the seven knobs the user
  // actually thinks in terms of (orbit triple + pivot triple + FOV).
  const dx = cameraPos[0] - cameraLookAt[0]
  const dy = cameraPos[1] - cameraLookAt[1]
  const dz = cameraPos[2] - cameraLookAt[2]
  const distance = Math.hypot(dx, dy, dz) || 1e-6
  const phi = Math.acos(Math.max(-1, Math.min(1, dy / distance)))
  const theta = Math.atan2(dx, dz)
  const tiltDeg = 90 - (phi * 180) / Math.PI
  const yawDeg = (theta * 180) / Math.PI
  const writeOrbit = (
    nextDistance: number,
    nextTiltDeg: number,
    nextYawDeg: number,
  ) => {
    // Pull the tilt slightly off the poles to keep yaw recoverable.
    const TILT_EPS = 0.01
    const clampedTilt = Math.max(
      -90 + TILT_EPS,
      Math.min(90 - TILT_EPS, nextTiltDeg),
    )
    const nextPhi = ((90 - clampedTilt) * Math.PI) / 180
    const nextTheta = (nextYawDeg * Math.PI) / 180
    const sinPhi = Math.sin(nextPhi)
    const nx = nextDistance * sinPhi * Math.sin(nextTheta)
    const ny = nextDistance * Math.cos(nextPhi)
    const nz = nextDistance * sinPhi * Math.cos(nextTheta)
    atomicUpdate({
      cameraPos: [
        cameraLookAt[0] + nx,
        cameraLookAt[1] + ny,
        cameraLookAt[2] + nz,
      ],
    })
  }
  const writePivot = (axis: 0 | 1 | 2, value: number) => {
    const delta = value - cameraLookAt[axis]
    const nextLookAt: [number, number, number] = [...cameraLookAt]
    const nextPos: [number, number, number] = [...cameraPos]
    nextLookAt[axis] = value
    nextPos[axis] += delta
    atomicUpdate({ cameraLookAt: nextLookAt, cameraPos: nextPos })
  }
  return (
    <>
      <SliderRow
        label="Distance"
        value={distance}
        min={CAMERA_LIMITS.distance.min}
        max={CAMERA_LIMITS.distance.max}
        step={0.1}
        onChange={(v) => writeOrbit(v, tiltDeg, yawDeg)}
        defaultValue={def.cameraPos[2]}
      />
      <SliderRow
        label="Horizontal"
        value={yawDeg}
        min={CAMERA_LIMITS.horizontalDeg.min}
        max={CAMERA_LIMITS.horizontalDeg.max}
        step={1}
        onChange={(v) => writeOrbit(distance, tiltDeg, v)}
        format={(v) => `${Math.round(v)}°`}
        defaultValue={0}
      />
      <SliderRow
        label="Vertical"
        value={tiltDeg}
        min={CAMERA_LIMITS.verticalDeg.min}
        max={CAMERA_LIMITS.verticalDeg.max}
        step={1}
        onChange={(v) => writeOrbit(distance, v, yawDeg)}
        format={(v) => `${Math.round(v)}°`}
        defaultValue={0}
      />
      <SliderRow
        label="Pivot X"
        value={cameraLookAt[0]}
        min={CAMERA_LIMITS.pivotX.min}
        max={CAMERA_LIMITS.pivotX.max}
        step={0.05}
        onChange={(v) => writePivot(0, v)}
        defaultValue={def.cameraLookAt[0]}
      />
      <SliderRow
        label="Pivot Y"
        value={cameraLookAt[1]}
        min={CAMERA_LIMITS.pivotY.min}
        max={CAMERA_LIMITS.pivotY.max}
        step={0.05}
        onChange={(v) => writePivot(1, v)}
        defaultValue={def.cameraLookAt[1]}
      />
      <SliderRow
        label="Pivot Z"
        value={cameraLookAt[2]}
        min={CAMERA_LIMITS.pivotZ.min}
        max={CAMERA_LIMITS.pivotZ.max}
        step={0.05}
        onChange={(v) => writePivot(2, v)}
        defaultValue={def.cameraLookAt[2]}
      />
    </>
  )
}

// ── Theme section ────────────────────────────────────────────────────
function ThemeSection() {
  const themeColor = useEffectiveSetting('themeColor')
  return (
    <ColorRow
      label="Color"
      value={themeColor}
      onChange={(v) =>
        atomicUpdate({
          themeColor: v,
          noteColor: v,
          hitLineColor: v,
          particleColor: v,
        })
      }
      defaultValue={def.themeColor}
    />
  )
}

// ── Notes: track color rows ──────────────────────────────────────────
function TrackColorRows() {
  const song = useStore((st) => st.song)
  const trackColors = useEffectiveSetting('trackColors')
  const noteColor = useEffectiveSetting('noteColor')
  const noteTracks =
    song?.tracks.map((t, idx) => ({ t, idx })).filter(({ t }) => t.hasNotes) ?? []
  if (noteTracks.length === 0) {
    return <BoundColorRow label="Color" settingKey="noteColor" />
  }
  return (
    <>
      {noteTracks.map(({ t, idx }) => {
        const key = String(idx)
        const hasOverride = trackColors[key] !== undefined
        const value = trackColors[key] ?? noteColor
        return (
          <ColorRow
            key={idx}
            label={t.name}
            value={value}
            onChange={(v) =>
              atomicUpdate({ trackColors: { ...trackColors, [key]: v } })
            }
            defaultValue={noteColor}
            isModified={hasOverride}
            onReset={
              hasOverride
                ? () => {
                    const next = { ...trackColors }
                    delete next[key]
                    atomicUpdate({ trackColors: next })
                  }
                : undefined
            }
          />
        )
      })}
    </>
  )
}

// ── Notes: texture subsection (depends on noteTexture preset) ────────
function TextureControls() {
  const noteTexture = useStore((st) => st.settings.noteTexture)
  const customFileName = useCustomTexture((st) => st.fileName)
  const setCustomFile = useCustomTexture((st) => st.setFromFile)
  return (
    <>
      <SelectRow
        label="Texture"
        value={noteTexture}
        options={[
          { value: 'solid', label: 'Solid' },
          { value: 'liquid', label: 'Liquid' },
          { value: 'gem', label: 'Gem' },
          { value: 'custom', label: 'Custom Image' },
        ]}
        onChange={(v) => atomicUpdate({ noteTexture: v })}
        defaultValue={def.noteTexture}
      />
      {noteTexture === 'custom' && (
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
      {noteTexture !== 'solid' && (
        <BoundSliderRow
          label="Texture Scale"
          settingKey="noteTextureScale"
          min={0.01}
          max={noteTexture === 'custom' ? 4 : 20}
          step={0.01}
        />
      )}
      {noteTexture !== 'solid' && (
        <>
          <BoundSliderRow label="Offset X" settingKey="noteTextureOffsetX" min={-3} max={3} step={0.01} />
          <BoundSliderRow label="Offset Y" settingKey="noteTextureOffsetY" min={-3} max={3} step={0.01} />
        </>
      )}
      {noteTexture === 'custom' ? (
        <>
          <BoundSliderRow label="Animation Speed X" settingKey="noteAnimSpeedX" min={-3} max={3} step={0.05} />
          <BoundSliderRow label="Animation Speed Y" settingKey="noteAnimSpeedY" min={-3} max={3} step={0.05} />
        </>
      ) : noteTexture === 'liquid' || noteTexture === 'gem' ? (
        <BoundSliderRow label="Animation Speed" settingKey="noteAnimSpeedY" min={0} max={3} step={0.05} />
      ) : null}
      {noteTexture === 'custom' && (
        <>
          <BoundSliderRow label="Blur" settingKey="noteTextureBlur" min={0} max={6} step={0.05} />
          <BoundSliderRow label="Per-Note Variation" settingKey="noteTextureVariation" min={0} max={1} step={0.01} />
        </>
      )}
      {noteTexture !== 'solid' && (
        <BoundSliderRow label="Texture Contrast" settingKey="noteTextureContrast" min={0.3} max={20} step={0.1} />
      )}
    </>
  )
}

// ── Flash: color row gated on `flashFollowNote` ──────────────────────
function FlashColorRow() {
  const flashFollowNote = useStore((st) => st.settings.flashFollowNote)
  if (flashFollowNote) return null
  return <BoundColorRow label="Color" settingKey="flashColor" />
}

// ── Keyboard: glow color row gated on `keyGlowFollowNote` ────────────
function GlowColorRow() {
  const keyGlowFollowNote = useStore((st) => st.settings.keyGlowFollowNote)
  if (keyGlowFollowNote) return null
  return <BoundColorRow label="Glow Color" settingKey="keyGlowColor" />
}

// ── Audio: EQ band row ───────────────────────────────────────────────
function EqRow() {
  const eqBands = useStore((st) => st.settings.eqBands)
  return (
    <SearchableBlock label="EQ Equalizer">
      <div className="pt-1 text-[10px] text-neutral-400">EQ (Hz)</div>
      <VerticalSliderBands
        values={eqBands}
        labels={EQ_LABELS}
        min={-12}
        max={12}
        step={0.5}
        onChange={(i, v) => {
          const next = eqBands.slice()
          next[i] = v
          atomicUpdate({ eqBands: next })
        }}
        defaultValues={def.eqBands}
      />
    </SearchableBlock>
  )
}

// ── Notes: fall direction select ─────────────────────────────────────
function FallDirectionRow() {
  const fallDirection = useStore((st) => st.settings.fallDirection)
  return (
    <SelectRow
      label="Direction"
      value={fallDirection}
      options={[
        { value: 'down', label: 'Top → Bottom' },
        { value: 'up', label: 'Bottom → Top' },
      ]}
      onChange={(v) => atomicUpdate({ fallDirection: v })}
      defaultValue={def.fallDirection}
    />
  )
}

// ── Audio: pre-delay needs unit conversion (s ↔ ms) ──────────────────
function PreDelayRow() {
  const reverbPreDelay = useStore((st) => st.settings.reverbPreDelay)
  return (
    <SliderRow
      label="Pre-Delay (ms)"
      value={reverbPreDelay * 1000}
      min={0}
      max={200}
      step={1}
      onChange={(v) => atomicUpdate({ reverbPreDelay: v / 1000 })}
      defaultValue={def.reverbPreDelay * 1000}
    />
  )
}

// Indicator of WHAT the Inspector controls currently edit: the
// SELECTED pin (set by clicking a pin / adding one), or the base
// "default look" when none is selected. The two are held separately —
// editing a pin never touches the default. The "Default" button
// deselects so the user can edit the default look (and back via a pin
// click). With no pins at all there's nothing to disambiguate.
function PinEditingBanner() {
  const keyframes = useStore((st) => st.settings.settingsKeyframes)
  const editingTime = useStore((st) => st.editingKeyframeTime)
  if (keyframes.length === 0) return null
  const idx =
    editingTime !== null
      ? keyframes.findIndex((p) => Math.abs(p.time - editingTime) < 1e-6)
      : -1
  // No pin selected → editing the separate, editable base default look.
  if (idx < 0) {
    return (
      <div className="flex items-center gap-2 border-b border-sky-500/30 bg-sky-500/10 px-3 py-1.5">
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-sky-300" />
        <span className="flex-1 truncate text-[11px] text-sky-200">
          Editing default look — click a pin to edit it
        </span>
      </div>
    )
  }
  const s = Math.max(0, keyframes[idx].time)
  const m = Math.floor(s / 60)
  const r = s - m * 60
  const stamp = `${m}:${r.toFixed(2).padStart(5, '0')}`
  return (
    <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5">
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 rotate-45 rounded-[1px] bg-amber-300"
      />
      <span className="flex-1 truncate text-[11px] text-amber-200">
        Editing pin {idx + 1}/{keyframes.length} @ {stamp}
      </span>
      <button
        type="button"
        onClick={() => useStore.getState().selectKeyframe(null)}
        className="shrink-0 rounded bg-amber-500/20 px-2 py-0.5 text-[10px] text-amber-100 outline-none hover:bg-amber-500/35"
      >
        Default
      </button>
    </div>
  )
}

export function Inspector() {
  const reset = useStore((st) => st.resetSettings)
  const [query, setQuery] = useState('')

  return (
    <aside className="flex h-full w-72 flex-col border-l border-neutral-800 bg-neutral-950">
      <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <div className="relative flex-1">
          <svg
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-neutral-500"
            width="11"
            height="11"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden
          >
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M11 11L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search settings…"
            spellCheck={false}
            className="w-full rounded border border-neutral-800 bg-neutral-900 py-1 pl-7 pr-7 text-xs text-neutral-200 placeholder-neutral-500 outline-none focus:border-sky-600"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-neutral-500 outline-none hover:bg-neutral-800 hover:text-neutral-200"
            >
              <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden>
                <path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
        <TooltipTrigger delay={300}>
          <Button
            onPress={() => reset()}
            className="shrink-0 rounded px-2 py-0.5 text-[10px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
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
      <PinEditingBanner />
      <SearchProvider query={query}>
      <div className="scroll-thin flex-1 overflow-y-auto px-3 pb-6">
        <Section title="Camera">
          <CameraSection />
          <p className="px-2 pt-1 pb-2 text-[10px] leading-snug text-neutral-500">
            Drag with the middle mouse button to orbit, Shift+middle to pan,
            and Ctrl/Cmd+scroll to zoom.
          </p>
        </Section>

        <Section title="Layout">
          <BoundSliderRow label="Keyboard Y" settingKey="keyboardY" min={-3} max={2} step={0.05} />
        </Section>

        <Section title="Theme">
          <ThemeSection />
        </Section>

        <Section title="Notes">
          <BoundSwitchRow label="Enabled" settingKey="notesEnabled" />
          <FallDirectionRow />
          <BoundSliderRow label="Fall Time (s)" settingKey="fallDurationSec" min={0.5} max={8} step={0.1} />
          <TrackColorRows />
          <BoundSliderRow label="Emissive" settingKey="noteEmissive" min={0} max={20} step={0.1} />
          <BoundSliderRow label="Opacity" settingKey="noteOpacity" min={0} max={1} step={0.01} />
          <BoundSliderRow label="Width" settingKey="noteWidthScale" min={0.2} max={1.5} step={0.01} />
          <BoundSliderRow label="Corner Radius" settingKey="noteCornerRadius" min={0} max={0.3} step={0.005} />
          <BoundSliderRow label="Min Length" settingKey="noteMinLength" min={0} max={0.6} step={0.01} />
          <TextureControls />
        </Section>

        <Section title="Edge">
          <BoundSwitchRow label="Enabled" settingKey="edgeEnabled" />
          <BoundColorRow label="Color" settingKey="noteEdgeColor" />
          <BoundSliderRow label="Width" settingKey="noteEdgeWidth" min={0} max={0.1} step={0.001} />
          <BoundSliderRow label="Intensity" settingKey="noteEdgeIntensity" min={0} max={5} step={0.05} />
        </Section>

        <Section title="Flash">
          <BoundSwitchRow label="Enabled" settingKey="flashEnabled" />
          <BoundSwitchRow label="Follows Note" settingKey="flashFollowNote" />
          <FlashColorRow />
          <BoundSliderRow label="Brightness" settingKey="flashBrightness" min={0} max={1} step={0.01} />
          <BoundSliderRow label="Intensity" settingKey="flashIntensity" min={0} max={2} step={0.05} />
          <BoundSliderRow label="Size" settingKey="flashSize" min={0.3} max={5} step={0.05} />
          <BoundSliderRow label="Width" settingKey="flashWidth" min={0.3} max={5} step={0.05} />
          <BoundSliderRow label="Halo" settingKey="flashHaloWidth" min={0} max={2} step={0.05} />
        </Section>

        <Section title="Particles">
          <BoundSwitchRow label="Enabled" settingKey="particlesEnabled" />
          <BoundColorRow label="Color" settingKey="particleColor" />
          <BoundSliderRow label="Size" settingKey="particleSize" min={0} max={2} step={0.01} />
          <BoundSliderRow label="Opacity" settingKey="particleOpacity" min={0} max={1} step={0.01} />
          <BoundSliderRow label="Brightness" settingKey="particleBrightness" min={0} max={2} step={0.01} />
          <BoundSliderRow label="Lifetime" settingKey="particleLifetime" min={0.1} max={3} step={0.05} />
          <BoundSliderRow label="Speed" settingKey="particleSpeed" min={0} max={3} step={0.05} />
          <BoundSliderRow label="Count" settingKey="particleCount" min={0} max={30} step={0.1} />
          <BoundSliderRow label="Turbulence" settingKey="particleTurbulence" min={0} max={2} step={0.05} />
          <BoundSliderRow label="Turb Frequency" settingKey="turbulenceFrequency" min={0} max={5} step={0.05} />
          <BoundSliderRow label="Flow Speed" settingKey="flowSpeed" min={0} max={16} step={0.05} />
          <BoundSliderRow label="Turbulence X" settingKey="turbulenceX" min={0} max={2} step={0.05} />
          <BoundSliderRow label="Turbulence Y" settingKey="turbulenceY" min={0} max={2} step={0.05} />
          <BoundSliderRow label="Turbulence Z" settingKey="turbulenceZ" min={0} max={2} step={0.05} />
          <BoundSliderRow label="Locality" settingKey="noiseLocality" min={0} max={1} step={0.01} />
          <BoundSliderRow label="Octaves" settingKey="turbulenceOctaves" min={1} max={4} step={1} />
          <BoundSliderRow label="Octave Scale" settingKey="octaveScale" min={0.5} max={3} step={0.05} />
          <BoundSliderRow label="Octave Mul" settingKey="octaveMultiplier" min={0} max={1} step={0.01} />
          <BoundSliderRow label="Drag" settingKey="drag" min={0} max={1} step={0.01} />
          <BoundSliderRow label="Swirl" settingKey="swirl" min={0} max={1} step={0.01} />
          <BoundSliderRow label="Kick" settingKey="kick" min={0} max={3} step={0.05} />
        </Section>

        <Section title="Hit Line">
          <BoundSwitchRow label="Enabled" settingKey="hitLineEnabled" />
          <BoundColorRow label="Color" settingKey="hitLineColor" />
          <BoundSliderRow label="Bar Intensity" settingKey="hitLineIntensity" min={0} max={8} step={0.05} />
          <BoundSliderRow label="Bar Y" settingKey="hitLineBarY" min={-1} max={1} step={0.01} />
          <BoundSliderRow label="Bar Thickness" settingKey="hitLineThickness" min={0} max={1} step={0.01} />
          <BoundSliderRow label="Bar Halo" settingKey="hitLineBarHalo" min={0} max={6} step={0.05} />
          <BoundSwitchRow label="Wave Enabled" settingKey="hitLineWaveEnabled" />
          <BoundSliderRow label="Wave Intensity" settingKey="hitLineWaveIntensity" min={0} max={4} step={0.05} />
          <BoundSliderRow label="Wave Y" settingKey="hitLineWaveY" min={-1} max={1} step={0.01} />
          <BoundSliderRow label="Wave Amplitude" settingKey="hitLineWaveAmplitude" min={0} max={1} step={0.01} />
          <BoundSliderRow label="Wave Scale" settingKey="hitLineWaveScale" min={0.5} max={200} step={0.5} />
          <BoundSliderRow label="Wave Scroll Speed" settingKey="hitLineWaveScrollSpeed" min={-3} max={3} step={0.05} />
          <BoundSliderRow label="Wave Morph Speed" settingKey="hitLineWaveMorphSpeed" min={0} max={3} step={0.05} />
          <BoundSliderRow label="Wave Thickness" settingKey="hitLineWaveThickness" min={0} max={0.2} step={0.005} />
          <BoundSliderRow label="Wave Halo" settingKey="hitLineWaveHalo" min={0} max={3} step={0.05} />
          <BoundSliderRow label="Wave Grain" settingKey="hitLineWaveGrain" min={0} max={3} step={0.05} />
        </Section>

        {/* Bloom is a global post-process applied AFTER all the visual
            emitters above, so it sits at the end of that group rather than
            mixed into any single emitter's section. */}
        <Section title="Bloom">
          <BoundSwitchRow label="Enabled" settingKey="bloomEnabled" />
          <BoundSliderRow label="Intensity" settingKey="bloomIntensity" min={0} max={4} step={0.05} />
          <BoundSliderRow label="Threshold" settingKey="bloomThreshold" min={0} max={1} step={0.01} />
          <BoundSliderRow label="Radius" settingKey="bloomRadius" min={0} max={1} step={0.01} />
          <BoundSliderRow label="Smoothing" settingKey="bloomSmoothing" min={0} max={1} step={0.01} />
        </Section>

        <Section title="Scene">
          <BoundColorRow label="Background" settingKey="backgroundColor" />
          <BoundSwitchRow label="60 fps Preview" settingKey="previewHighFps" />
        </Section>

        <Section title="Keyboard">
          <BoundSliderRow label="Brightness" settingKey="keyboardBrightness" min={0} max={2} step={0.01} />
          <BoundColorRow label="White Keys" settingKey="whiteKeyColor" />
          <BoundColorRow label="Black Keys" settingKey="blackKeyColor" />
          <BoundColorRow label="Wood" settingKey="woodColor" />
          <BoundSwitchRow label="Glow Enabled" settingKey="keyGlowEnabled" />
          <BoundSwitchRow label="Glow Follows Note" settingKey="keyGlowFollowNote" />
          <GlowColorRow />
          <BoundSliderRow label="Glow Intensity" settingKey="keyGlowIntensity" min={0} max={5} step={0.05} />
          <BoundSliderRow label="Glow Decay (s)" settingKey="keyGlowDecay" min={0.05} max={2} step={0.01} />
        </Section>

        <Section title="Audio">
          <BoundSliderRow label="Release (s)" settingKey="releaseTime" min={0.01} max={1.5} step={0.01} />
          <BoundSliderRow label="Detune (¢)" settingKey="samplerDetune" min={-100} max={100} step={1} />
          <EqRow />
          <VelocityCurveEditor />
          <BoundSliderRow label="Velocity Compensation" settingKey="velocityCompensation" min={0} max={1} step={0.05} />
          <BoundSliderRow label="Transpose" settingKey="transpose" min={-24} max={24} step={1} />
          <BoundSwitchRow label="Pedal Enabled" settingKey="pedalEnabled" />
        </Section>

        <Section title="Reverb">
          <BoundSwitchRow label="Enabled" settingKey="reverbEnabled" />
          <BoundSliderRow label="Dry" settingKey="reverbDry" min={0} max={2} step={0.01} />
          <BoundSliderRow label="Wet" settingKey="reverbWet" min={0} max={2} step={0.01} />
          <BoundSliderRow label="Size (s)" settingKey="reverbSize" min={0.3} max={5} step={0.1} />
          <BoundSliderRow label="Decay Time (s)" settingKey="reverbDecayTime" min={0.1} max={8} step={0.05} />
          <BoundSliderRow label="Decay" settingKey="reverbDecay" min={0} max={6} step={0.05} />
          <PreDelayRow />
          <BoundSliderRow label="Damping" settingKey="reverbDamping" min={0} max={0.99} step={0.01} />
          <BoundSliderRow label="Hi Cut (Hz)" settingKey="reverbHiCut" min={500} max={20000} step={100} />
          <BoundSliderRow label="Low Cut (Hz)" settingKey="reverbLowCut" min={20} max={1000} step={10} />
        </Section>
      </div>
      </SearchProvider>
    </aside>
  )
}
