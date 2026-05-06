# notefall

Browser-based piano visualizer. Notes fall onto a flat 88-key keyboard while a MIDI plays. Users can also touch / mouse / keyboard the keys directly to play live, record their input as MIDI, and edit any loaded MIDI directly on the canvas. All processing is client-side. Source-available under PolyForm Shield 1.0.0.

## Stack

- Vite + React 18 + TypeScript
- `@react-three/fiber` + `drei` + `@react-three/postprocessing` (Three.js scene with Bloom)
- `smplr` (`SplendidGrandPiano`) for sampled piano playback
- `@tonejs/midi` for MIDI parse / serialize; `tone` for AudioContext lifecycle only
- `react-aria-components` + `react-aria` (`useHover`) + Tailwind for UI
- `zustand` for app state
- IndexedDB for recording persistence; Web MIDI API for hardware input

## Directory layout

```
src/
├ App.tsx               renders Layout, or UnsupportedScreen on screens < 1024px
├ main.tsx
├ store.ts              Zustand store: settings, song, transport, loadStatus, loop, fastForward,
│                       countIn, editor state (selection, history, contextMenu, rangeSelectRect),
│                       project file (currentFile, dirty, loadProject, newProject)
├ samples.ts            procedural demo songs (Scales, Arpeggios, Chords + Pedal)
├ midi/
│  ├ types.ts           NoteEvent / PedalEvent / ParsedSong
│  ├ parse.ts           @tonejs/midi → ParsedSong (sorted by time)
│  ├ serialize.ts       ParsedSong → SMF bytes (counterpart of parse; used by project Save)
│  └ edit.ts            editor mutation helpers (delete/move/add/split/setVelocity/resolveOverlaps)
├ projects/
│  ├ types.ts           ProjectManifest / Project / FileRef + CURRENT_SCHEMA_VERSION + extensions
│  ├ migrate.ts         migrations table + loadSettings lenient merge + NewerVersionError
│  ├ io.ts              fflate zip pack/unpack + FSA wrapper + <input>/download fallback
│  ├ actions.ts         newProject / openProject / openRecent / saveProject / saveProjectAs orchestration
│  └ recent.ts          IndexedDB-backed recent files list (FSA only) + subscribe channel
├ audio/
│  ├ sampler.ts         PianoInstrument wrapper (smplr + FadeInStorage + Reverb + EQ)
│  ├ engine.ts          AudioEngine singleton (scheduler, pedal, live notes, bg ticker, init dedupe)
│  ├ playback.ts        playSong / pauseSong / togglePlayback (resets editor state on transport)
│  ├ preview.ts         editor-only previewNote (sync, silently drops when sampler not ready)
│  │                    + ensureSamplerLoaded helper (idempotent download trigger)
│  ├ midiInput.ts       Web MIDI device manager + ensureAudioReady
│  ├ useMidiInput.ts    React hook over midiInput
│  ├ recorder.ts        captures live input → Recording[]; SMF export; IndexedDB persistence
│  ├ useRecorder.ts     React hook (state, elapsed, lastNote, noteOnCount, recordings)
│  ├ recordingStore.ts  IndexedDB CRUD for recordings
│  ├ recordControl.ts   shared toggleRecord (used by Toolbar UI + Shift+R global shortcut)
│  ├ click.ts           count-in metronome scheduler (sine wave clicks via Tone's AudioContext)
│  └ useCurrentTime.ts  rAF-polled hook returning the engine's current song time
├ keyboard/
│  ├ layout.ts          88-key XY-plane layout (MIDI 21..108)
│  └ Keyboard.tsx       flat-plane keys, glow, pointer + PC-keyboard input, octave dividers
├ notes/
│  ├ FallingNotes.tsx   InstancedMesh + SDF rounded-rect shader; clicks own select/move/resize
│  ├ LandingFlashes.tsx additive white spark per key, sustained while a note is held
│  ├ HitParticles.tsx   curl-noise particle system; subscribes to noteDeathFx for delete bursts
│  ├ HitLine.tsx        glowing horizontal bar + animated wavy beam at the hit line
│  ├ curlNoise.ts       3D Perlin curl-field sampler used by HitParticles
│  ├ customTexture.ts   ImageDecoder-based GIF/WebP loader + retains original
│  │                    bytes so projects round-trip the image (setFromFile / setFromBytes)
│  ├ positions.ts       shared geometry (clickX→midi, clickY→time, fallDistance, noteVisualBounds)
│  └ noteDeathFx.ts     publish/subscribe channel for "note deleted" events + active-ghost list
├ scene/
│  ├ Scene.tsx          Canvas, lights, EffectComposer/Bloom; mounts EditTools or PlayToggleArea
│  └ EditTools.tsx      edit-mode click handlers (new note, range-select, eraser drag)
└ ui/
   ├ Layout.tsx           top-level shell (Toolbar + Viewport + Inspector); engine-setting sync
   ├ Toolbar.tsx          File menu (New/Open/Save/Save As + Open MIDI + demo songs),
   │                      MIDI device picker, recording UI, count-in toggle, currentFile + dirty indicator
   ├ ConfirmModal.tsx     single-instance modal driven by `confirm.ts`'s pending state
   ├ confirm.ts           Promise-based imperative `showConfirm()` / `showAlert()`
   │                      (replaces window.confirm + window.alert)
   ├ Viewport.tsx         16:9 letterbox, DropZone, hover controls, range-select rect, context menu
   ├ Inspector.tsx        Reset + every settings slider/switch/select/color picker
   ├ SeekBar.tsx          transport row + slider, lives inside the Viewport overlay
   ├ LoadingOverlay.tsx   centered sample-loading progress
   ├ PageLoader.tsx       initial app-load spinner before React mounts
   ├ UnsupportedScreen.tsx fallback for screens < 1024px (no Layout / Canvas mounted)
   ├ controls.tsx         SliderRow / SwitchRow / SelectRow / ColorRow primitives
   ├ icons.tsx            Solar-paste-friendly SVG icon components
   └ useGlobalShortcuts.ts window-level keyboard shortcuts (transport, record, editor)
```

## Coordinates and geometry

- Camera at `[0, 0, 12]` looking at origin (perspective, FOV 32°). +X right, +Y up, +Z toward camera
- Keyboard group positioned at `settings.keyboardY` (default `-2.0`)
- Keys are **flat planes** in XY, not boxes (boxes' side faces became visible at perspective edges and filled the gaps with the key colour)
- Real grand-piano spec at 1mm = 0.01 world units. White: 0.235 × 1.475 (z=0). Black: 0.137 × 0.95 (z=0.04, in front of white to avoid z-fighting). 88 white keys × 0.235 = 12.22 world units, matching the visible width of the default 16:9 viewport edge-to-edge
- Hit line: `keyboardY + WHITE_KEY_LENGTH` (the back edge of the keyboard)
- Note plane z = **0.05** (in front of all keys). Notes are clipped at `vWorldY < uHitY` in the fragment shader, NOT via z-occlusion. Per-pixel SDF clipping avoids perspective parallax — putting notes at a different z would visually pull them inward at the edges relative to the keys
- Octave dividers at z = 0.02 (gray, transparent). Landing flashes at z = 0.06 (additive)

## AudioEngine (`src/audio/engine.ts`)

Singleton. Self-driven clock via `performance.now() / 1000`. The visual layer reads `currentSongTime()` to align bars with audio.

`tick()`: cleanup live notes → process pedal events → process note-ons → process note-offs → loop / stop on end-of-song.

Non-obvious details:
- **Two tick drivers**: `FallingNotes`'s `useFrame` calls `tick()` for visual sync (paused when tab hidden), AND a Web Worker `setInterval(25ms)` calls it while playing. Background-tab playback would otherwise stall and burst on return
- **Unique `stopId` per note** is mandatory. smplr defaults `stopId` to the midi number, so back-to-back notes of the same pitch share an id and stopping one cancels another mid-release. We pass `s${noteId}` for song notes, `live${liveId}` for touch, `prev-${n}` for editor previews
- **Lookahead 0.015s** + **stop buffer 0.02s** prevent attack clicks and the cancel-before-start drop on fast notes
- **Pedal sustain**: when pedal is engaged and a note's `endTime` arrives, its smplr stop fn is pushed onto `pedalHeld[]` instead of being called. Pedal-up flushes per-source ('song' / 'live')
- **Live notes** (`triggerKey`): tracked separately in `liveNotes[]`, always render in 'up' (rising trail) mode regardless of `fallDirection`. Respect pedal sustain
- **Preview** (`triggerPreview`): plays a sampler note WITHOUT emitting key listener events or appending to liveNotes — used by the editor for click/drag/select audible cues so keyboard glow and particles don't react
- **Init dedupe**: concurrent `init()` callers share a cached `initPromise`, so multiple clicks during the ~60MB sample download don't each kick off their own load
- **`updateSong(song)`**: editor-driven song replacement. Selectively releases active notes — if a note's id is gone from the new song or its midi/endTime changed, emits 'off' and drops it; structurally-unchanged notes stay in `active` so the engine fires their note-off naturally as time advances
- **`addLiveListener`** is a separate channel from `addKeyListener` — only user input (PC keyboard, on-screen, MIDI device) fires it; the recorder uses it to capture only what the user actually played
- **`pause()`** keeps visualizer state intact (key glow / particles / flash continue from where they were); only audio is killed via `releaseAllSounding()`. The "stuck visualizer after pause+edit+resume" bug is handled inside `updateSong` (see above)
- The engine is decoupled from React. `Layout.tsx` syncs settings → engine via `useEffect`s

## Sampler (`src/audio/sampler.ts`)

Wraps smplr's `SplendidGrandPiano` (~60 MB initial download, 4 velocity layers). Signal chain: sampler → master gain → 6-band EQ → dry/wet split → ConvolverNode (synthetic IR) → destination. Volume / reverb mix use `setTargetAtTime` ramps.

**FadeInStorage** is critical. smplr's `Voice` sets `envelope.gain.value = 1` instantly (no attack envelope) — any sample whose first frame isn't exactly zero clicks on attack. We intercept the storage layer, decode each fetched sample, apply a 1.5 ms linear fade-in, re-encode to WAV, and hand the buffer to smplr.

## Falling notes (`src/notes/FallingNotes.tsx`)

Single `InstancedMesh` using `PlaneGeometry(1,1)` and a custom `ShaderMaterial`.

Per-instance attributes:
- `instanceSize` (vec2 width × length) — for the SDF rounded-box in world units
- `instanceSeed` (vec2) — stable per-id texture variation
- `instanceSelected` (float) — drives the bright white outline for editor selection
- `instanceAlpha` (float) — drives the 1→0 linear fade for delete-ghost notes (see noteDeathFx)

Fragment shader: clip `vWorldY < uHitY` per-pixel (NOT z-occlusion), then rounded-box SDF, then texture preset (solid / liquid / gem / custom), then rim, then selection outline. Final alpha multiplies by `vAlpha` so dying ghosts can fade.

CPU-side per `useFrame`:
- Iterate `song.notes`, place visible bars at `[head, head + max(minLength, naturalLength)]`
- Append live notes (always 'up' direction)
- Append `noteDeathFx.list()` ghosts at their captured (x, centerY, w, l) with computed `fadeAlpha`
- Maintain `instanceToNoteId[]` so click handlers can resolve `event.instanceId` → noteId
- Pin `mesh.boundingSphere = Sphere(0, 1000)` to defeat three.js's stale lazy BS (auto-computed once from initial instances → later notes at far positions would silently fail raycast)

Direction (`settings.fallDirection`): `'down'` future notes fall onto the keyboard; `'up'` past notes rise as a "history trail".

## Editor (selection / move / resize / delete / add / undo)

The editor activates whenever `transport !== 'playing' && song !== null` — `Scene.tsx` mounts `<EditTools />` instead of `<PlayToggleArea />`. State lives in `store.ts`: `selection: Set<number>`, `editHistory[]` / `editFuture[]` (capped at 50 snapshots), `contextMenu`, `rangeSelectRect`.

**Undo / redo plumbing.** Three setters back the editor:
- `applySongEdit(next)` — push current to history, replace song, clear future, sync engine
- `setSongPreview(s)` — replace song without touching history (used during in-flight drags)
- `pushUndoSnapshot(snapshot)` — push a snapshot to history without applying anything (call once at drag start, then `setSongPreview` per frame, then no extra commit at drag end)

This keeps a whole drag = 1 undo entry.

**Gestures (FallingNotes + EditTools):**

| Target | Input | Action |
|---|---|---|
| Note body | Left click | Select (replaces) + arm move-drag. Drag updates time/pitch via `moveNotes` |
| Note body | Ctrl/Cmd+Left | Toggle in selection (no drag) |
| Note body | Alt+Left | Split at click Y via `splitNote` |
| Note body | Right click | Delete just that note (never the whole selection — that's reserved for Delete key) |
| Note body | Double-click | Open velocity context menu at cursor |
| Note edge (top/bottom, ~0.08 world units) | Left drag | Edge-resize (head moves time + adjusts duration to keep tail fixed; tail moves duration only) |
| Empty area, above hit | Left click | Create new note + arm drag-to-position. One pointerdown = one undo entry |
| Empty area | Cmd/Ctrl+Left drag | Marquee range-select (additive — preserves existing selection). Newly-entered notes preview as you sweep |
| Empty area | Right drag | Eraser — sweep to delete |
| (any) | Delete / Backspace | Delete entire selection |
| (any) | Escape | Clear selection (closes context menu first if open) |
| (any) | ↑↓ / ←→ | Nudge ±1 semitone / ±0.05s |
| (any) | Cmd/Ctrl+Z / Shift+Z / Y | Undo / redo |

**Cursors** (set on `gl.domElement.style.cursor`):
- Note body → `move` (drag is 2D)
- Note edge → `ns-resize`
- Keyboard key → `pointer` (counter-based with deferred reset to avoid black/white flicker)
- Empty above hit → `crosshair` (= "click here to drop a note")
- Empty below hit → `default` (clicks are no-ops there)
- Range-select drag → `cell`
- Eraser drag → `not-allowed`
- Loading → `wait` (via the click-eater overlay)

**Collision rules ("notes are solid").** Same-pitch overlap is forbidden. Mutations enforce it differently:
- `moveNotes`: clamps the time delta uniformly across the moved set so no moved note crosses into a non-moved same-pitch neighbour. Pitch shift clamps toward 0 from the requested |k| (largest valid shift in the requested direction wins) — same-pitch obstacles WHOSE TIME INTERVAL OVERLAPS the moved note stop the move at the slot before them, but if the cursor drags PAST the obstacle (target pitch lands on a free slot beyond, or on a same-pitch note whose time doesn't overlap), the moved set jumps over. The collision check uses time-overlap rather than "any same-pitch note blocks" because a typical song has same-pitch notes scattered across time, and a strict pitch-only block would freeze most drags. Touching boundaries are allowed
- Edge-resize: clamps to nearest same-pitch obstacle (head edge can't go past `prevObstacle.end`; tail edge can't go past `nextObstacle.start`)
- `addNote`: uses `resolveOverlaps` with the new id as priority — if the new note's interval crosses an existing note, the existing one is clipped to make room
- `resolveOverlaps(song, priorityIds)`: generic per-pitch resolver. Used by `addNote` only after the move-side switched to clamping. Trims/drops non-priority notes against priority intervals, then applies "later wins, earlier trims" to remaining overlaps

**Context menu** (`NoteContextMenu` in `Viewport.tsx`): right-click was repurposed for delete, so the velocity-edit menu opens on **double-click**. Position is clamped to the viewport so it can't slide behind the Inspector. Slider uses `pushUndoSnapshot` once per session + `setSongPreview` per change. While dragging the slider, a 500ms-interval ticker plays the anchor note as preview audio so the user hears the loudness change.

**Loading guard.** While `loadStatus.state === 'loading'`, a transparent click-eater div (`absolute inset-0 cursor-wait`) is mounted between the Canvas and the SeekBar gradient. Blocks every canvas interaction (play toggle, range-select, eraser, new note, hold-to-FF). SeekBar / Inspector / Toolbar stay live.

**The click that triggers the load itself isn't covered by the eater** — at the moment of pointerdown, `loadStatus` is still `'idle'`. Defense-in-depth: editor pointer handlers (`EditTools` and `FallingNotes`) early-return when `!audioEngine.isReady()`, kicking off `ensureSamplerLoaded` instead. So the first canvas click during a never-loaded session triggers the download but does NOT start a drag — the user clicks again once samples have arrived. This pairs with `previewNote`'s sync drop (see `audio/preview.ts`) so no audio queues during the load: the chord-burst-on-ready bug that made the old async version unsafe is structurally impossible.

## Note death FX (`src/notes/noteDeathFx.ts` + `HitParticles.tsx` + `FallingNotes.tsx`)

Right-click delete and eraser drag emit a `DyingNote` payload via `noteDeathFx.emit({ midi, velocity, x, centerY, width, length })`. Two consumers:
1. `HitParticles` subscribes via `noteDeathFx.subscribe`. Each event spawns a "phantom hit" emitter that runs the SAME per-frame sustained emission rate as a held key for `DEATH_EMIT_DURATION` (0.35s) — count, size, lifetime, curl noise all match the user's particle settings exactly, scaled by the deleted note's velocity
2. `FallingNotes` reads `noteDeathFx.list()` each frame and appends a fading ghost to its instance buffer (same shader, just `instanceAlpha = 1 - age/FADE_DURATION` linear, FADE_DURATION = 0.12s)

Bulk-delete paths (Delete key, programmatic) intentionally skip the channel — wholesale deletion shouldn't spawn dozens of overlapping puffs.

## Landing flashes (`src/notes/LandingFlashes.tsx`)

One `InstancedMesh` instance per key (88) at the hit line. White additive shader with sharp gaussian core + smoothstep edge fade. Subscribes to `audioEngine.addKeyListener`: bumps `intensities[idx]` instantly on note-on (no fade-in) and extends `heldUntil[idx] = now + 80ms`. On note-off, decrements `heldCount[idx]`; useFrame snaps to 0 only once the key has released AND the 80ms window has elapsed (guarantees super-short notes register).

## Hit particles (`src/notes/HitParticles.tsx`)

3D curl-noise particle system. Per-particle world position (XYZ) so the divergence-free vector field can produce internal cluster width without horizontal spreading; a 2D curl with any per-particle perturbation produced either a thin coherent strand or a too-wide spread.

Velocity update per frame:
1. Domain transform mixes particle pos and emitter pos by `noiseLocality` (pure-particle = independent drift; pure-emitter = lockstep), then applies per-axis inverse-feature-size (`/ turbX`, etc.) and slides Z by `t × flowSpeed`
2. Multi-octave curl sample → EMA-smoothed (60 ms time constant) to filter out lattice-cell discontinuities
3. Component-multiplied by per-axis amplitudes → asymmetric noise
4. Optional swirl (rotational pull on velocity.xy angle away from +Y, the unstable equilibrium) and drag (multiplicative damping with a min floor so particles don't fully stall)

Emission has two paths:
- **Per-key**: subscribes to `addKeyListener`. On note-on: bumps `pendingBurst[idx]` by ATTACK_BURST (3); useFrame drains those + adds sustained per-frame emission while the key (or its 80ms min-emit window) is still active
- **Note death**: subscribes to `noteDeathFx`. Each event creates a `DeathEmitter` running the same per-frame logic at the deleted note's center for `DEATH_EMIT_DURATION` seconds

Both paths go through one shared `emitParticleAt(x, y, z, vel, isBurst, color, sizeMul, upwardSpeed, lifetime)` so the visual stays consistent.

## Hit line (`src/notes/HitLine.tsx`)

Two layers at the keyboard hit line: a horizontal bright bar (sharp gaussian core), and a wavy laser beam scrolling along the keyboard width. Each is independently togglable + has its own thickness / halo / vertical offset. The wave's shape evolves in place (`hitLineWaveMorphSpeed`) and scrolls horizontally (`hitLineWaveScrollSpeed`, signed for direction).

## Keyboard (`src/keyboard/Keyboard.tsx`)

Per-key glow: `audioEngine.addKeyListener` updates `held[]` (reference-counted, not a flag — back-to-back retriggers may emit on/off in either order within a frame). Glow scales with `settings.keyboardBrightness`; colour either follows `noteColor` (default) or uses `keyGlowColor` per `keyGlowFollowNote`.

**Pointer input** (mouse + multi-touch):
- `onPointerDown` releases the touch's implicit pointer capture so sibling keys' `onPointerEnter` fires during a slide
- `pointerId → activePointers` map tracks which note each pointer holds
- A touch during async sample loading is tracked in `pendingMidi`; releasing during the load clears it so no stuck note appears
- Window-level `pointerup`/`pointercancel` releases notes dragged off the canvas
- Hover counter + deferred reset on `Over` / `Out` so the cursor stays `pointer` across black/white boundaries (R3F may fire Out after Over depending on raycast result, which would otherwise flicker)

**PC keyboard** (`PC_KEY_NOTES`):
- ZXCV row → C3..E4 white keys
- ASDF row → sharps for the ZXCV row (s=C#3, ;=D#4)
- QWERTY row → C4..G5 white keys
- Digit row → chromatic continuation A5..G#6
- Skipped on editable focus, modifier combos (incl. Shift — reserved for Shift+R record). Window blur releases everything. The global `transpose` setting also applies here

## Confirm / alert modal (`src/ui/confirm.ts` + `ConfirmModal.tsx`)

Two flavours share one mounted `<ConfirmModal />`:
- `showConfirm({ title, message, confirmLabel?, cancelLabel?, destructive? }): Promise<boolean>` — two-button decision. Resolves `false` on Cancel / Escape / backdrop click
- `showAlert({ title, message, okLabel?, tone? }): Promise<void>` — single-button acknowledgement, used for "an action failed" surfaces (replaces `window.alert`). `tone: 'error'` swaps the neutral ring for a rose border so failed-load prompts read as "something went wrong"

Both are async-callable from non-React modules (`projects/actions.ts`, `useGlobalShortcuts.ts`, the window-level drop handler) without holding React refs. Module-level pending state + listener channel; `<ConfirmModal />` subscribes via `useSyncExternalStore`, renders a `react-aria-components` `ModalOverlay` + `Modal` + `Dialog` (focus trap, Escape, backdrop-click — all for free), and dispatches the user's pick through `resolveConfirm` / `resolveAlert`.

Visual language matches `LoadingOverlay` (centered card, blurred backdrop). Confirm uses a neutral ring; alerts adopt rose for errors. Cancel/OK is `autoFocus` so pressing Enter on a destructive prompt preserves work by default.

Overlapping calls: if a prompt is already open when `showConfirm` / `showAlert` is called again, the prior promise is settled (confirm → `false`, alert → resolve) before the new one takes its place — keeps callers from deadlocking on a forgotten promise.

Where it's used: `openProject` / `openRecent` / `newProject` (dirty confirms), file drop handler (corrupt `.nfz`, MIDI parse failure, unsupported extension), `Cmd+S` / `Cmd+O` shortcut error surfaces, Toolbar action error surfaces. **No `window.alert` / `window.confirm` calls remain in the app** — the styled modal is the only path.

## Recording (`src/audio/recorder.ts` + `recordControl.ts` + `recordingStore.ts`)

`RecorderManager` singleton captures `addLiveListener` events into `Recording[]`. Hydrates from IndexedDB on first construction; every mutation (stop, rename, delete, clearAll) also writes through. Errors silently degrade (private mode / quota) so the in-memory recorder still works.

`recordControl.toggleRecord()` is the shared entry — Toolbar UI button + Shift+R global shortcut both call it. Drives a 4-beat metronome count-in (100 BPM, sine clicks via `click.ts`) when `countInEnabled` is set; the count-in beat number flows through the store so the Record button shows `1/4`, `2/4`, etc. Empty recordings (no captured events) are silently discarded with a toast.

**Pre-record snapshot.** Pressing Record on a session with a song already loaded clears that song so the falling notes don't keep streaming during capture. To keep an accidental Record press from silently destroying user work, `recordControl` stashes `{ song, wasClean }` at start and restores it (`setSong` + `audioEngine.loadSong` + `markClean` if applicable) when the take ends with **no notes captured**, OR when the user **cancels the count-in** by pressing Record again. The snapshot is dropped on a non-empty stop — the recorder's auto-load takes over there. `wasClean` mirrors `!dirty` at start so a saved project's dirty indicator stays accurate across the round-trip.

Recordings are loadable straight back into the player (recorder.toArrayBuffer → parseMidi → setSong) and downloadable as SMF. **Auto-load on stop**: `recorder.addFinalizedListener(fn)` fires once per non-empty stop with the new `Recording`. The Toolbar subscribes and immediately loads the take as the current song so the user can replay it without an extra click. Empty stops do NOT fire the channel — they go through `addEmptyStopListener` (which surfaces a "no notes captured" toast) instead. The auto-load is non-destructive: Record start already cleared the previous song, so this just fills the empty slot.

## Live MIDI input (`src/audio/midiInput.ts`)

Web MIDI API wrapper. Connects to a chosen device, applies `transpose` and velocity shaping, calls `audioEngine.triggerKey` per note-on, releases per note-off. CC#64 ≥ 64 toggles `audioEngine.setLivePedalDown(true/false)`. `ensureAudioReady` is the shared "Tone.start + audioEngine.init" gate, used by the device picker, the on-screen keyboard's first touch, and the editor preview.

## Scene click area (`src/scene/Scene.tsx` + `EditTools.tsx`)

While playing: `<PlayToggleArea />` mounts. Two invisible meshes (above and below the keyboard).
- Short click → `togglePlayback`
- Press-and-hold > 200 ms → 2× playback rate, sets `fastForward` for the badge. If the song was paused, the hold also starts playback; releasing pauses it again (preview / scrub)
- Window-level `pointerup`/`pointercancel`/`blur` always restore the rate

While paused/stopped + a song loaded: `<EditTools />` mounts instead. See **Editor** above.

## State (`src/store.ts`)

- `settings` — every visual / audio param. Edited live in Inspector. `resetSettings` restores defaults but preserves `volume` and `playbackRate` (transport-bar controlled)
- `song: ParsedSong | null`. `setSong` clears editor state (history, future, selection, contextMenu)
- `transport: 'stopped' | 'playing' | 'paused'`
- `currentTime` — kept for SeekBar's onChange handler; the live readout uses `useCurrentTime` so 60 Hz updates don't re-render the whole subtree
- `loadStatus: 'idle' | { state: 'loading', loaded, total } | 'ready'` — drives `LoadingOverlay` AND the click-eater overlay
- `loop`, `fastForward`, `countInEnabled`, `countInBeat`
- Editor: `selection`, `editHistory[]`, `editFuture[]`, `applySongEdit`, `setSongPreview`, `pushUndoSnapshot`, `undoEdit`, `redoEdit`, `rangeSelectRect`, `contextMenu`
- Project file: `currentFile: FileRef | null`, `dirty: boolean`, `loadProject`, `newProject`, `setCurrentFile`, `markClean`. `dirty` flips on `setSong`, `updateSettings`, `resetSettings`, `applySongEdit`, `setSongPreview`, `undoEdit`, `redoEdit` — anything that changes what `Save` would persist. `loadProject` is atomic (settings + song + currentFile in one set) and resets `dirty`

## Projects (`src/projects/`)

**File-based** persistence. The user owns their data — projects are saved as `.nfz` ("notefall zip") files on the user's filesystem, not in IndexedDB. Recordings remain the only IndexedDB-backed feature (capture artefacts, not user-authored documents). Presets are planned but not yet implemented; they'll follow the same shape as projects (separate file extension, settings-only manifest).

Why file-based and not IndexedDB:
- IndexedDB silently disappears on "clear site data", in private mode, and under Safari's 7-day ITP eviction. For creative work this is a catastrophic failure mode
- Files live in the user's filesystem, sync via Dropbox / iCloud / Git, and can be transferred between devices without any extra UI
- "Import" and "Open" collapse to a single operation (open a file from disk) — one button instead of two

**Project** = a piece of work. Holds:
- `settings: Partial<Settings>` — visual / audio config snapshot at save time
- `songMidi: ArrayBuffer | null` — loaded MIDI re-serialized from the in-memory `ParsedSong` via `serializeMidi` so editor changes round-trip
- `customTexture: { bytes, mime, fileName } | null` — user-uploaded image for the `noteTexture: 'custom'` preset (lives in `useCustomTexture` at runtime; `actions.ts` ferries it through the manifest's `customTexture` `AssetRef` and the zip's `assets/note-texture<ext>` payload). Captured on save even when the active preset isn't `'custom'` so a temporary preset switch doesn't drop the user's image
- `audioTrack` (future) — user-supplied piano audio + sync offset, when that feature ships
- `name`, `createdAt`, `updatedAt`

**Schema versioning.** Files carry `schemaVersion: number` and `appVersion: string` (from package.json — diagnostic only, never used for branching). Strategy:
- Settings load is a **lenient merge**: `{ ...defaultSettings, ...saved }`. Missing keys fill with defaults; unknown keys drop silently (`migrate.ts:loadSettings`)
- `schemaVersion` only increments for **breaking** shape changes (key rename, type change, semantic flip). Each break adds an entry to `migrate.ts:migrations[oldV] = (data) => migratedData`
- `schemaVersion > CURRENT_SCHEMA_VERSION` → throws `NewerVersionError`, surfaced as an alert ("saved in a newer version"). Failure mode: stale tab loading something the new app saved

So: **adding or removing a settings key needs no migration**. Only renames / restructures cost a migration step.

**File format.** `.nfz` is a zip (via `fflate`). The container is a regular zip — `unzip my.nfz` works for inspection:

```
my-project.nfz  (zip)
├ manifest.json   { schemaVersion, appVersion, name, createdAt, updatedAt, settings,
│                   songRef: "song.mid" | null,
│                   customTexture: { ref, mime, fileName } | null }
└ assets/
   ├ song.mid              (raw SMF bytes — absent when songRef is null)
   └ note-texture.<ext>    (custom note-texture image — absent when customTexture is null)
```

The zip wrapper exists from day 1 even when only `manifest.json` is present, so the format doesn't fork later when audio sync ships. MIDI is stored as a binary asset (referenced by `songRef`) rather than base64 inside the manifest — keeps the zip self-describing on hand-extraction and avoids the 33% inflation base64 would impose.

**File I/O strategy** (`io.ts`). Browsers split here:
- **Chrome / Edge**: File System Access API (`showOpenFilePicker`, `showSaveFilePicker`, `FileSystemFileHandle.createWritable`). The handle is held in `useStore.currentFile.handle` for the session, so `Save` overwrites the same file in place. The Recent Files list (`recent.ts`) persists handles across reloads in IndexedDB, capped at 8 entries
- **Safari / Firefox**: `hasFileSystemAccess()` returns false → fallback path. `showOpen` uses a programmatic `<input type="file">`; `showSaveAs` triggers a Blob-URL download. `Save` falls through to `Save As` because `currentFile.handle` is always null on this path. Functionally `Save` and `Save As` are identical here

**Save model.**
- Explicit only. No autosave
- `Save` (`Cmd+S`) overwrites the active file via FSA, or falls through to `Save As` if no handle / handle stale
- `Save As` (`Cmd+Shift+S`) always opens the picker (FSA) or downloads (fallback)
- `dirty` clears on successful save
- Window `beforeunload` prompts when `dirty && currentFile !== null`. Unnamed sessions don't prompt — there's no save target to point the user at, and the friction would be tiring on every reload
- Edit history (undo / redo stack) is **not** persisted — too large, rarely useful across sessions

**Action layer** (`actions.ts`). `newProject` / `openProject` / `openRecent` / `openProjectFromFile` / `saveProject` / `saveProjectAs` orchestrate file I/O + parse/serialize + store mutations + audio engine sync. `openProjectFromFile(file)` is the entry point used by canvas drag-and-drop in `Viewport.tsx` — same pipeline as `openProject` but skips the picker. Dropped files don't carry an FSA write handle, so the resulting `currentFile.handle` is null and Save falls through to Save As until the user picks a destination. All return `{ kind: 'ok' | 'cancelled' | 'error', message? }` so call sites can pattern-match — `'cancelled'` is silent (user dismissed picker / declined the dirty prompt), `'error'` surfaces via `showAlert({ tone: 'error' })` so the in-app rose-bordered modal appears instead of the OS-native popup. The `dirty`-confirm prompt for the destructive actions (`newProject`, `openProject`, `openRecent`) lives **inside the action**, not at call sites, so the Cmd+O shortcut and the File menu items stay in sync without duplicating the gate. The prompt itself goes through `showConfirm` (`src/ui/confirm.ts`) so it shares the styled modal with the rest of the app — no `window.confirm` calls. `openProject` and `openRecent` share an internal `applyOpenedProject(buf, ref)` helper so unpack / migrate / audio sync / recent-list update logic is in one place.

**Recent files** (`recent.ts`). Persists `FileSystemFileHandle` references in IndexedDB (DB `notefall-recents`, store `handles`, capped at 8 entries) so the user can reopen a project with one click. **FSA-only**: handles can't be obtained on Safari / Firefox, so `addRecent` no-ops there and the Toolbar's "Open Recent" submenu hides itself when the list is empty. Dedup via FSA's `isSameEntry()` so opening the same file twice moves it to the top instead of duplicating. The list is updated by `applyOpenedProject` (after `openProject` / `openRecent`), `saveProject` (bumps timestamp on overwrite), and `saveProjectAs` (records the freshly-picked handle). `openRecent` re-checks read permission via `openFromHandle`; if the handle is stale (file moved / deleted / permission denied), the entry is dropped from the list so the menu doesn't keep showing dead items. No project DATA lives here — only the handle. Losing this list is harmless; the project files themselves are unaffected.

**UI surface.** Toolbar has a single **File** menu (react-aria `MenuTrigger`) consolidating every "load or save a song-bearing payload" entry point into one place:

- Project actions — `New` / `Open…` / `Open Recent ▸` / `Save` / `Save As…`. Open / Save / Save As show shortcut hints (`⌘O` / `⌘S` / `⇧⌘S` on macOS, `Ctrl+…` elsewhere — detection at module load via `navigator.platform`). `New` deliberately has no shortcut (Cmd+N / Cmd+Shift+N collide with the browser's New Window / Incognito affordances). `Open Recent` is a `SubmenuTrigger` that hides itself when there are no recents OR when FSA is unavailable
- `Open MIDI…` — programmatic `<input type="file">` rather than `FileTrigger`, since menu items can't host a `FileTrigger` directly. Replaces just the song in the current project (settings preserved); contrast with `Open Project…` which replaces the whole session
- Demo Songs section (under a `Header` inside `MenuSection`) — built from the `SAMPLES` array in `src/samples.ts`

The whole menu disables during recording — any of these would clobber the in-progress take. `SAMPLES` items shouldn't change frequently; if the list grows beyond 5–6 entries, consider a `SubmenuTrigger` so the menu stays compact.

**Keyboard shortcuts.** `Cmd/Ctrl+O` (open), `Cmd/Ctrl+S` (save), `Cmd/Ctrl+Shift+S` (save as) are wired in `useGlobalShortcuts.ts` on the **capture phase**, same rationale as `Space`: must beat both the browser's native dialogs (Save Page / Open File) AND any focused react-aria button that might otherwise consume the key event.

**Rules of thumb when changing settings:**
- New key → add to `defaultSettings`. Old projects load via lenient merge. No migration
- Removed key → just delete it. Unknown key drops on load. No migration
- Renamed / type-changed / semantically-changed key → `CURRENT_SCHEMA_VERSION++` and add `migrations[oldV]` that rewrites the field

## UI layout

`App.tsx` renders `<Layout />` only when the viewport is ≥ 1024 px (Tailwind `lg`, watched via `matchMedia`). Below that → `<UnsupportedScreen />`; the 3D Canvas and audio engine never initialise.

```
┌─ Toolbar ────────────────────────────────────┐
├──────────────────────────────┬───────────────┤
│  Viewport (16:9 letterboxed) │  Inspector    │
│  inside DropZone             │  (settings)   │
├──────────────────────────────┴───────────────┤
+ LoadingOverlay (fixed, z-50, pointer-events:none)
```

`Viewport.tsx` overlays (inside the inner letterboxed div):
- `<Scene />` (the Canvas)
- Click-eater (transparent, only while loading)
- `<TransportFeedback />` — transient centered play/pause icon on every transition (skip on the very first play after sample load — that's "the load finished", not a user toggle)
- `<FastForwardIndicator />` — top-center 2× pill while `fastForward`
- `<RangeSelectRect />` — marquee, positioned in client coords against `innerRef`'s bounding rect (NOT the outer wrapper, which spans the full available area and is offset from the canvas by the letterbox bars)
- `<NoteContextMenu />` — velocity slider; same `innerRef`-based positioning + clamp
- Bottom gradient + `<SeekBar />` — gradient is `pointer-events-none`; only buttons / slider re-enable `pointer-events-auto` so empty space passes clicks to the canvas. Hover (`useHover`) + `idleHidden` autohide while playing; popovers from SeekBar pin the controls visible

**File drag-and-drop.** A single `react-aria-components` `<DropZone>` wraps the entire `Layout` (Toolbar + Viewport + Inspector) so a drop anywhere over the app routes the file. Earlier the DropZone was scoped to Viewport, but users routinely dropped onto the Toolbar or Inspector and got nothing — widening the bound surface removes that footgun. Routing inside `onDrop`: `.nfz` → `openProjectFromFile` (project pipeline with dirty-confirm), `.mid`/`.midi` → direct `parseMidi` + `setSong` (song-only swap, mirrors the File menu's "Open MIDI"). Extension match is case-insensitive (`.NFZ` / `.MIDI` work). Failure paths — corrupt zip, missing `manifest.json`, MIDI parse error, unsupported extension — all surface through `showAlert({ tone: 'error' })` so the user gets a styled modal explaining what went wrong instead of a silent no-op. The drop indicator is rendered inside the DropZone's `isDropTarget` render prop (`pointer-events-none`, z-50) so it doesn't intercept the drop event itself.

**Footgun**: react-aria's `DragTypes.has('Files')` does NOT mirror HTML's `dataTransfer.types.includes('Files')`. The `DragTypes` set holds the MIME types of the dragged items (e.g. `'image/png'`), not the OS-level `'Files'` sentinel — so a `getDropOperation` gated on `types.has('Files')` always returns `'cancel'` for native file drops and the DropZone silently does nothing. Either return `'copy'` unconditionally and filter in `onDrop` (current approach), or check specific MIME types like `'audio/midi'`. Don't gate on `'Files'`.

The seek slider uses `SliderTrackRenderProps.isHovered` + `state.isThumbDragging(0)` to expand the bar / brighten the fill. Thumb is `sr-only` (visible track only). Same hover-grow pattern in `Inspector.tsx`'s `SliderRow`.

`Toolbar.tsx`: `<FileTrigger>` for "Open MIDI"; recording UI (Record button with elapsed + last-note + count display, Metronome toggle, Recordings list popover with rename / load+play / download / delete-with-confirm). Open MIDI / sample buttons disable while recording.

`Toolbar.tsx`'s **Help menu** (rightmost `?` button on the left cluster) is the single in-app entry point for user feedback — `Report a bug…` / `Request a feature…` / `View on GitHub`. The bug / feature items open `https://github.com/ekkx/notefall/issues/new?template=<bug|feature>.yml&environment=<encoded>` in a new tab; the templates live in `.github/ISSUE_TEMPLATE/{bug,feature}.yml` and expose a textarea field with `id: environment` that the URL query pre-fills (GitHub Issue Forms feature). `buildEnvironmentBlock()` only collects browser / viewport / FSA-support info — never the user's notes / settings / project content. `config.yml` disables blank issues so users always land on a template.

`Inspector.tsx` color rows are `<ColorPicker>` + `<ColorArea>` + `<ColorSlider>` + `<ColorField>` in a `<Popover>` (no native `<input type="color">`).

`Viewport` adds a window-level `contextmenu` listener that `preventDefault()`s when the target is the canvas — the right-click is repurposed for delete; outside the canvas (Inspector / Toolbar / popovers) the browser menu stays untouched.

## Demo songs (`src/samples.ts`)

Three procedural patterns built without external MIDI files:
- **Scales** — chromatic scale up/down across 6 octaves at 0.18 s/note
- **Arpeggios** — broken chord patterns with bass octaves
- **Chords + Pedal** — short staccato chords with legato pedaling between bars

## Build / dev

```
npm install
npm run dev        # Vite dev server on :5173
npm run build      # tsc -b && vite build → dist/
npm run typecheck
```

`index.html` lives at the project root by Vite convention — it is the literal entry point Vite resolves.

## License

PolyForm Shield 1.0.0 (source-available). Permits any use except providing a competing product or service. See `LICENSE.md`. Copyright holder: ekkx.
