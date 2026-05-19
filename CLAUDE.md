# notefall

Browser-based piano visualizer. Notes fall onto an 88-key keyboard while a MIDI plays; users can also play live (touch / mouse / PC keyboard / Web MIDI), record, and edit MIDI directly on the canvas. All client-side. PolyForm Shield 1.0.0.

## Stack

- Vite + React 18 + TypeScript
- `@react-three/fiber` + `drei` + `@react-three/postprocessing` (Bloom)
- `smplr` (`SplendidGrandPiano`) for sampled playback
- `@tonejs/midi` for parse/serialize; `tone` only for AudioContext lifecycle
- `react-aria-components` + Tailwind for UI; `zustand` for state
- IndexedDB for recordings; Web MIDI API for hardware input
- `mp4-muxer` + WebCodecs (`VideoEncoder` / `AudioEncoder`) for offline MP4 export

## Layout

```
src/
├ App.tsx        Layout, fallbacks for no-WebGL or <1024px
├ store.ts       zustand: settings, song, transport, editor, project file
├ midi/          parse / serialize / edit (resolveOverlaps lives here)
├ projects/      .nfz zip format + FSA wrapper + recent files
├ audio/         engine, sampler, recorder, click metronome, MIDI input, preview,
│                clock (pluggable time source — real wall-clock or virtual export clock)
├ keyboard/      88-key layout + Keyboard.tsx (3D cap geometry, glow, input)
├ notes/         FallingNotes (SDF shader), HitLine, HitParticles, LandingFlashes,
│                noteDeathFx pub-sub, customTexture
├ scene/         Canvas + EditTools (paused) / PlayToggleArea (playing) +
│                exportBridge (R3F state getter for the offline video pass)
├ export/        renderAudio (OfflineAudioContext → AudioBuffer / WAV),
│                renderVideo (frame-stepped R3F → AVC + AAC → mp4-muxer),
│                exportAudio / exportVideo (download wrappers)
└ ui/            Layout, Toolbar, Inspector, Viewport, SeekBar, ConfirmModal,
                 ExportSettingsDialog, ExportProgressModal
```

## Coordinates

- Camera at `[0, 0, 12]`, FOV 32°. Keyboard at `keyboardY = -2.0`.
- 1 mm = 0.01 wu. White: 0.235 × 1.475. Black: 0.137 × 0.95. 88 white keys × 0.235 = 12.22 wu = full 16:9 viewport width.
- White keys are 3D solid caps with rounded corners (`createRoundedWhiteGeometry`); black keys are custom chamfered geometry with an **inner solid fill** so chamfer/slope seams resolve to black instead of revealing the void behind.
- Hit line at `keyboardY + WHITE_KEY_LENGTH`. Note plane z = 0.05; clipping is **per-fragment SDF** (`vWorldY < uHitY`), NOT z-occlusion — putting notes at a different z would cause perspective parallax against the keys.

## AudioEngine (`src/audio/engine.ts`)

Singleton, decoupled from React. Self-clocked via `now()` from `audio/clock.ts` (default = `performance.now() / 1000`; the offline video exporter swaps in a `VirtualClock`). `Layout.tsx` syncs settings → engine via `useEffect`s.

- **Two tick drivers**: `useFrame` (visual sync, paused on hidden tab) + Web Worker `setInterval(25 ms)` (background-tab playback would otherwise stall and burst on return).
- **Unique `stopId` per note** is mandatory. smplr defaults `stopId` to midi number, so back-to-back same-pitch notes share an id and stopping one cancels another mid-release. We pass `s${noteId}` for song, `live${liveId}` for touch, `prev-${n}` for previews.
- **Lookahead 0.015 s + stop buffer 0.02 s** prevent attack clicks and cancel-before-start drops.
- **Pedal sustain**: when pedal is engaged and a note's `endTime` arrives, its stop fn is pushed onto `pedalHeld[]`. Pedal-up flushes per-source ('song' / 'live').
- **Init dedupe**: concurrent `init()` callers share `initPromise`, so the ~60 MB sample load isn't kicked off twice.
- **`updateSong(song)`**: editor-driven replacement. Selectively releases active notes whose id/midi/endTime changed; structurally-unchanged notes stay so the engine fires their note-off naturally. Without this, pause+edit+resume left phantom-held notes.
- **`addLiveListener` ≠ `addKeyListener`**: live channel only fires for user input (recorder uses it to capture only what the user played).
- **`triggerPreview`**: plays a sampler note WITHOUT firing key listeners — editor previews don't trigger glow/particles.
- **`pause()`** keeps visualizer state intact, only kills audio via `releaseAllSounding()`.
- **Silent / export mode** — `beginExportPlayback()` resets the song cursor and flips `silent = true` so `tick()` walks the timeline emitting only listener events (no `piano.start()`, no pedal-held queue mutation, no end-of-song auto-stop). The video exporter brackets the render with `begin/endExportPlayback` and drives the virtual clock externally.

## Sampler (`src/audio/sampler.ts`)

Loads the `SplendidGrandPiano` sample set (~60 MB, 4 velocity layers) directly via smplr's underlying `Smplr` class — NOT the `SplendidGrandPiano` wrapper, because that wrapper drops the `scheduler` option when forwarding to its inner `Smplr`. The offline audio render passes a custom `Scheduler` with `lookaheadMs: Infinity` so every `piano.start()` dispatches synchronously inside `OfflineAudioContext.startRendering()` (smplr's default `setInterval`-driven scheduler never fires during offline render and would silently drop everything past the first 100 ms).

`createPiano(context, onProgress, options)` accepts any `BaseAudioContext` — the realtime engine passes Tone's `rawContext`, the offline exporter passes a fresh `OfflineAudioContext`. Same effect-chain wiring (master → 6-band EQ → split → dry / pre-delay → reverb → wet) is used in both paths so render parity is automatic.

**FadeInStorage** is critical — smplr's `Voice` sets `envelope.gain.value = 1` instantly (no attack), so any sample whose first frame isn't zero clicks on attack. We intercept the storage layer, decode, apply 1.5 ms linear fade-in, re-encode WAV, hand back to smplr.

## Falling notes (`src/notes/FallingNotes.tsx`)

Single `InstancedMesh` + custom ShaderMaterial. Per-instance: `instanceSize` / `instanceSeed` / `instanceSelected` / `instanceAlpha`. Fragment shader clips `vWorldY < uHitY` per pixel, then SDF rounded-box, texture preset, edge, selection outline.

Each `useFrame`: places song notes, appends live notes (always 'up'), appends `noteDeathFx.list()` ghosts (fading via `instanceAlpha`). Maintains `instanceToNoteId[]` for click→note resolution. **Pin `mesh.boundingSphere = Sphere(0, 1000)`** to defeat three.js's stale lazy BS — auto-computed once would silently fail raycast for later far-positioned notes.

`fallDirection`: `'down'` future falls onto keyboard; `'up'` past rises as history trail.

## Editor

Active when `transport !== 'playing' && song !== null` — `Scene.tsx` mounts `<EditTools />` instead of `<PlayToggleArea />`.

**Undo plumbing** — three setters keep "whole drag = 1 undo entry":
- `applySongEdit(next)` — push history, replace, clear future, sync engine
- `setSongPreview(s)` — replace without history (in-flight drags)
- `pushUndoSnapshot(snapshot)` — push without applying (call once at drag start)

**Gestures:**

| Target | Input | Action |
|---|---|---|
| Note body | LClick | Select + arm move-drag |
| Note body | Cmd+L / Alt+L / RClick / DblClick | Toggle selection / split / delete that note / velocity menu |
| Note edge | LDrag | Edge-resize (head moves time+duration; tail duration only) |
| Empty above hit | LClick | Create note + arm position-drag (1 undo entry) |
| Empty | Cmd+LDrag / RDrag | Marquee range-select (additive) / eraser sweep |
| (any) | Del / Esc / Arrows / Cmd+Z / Shift+Z\|Y | Delete selection / clear / nudge ±1 semitone or ±0.05 s / undo / redo |

**Collision rules** ("notes are solid", same-pitch overlap forbidden):
- `moveNotes` clamps time delta uniformly across the moved set. Pitch-shift collision uses **time-overlap**, not pitch-only — strict pitch-only would freeze most drags since same-pitch notes are scattered across time. Touching boundaries allowed.
- Edge-resize clamps to nearest same-pitch obstacle.
- `addNote` uses `resolveOverlaps` with new id as priority; existing overlapping notes get clipped.

**Loading guard.** Transparent click-eater div mounts between Canvas and SeekBar gradient while `loadStatus.state === 'loading'`. The triggering click itself isn't covered (status was still `'idle'` at pointerdown), so editor handlers also early-return when `!audioEngine.isReady()` and kick off `ensureSamplerLoaded` — first cold-session click downloads but doesn't drag. Pairs with `previewNote`'s sync-drop so no audio queues during load.

**Velocity context menu** opens on **double-click** (right-click is taken for delete). One `pushUndoSnapshot` + per-change `setSongPreview`; a 500 ms ticker plays preview audio while the slider is dragged.

## Timeline pins (settings keyframes)

Snapshot keyframes that animate visual settings along the timeline — drop a pin, change settings, drop another pin, and the scene morphs between them. Closer pins → steeper slope → faster visible change (inherent in time-parametric lerp). Modelled on `midiSpeedAutomation`: a speed point carries one scalar, a pin carries a whole settings snapshot.

- **Data** (`midi/settingsKeyframes.ts`). `settingsKeyframes: SettingsKeyframe[]` is a key **inside `Settings`** — so it rides the existing persistence / dirty / undo / `.nfz` paths with zero new plumbing (no manifest schema bump). `SettingsKeyframe = { time /* timeline-time sec */, settings: Partial<Settings>, curvature? }`. `ANIMATABLE_KEYS` enumerates the snapshot-able continuous visual keys (camera, colours, opacity/emissive, bloom, background, …) — discrete enums/booleans, audio, timeline-layout and song-sync are excluded. `pickAnimatable(s)` extracts that subset.
- **Resolver** `resolveSettingsAt(base, kfs, t)` — pure. **0 pins → returns `base` by reference** (bit-for-bit identity; the whole feature is a no-op until a pin exists). Before first / after last pin → that endpoint held. Between → per-type lerp (number / `#rrggbb` via THREE.Color / vec3 / colour-map), eased by the left pin's `curvature` (same `applyCurvature` shape as `speedMap`).
- **Time base.** `t = audioEngine.currentSongTime()` — the same clock-driven value `FallingNotes` uses to place song notes. Because it flows through `audio/clock.ts`, pin animation is identical in live preview and the offline exporter (`renderVideo` swaps a `VirtualClock` and steps `r3f.advance()`) — **export parity is automatic**.
- **Supply** (`scene/automatedSettings.ts`). `AutomatedSettingsDriver` (mounted in `Scene` before every consumer; same-priority R3F useFrames run in mount order) recomputes `getResolvedSettings()` each frame. Visual consumers (`FallingNotes`, `HitLine`, `HitParticles`, `LandingFlashes`, `Keyboard`, `CameraSync`) read **animatable** keys from the resolved snapshot in their per-frame code; non-animatable keys stay on `useSettingsSlice`. Background and Bloom are applied **imperatively** in `BackgroundSync` / `BloomSync` useFrames (writing `scene.background` and the `BloomEffect`'s intensity/threshold/smoothing/radius) — React-prop updates wouldn't reach the exporter, which never re-renders React. The timeline editor's MIDI clip (`Timeline.tsx` → `MidiPreviewCanvas`) tints **each note by `resolveNoteTintAt(...)` at that note's OWN time** (note TL_audio = `midiOffset + midiToTimeline(speedMap, n.time)`), so the whole colour automation reads as a static gradient along the clip even while paused — it must NOT be a single playhead colour (the pin-edit base drift would otherwise stick it on the last-written colour) and must NOT use `getResolvedSettings()` (the R3F driver only ticks while the Canvas renders; the editor is used paused). `resolveNoteTintAt` is the cheap colour-only sibling of `resolveSettingsAt` (no ~100-key spread). The per-note array is memoised on notes/pins/base-tint/speedMap/offset — NOT the playhead — so scrub/play never recomputes or repaints it; `null` with no pins → unchanged base-colour path.
- **Editing UX.** Pins live on a fixed 16 px strip under the ruler (`ui/SettingsPinLane.tsx`, wired in `Timeline.tsx`) — diamond markers, not a value graph. `P` / `+` adds at the playhead and a left-click on empty lane space adds at the clicked time; clicking a pin selects + seeks, drag moves, right-drag sweeps to erase every pin under the cursor, Del removes — each gesture collapses to one undo entry (begin/endSettingsEdit refcount nests with `removeKeyframe`'s own). Cursors mirror the note editor: `crosshair` on empty lane, `move` over a pin, `not-allowed` while erasing. Selecting a pin loads its snapshot into base `settings` and sets `editingKeyframeTime`; while set, `updateSettings` transparently mirrors the animatable patch into that pin's snapshot too — so **every Inspector control keeps working unchanged** and just edits "the pin". `Inspector` shows an "Editing pin @ m:ss" banner with a Clear button. Base drift is harmless: once any pin exists, animatable base values are fully shadowed by the resolver.

## Note death FX (`noteDeathFx.ts`)

Right-click and eraser drag emit `DyingNote { midi, velocity, x, centerY, width, length }`. `HitParticles` spawns a 0.35 s phantom emitter; `FallingNotes` reads `list()` and renders a fading ghost (`instanceAlpha = 1 - age/0.12s`). Bulk delete (Delete key, programmatic) skips the channel — wholesale deletion shouldn't spawn dozens of puffs.

## Hit particles (`src/notes/HitParticles.tsx`)

3D curl-noise system. Per-particle world XYZ position so the divergence-free field produces internal cluster width without horizontal spreading (a 2D curl produced either thin strands or too-wide spread). EMA-smoothed (60 ms) curl filters lattice-cell discontinuities. Two emission paths share `emitParticleAt(...)`:
- **Per-key** — `addKeyListener` → ATTACK_BURST (3) on note-on + sustained per-frame while held.
- **Note death** — `noteDeathFx` → `DeathEmitter` for `DEATH_EMIT_DURATION` (0.35 s).

## Landing flashes (`src/notes/LandingFlashes.tsx`)

One `InstancedMesh` instance per key. Bumps intensities **instantly** on note-on (no fade-in) and extends `heldUntil[idx] = now + 80 ms` so super-short notes still register a flash.

## Keyboard (`src/keyboard/Keyboard.tsx`)

Per-key glow uses **reference-counted `held[]`** (not a flag) — back-to-back retriggers may emit on/off in either order within a frame; counting handles overlap correctly.

**Pointer input** (mouse + multi-touch):
- `onPointerDown` releases the touch's implicit pointer capture so sibling keys' `onPointerEnter` fires during a slide.
- `pointerId → activePointers` map; `pendingMidi` tracks intent during async load.
- Window-level `pointerup` / `pointercancel` releases notes dragged off the canvas.
- Hover counter + deferred reset on Over/Out so the cursor stays `pointer` across black/white boundaries (R3F may fire Out after Over depending on raycast).

**PC keyboard** (`PC_KEY_NOTES`): ZXCV → C3..E4 whites, ASDF → sharps, QWERTY → C4..G5 whites, digit row → chromatic above. Skipped on editable focus and modifiers (incl. Shift, reserved for Shift+R record). Window blur releases everything. Global `transpose` applies.

## Confirm / alert modal (`src/ui/confirm.ts`)

`showConfirm(...)` returns `Promise<boolean>`; `showAlert({ tone: 'error' })` swaps to rose border for failure surfaces. Async-callable from non-React modules via module-level pending state; component subscribes via `useSyncExternalStore`. Overlapping calls settle the prior promise first.

**No `window.confirm` / `window.alert` calls remain in the app.**

## Recording (`src/audio/recorder.ts` + `recordControl.ts`)

`RecorderManager` singleton captures `addLiveListener` events. Hydrates from IndexedDB; mutations write through; errors silently degrade. `recordControl.toggleRecord()` is shared by Toolbar button + Shift+R shortcut. 4-beat metronome count-in (100 BPM, sine clicks via `click.ts`) when `countInEnabled`. Empty recordings discarded with toast.

**Pre-record snapshot.** Pressing Record clears any loaded song; `recordControl` stashes `{ song, wasClean }` and restores it if the take ends empty OR the user cancels the count-in. `wasClean` mirrors `!dirty` so saved-project dirty indicator stays accurate.

**Auto-load on stop**: `recorder.addFinalizedListener` fires once per non-empty stop; Toolbar loads the take immediately. Empty stops go through `addEmptyStopListener` (toast).

**Unread badge.** `markAllRead()` runs when the popover **closes** (not opens) so users see what was new while reading.

## Projects (`src/projects/`)

**File-based persistence**, not IndexedDB. Files are `.nfz` (zip via `fflate`), saved to user's filesystem. IndexedDB silently disappears on clear-site-data, private mode, Safari ITP — catastrophic for creative work.

**Format:**
```
my-project.nfz  (zip)
├ manifest.json   { appVersion, name, createdAt, updatedAt, settings,
│                   songRef, customTexture: { ref, mime, fileName } | null }
└ assets/
   ├ song.mid
   └ note-texture.<ext>
```
Zip wrapper present from day 1 even with only `manifest.json`, so audio-sync (future) won't fork the format.

**Versioning (pre-1.0).** No version field, no migration table — settings load via lenient merge `{ ...defaultSettings, ...saved }`; missing fills, unknown drops, renames silently lose old value. Reintroduce versioned migration before 1.0.

**FSA vs fallback** (`io.ts`):
- **Chrome/Edge**: File System Access API; handle held in `currentFile.handle` so Save overwrites in place. `recent.ts` persists handles in IndexedDB (capped 8); stale handles drop on `openRecent` re-check.
- **Safari/Firefox**: programmatic `<input type="file">` for open, Blob-URL download for save. Save falls through to Save As since no handle.

**Save model.** Explicit only, no autosave. `Cmd+S` overwrites; `Cmd+Shift+S` always opens picker. `dirty` flips on `setSong` / `updateSettings` / `resetSettings` / `applySongEdit` / `setSongPreview` / `undo` / `redo`. Window `beforeunload` prompts whenever `dirty`. Edit history NOT persisted.

**Action layer** (`actions.ts`). All return `{ kind: 'ok' | 'cancelled' | 'error', message? }`. The dirty-confirm prompt lives **inside the action** so shortcuts and menu items share one gate. `applyOpenedProject(buf, ref)` is the shared unpack/sync/recent-update helper.

**Customizing settings (pre-1.0).** New key → add to `defaultSettings`. Removed key → delete. Renamed/type-changed → just rename; old saved values silently drop.

## UI shell

`App.tsx` mounts `<Layout />` only when (a) WebGL context available (`detectWebGLAvailable()` probes webgl2 then webgl) and (b) viewport ≥ 1024 px. WebGL takes precedence over viewport-size.

```
┌─ Toolbar ─────────────────────────────────┐
├─────────────────────────────┬─────────────┤
│ Viewport (16:9 letterboxed) │ Inspector   │
│ inside DropZone             │             │
└─────────────────────────────┴─────────────┘
+ LoadingOverlay (fixed, z-50)
```

**File drag-and-drop.** Single `<DropZone>` wraps the whole Layout (drops on Toolbar/Inspector used to silently fail). `.nfz` → `openProjectFromFile`; `.mid`/`.midi` → direct parse + setSong. Failures surface via `showAlert({ tone: 'error' })`.

**Footgun**: react-aria's `DragTypes.has('Files')` does NOT mirror HTML's `dataTransfer.types.includes('Files')` — it holds MIME types, not the OS-level `'Files'` sentinel. Don't gate `getDropOperation` on `'Files'`; either return `'copy'` unconditionally and filter in `onDrop`, or check specific MIME types.

**Toolbar File menu** consolidates New / Open / Open Recent ▸ / Save / Save As / Open MIDI / Demo Songs. Disables during recording. Open MIDI replaces just the song; Open Project replaces the whole session. Open Recent submenu hides when no recents OR FSA unavailable.

**Help menu** opens GitHub issue templates with `&environment=<encoded>` URL-prefilling browser/viewport/FSA info only — never user content.

**Global shortcuts** (`useGlobalShortcuts.ts`) for `Cmd+O` / `Cmd+S` / `Cmd+Shift+S` / Space wire on **capture phase** to beat browser native dialogs and any focused react-aria button.

`Viewport.tsx` adds a window-level `contextmenu` listener that `preventDefault()`s on canvas (right-click is delete); outside the canvas the browser menu stays.

## Build / dev

```
npm install
npm run dev        # Vite dev server on :5173
npm run build      # tsc -b && vite build → dist/
npm run typecheck
```

`index.html` lives at project root (Vite convention).

## Export (`src/export/`)

Offline render of the loaded song to either a WAV (audio only), silent MP4 (video only), or A/V MP4. Triggered from File → Export… → settings dialog (`ExportSettingsDialog`); progress + cancel surfaced via `ExportProgressModal` with wall-clock-derived ETA.

### `audio/clock.ts` — pluggable time source

Module-level `Clock` with `setActiveClock` / `resetActiveClock` / `now()`. Default is the real wall clock (`performance.now() / 1000`). Engine + visual effects (HitParticles, LandingFlashes, HitLine, FallingNotes' `uTime`, customTexture animator) all read `now()` instead of `performance.now()` so the exporter can swap in a `VirtualClock` and step them at non-realtime intervals.

Recorder + MIDI input intentionally still call `performance.now()` directly — they only run during live performance, never under a virtualised clock.

### Audio render (`renderAudio.ts`)

Builds a fresh `OfflineAudioContext` at the chosen sample rate, brings up `createPiano(ctx)` with the **infinite-lookahead Scheduler**, walks the song's notes + pedal events to schedule note-on / note-off on the AudioContext clock (with the same lookahead / stop-buffer / pedal-sustain semantics as the realtime tick), and `await ctx.startRendering()`. Returns an `AudioBuffer`.

Pedal sustain becomes declarative offline: `buildPedalRanges(events)` collapses the song's pedal CC into `[downStart, downEnd]` ranges, then any note whose natural off-time falls inside a range is held until that range's end (mirrors the realtime engine's `pedalHeld` deferred-release behaviour).

`AbortSignal` plumbing: `raceWithAbort` wraps both the sample fetch (`await piano.load`) and `ctx.startRendering()` so Cancel is responsive even mid-load. The underlying work continues in the background and gets GC'd along with the abandoned `OfflineAudioContext`.

Default sample rate: 44.1 kHz (vs 48 kHz). Convolution reverb is the dominant cost; the audible difference for piano material is below human-hearing thresholds and the lower rate noticeably trims render time.

### Video render (`renderVideo.ts`)

Single function `renderSongVideo(song, settings, options)` produces a complete MP4 Blob with both video + audio tracks (or video only when `options.audio === null`).

**Pipeline:**
1. Snapshot R3F state (renderer size, pixel ratio, frameloop, camera aspect, `state.clock` flags) for the `finally`-block restoration.
2. **Disarm `THREE.Clock`**: stop it + set `autoStart=false` + zero `elapsedTime`/`oldTime`. Without this, R3F's `getDelta()` (called unconditionally before the `frameloop="never"` override) accumulates wall-clock seconds into `elapsedTime`. The override's `delta = timestamp - elapsedTime` then drifts with units mismatched against our virtual timeline and **eventually goes negative** — sending Keyboard's exp-decay glow into NaN/Infinity (~1 minute into a render the keyboard saturates and clips to black). With autoStart off, getDelta returns 0 and the override owns the timeline.
3. Install a `VirtualClock` and call `audioEngine.beginExportPlayback()`.
4. Build a single `mp4-muxer` with both video + audio track configs.
5. **Audio render runs in parallel** with the video pass — `renderSongAudio(...)` returns a Promise that's not awaited until step 7. The OfflineAudioContext processes off the main thread; the video frame loop runs on the main thread; total wall-clock = max(audio, video) instead of sum.
6. Resize renderer's drawing buffer to export resolution, switch to `frameloop="never"`. Frame loop:
   - `clock.setTime(t)` — virtual time in seconds
   - `r3f.advance(t, true)` — fires all useFrames + renders. **Pass seconds, not milliseconds**: useFrame consumers (Keyboard's `1 - exp(-delta/decay)` glow) treat delta as seconds, and the `frameloop="never"` override sets `delta = timestamp - elapsedTime` directly.
   - `new VideoFrame(canvas, { timestamp })` → `videoEncoder.encode(...)`
   - **Yield to event loop every frame** via `MessageChannel.postMessage` (`yieldToEventLoop()`). Without this, the synchronous loop monopolises the main thread and Cancel-button clicks never fire. `setTimeout(0)` would compound the spec's nested-timeout 4 ms clamp into many seconds across an 18 000-frame render; MessageChannel has no clamp.
7. Await audio buffer → AudioEncoder → AAC chunks (1024 samples per chunk in `f32-planar` layout) → muxer.
8. Flush both encoders, `muxer.finalize()`, return Blob.

**Codec selection:** `pickAvcCodecString(w, h, fps)` picks an H.264 high-profile level by macroblocks-per-second budget (4.0 for 1080p30, 4.1 for 1080p60, 5.0 for 4K30, 5.1 for 4K60) so `VideoEncoder.configure()` doesn't reject mismatched levels.

**Progress** is a single weighted-sum bar: `audioWeight × audioFraction + videoWeight × videoFraction`. Audio weight collapses to 0 when no audio track is wanted, so the bar becomes pure video progress. The audio fraction is itself a weighted sum of three sub-phases (loading 35% / offline render 55% / AAC encode 10%) so it's monotonic.

**Browser support:** WebCodecs (`VideoEncoder` + `AudioEncoder` + `VideoFrame` + `AudioData`) is the binding constraint. Available on Chrome / Edge / Safari 16.4+; Firefox is still rolling out (early 2026). `isVideoExportSupported()` gates the dialog's video options.

### Settings dialog + progress modal (`ui/Export*.tsx`)

`ExportSettingsDialog` — single configuration form with format radio (Video+audio / Video only / Audio only), resolution / fps / quality (when video), and an estimated-size readout. Defaults persist across the session via `Toolbar`'s `exportDefaults` state. Dismissable; no in-flight work to lose.

`ExportProgressModal` — shared by all three export paths. Shows title, phase label, progress bar, percentage, and ETA (`elapsed × (1/progress - 1)`, suppressed below 5% progress so the readout doesn't snap from a wildly wrong huge number). Non-dismissable; Cancel button aborts the controller.

## License

PolyForm Shield 1.0.0 (source-available). Permits any use except providing a competing product or service. See `LICENSE.md`.
