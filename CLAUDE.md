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
│                       countIn, editor state (selection, history, contextMenu, rangeSelectRect)
├ samples.ts            procedural demo songs (Scales, Arpeggios, Chords + Pedal)
├ midi/
│  ├ types.ts           NoteEvent / PedalEvent / ParsedSong
│  ├ parse.ts           @tonejs/midi → ParsedSong (sorted by time)
│  └ edit.ts            editor mutation helpers (delete/move/add/split/setVelocity/resolveOverlaps)
├ audio/
│  ├ sampler.ts         PianoInstrument wrapper (smplr + FadeInStorage + Reverb + EQ)
│  ├ engine.ts          AudioEngine singleton (scheduler, pedal, live notes, bg ticker, init dedupe)
│  ├ playback.ts        playSong / pauseSong / togglePlayback (resets editor state on transport)
│  ├ preview.ts         editor-only previewNote (auto-loads sampler, no listener emit)
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
│  ├ customTexture.ts   ImageDecoder-based GIF/WebP loader for note texture preset
│  ├ positions.ts       shared geometry (clickX→midi, clickY→time, fallDistance, noteVisualBounds)
│  └ noteDeathFx.ts     publish/subscribe channel for "note deleted" events + active-ghost list
├ scene/
│  ├ Scene.tsx          Canvas, lights, EffectComposer/Bloom; mounts EditTools or PlayToggleArea
│  └ EditTools.tsx      edit-mode click handlers (new note, range-select, eraser drag)
└ ui/
   ├ Layout.tsx           top-level shell (Toolbar + Viewport + Inspector); engine-setting sync
   ├ Toolbar.tsx          Open MIDI, demo songs, MIDI device picker, recording UI, count-in toggle
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
- `moveNotes`: clamps the time delta uniformly across the moved set so no moved note crosses into a non-moved same-pitch neighbour. Pitch shift is all-or-nothing — reverts entirely if any moved note would land on top of an existing note. Touching boundaries are allowed
- Edge-resize: clamps to nearest same-pitch obstacle (head edge can't go past `prevObstacle.end`; tail edge can't go past `nextObstacle.start`)
- `addNote`: uses `resolveOverlaps` with the new id as priority — if the new note's interval crosses an existing note, the existing one is clipped to make room
- `resolveOverlaps(song, priorityIds)`: generic per-pitch resolver. Used by `addNote` only after the move-side switched to clamping. Trims/drops non-priority notes against priority intervals, then applies "later wins, earlier trims" to remaining overlaps

**Context menu** (`NoteContextMenu` in `Viewport.tsx`): right-click was repurposed for delete, so the velocity-edit menu opens on **double-click**. Position is clamped to the viewport so it can't slide behind the Inspector. Slider uses `pushUndoSnapshot` once per session + `setSongPreview` per change. While dragging the slider, a 500ms-interval ticker plays the anchor note as preview audio so the user hears the loudness change.

**Loading guard.** While `loadStatus.state === 'loading'`, a transparent click-eater div (`absolute inset-0 cursor-wait`) is mounted between the Canvas and the SeekBar gradient. Blocks every canvas interaction (play toggle, range-select, eraser, new note, hold-to-FF). SeekBar / Inspector / Toolbar stay live. Defense-in-depth: editor pointer handlers also early-return on loading.

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

## Recording (`src/audio/recorder.ts` + `recordControl.ts` + `recordingStore.ts`)

`RecorderManager` singleton captures `addLiveListener` events into `Recording[]`. Hydrates from IndexedDB on first construction; every mutation (stop, rename, delete, clearAll) also writes through. Errors silently degrade (private mode / quota) so the in-memory recorder still works.

`recordControl.toggleRecord()` is the shared entry — Toolbar UI button + Shift+R global shortcut both call it. Drives a 4-beat metronome count-in (100 BPM, sine clicks via `click.ts`) when `countInEnabled` is set; the count-in beat number flows through the store so the Record button shows `1/4`, `2/4`, etc. Empty recordings (no captured events) are silently discarded with a toast.

Recordings are loadable straight back into the player (recorder.toArrayBuffer → parseMidi → setSong) and downloadable as SMF.

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
- `<RangeSelectRect />` — marquee, positioned in client coords against `innerRef`'s bounding rect (NOT the outer DropZone, which is offset by the letterbox bars)
- `<NoteContextMenu />` — velocity slider; same `innerRef`-based positioning + clamp
- Bottom gradient + `<SeekBar />` — gradient is `pointer-events-none`; only buttons / slider re-enable `pointer-events-auto` so empty space passes clicks to the canvas. Hover (`useHover`) + `idleHidden` autohide while playing; popovers from SeekBar pin the controls visible

The seek slider uses `SliderTrackRenderProps.isHovered` + `state.isThumbDragging(0)` to expand the bar / brighten the fill. Thumb is `sr-only` (visible track only). Same hover-grow pattern in `Inspector.tsx`'s `SliderRow`.

`Toolbar.tsx`: `<FileTrigger>` for "Open MIDI"; recording UI (Record button with elapsed + last-note + count display, Metronome toggle, Recordings list popover with rename / load+play / download / delete-with-confirm). Open MIDI / sample buttons disable while recording.

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
