# notefall

Browser-based piano visualizer. Notes fall onto an 88-key keyboard while a MIDI plays; users can also play live (touch / mouse / PC keyboard / Web MIDI), record, and edit MIDI directly on the canvas. All client-side. PolyForm Shield 1.0.0.

## Stack

- Vite + React 18 + TypeScript
- `@react-three/fiber` + `drei` + `@react-three/postprocessing` (Bloom)
- `smplr` (`SplendidGrandPiano`) for sampled playback
- `@tonejs/midi` for parse/serialize; `tone` only for AudioContext lifecycle
- `react-aria-components` + Tailwind for UI; `zustand` for state
- IndexedDB for recordings; Web MIDI API for hardware input

## Layout

```
src/
├ App.tsx        Layout, fallbacks for no-WebGL or <1024px
├ store.ts       zustand: settings, song, transport, editor, project file
├ midi/          parse / serialize / edit (resolveOverlaps lives here)
├ projects/      .nfz zip format + FSA wrapper + recent files
├ audio/         engine, sampler, recorder, click metronome, MIDI input, preview
├ keyboard/      88-key layout + Keyboard.tsx (3D cap geometry, glow, input)
├ notes/         FallingNotes (SDF shader), HitLine, HitParticles, LandingFlashes,
│                noteDeathFx pub-sub, customTexture
├ scene/         Canvas + EditTools (paused) / PlayToggleArea (playing)
└ ui/            Layout, Toolbar, Inspector, Viewport, SeekBar, ConfirmModal
```

## Coordinates

- Camera at `[0, 0, 12]`, FOV 32°. Keyboard at `keyboardY = -2.0`.
- 1 mm = 0.01 wu. White: 0.235 × 1.475. Black: 0.137 × 0.95. 88 white keys × 0.235 = 12.22 wu = full 16:9 viewport width.
- White keys are 3D solid caps with rounded corners (`createRoundedWhiteGeometry`); black keys are custom chamfered geometry with an **inner solid fill** so chamfer/slope seams resolve to black instead of revealing the void behind.
- Hit line at `keyboardY + WHITE_KEY_LENGTH`. Note plane z = 0.05; clipping is **per-fragment SDF** (`vWorldY < uHitY`), NOT z-occlusion — putting notes at a different z would cause perspective parallax against the keys.

## AudioEngine (`src/audio/engine.ts`)

Singleton, decoupled from React. Self-clocked via `performance.now() / 1000`. `Layout.tsx` syncs settings → engine via `useEffect`s.

- **Two tick drivers**: `useFrame` (visual sync, paused on hidden tab) + Web Worker `setInterval(25 ms)` (background-tab playback would otherwise stall and burst on return).
- **Unique `stopId` per note** is mandatory. smplr defaults `stopId` to midi number, so back-to-back same-pitch notes share an id and stopping one cancels another mid-release. We pass `s${noteId}` for song, `live${liveId}` for touch, `prev-${n}` for previews.
- **Lookahead 0.015 s + stop buffer 0.02 s** prevent attack clicks and cancel-before-start drops.
- **Pedal sustain**: when pedal is engaged and a note's `endTime` arrives, its stop fn is pushed onto `pedalHeld[]`. Pedal-up flushes per-source ('song' / 'live').
- **Init dedupe**: concurrent `init()` callers share `initPromise`, so the ~60 MB sample load isn't kicked off twice.
- **`updateSong(song)`**: editor-driven replacement. Selectively releases active notes whose id/midi/endTime changed; structurally-unchanged notes stay so the engine fires their note-off naturally. Without this, pause+edit+resume left phantom-held notes.
- **`addLiveListener` ≠ `addKeyListener`**: live channel only fires for user input (recorder uses it to capture only what the user played).
- **`triggerPreview`**: plays a sampler note WITHOUT firing key listeners — editor previews don't trigger glow/particles.
- **`pause()`** keeps visualizer state intact, only kills audio via `releaseAllSounding()`.

## Sampler (`src/audio/sampler.ts`)

Wraps smplr's `SplendidGrandPiano` (~60 MB, 4 velocity layers). Signal: sampler → master gain → 6-band EQ → dry/wet split → ConvolverNode (synthetic IR) → destination.

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

## License

PolyForm Shield 1.0.0 (source-available). Permits any use except providing a competing product or service. See `LICENSE.md`.
