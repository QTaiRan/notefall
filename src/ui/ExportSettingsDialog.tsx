import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Checkbox,
  Dialog,
  Heading,
  Label,
  Modal,
  ModalOverlay,
  Radio,
  RadioGroup,
} from 'react-aria-components'
import {
  DEFAULT_AUDIO_CONFIG,
  VIDEO_QUALITIES,
  VIDEO_RESOLUTIONS,
  computeVideoBitrateKbps,
  type VideoFps,
  type VideoQualityId,
  type VideoResolutionId,
} from '../export/exportVideo'
import { playExportCompleteChime } from '../audio/exportChime'

export type ExportFormat = 'video-audio' | 'video-only' | 'audio-only'

export type ExportSettingsValues = {
  format: ExportFormat
  resolution: VideoResolutionId
  fps: VideoFps
  quality: VideoQualityId
  /** Play a chime when the export finishes successfully. */
  playSoundOnComplete: boolean
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettingsValues = {
  format: 'video-audio',
  resolution: '1080p',
  fps: 60,
  quality: 'high',
  playSoundOnComplete: true,
}

/**
 * Single export configuration dialog. Replaces the old
 * "Export Audio" / "Export Video ▸" menu pair — the user picks
 * format, resolution, fps, and quality here, then submits.
 *
 * Layout collapses to just the format radio + Export button when
 * "Audio only" is selected, since none of the video knobs apply.
 *
 * Defaults come from the caller so the Toolbar can remember the
 * user's last choice across the session — picked once, the dialog
 * opens to those values next time.
 *
 * Non-dismissable while the user is configuring (Cancel button is
 * the way out). Dismissing on Escape / backdrop is allowed because
 * the dialog has no in-flight work to lose.
 */
export function ExportSettingsDialog({
  isOpen,
  onClose,
  onExport,
  songDuration,
  videoExportSupported,
  defaults,
}: {
  isOpen: boolean
  onClose: () => void
  onExport: (settings: ExportSettingsValues) => void
  /** Song length in seconds — used for the estimated-size readout. */
  songDuration: number
  /** Browser support gate. When false, video formats are disabled. */
  videoExportSupported: boolean
  defaults: ExportSettingsValues
}) {
  const { t } = useTranslation('dialogs')
  const [format, setFormat] = useState<ExportFormat>(defaults.format)
  const [resolution, setResolution] = useState<VideoResolutionId>(defaults.resolution)
  const [fps, setFps] = useState<VideoFps>(defaults.fps)
  const [quality, setQuality] = useState<VideoQualityId>(defaults.quality)
  const [playSoundOnComplete, setPlaySoundOnComplete] = useState<boolean>(
    defaults.playSoundOnComplete,
  )

  // Reset to defaults each time the dialog opens. Without this, the
  // form would show whatever the previous render left in state, even
  // if the user dismissed without exporting and the caller's
  // defaults updated.
  useEffect(() => {
    if (isOpen) {
      setFormat(defaults.format)
      setResolution(defaults.resolution)
      setFps(defaults.fps)
      setQuality(defaults.quality)
      setPlaySoundOnComplete(defaults.playSoundOnComplete)
    }
  }, [isOpen, defaults])

  // If video export is unsupported, force the form to audio-only so
  // submitting always produces a valid export.
  useEffect(() => {
    if (isOpen && !videoExportSupported && format !== 'audio-only') {
      setFormat('audio-only')
    }
  }, [isOpen, videoExportSupported, format])

  const showVideoOptions = format !== 'audio-only'

  // Estimated file size readout. Helps the user catch "I picked 4K
  // 60fps High and got a 2 GB file" surprises before committing.
  // Numbers are intentionally rough — the actual encoder hits a
  // variable bitrate and the muxer adds container overhead.
  const estimatedMb = useMemo(() => {
    let bitrateKbps = 0
    if (format === 'audio-only') {
      // 32-bit float stereo PCM wav = 4 bytes × 2 channels × sampleRate
      // = 352.8 kB/s at 44.1 kHz ≈ 2822 kbps
      bitrateKbps = 44_100 * 4 * 2 * 8 / 1000
    } else {
      bitrateKbps += computeVideoBitrateKbps(resolution, fps, quality)
      if (format === 'video-audio') {
        bitrateKbps += DEFAULT_AUDIO_CONFIG?.bitrateKbps ?? 0
      }
    }
    const bytes = (bitrateKbps * songDuration * 1000) / 8
    return Math.max(1, Math.round(bytes / (1024 * 1024)))
  }, [format, resolution, fps, quality, songDuration])

  const handleExport = () => {
    onExport({ format, resolution, fps, quality, playSoundOnComplete })
  }

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      isDismissable
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm data-[entering]:animate-in data-[entering]:fade-in data-[entering]:duration-150 data-[exiting]:animate-out data-[exiting]:fade-out data-[exiting]:duration-100"
    >
      <Modal className="outline-none data-[entering]:animate-in data-[entering]:zoom-in-95 data-[entering]:duration-150">
        <Dialog
          role="dialog"
          aria-label={t('export.ariaLabel')}
          className="flex w-96 flex-col gap-4 rounded-md bg-black/55 p-5 shadow-lg ring-1 ring-white/10 backdrop-blur-md outline-none"
        >
          <Heading slot="title" className="text-sm font-medium text-neutral-100">
            {t('export.title')}
          </Heading>

          {!videoExportSupported && (
            <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-amber-200">
              {t('export.unsupported')}
            </p>
          )}

          <RadioGroup
            value={format}
            onChange={(v) => setFormat(v as ExportFormat)}
            className="flex flex-col gap-1.5"
          >
            <Label className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
              {t('export.format.label')}
            </Label>
            <FormatRadio value="video-audio" disabled={!videoExportSupported}>
              {t('export.format.videoAudio')}
            </FormatRadio>
            <FormatRadio value="video-only" disabled={!videoExportSupported}>
              {t('export.format.videoOnly')}
            </FormatRadio>
            <FormatRadio value="audio-only">{t('export.format.audioOnly')}</FormatRadio>
          </RadioGroup>

          {showVideoOptions && (
            <>
              <RadioGroup
                value={resolution}
                onChange={(v) => setResolution(v as VideoResolutionId)}
                className="flex flex-col gap-1.5"
              >
                <Label className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                  {t('export.resolution')}
                </Label>
                <div className="flex gap-1.5">
                  {(Object.keys(VIDEO_RESOLUTIONS) as VideoResolutionId[]).map((id) => (
                    <SegmentRadio key={id} value={id}>
                      {VIDEO_RESOLUTIONS[id].label}
                    </SegmentRadio>
                  ))}
                </div>
              </RadioGroup>

              <RadioGroup
                value={String(fps)}
                onChange={(v) => setFps(Number(v) as VideoFps)}
                className="flex flex-col gap-1.5"
              >
                <Label className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                  {t('export.fps')}
                </Label>
                <div className="flex gap-1.5">
                  <SegmentRadio value="30">{t('export.fps30')}</SegmentRadio>
                  <SegmentRadio value="60">{t('export.fps60')}</SegmentRadio>
                </div>
              </RadioGroup>

              <RadioGroup
                value={quality}
                onChange={(v) => setQuality(v as VideoQualityId)}
                className="flex flex-col gap-1.5"
              >
                <Label className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                  {t('export.quality')}
                </Label>
                <div className="flex gap-1.5">
                  {(Object.keys(VIDEO_QUALITIES) as VideoQualityId[]).map((id) => (
                    <SegmentRadio key={id} value={id}>
                      {VIDEO_QUALITIES[id].label}
                    </SegmentRadio>
                  ))}
                </div>
                <p className="text-[10px] text-neutral-500">
                  {t('export.bitrateNote', {
                    mbps: (computeVideoBitrateKbps(resolution, fps, quality) / 1000).toFixed(1),
                  })}
                </p>
              </RadioGroup>
            </>
          )}

          <div className="flex flex-col gap-2 border-t border-neutral-800 pt-3">
            <div className="flex items-baseline justify-between text-[11px] text-neutral-400">
              <span>{t('export.estimatedSize')}</span>
              <span className="font-mono tabular-nums text-neutral-200">
                {t('export.estimatedSizeValue', { mb: estimatedMb })}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <Checkbox
                isSelected={playSoundOnComplete}
                onChange={setPlaySoundOnComplete}
                className="group flex cursor-pointer items-center gap-2 text-[11px] text-neutral-300 outline-none data-[focused]:text-neutral-100"
              >
                {({ isSelected }) => (
                  <>
                    <span
                      className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                        isSelected
                          ? 'border-sky-400 bg-sky-500/20'
                          : 'border-neutral-600 bg-neutral-900'
                      } group-data-[focused]:ring-1 group-data-[focused]:ring-sky-500/40`}
                    >
                      {isSelected && (
                        <svg
                          viewBox="0 0 14 14"
                          className="h-2.5 w-2.5 stroke-sky-300"
                          fill="none"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M2.5 7.5 L6 11 L11.5 3.5" />
                        </svg>
                      )}
                    </span>
                    <span>{t('export.playSoundOnComplete')}</span>
                  </>
                )}
              </Checkbox>
              {/* Audition the chime without committing to a full
                  render. `excludeFromTabOrder` keeps Tab focus
                  flowing through the form's main controls without
                  detouring through this preview button. */}
              <Button
                excludeFromTabOrder
                onPress={() => playExportCompleteChime()}
                className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[10px] text-neutral-300 outline-none hover:border-neutral-600 focus-visible:border-sky-500"
              >
                {t('export.test')}
              </Button>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button
              onPress={onClose}
              className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 outline-none hover:border-neutral-600 focus-visible:border-sky-500"
            >
              {t('export.cancel')}
            </Button>
            <Button
              onPress={handleExport}
              className="rounded border border-sky-500/60 bg-sky-500/15 px-3 py-1.5 text-xs text-sky-200 outline-none hover:bg-sky-500/25 focus-visible:border-sky-300"
            >
              {t('export.submit')}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}

/**
 * List-style radio: dot + label, fills its row. Used for the format
 * selector where each option's label is long.
 */
function FormatRadio({
  value,
  disabled,
  children,
}: {
  value: string
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <Radio
      value={value}
      isDisabled={disabled}
      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-neutral-200 outline-none data-[focused]:bg-neutral-800 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50"
    >
      {({ isSelected }) => (
        <>
          <span
            className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
              isSelected ? 'border-sky-400' : 'border-neutral-600'
            }`}
          >
            {isSelected && <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />}
          </span>
          <span>{children}</span>
        </>
      )}
    </Radio>
  )
}

/**
 * Segment-style radio: pill button, suitable for a row of short
 * options like 720p / 1080p / 4K.
 */
function SegmentRadio({
  value,
  children,
}: {
  value: string
  children: React.ReactNode
}) {
  return (
    <Radio
      value={value}
      className="flex-1 cursor-pointer rounded border px-2 py-1.5 text-center text-xs outline-none transition-colors data-[selected]:border-sky-500/60 data-[selected]:bg-sky-500/15 data-[selected]:text-sky-200 data-[focused]:ring-1 data-[focused]:ring-sky-500/40 [&:not([data-selected])]:border-neutral-700 [&:not([data-selected])]:bg-neutral-900 [&:not([data-selected])]:text-neutral-300 [&:not([data-selected])]:hover:border-neutral-600"
    >
      {children}
    </Radio>
  )
}
