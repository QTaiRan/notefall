import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Button, OverlayArrow, Tooltip, TooltipTrigger } from "react-aria-components";
import { defaultSettings, useStore } from "../store";
import { audioEngine } from "../audio/engine";
import { pauseSong, playSong } from "../audio/playback";
import { useCurrentTime } from "../audio/useCurrentTime";
import { SliderRow } from "./controls";
import {
  Forward10Icon,
  FullscreenExitIcon,
  FullscreenIcon,
  LoopIcon,
  PauseIcon,
  PlayIcon,
  Replay10Icon,
  ResetViewIcon,
  RewindToStartIcon,
  VolumeHighIcon,
  VolumeLowIcon,
  VolumeMuteIcon,
} from "./icons";

function fmt(t: number): string {
  if (!isFinite(t)) return "00:00";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

type Props = {
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  /**
   * Notify parent whenever any popover (volume / speed) opens or closes.
   * Used to suppress the playback-area auto-hide while the user is
   * interacting with a popover that lives outside the viewport.
   */
  onPopoverOpenChange?: (open: boolean) => void;
};

/**
 * Transport bar overlay: rewind / play-pause centered above the seek slider.
 * Pause keeps the current play position; rewind is a separate dedicated button.
 * Designed to sit at the bottom of the viewport with a dark gradient backdrop
 * (rendered by the parent), revealed on hover like a video player.
 */
/**
 * Pop-up slider attached to a transport-bar icon button. Used for volume
 * and playback speed — both are quick adjustments the user makes while
 * watching, so they live in the player chrome instead of the Inspector.
 *
 * Hover-triggered (not click): the popover opens whenever the cursor is
 * over either the button or the popover itself, with a brief grace period
 * on leave so the user can travel from button → popover without it
 * snapping closed.
 *
 * `onClick` lets the caller override what happens when the button is
 * pressed — used by Volume to toggle mute instead of opening the slider.
 * `onOpenChange` informs the parent so the playback-area auto-hide can
 * pause while the popover is visible.
 */
const HOVER_CLOSE_DELAY_MS = 150;

function PopSliderButton({
  id,
  openId,
  setOpenId,
  ariaLabel,
  iconLabel,
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  buttonClass,
  onClick,
}: {
  /** Stable id for this button. Acts as the slot key in the shared open state. */
  id: string;
  /** Currently-open popover id from the shared parent state, or null. */
  openId: string | null;
  /** Setter for the shared open id. Functional updates supported. */
  setOpenId: Dispatch<SetStateAction<string | null>>;
  ariaLabel: string;
  iconLabel: React.ReactNode;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  buttonClass?: string;
  onClick?: () => void;
}) {
  const isOpen = openId === id;
  const closeTimerRef = useRef<number | null>(null);

  const cancelClose = () => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };
  const open = () => {
    cancelClose();
    // Claim the slot — implicitly closes any other open popover instantly.
    setOpenId(id);
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      // Only release the slot if we still own it. A sibling may have taken
      // over while our timer was pending; clearing unconditionally would
      // close THEIR popover.
      setOpenId((prev) => (prev === id ? null : prev));
    }, HOVER_CLOSE_DELAY_MS);
  };
  useEffect(() => () => cancelClose(), []);
  // If a sibling claims the open slot, drop our pending close timer so it
  // doesn't fire later and try to clear someone else's popover.
  useEffect(() => {
    if (!isOpen) cancelClose();
  }, [isOpen]);

  // Plain-DOM positioning (no portal): popover renders as an absolute child
  // of the button's wrapper, which keeps it in the same hover/render flow
  // as the button. Avoids the flicker we got from react-aria Popover —
  // its portal lands in document.body and there's a brief layout/positioning
  // window where the cursor effectively bounces on/off the trigger.
  return (
    <div className="pointer-events-auto relative">
      <Button
        aria-label={ariaLabel}
        // Default press: open the popover so touch devices (no hover) can
        // still reach the slider. onClick overrides — Volume uses it to mute.
        onPress={onClick ?? open}
        onHoverStart={open}
        onHoverEnd={scheduleClose}
        className={
          buttonClass ??
          "flex h-11 w-11 items-center justify-center rounded-full border border-neutral-700 bg-black/20 text-neutral-200 outline-none backdrop-blur-sm hover:bg-neutral-800/50 focus-visible:border-sky-500"
        }
      >
        {iconLabel}
      </Button>
      {isOpen && (
        <div
          className="absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2"
          onMouseEnter={open}
          onMouseLeave={scheduleClose}
        >
          <div className="w-44 rounded-lg bg-black/55 p-3 shadow-lg ring-1 ring-white/10 backdrop-blur-sm">
            <SliderRow
              label={label}
              value={value}
              min={min}
              max={max}
              step={step}
              onChange={onChange}
              format={format}
            />
          </div>
        </div>
      )}
    </div>
  );
}

const fmtSpeed = (v: number) => `${v.toFixed(2)}×`;
const fmtVolume = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Time readout (current / total). Subscribes to `useCurrentTime` so it
 * updates per frame, but the rest of the SeekBar doesn't need to: keep
 * the per-frame subscription isolated here so the transport buttons +
 * volume/speed popovers don't re-render 60×/sec.
 */
function TimeReadout({ duration }: { duration: number }) {
  const currentTime = useCurrentTime();
  return (
    <span className="font-mono text-sm tabular-nums text-neutral-300">
      {fmt(currentTime)} / {fmt(duration)}
    </span>
  );
}

/**
 * Progress-bar fill. Same isolation as `TimeReadout` — keeps the
 * per-frame update local to this slim child so the surrounding
 * scrubbable track + outer SeekBar don't re-render every frame.
 */
function ProgressFill({ duration }: { duration: number }) {
  const currentTime = useCurrentTime();
  return (
    <div
      className="h-full bg-sky-500/80 transition-colors duration-150 group-hover:bg-sky-400"
      style={{
        width: duration > 0 ? `${(currentTime / duration) * 100}%` : "0%",
      }}
    />
  );
}

/**
 * Wrap a Button in a react-aria Tooltip so each transport-icon button
 * surfaces its purpose on hover. Volume and Speed have hover popovers
 * already (they're not icon-only), so they don't get this treatment —
 * a tooltip would conflict with the popover trigger.
 */
function WithTooltip({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <TooltipTrigger delay={300}>
      {children}
      <Tooltip
        offset={8}
        placement="top"
        className="z-[100] rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1 text-[10px] text-neutral-200 shadow-lg outline-none data-[entering]:animate-in data-[entering]:fade-in data-[exiting]:animate-out data-[exiting]:fade-out"
      >
        <OverlayArrow>
          <svg
            viewBox="0 0 8 8"
            width={8}
            height={8}
            className="fill-neutral-800 stroke-neutral-700 group-data-[placement=bottom]/popover:rotate-180"
          >
            <path d="M0 0 L4 4 L8 0" />
          </svg>
        </OverlayArrow>
        {label}
      </Tooltip>
    </TooltipTrigger>
  );
}

export function SeekBar({
  isFullscreen,
  onToggleFullscreen,
  onPopoverOpenChange,
}: Props) {
  const song = useStore((s) => s.song);
  const transport = useStore((s) => s.transport);
  const loadStatus = useStore((s) => s.loadStatus);
  const loop = useStore((s) => s.loop);
  const setLoop = useStore((s) => s.setLoop);
  const volume = useStore((s) => s.settings.volume);
  const playbackRate = useStore((s) => s.settings.playbackRate);
  const updateSettings = useStore((s) => s.updateSettings);
  const beginEdit = useStore((s) => s.beginSettingsEdit);
  const endEdit = useStore((s) => s.endSettingsEdit);
  const resetCameraView = () => {
    beginEdit();
    updateSettings({
      cameraFov: defaultSettings.cameraFov,
      cameraPos: defaultSettings.cameraPos,
      cameraLookAt: defaultSettings.cameraLookAt,
    });
    endEdit();
  };
  // Subscribe to inputs that affect the TL_audio total duration so
  // the slider rescales when the user changes the speed curve / MIDI
  // offset. The values themselves aren't read here — only the
  // subscription matters; the actual map lives in the engine.
  useStore((s) => s.settings.midiSpeedAutomation);
  useStore((s) => s.settings.midiOffsetSec);

  // Single shared "which popover is open" slot. Mutual exclusion: opening
  // one popover (e.g. Speed) immediately drops any other (e.g. Volume) so
  // they can never overlap visually for even a frame.
  const [openPopoverId, setOpenPopoverId] = useState<string | null>(null);
  useEffect(() => {
    onPopoverOpenChange?.(openPopoverId !== null);
  }, [openPopoverId, onPopoverOpenChange]);

  // Last user-set non-zero volume — restored when toggling off mute.
  // Initialised lazily and updated whenever the user moves the slider away
  // from zero, so an unmute returns to whatever they were last listening at.
  const lastNonZeroVolumeRef = useRef(volume > 0.001 ? volume : 0.5);
  useEffect(() => {
    if (volume > 0.001) lastNonZeroVolumeRef.current = volume;
  }, [volume]);
  const toggleMute = () => {
    if (volume > 0.001) {
      updateSettings({ volume: 0 });
    } else {
      updateSettings({ volume: lastNonZeroVolumeRef.current });
    }
  };

  // Total song length on the engine's INTERNAL TL_audio axis (the
  // same axis `currentTime` lives on). With speed automation this
  // can differ from the natural MIDI duration — what matters here
  // is "elapsed real time at the end of the song", which is what
  // the slider's progress and time readout reflect.
  const duration = song ? audioEngine.midiTimeToTimeline(song.duration) : 0;

  const onRewind = () => {
    audioEngine.seek(0);
    useStore.getState().setCurrentTime(0);
  };

  const SKIP_SECONDS = 10;
  // Read the playhead imperatively at click time so SeekBar doesn't need
  // to subscribe to `useCurrentTime` — that subscription would re-render
  // the whole transport row + buttons at 60 fps during playback.
  const onSkipBack = () => {
    const t = Math.max(0, audioEngine.currentSongTime() - SKIP_SECONDS);
    audioEngine.seek(t);
    useStore.getState().setCurrentTime(t);
  };
  const onSkipForward = () => {
    const t = Math.min(duration, audioEngine.currentSongTime() + SKIP_SECONDS);
    audioEngine.seek(t);
    useStore.getState().setCurrentTime(t);
  };

  // ── Simple click/drag seek across the full song. The detailed
  // timeline editor (ruler + lanes) lives in `<TimelineEditor />`
  // below the viewport; this strip is the "watching" scrub surface
  // that hides together with the rest of the transport overlay
  // when the cursor leaves the canvas.
  const seekDraggingRef = useRef(false);
  const seekFromX = (clientX: number, el: HTMLElement) => {
    if (!song) return;
    const r = el.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const t = fraction * duration;
    audioEngine.seek(t);
    useStore.getState().setCurrentTime(t);
  };
  const onSeekPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!song) return;
    if (e.button !== 0) return;
    seekDraggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekFromX(e.clientX, e.currentTarget);
  };
  const onSeekPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!seekDraggingRef.current) return;
    seekFromX(e.clientX, e.currentTarget);
  };
  const onSeekPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!seekDraggingRef.current) return;
    seekDraggingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be released — ignore */
    }
  };

  // Root + the time/grid/button row are pointer-events-none so empty padding
  // around the controls falls through to the play-toggle area on the canvas.
  // Each interactive widget (Button, Slider) re-enables pointer-events-auto.
  // The multi-lane Timeline used to live below this row but has been
  // promoted to its own `<TimelineEditor />` section outside the canvas
  // — see `Layout.tsx`. Only transport controls remain inside the
  // viewport overlay now.
  return (
    <div className="pointer-events-none px-4 pt-3 pb-4">
      <div className="relative flex items-center">
        {/* Big-font, at-a-glance time readout on the left of the
            transport row. */}
        <TimeReadout duration={duration} />

        {/* Absolute-centered transport group: always at the geometric
            middle of the seek-bar row, independent of how wide the left
            (time) or right (volume/speed/fullscreen) groups become. */}
        <div className="pointer-events-none absolute left-1/2 flex -translate-x-1/2 items-center gap-3">
          <WithTooltip label="Rewind to start">
            <Button
              isDisabled={!song}
              onPress={onRewind}
              aria-label="Rewind to start"
              className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full border border-neutral-700 bg-black/20 text-neutral-200 outline-none backdrop-blur-sm hover:bg-neutral-800/50 focus-visible:border-sky-500 disabled:border-neutral-800 disabled:bg-black/15 disabled:text-neutral-600"
            >
              <RewindToStartIcon className="h-5 w-5" />
            </Button>
          </WithTooltip>
          <WithTooltip label="Rewind 10 seconds">
            <Button
              isDisabled={!song}
              onPress={onSkipBack}
              aria-label="Rewind 10 seconds"
              className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full border border-neutral-700 bg-black/20 text-neutral-200 outline-none backdrop-blur-sm hover:bg-neutral-800/50 focus-visible:border-sky-500 disabled:border-neutral-800 disabled:bg-black/15 disabled:text-neutral-600"
            >
              <Replay10Icon className="h-5 w-5" />
            </Button>
          </WithTooltip>
          <WithTooltip label={transport === "playing" ? "Pause" : "Play"}>
            <Button
              isDisabled={!song || loadStatus.state === "loading"}
              onPress={transport === "playing" ? pauseSong : playSong}
              aria-label={transport === "playing" ? "Pause" : "Play"}
              className="pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full bg-sky-500/90 text-neutral-950 outline-none backdrop-blur-sm hover:bg-sky-400/95 focus-visible:ring-2 focus-visible:ring-sky-300 disabled:bg-neutral-800/70 disabled:text-neutral-600"
            >
              {transport === "playing" ? (
                <PauseIcon className="h-6 w-6" />
              ) : (
                <PlayIcon className="ml-0.5 h-6 w-6" />
              )}
            </Button>
          </WithTooltip>
          <WithTooltip label="Forward 10 seconds">
            <Button
              isDisabled={!song}
              onPress={onSkipForward}
              aria-label="Forward 10 seconds"
              className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full border border-neutral-700 bg-black/20 text-neutral-200 outline-none backdrop-blur-sm hover:bg-neutral-800/50 focus-visible:border-sky-500 disabled:border-neutral-800 disabled:bg-black/15 disabled:text-neutral-600"
            >
              <Forward10Icon className="h-5 w-5" />
            </Button>
          </WithTooltip>
          <WithTooltip label={loop ? "Disable loop" : "Enable loop"}>
            <Button
              isDisabled={!song}
              onPress={() => setLoop(!loop)}
              aria-label={loop ? "Disable loop" : "Enable loop"}
              className={
                loop
                  ? "pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full border border-sky-500 bg-sky-500/20 text-sky-300 outline-none backdrop-blur-sm hover:bg-sky-500/30 focus-visible:ring-2 focus-visible:ring-sky-300 disabled:border-neutral-800 disabled:bg-black/15 disabled:text-neutral-600"
                  : "pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full border border-neutral-700 bg-black/20 text-neutral-200 outline-none backdrop-blur-sm hover:bg-neutral-800/50 focus-visible:border-sky-500 disabled:border-neutral-800 disabled:bg-black/15 disabled:text-neutral-600"
              }
            >
              <LoopIcon className="h-5 w-5" />
            </Button>
          </WithTooltip>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Volume */}
          <PopSliderButton
            id="volume"
            openId={openPopoverId}
            setOpenId={setOpenPopoverId}
            ariaLabel="Volume"
            label="Volume"
            iconLabel={
              volume <= 0.001 ? (
                <VolumeMuteIcon className="h-5 w-5" />
              ) : volume <= 0.4 ? (
                <VolumeLowIcon className="h-5 w-5" />
              ) : (
                <VolumeHighIcon className="h-5 w-5" />
              )
            }
            value={volume}
            min={0}
            max={1.5}
            step={0.01}
            onChange={(v) => updateSettings({ volume: v })}
            format={fmtVolume}
            onClick={toggleMute}
          />
          {/* Speed: text label doubles as the icon */}
          <PopSliderButton
            id="speed"
            openId={openPopoverId}
            setOpenId={setOpenPopoverId}
            ariaLabel="Playback speed"
            label="Speed"
            iconLabel={
              <span className="font-mono text-[11px] tabular-nums">
                {fmtSpeed(playbackRate)}
              </span>
            }
            value={playbackRate}
            min={0.25}
            max={2}
            step={0.05}
            onChange={(v) => updateSettings({ playbackRate: v })}
            format={fmtSpeed}
            buttonClass="flex h-11 min-w-[52px] items-center justify-center rounded-full border border-neutral-700 bg-black/20 px-2 text-neutral-200 outline-none backdrop-blur-sm hover:bg-neutral-800/50 focus-visible:border-sky-500"
          />
          <WithTooltip label="Reset camera view">
            <Button
              onPress={resetCameraView}
              aria-label="Reset camera view"
              className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full border border-neutral-700 bg-black/20 text-neutral-200 outline-none backdrop-blur-sm hover:bg-neutral-800/50 focus-visible:border-sky-500"
            >
              <ResetViewIcon className="h-5 w-5" />
            </Button>
          </WithTooltip>
          <WithTooltip label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}>
            <Button
              onPress={onToggleFullscreen}
              aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full border border-neutral-700 bg-black/20 text-neutral-200 outline-none backdrop-blur-sm hover:bg-neutral-800/50 focus-visible:border-sky-500"
            >
              {isFullscreen ? (
                <FullscreenExitIcon className="h-5 w-5" />
              ) : (
                <FullscreenIcon className="h-5 w-5" />
              )}
            </Button>
          </WithTooltip>
        </div>
      </div>

      {/* Simple full-song progress slider, shown alongside the
          transport buttons. Hides together with the surrounding
          gradient when the cursor leaves the canvas. The detailed
          editor (ruler / MIDI / audio lanes) is in TimelineEditor. */}
      <div
        onPointerDown={onSeekPointerDown}
        onPointerMove={onSeekPointerMove}
        onPointerUp={onSeekPointerUp}
        onPointerCancel={onSeekPointerUp}
        className={
          song
            ? "group pointer-events-auto relative mt-3 flex h-3 cursor-pointer items-center"
            : "relative mt-3 flex h-3 items-center"
        }
        style={{ touchAction: "none" }}
        role={song ? "slider" : undefined}
        aria-label="Seek"
      >
        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-neutral-700/70 transition-all duration-150 group-hover:h-3 group-hover:bg-neutral-500/80">
          <ProgressFill duration={duration} />
        </div>
      </div>
    </div>
  );
}
