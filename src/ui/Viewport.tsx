import { useEffect, useRef, useState } from "react";
import { DropZone, Text } from "react-aria-components";
import { useHover } from "react-aria";
import { Scene } from "../scene/Scene";
import { SeekBar } from "./SeekBar";
import { FastForwardIcon, PauseIcon, PlayIcon } from "./icons";
import { useStore } from "../store";
import { audioEngine } from "../audio/engine";
import { parseMidi } from "../midi/parse";

const ASPECT = 16 / 9;
// Auto-hide the seek bar / play controls after this many ms of no pointer
// movement while the song is playing. Matches the rough cadence of video
// players; long enough that brief pauses to read the timestamp don't dismiss.
const IDLE_HIDE_MS = 2000;

// How long the transport feedback badge stays at full opacity before it
// pops back out. Plus the ~250ms transition this gives roughly a second of
// total presence — long enough to read clearly without lingering.
const FEEDBACK_VISIBLE_MS = 800;
// Easing curves: a back-out cubic on appear gives the badge an overshoot
// that reads as a soft "pop", and a snappier ease-in on hide makes it
// shrink decisively rather than sliding away.
const FEEDBACK_EASE_IN = "cubic-bezier(0.175, 0.885, 0.32, 1.4)";
const FEEDBACK_EASE_OUT = "cubic-bezier(0.4, 0, 1, 1)";

/**
 * Transient centered play / pause badge fired on every transport toggle.
 * Like a video player, the icon flashes briefly to acknowledge the action
 * (play icon when starting, pause icon when stopping) and then fades out.
 * Does not gate on `transport !== 'playing'` — it's a transition cue, not
 * a persistent state indicator. `pointer-events-none` so the underlying
 * canvas still receives clicks for play/pause toggling.
 */
function TransportFeedback() {
  const transport = useStore((s) => s.transport);
  const song = useStore((s) => s.song);
  const loadStatus = useStore((s) => s.loadStatus);
  const [feedback, setFeedback] = useState<"play" | "pause" | null>(null);
  // Latched icon: kept around during the fade-out so the icon doesn't swap
  // mid-animation if the next transition arrives before this one finishes.
  const [displayIcon, setDisplayIcon] = useState<"play" | "pause">("play");
  const prevTransportRef = useRef(transport);
  // The very first play after sample loading isn't a user "toggle" — the
  // user already pressed play earlier and was just waiting on the load —
  // so the badge would feel redundant. We mark this state when loadStatus
  // resolves to 'ready' and consume it on the next 'playing' transition.
  const skipNextPlayRef = useRef(false);

  useEffect(() => {
    if (loadStatus.state === "ready") skipNextPlayRef.current = true;
  }, [loadStatus]);

  useEffect(() => {
    const prev = prevTransportRef.current;
    prevTransportRef.current = transport;
    // Only react to actual transitions, and only once a song is loaded so
    // initial mount ('stopped' → 'stopped' once a song lands) doesn't fire.
    if (prev === transport || !song) return;
    if (transport === "playing") {
      if (skipNextPlayRef.current) {
        skipNextPlayRef.current = false;
        return;
      }
      setDisplayIcon("play");
      setFeedback("play");
    } else if (prev === "playing") {
      setDisplayIcon("pause");
      setFeedback("pause");
    }
  }, [transport, song]);

  useEffect(() => {
    if (feedback === null) return;
    const t = window.setTimeout(() => setFeedback(null), FEEDBACK_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [feedback]);

  const visible = feedback !== null;
  return (
    <div
      className="pointer-events-none absolute inset-0 flex items-center justify-center pb-[15%]"
      aria-hidden={!visible}
    >
      <div
        style={{
          transitionTimingFunction: visible
            ? FEEDBACK_EASE_IN
            : FEEDBACK_EASE_OUT,
        }}
        className={`flex h-20 w-20 items-center justify-center rounded-full bg-black/55 shadow-lg ring-1 ring-white/10 backdrop-blur-sm transition-[opacity,transform] duration-200 ${
          visible ? "scale-100 opacity-100" : "scale-50 opacity-0"
        }`}
      >
        {displayIcon === "pause" ? (
          <PauseIcon className="h-9 w-9 text-white" />
        ) : (
          <PlayIcon className="ml-1 h-9 w-9 text-white" />
        )}
      </div>
    </div>
  );
}

/**
 * Top-center pill shown while the user is holding the falling-notes area
 * to fast-forward. `pointer-events-none` so the underlying click-to-hold
 * region keeps receiving events for the entire hold duration.
 */
function FastForwardIndicator() {
  const fastForward = useStore((s) => s.fastForward);
  return (
    <div
      className={`pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 transition-all duration-150 ${
        fastForward ? "scale-100 opacity-100" : "scale-90 opacity-0"
      }`}
      aria-hidden={!fastForward}
    >
      <div className="flex items-center gap-1.5 rounded-full bg-black/65 px-3 py-1 text-xs font-semibold text-white shadow-lg ring-1 ring-white/15 backdrop-blur-sm">
        <FastForwardIcon className="h-3.5 w-3.5" />
        <span className="tabular-nums">2x</span>
      </div>
    </div>
  );
}

export function Viewport() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const transport = useStore((s) => s.transport);
  const setSong = useStore((s) => s.setSong);
  const setTransport = useStore((s) => s.setTransport);

  // useHover is touch-aware: it does not fire on touch tap (unlike CSS :hover
  // which sticks until the next interaction) and is normalised across browsers.
  const { hoverProps, isHovered } = useHover({});
  // YouTube-style idle auto-hide: while playing+hovered, hide the controls
  // after a stretch of no pointer movement. Pause / stop keeps them visible
  // (the user can always reach play/seek).
  const [idleHidden, setIdleHidden] = useState(false);
  // Whether any popover (volume/speed) opened from the SeekBar is currently
  // visible. Popovers render in a portal outside the viewport, so the user's
  // cursor leaves the hover area and the controls would otherwise auto-hide
  // while they're still adjusting a value.
  const [popoverOpen, setPopoverOpen] = useState(false);
  // Cursor follows idleHidden but lags both directions by ~100ms so the
  // cursor and the controls appear/disappear at the same visual moment.
  // The seek bar's 200ms opacity fade reads as "gone" / "showing" around
  // its midpoint, which matches a 100ms delay on the cursor.
  const [cursorHidden, setCursorHidden] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setCursorHidden(idleHidden), 100);
    return () => clearTimeout(t);
  }, [idleHidden]);

  // Fullscreen tracking. We fullscreen the DropZone wrapper so the Scene,
  // indicators and SeekBar all follow into fullscreen — the surrounding
  // Toolbar/Inspector are naturally hidden by the browser. ResizeObserver
  // re-fires on the dimension change, so the 16:9 letterbox recomputes
  // automatically.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () =>
      setIsFullscreen(document.fullscreenElement === wrapRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = async () => {
    const el = wrapRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (el.requestFullscreen) {
        await el.requestFullscreen();
      }
    } catch {
      /* user-gesture or permission failure — silently ignore */
    }
  };
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || transport !== "playing" || !isHovered || popoverOpen) {
      // Only the playing+hovered branch (with no popover open) arms the
      // timer; reset hidden flag so we start "visible" next time.
      setIdleHidden(false);
      return;
    }
    let timer: number | null = null;
    const arm = () => {
      if (timer !== null) clearTimeout(timer);
      timer = window.setTimeout(() => setIdleHidden(true), IDLE_HIDE_MS);
    };
    const onMove = (e: PointerEvent) => {
      setIdleHidden(false);
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      // While the cursor is parked on an interactive control (transport
      // button, popover trigger, seek slider, etc.) keep the seek bar up —
      // a stationary cursor produces no further pointermove events, so the
      // idle timer would otherwise fire under the user's cursor.
      const target = e.target as HTMLElement | null;
      const onControl = !!target?.closest('button, [role="slider"]');
      if (!onControl) arm();
    };
    arm(); // also start the countdown if entry happened with no movement (e.g. just pressed play)
    el.addEventListener("pointermove", onMove);
    return () => {
      el.removeEventListener("pointermove", onMove);
      if (timer !== null) clearTimeout(timer);
    };
  }, [transport, isHovered, popoverOpen]);
  const controlsVisible =
    (isHovered && !idleHidden) || popoverOpen || transport !== "playing";

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const containerAspect = r.width / r.height;
      let w: number, h: number;
      if (containerAspect > ASPECT) {
        h = r.height;
        w = h * ASPECT;
      } else {
        w = r.width;
        h = w / ASPECT;
      }
      setSize({ w, h });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleFile = async (file: File) => {
    const buf = await file.arrayBuffer();
    const parsed = await parseMidi(buf, file.name);
    setSong(parsed);
    audioEngine.loadSong(parsed);
    setTransport("stopped");
  };

  return (
    <DropZone
      ref={wrapRef}
      className="relative flex flex-1 items-center justify-center overflow-hidden bg-black outline-none"
      getDropOperation={(types) =>
        // Accept any file drop; we filter by .mid/.midi in onDrop
        types.has("Files") ? "copy" : "cancel"
      }
      onDrop={async (e) => {
        const fileItem = e.items.find((item) => item.kind === "file");
        if (!fileItem || fileItem.kind !== "file") return;
        if (!/\.midi?$/i.test(fileItem.name)) return;
        const file = await fileItem.getFile();
        await handleFile(file);
      }}
    >
      {({ isDropTarget }) => (
        <>
          {/* Visually-hidden label for screen readers */}
          <Text slot="label" className="sr-only">
            Drop a MIDI file here
          </Text>
          <div
            className={`relative shadow-2xl ${cursorHidden && !popoverOpen ? "cursor-none" : ""}`}
            style={{ width: size.w, height: size.h, touchAction: "none" }}
            {...hoverProps}
          >
            <Scene />
            <TransportFeedback />
            <FastForwardIndicator />
            {/* Gradient and SeekBar root are click-through (pointer-events-none);
                only the buttons / slider inside SeekBar carry pointer-events-auto.
                That lets the lower PlayToggleArea under the keyboard still
                receive clicks in the empty space around the controls.
                When hiding, visibility transitions to hidden after the opacity
                fade so the (invisible) buttons stop intercepting events. */}
            <div
              className={`pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent pt-10 transition-[opacity,visibility] duration-200 ${
                controlsVisible
                  ? "visible opacity-100"
                  : "invisible opacity-0 [transition-delay:0s,200ms]"
              }`}
            >
              <SeekBar
                isFullscreen={isFullscreen}
                onToggleFullscreen={toggleFullscreen}
                onPopoverOpenChange={setPopoverOpen}
              />
            </div>
            {isDropTarget && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-sky-500/10 ring-2 ring-inset ring-sky-400">
                <span className="rounded bg-neutral-950/80 px-3 py-1 text-sm text-sky-300">
                  Drop MIDI file
                </span>
              </div>
            )}
          </div>
        </>
      )}
    </DropZone>
  );
}
