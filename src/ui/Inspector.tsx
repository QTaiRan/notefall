import { useState } from 'react'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation('inspector')
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
        label={t('camera.distance')}
        value={distance}
        min={CAMERA_LIMITS.distance.min}
        max={CAMERA_LIMITS.distance.max}
        step={0.1}
        onChange={(v) => writeOrbit(v, tiltDeg, yawDeg)}
        defaultValue={def.cameraPos[2]}
      />
      <SliderRow
        label={t('camera.horizontal')}
        value={yawDeg}
        min={CAMERA_LIMITS.horizontalDeg.min}
        max={CAMERA_LIMITS.horizontalDeg.max}
        step={1}
        onChange={(v) => writeOrbit(distance, tiltDeg, v)}
        format={(v) => `${Math.round(v)}°`}
        defaultValue={0}
      />
      <SliderRow
        label={t('camera.vertical')}
        value={tiltDeg}
        min={CAMERA_LIMITS.verticalDeg.min}
        max={CAMERA_LIMITS.verticalDeg.max}
        step={1}
        onChange={(v) => writeOrbit(distance, v, yawDeg)}
        format={(v) => `${Math.round(v)}°`}
        defaultValue={0}
      />
      <SliderRow
        label={t('camera.pivotX')}
        value={cameraLookAt[0]}
        min={CAMERA_LIMITS.pivotX.min}
        max={CAMERA_LIMITS.pivotX.max}
        step={0.05}
        onChange={(v) => writePivot(0, v)}
        defaultValue={def.cameraLookAt[0]}
      />
      <SliderRow
        label={t('camera.pivotY')}
        value={cameraLookAt[1]}
        min={CAMERA_LIMITS.pivotY.min}
        max={CAMERA_LIMITS.pivotY.max}
        step={0.05}
        onChange={(v) => writePivot(1, v)}
        defaultValue={def.cameraLookAt[1]}
      />
      <SliderRow
        label={t('camera.pivotZ')}
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
  const { t } = useTranslation('inspector')
  const themeColor = useEffectiveSetting('themeColor')
  return (
    <ColorRow
      label={t('row.color')}
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
  const { t: tr } = useTranslation('inspector')
  const song = useStore((st) => st.song)
  const trackColors = useEffectiveSetting('trackColors')
  const noteColor = useEffectiveSetting('noteColor')
  const noteTracks =
    song?.tracks.map((t, idx) => ({ t, idx })).filter(({ t }) => t.hasNotes) ?? []
  if (noteTracks.length === 0) {
    return <BoundColorRow label={tr('row.color')} settingKey="noteColor" />
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
  const { t } = useTranslation('inspector')
  const noteTexture = useStore((st) => st.settings.noteTexture)
  const customFileName = useCustomTexture((st) => st.fileName)
  const setCustomFile = useCustomTexture((st) => st.setFromFile)
  return (
    <>
      <SelectRow
        label={t('texture.texture')}
        value={noteTexture}
        options={[
          { value: 'solid', label: t('texture.solid') },
          { value: 'liquid', label: t('texture.liquid') },
          { value: 'gem', label: t('texture.gem') },
          { value: 'custom', label: t('texture.customImage') },
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
              {t('texture.chooseImage')}
            </Button>
          </FileTrigger>
          <span className="flex-1 truncate text-[10px] text-neutral-400">
            {customFileName ?? t('texture.noImage')}
          </span>
          {customFileName && (
            <Button
              onPress={() => setCustomFile(null)}
              className="rounded px-1.5 py-0.5 text-[10px] text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
            >
              {t('texture.clear')}
            </Button>
          )}
        </div>
      )}
      {noteTexture !== 'solid' && (
        <BoundSliderRow
          label={t('texture.scale')}
          settingKey="noteTextureScale"
          min={0.01}
          max={noteTexture === 'custom' ? 4 : 20}
          step={0.01}
        />
      )}
      {noteTexture !== 'solid' && (
        <>
          <BoundSliderRow label={t('texture.offsetX')} settingKey="noteTextureOffsetX" min={-3} max={3} step={0.01} />
          <BoundSliderRow label={t('texture.offsetY')} settingKey="noteTextureOffsetY" min={-3} max={3} step={0.01} />
        </>
      )}
      {noteTexture === 'custom' ? (
        <>
          <BoundSliderRow label={t('texture.animationSpeedX')} settingKey="noteAnimSpeedX" min={-3} max={3} step={0.05} />
          <BoundSliderRow label={t('texture.animationSpeedY')} settingKey="noteAnimSpeedY" min={-3} max={3} step={0.05} />
        </>
      ) : noteTexture === 'liquid' || noteTexture === 'gem' ? (
        <BoundSliderRow label={t('texture.animationSpeed')} settingKey="noteAnimSpeedY" min={0} max={3} step={0.05} />
      ) : null}
      {noteTexture === 'custom' && (
        <>
          <BoundSliderRow label={t('texture.blur')} settingKey="noteTextureBlur" min={0} max={6} step={0.05} />
          <BoundSliderRow label={t('texture.perNoteVariation')} settingKey="noteTextureVariation" min={0} max={1} step={0.01} />
        </>
      )}
      {noteTexture !== 'solid' && (
        <BoundSliderRow label={t('texture.contrast')} settingKey="noteTextureContrast" min={0.3} max={20} step={0.1} />
      )}
    </>
  )
}

// ── Flash: color row gated on `flashFollowNote` ──────────────────────
function FlashColorRow() {
  const { t } = useTranslation('inspector')
  const flashFollowNote = useStore((st) => st.settings.flashFollowNote)
  if (flashFollowNote) return null
  return <BoundColorRow label={t('row.color')} settingKey="flashColor" />
}

// ── Keyboard: glow color row gated on `keyGlowFollowNote` ────────────
function GlowColorRow() {
  const { t } = useTranslation('inspector')
  const keyGlowFollowNote = useStore((st) => st.settings.keyGlowFollowNote)
  if (keyGlowFollowNote) return null
  return <BoundColorRow label={t('row.glowColor')} settingKey="keyGlowColor" />
}

// ── Audio: EQ band row ───────────────────────────────────────────────
function EqRow() {
  const { t } = useTranslation('inspector')
  const eqBands = useStore((st) => st.settings.eqBands)
  return (
    <SearchableBlock label={t('eq.block')}>
      <div className="pt-1 text-[10px] text-neutral-400">{t('eq.label')}</div>
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
  const { t } = useTranslation('inspector')
  const fallDirection = useStore((st) => st.settings.fallDirection)
  return (
    <SelectRow
      label={t('row.direction')}
      value={fallDirection}
      options={[
        { value: 'down', label: t('direction.topToBottom') },
        { value: 'up', label: t('direction.bottomToTop') },
      ]}
      onChange={(v) => atomicUpdate({ fallDirection: v })}
      defaultValue={def.fallDirection}
    />
  )
}

// ── Audio: pre-delay needs unit conversion (s ↔ ms) ──────────────────
function PreDelayRow() {
  const { t } = useTranslation('inspector')
  const reverbPreDelay = useStore((st) => st.settings.reverbPreDelay)
  return (
    <SliderRow
      label={t('row.preDelay')}
      value={reverbPreDelay * 1000}
      min={0}
      max={200}
      step={1}
      onChange={(v) => atomicUpdate({ reverbPreDelay: v / 1000 })}
      defaultValue={def.reverbPreDelay * 1000}
    />
  )
}

// Indicator of WHAT the Inspector controls currently edit. The target
// follows the PLAYHEAD (nearest pin at/before the head — see
// `PinTargetSync`): move the timeline and the banner retargets. Before
// the first pin there's no target → the base "default look" (held
// separately; editing a pin never touches it). No pins at all → nothing
// to disambiguate.
function PinEditingBanner() {
  const { t } = useTranslation('inspector')
  const keyframes = useStore((st) => st.settings.settingsKeyframes)
  const editingTime = useStore((st) => st.editingKeyframeTime)
  if (keyframes.length === 0) return null
  const idx =
    editingTime !== null
      ? keyframes.findIndex((p) => Math.abs(p.time - editingTime) < 1e-6)
      : -1
  // Understated status strip — same neutral divider as the rest of
  // the Inspector chrome, faint sky wash, sky diamond echoing the pin
  // marker, mono time echoing the timeline readouts.
  if (idx < 0) {
    // Head before the first pin → editing the separate base default.
    return (
      <div className="flex items-center gap-2 border-b border-neutral-800 bg-sky-500/[0.04] px-3 py-1.5">
        <span
          aria-hidden
          className="h-[7px] w-[7px] shrink-0 rotate-45 rounded-[1px] ring-1 ring-neutral-500"
        />
        <span className="flex-1 truncate text-[11px] text-neutral-400">
          {t('banner.editingDefaultLookPrefix')}
          <span className="text-neutral-300">
            {t('banner.editingDefaultLookHighlight')}
          </span>
          {t('banner.editingDefaultLookSuffix')}
        </span>
      </div>
    )
  }
  const s = Math.max(0, keyframes[idx].time)
  const m = Math.floor(s / 60)
  const r = s - m * 60
  const stamp = `${m}:${r.toFixed(2).padStart(5, '0')}`
  return (
    <div className="flex items-center gap-2 border-b border-neutral-800 bg-sky-500/[0.06] px-3 py-1.5">
      <span
        aria-hidden
        className="h-[7px] w-[7px] shrink-0 rotate-45 rounded-[1px] bg-sky-300"
      />
      <span className="flex-1 truncate text-[11px] text-neutral-300">
        {t('banner.editingPin')}{' '}
        <span className="font-mono text-sky-300">
          {idx + 1}/{keyframes.length}
        </span>{' '}
        <span className="font-mono text-[10px] text-neutral-500">{stamp}</span>
      </span>
    </div>
  )
}

export function Inspector() {
  const { t } = useTranslation('inspector')
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
            placeholder={t('search.placeholder')}
            spellCheck={false}
            className="w-full rounded border border-neutral-800 bg-neutral-900 py-1 pl-7 pr-7 text-xs text-neutral-200 placeholder-neutral-500 outline-none focus:border-sky-600"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={t('search.clear')}
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
            {t('reset.button')}
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
            {t('reset.tooltip')}
          </Tooltip>
        </TooltipTrigger>
      </div>
      <PinEditingBanner />
      <SearchProvider query={query}>
      <div className="scroll-thin flex-1 overflow-y-auto px-3 pb-6">
        <Section title={t('section.camera')}>
          <CameraSection />
          <p className="px-2 pt-1 pb-2 text-[10px] leading-snug text-neutral-500">
            {t('camera.hint')}
          </p>
        </Section>

        <Section title={t('section.layout')}>
          <BoundSliderRow label={t('row.keyboardY')} settingKey="keyboardY" min={-3} max={2} step={0.05} />
        </Section>

        <Section title={t('section.theme')}>
          <ThemeSection />
        </Section>

        <Section title={t('section.notes')}>
          <BoundSwitchRow label={t('row.enabled')} settingKey="notesEnabled" />
          <FallDirectionRow />
          <BoundSliderRow label={t('row.fallTime')} settingKey="fallDurationSec" min={0.5} max={8} step={0.1} />
          <TrackColorRows />
          <BoundSliderRow label={t('row.emissive')} settingKey="noteEmissive" min={0} max={20} step={0.1} />
          <BoundSliderRow label={t('row.opacity')} settingKey="noteOpacity" min={0} max={1} step={0.01} />
          <BoundSliderRow label={t('row.width')} settingKey="noteWidthScale" min={0.2} max={1.5} step={0.01} />
          <BoundSliderRow label={t('row.cornerRadius')} settingKey="noteCornerRadius" min={0} max={0.3} step={0.005} />
          <BoundSliderRow label={t('row.minLength')} settingKey="noteMinLength" min={0} max={0.6} step={0.01} />
          <TextureControls />
        </Section>

        <Section title={t('section.edge')}>
          <BoundSwitchRow label={t('row.enabled')} settingKey="edgeEnabled" />
          <BoundColorRow label={t('row.edgeColor')} settingKey="noteEdgeColor" />
          <BoundSliderRow label={t('row.edgeWidth')} settingKey="noteEdgeWidth" min={0} max={0.1} step={0.001} />
          <BoundSliderRow label={t('row.edgeIntensity')} settingKey="noteEdgeIntensity" min={0} max={5} step={0.05} />
        </Section>

        <Section title={t('section.flash')}>
          <BoundSwitchRow label={t('row.flashEnabled')} settingKey="flashEnabled" />
          <BoundSwitchRow label={t('row.flashFollowsNote')} settingKey="flashFollowNote" />
          <FlashColorRow />
          <BoundSliderRow label={t('row.flashBrightness')} settingKey="flashBrightness" min={0} max={1} step={0.01} />
          <BoundSliderRow label={t('row.flashIntensity')} settingKey="flashIntensity" min={0} max={2} step={0.05} />
          <BoundSliderRow label={t('row.flashSize')} settingKey="flashSize" min={0.3} max={5} step={0.05} />
          <BoundSliderRow label={t('row.flashWidth')} settingKey="flashWidth" min={0.3} max={5} step={0.05} />
          <BoundSliderRow label={t('row.flashHalo')} settingKey="flashHaloWidth" min={0} max={2} step={0.05} />
        </Section>

        <Section title={t('section.particles')}>
          <BoundSwitchRow label={t('row.particlesEnabled')} settingKey="particlesEnabled" />
          <BoundColorRow label={t('row.particleColor')} settingKey="particleColor" />
          <BoundSliderRow label={t('row.particleSize')} settingKey="particleSize" min={0} max={2} step={0.01} />
          <BoundSliderRow label={t('row.particleOpacity')} settingKey="particleOpacity" min={0} max={1} step={0.01} />
          <BoundSliderRow label={t('row.particleBrightness')} settingKey="particleBrightness" min={0} max={2} step={0.01} />
          <BoundSliderRow label={t('row.particleLifetime')} settingKey="particleLifetime" min={0.1} max={3} step={0.05} />
          <BoundSliderRow label={t('row.particleSpeed')} settingKey="particleSpeed" min={0} max={3} step={0.05} />
          <BoundSliderRow label={t('row.particleCount')} settingKey="particleCount" min={0} max={30} step={0.1} />
          <BoundSliderRow label={t('row.particleTurbulence')} settingKey="particleTurbulence" min={0} max={2} step={0.05} />
          <BoundSliderRow label={t('row.turbFrequency')} settingKey="turbulenceFrequency" min={0} max={5} step={0.05} />
          <BoundSliderRow label={t('row.flowSpeed')} settingKey="flowSpeed" min={0} max={16} step={0.05} />
          <BoundSliderRow label={t('row.turbulenceX')} settingKey="turbulenceX" min={0} max={2} step={0.05} />
          <BoundSliderRow label={t('row.turbulenceY')} settingKey="turbulenceY" min={0} max={2} step={0.05} />
          <BoundSliderRow label={t('row.turbulenceZ')} settingKey="turbulenceZ" min={0} max={2} step={0.05} />
          <BoundSliderRow label={t('row.locality')} settingKey="noiseLocality" min={0} max={1} step={0.01} />
          <BoundSliderRow label={t('row.octaves')} settingKey="turbulenceOctaves" min={1} max={4} step={1} />
          <BoundSliderRow label={t('row.octaveScale')} settingKey="octaveScale" min={0.5} max={3} step={0.05} />
          <BoundSliderRow label={t('row.octaveMul')} settingKey="octaveMultiplier" min={0} max={1} step={0.01} />
          <BoundSliderRow label={t('row.drag')} settingKey="drag" min={0} max={1} step={0.01} />
          <BoundSliderRow label={t('row.swirl')} settingKey="swirl" min={0} max={1} step={0.01} />
          <BoundSliderRow label={t('row.kick')} settingKey="kick" min={0} max={3} step={0.05} />
        </Section>

        <Section title={t('section.hitLine')}>
          <BoundSwitchRow label={t('row.hitLineEnabled')} settingKey="hitLineEnabled" />
          <BoundColorRow label={t('row.hitLineColor')} settingKey="hitLineColor" />
          <BoundSliderRow label={t('row.barIntensity')} settingKey="hitLineIntensity" min={0} max={8} step={0.05} />
          <BoundSliderRow label={t('row.barY')} settingKey="hitLineBarY" min={-1} max={1} step={0.01} />
          <BoundSliderRow label={t('row.barThickness')} settingKey="hitLineThickness" min={0} max={1} step={0.01} />
          <BoundSliderRow label={t('row.barHalo')} settingKey="hitLineBarHalo" min={0} max={6} step={0.05} />
          <BoundSwitchRow label={t('row.waveEnabled')} settingKey="hitLineWaveEnabled" />
          <BoundSliderRow label={t('row.waveIntensity')} settingKey="hitLineWaveIntensity" min={0} max={4} step={0.05} />
          <BoundSliderRow label={t('row.waveY')} settingKey="hitLineWaveY" min={-1} max={1} step={0.01} />
          <BoundSliderRow label={t('row.waveAmplitude')} settingKey="hitLineWaveAmplitude" min={0} max={1} step={0.01} />
          <BoundSliderRow label={t('row.waveScale')} settingKey="hitLineWaveScale" min={0.5} max={200} step={0.5} />
          <BoundSliderRow label={t('row.waveScrollSpeed')} settingKey="hitLineWaveScrollSpeed" min={-3} max={3} step={0.05} />
          <BoundSliderRow label={t('row.waveMorphSpeed')} settingKey="hitLineWaveMorphSpeed" min={0} max={3} step={0.05} />
          <BoundSliderRow label={t('row.waveThickness')} settingKey="hitLineWaveThickness" min={0} max={0.2} step={0.005} />
          <BoundSliderRow label={t('row.waveHalo')} settingKey="hitLineWaveHalo" min={0} max={3} step={0.05} />
          <BoundSliderRow label={t('row.waveGrain')} settingKey="hitLineWaveGrain" min={0} max={3} step={0.05} />
        </Section>

        {/* Bloom is a global post-process applied AFTER all the visual
            emitters above, so it sits at the end of that group rather than
            mixed into any single emitter's section. */}
        <Section title={t('section.bloom')}>
          <BoundSwitchRow label={t('row.bloomEnabled')} settingKey="bloomEnabled" />
          <BoundSliderRow label={t('row.bloomIntensity')} settingKey="bloomIntensity" min={0} max={4} step={0.05} />
          <BoundSliderRow label={t('row.bloomThreshold')} settingKey="bloomThreshold" min={0} max={1} step={0.01} />
          <BoundSliderRow label={t('row.bloomRadius')} settingKey="bloomRadius" min={0} max={1} step={0.01} />
          <BoundSliderRow label={t('row.bloomSmoothing')} settingKey="bloomSmoothing" min={0} max={1} step={0.01} />
        </Section>

        <Section title={t('section.scene')}>
          <BoundColorRow label={t('row.background')} settingKey="backgroundColor" />
          <BoundSwitchRow label={t('row.highFpsPreview')} settingKey="previewHighFps" />
        </Section>

        <Section title={t('section.keyboard')}>
          <BoundSliderRow label={t('row.brightness')} settingKey="keyboardBrightness" min={0} max={2} step={0.01} />
          <BoundColorRow label={t('row.whiteKeys')} settingKey="whiteKeyColor" />
          <BoundColorRow label={t('row.blackKeys')} settingKey="blackKeyColor" />
          <BoundColorRow label={t('row.wood')} settingKey="woodColor" />
          <BoundSwitchRow label={t('row.glowEnabled')} settingKey="keyGlowEnabled" />
          <BoundSwitchRow label={t('row.glowFollowsNote')} settingKey="keyGlowFollowNote" />
          <GlowColorRow />
          <BoundSliderRow label={t('row.glowIntensity')} settingKey="keyGlowIntensity" min={0} max={5} step={0.05} />
          <BoundSliderRow label={t('row.glowDecay')} settingKey="keyGlowDecay" min={0.05} max={2} step={0.01} />
        </Section>

        <Section title={t('section.audio')}>
          <BoundSliderRow label={t('row.release')} settingKey="releaseTime" min={0.01} max={1.5} step={0.01} />
          <BoundSliderRow label={t('row.detune')} settingKey="samplerDetune" min={-100} max={100} step={1} />
          <EqRow />
          <VelocityCurveEditor />
          <BoundSliderRow label={t('row.velocityCompensation')} settingKey="velocityCompensation" min={0} max={1} step={0.05} />
          <BoundSliderRow label={t('row.transpose')} settingKey="transpose" min={-24} max={24} step={1} />
          <BoundSwitchRow label={t('row.pedalEnabled')} settingKey="pedalEnabled" />
        </Section>

        <Section title={t('section.reverb')}>
          <BoundSwitchRow label={t('row.reverbEnabled')} settingKey="reverbEnabled" />
          <BoundSliderRow label={t('row.reverbDry')} settingKey="reverbDry" min={0} max={2} step={0.01} />
          <BoundSliderRow label={t('row.reverbWet')} settingKey="reverbWet" min={0} max={2} step={0.01} />
          <BoundSliderRow label={t('row.reverbSize')} settingKey="reverbSize" min={0.3} max={5} step={0.1} />
          <BoundSliderRow label={t('row.reverbDecayTime')} settingKey="reverbDecayTime" min={0.1} max={8} step={0.05} />
          <BoundSliderRow label={t('row.reverbDecay')} settingKey="reverbDecay" min={0} max={6} step={0.05} />
          <PreDelayRow />
          <BoundSliderRow label={t('row.reverbDamping')} settingKey="reverbDamping" min={0} max={0.99} step={0.01} />
          <BoundSliderRow label={t('row.reverbHiCut')} settingKey="reverbHiCut" min={500} max={20000} step={100} />
          <BoundSliderRow label={t('row.reverbLowCut')} settingKey="reverbLowCut" min={20} max={1000} step={10} />
        </Section>
      </div>
      </SearchProvider>
    </aside>
  )
}
