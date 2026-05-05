import { useEffect, useMemo, useRef, useState } from "react";
import {
  DropZone,
  Label,
  Slider,
  SliderOutput,
  SliderThumb,
  SliderTrack,
  Text,
} from "react-aria-components";
import { useHover } from "react-aria";
import { Scene } from "../scene/Scene";
import { SeekBar } from "./SeekBar";
import { FastForwardIcon, PauseIcon, PlayIcon } from "./icons";
import { useStore } from "../store";
import { audioEngine } from "../audio/engine";
import { previewNote } from "../audio/preview";
import { parseMidi } from "../midi/parse";
import { setNotesVelocity } from "../midi/edit";

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
 * Per-note context menu (right-click on a falling note in edit mode).
 * Hijacks the browser context menu to expose note-level edit affordances
 * — currently a velocity slider that sets the velocity of every selected
 * note. Average velocity is shown on multi-select; adjusting the slider
 * sets all selected notes to the new value.
 *
 * History grouping: a single open-menu session collapses to one undo
 * entry. The pre-edit snapshot is captured on the first onChange and the
 * "session" is reset when the menu closes. Subsequent re-opens start a
 * fresh session.
 */
function NoteContextMenu({ wrapEl }: { wrapEl: HTMLElement | null }) {
  const ctxMenu = useStore((s) => s.contextMenu);
  const setContextMenu = useStore((s) => s.setContextMenu);
  const selection = useStore((s) => s.selection);
  const song = useStore((s) => s.song);
  const transport = useStore((s) => s.transport);
  const pushUndoSnapshot = useStore((s) => s.pushUndoSnapshot);
  const setSongPreview = useStore((s) => s.setSongPreview);

  const sessionStartedRef = useRef(false);

  // Periodic-preview ticker. While the user is actively dragging the
  // velocity slider we play the anchor note every 500 ms so they can
  // hear the loudness changing — a one-shot preview at slider release
  // would land too late to inform the gesture.
  const previewIntervalRef = useRef<number | null>(null);
  const firePreview = () => {
    const state = useStore.getState();
    if (!state.song || state.selection.size === 0) return;
    const sel = state.song.notes.filter((n) => state.selection.has(n.id));
    if (sel.length === 0) return;
    // Use the first selected note (sorted by time) as the audible
    // representative. Multi-select sets all selected notes to the same
    // velocity, so reading any selected note's velocity yields the
    // current slider value.
    const anchor = sel[0];
    void previewNote(
      anchor.midi + state.settings.transpose,
      anchor.velocity,
      200,
    );
  };
  const startPreviewLoop = () => {
    if (previewIntervalRef.current !== null) return;
    firePreview(); // immediate cue so the very first slider movement is audible
    previewIntervalRef.current = window.setInterval(firePreview, 500);
  };
  const stopPreviewLoop = () => {
    if (previewIntervalRef.current !== null) {
      window.clearInterval(previewIntervalRef.current);
      previewIntervalRef.current = null;
    }
  };

  // Outside-click + Escape close the menu.
  useEffect(() => {
    if (!ctxMenu) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-note-context-menu]")) return;
      setContextMenu(null);
      sessionStartedRef.current = false;
      stopPreviewLoop();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setContextMenu(null);
        sessionStartedRef.current = false;
        stopPreviewLoop();
      }
    };
    // Defer mousedown attach by a tick so the right-click that opens the
    // menu doesn't immediately get caught by the outside-click handler.
    const t = window.setTimeout(() => {
      window.addEventListener("mousedown", onMouseDown);
    }, 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu, setContextMenu]);

  // Belt-and-braces cleanup: clear the ticker on unmount so a quickly-
  // closed menu can't leak an interval.
  useEffect(() => {
    return () => stopPreviewLoop();
  }, []);

  // Selected notes derived per render — kept inline rather than memoised
  // because both inputs (song / selection) already participate in the
  // store's referential change detection.
  const selectedNotes = useMemo(
    () => (song ? song.notes.filter((n) => selection.has(n.id)) : []),
    [song, selection],
  );

  // Hide gracefully if any precondition for "edit a selected note" no
  // longer holds. Doesn't clear the underlying state — the next valid
  // context (re-open + re-select) will use it again.
  if (
    !ctxMenu ||
    !wrapEl ||
    !song ||
    transport === "playing" ||
    selectedNotes.length === 0
  ) {
    return null;
  }

  const wrapRect = wrapEl.getBoundingClientRect();
  // Clamp the menu's position so it can't slide off the canvas edge or
  // get hidden behind the Inspector when the user right-clicks near the
  // viewport's right / bottom border. Width / height are estimates based
  // on the menu's content (`min-w-[14rem]` plus padding); slightly
  // generous on purpose so the eye sees the menu fully on-screen, not
  // teetering at the edge.
  const MENU_W = 240;
  const MENU_H = 110;
  const PAD = 8;
  const rawLeft = ctxMenu.x - wrapRect.left;
  const rawTop = ctxMenu.y - wrapRect.top;
  const left = Math.max(
    PAD,
    Math.min(rawLeft, wrapRect.width - MENU_W - PAD),
  );
  const top = Math.max(
    PAD,
    Math.min(rawTop, wrapRect.height - MENU_H - PAD),
  );

  const avgVelocity =
    selectedNotes.reduce((s, n) => s + n.velocity, 0) / selectedNotes.length;

  const handleChange = (raw: number | number[]) => {
    const value = typeof raw === "number" ? raw : raw[0];
    if (!song) return;
    if (!sessionStartedRef.current) {
      pushUndoSnapshot(song);
      sessionStartedRef.current = true;
    }
    setSongPreview(setNotesVelocity(song, selection, () => value));
    // Each onChange call (every dragged tick or each click on the
    // track) pings the preview ticker. startPreviewLoop is idempotent
    // so continuous dragging doesn't stack intervals.
    startPreviewLoop();
  };
  const handleChangeEnd = () => {
    // The slider thumb was released — stop pinging until the user grabs
    // it again. Without this the ticker would keep firing at the last
    // velocity until the menu itself closed.
    stopPreviewLoop();
  };

  return (
    <div
      data-note-context-menu
      className="absolute z-50 min-w-[14rem] rounded-md border border-neutral-700 bg-neutral-900/95 p-3 shadow-2xl backdrop-blur-sm"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
        {selectedNotes.length === 1
          ? "Note"
          : `${selectedNotes.length} notes selected`}
      </div>
      <Slider
        value={avgVelocity}
        minValue={0.01}
        maxValue={1}
        step={0.01}
        onChange={handleChange}
        onChangeEnd={handleChangeEnd}
        className="flex flex-col gap-1.5"
      >
        <div className="flex items-center justify-between text-xs select-none">
          <Label className="text-neutral-300">Velocity</Label>
          <SliderOutput className="text-neutral-200 tabular-nums">
            {Math.round(avgVelocity * 127)}
          </SliderOutput>
        </div>
        <SliderTrack className="relative flex h-4 w-full cursor-pointer items-center">
          {({ state }) => (
            <>
              <div className="relative h-2 w-full overflow-hidden rounded-full bg-neutral-800">
                <div
                  className="h-full bg-sky-400"
                  style={{ width: `${state.getThumbPercent(0) * 100}%` }}
                />
              </div>
              <SliderThumb className="top-1/2 h-3 w-3 rounded-full bg-white shadow ring-1 ring-neutral-900 outline-none data-[dragging]:scale-125 focus-visible:ring-2 focus-visible:ring-sky-400" />
            </>
          )}
        </SliderTrack>
      </Slider>
    </div>
  );
}

/**
 * Marquee rectangle for range-select while in edit mode. The rect is
 * stored in client (CSS) coords by EditTools' window-level pointermove,
 * which means we have to subtract the wrapper element's bounding box to
 * place the div correctly relative to the letterboxed Canvas. `pointer-
 * events-none` so the underlying canvas / EditTools mesh keeps receiving
 * the in-flight pointer events that drive the rect.
 */
function RangeSelectRect({ wrapEl }: { wrapEl: HTMLElement | null }) {
  const rect = useStore((s) => s.rangeSelectRect);
  if (!rect || !wrapEl) return null;
  const r = wrapEl.getBoundingClientRect();
  const left = Math.min(rect.x1, rect.x2) - r.left;
  const top = Math.min(rect.y1, rect.y2) - r.top;
  const width = Math.abs(rect.x2 - rect.x1);
  const height = Math.abs(rect.y2 - rect.y1);
  return (
    <div
      className="pointer-events-none absolute border border-sky-400/80 bg-sky-400/10"
      style={{ left, top, width, height }}
      aria-hidden
    />
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
  // Ref to the INNER letterboxed div. Range-select / future overlays
  // position absolutely inside this element, so their offsets need this
  // div's bounding rect — not the outer DropZone, which spans the full
  // available area and is offset from the canvas by the letterbox bars.
  const innerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const transport = useStore((s) => s.transport);
  const setSong = useStore((s) => s.setSong);
  const setTransport = useStore((s) => s.setTransport);
  // Drives the click-eater overlay: while samples are being downloaded
  // we shouldn't let any canvas interaction (play toggle, eraser, new
  // note, range-select, hold-to-fast-forward) fire. The Inspector and
  // Toolbar stay live since they sit outside the Viewport.
  const isLoading =
    useStore((s) => s.loadStatus.state) === "loading";

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

  // Suppress the browser's native context menu over the 3D canvas while a
  // song is loaded — right-click is repurposed as the per-note context
  // menu, and the browser default would either pop up alongside it or
  // (when right-clicking empty space) get in the way of the editing flow.
  // Outside the canvas (Inspector, Toolbar, Popovers) the browser menu
  // stays untouched so users can still inspect / view-source / paste etc.
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.tagName === "CANVAS") e.preventDefault();
    };
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []);

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
            ref={innerRef}
            className={`relative shadow-2xl ${cursorHidden && !popoverOpen ? "cursor-none" : ""}`}
            style={{ width: size.w, height: size.h, touchAction: "none" }}
            {...hoverProps}
          >
            <Scene />
            {/* Click-eater while the sampler is loading. Sits between
                the Scene canvas and the SeekBar gradient, so canvas
                interactions are blocked but SeekBar / NoteContextMenu /
                Inspector / Toolbar stay live. cursor-wait gives the
                visual feedback that interaction is paused. */}
            {isLoading && (
              <div
                aria-hidden
                className="absolute inset-0 cursor-wait"
              />
            )}
            <TransportFeedback />
            <FastForwardIndicator />
            <RangeSelectRect wrapEl={innerRef.current} />
            <NoteContextMenu wrapEl={innerRef.current} />
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
