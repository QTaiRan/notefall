# notefall

Browser-based piano visualizer. Notes fall onto a flat 88-key keyboard while a MIDI plays. Users can also touch / mouse / keyboard the keys directly to play live. All processing is client-side. Source-available under PolyForm Shield 1.0.0.

## Stack

- Vite + React 18 + TypeScript
- `@react-three/fiber` + `drei` + `@react-three/postprocessing` (Three.js scene with Bloom)
- `smplr` (`SplendidGrandPiano`) for sampled piano playback
- `@tonejs/midi` for MIDI parsing; `tone` for AudioContext lifecycle only
- `react-aria-components` + `react-aria` (`useHover`) + Tailwind for UI
- `zustand` for app state

## Directory layout

```
src/
├ App.tsx               renders Layout, or UnsupportedScreen on screens < 1024px
├ main.tsx
├ store.ts              Zustand store: settings, song, transport, loadStatus, loop, fastForward
├ samples.ts            procedural demo songs (Scales, Arpeggios, Chords + Pedal)
├ midi/
│  ├ types.ts           NoteEvent / PedalEvent / ParsedSong
│  └ parse.ts           @tonejs/midi → ParsedSong (sorted by time)
├ audio/
│  ├ sampler.ts         PianoInstrument wrapper around smplr + FadeInStorage + Reverb
│  ├ engine.ts          AudioEngine singleton (scheduler, pedal, live notes, bg ticker)
│  ├ playback.ts        playSong / pauseSong / togglePlayback (shared by SeekBar + scene)
│  └ useCurrentTime.ts  rAF-polled hook returning the engine's current song time
├ keyboard/
│  ├ layout.ts          88-key XY-plane layout (MIDI 21..108)
│  └ Keyboard.tsx       flat-plane keys, glow, pointer + PC-keyboard input, octave dividers
├ notes/
│  ├ FallingNotes.tsx   InstancedMesh + SDF rounded-rect shader with hit-line clipping
│  └ LandingFlashes.tsx additive white spark per key, sustained while a note is held
├ scene/
│  └ Scene.tsx          Canvas, lights, EffectComposer/Bloom, PlayToggleArea
└ ui/
   ├ Layout.tsx           top-level shell (Toolbar + Viewport + Inspector)
   ├ Toolbar.tsx          logo, Open MIDI (FileTrigger), demo song buttons
   ├ Viewport.tsx         16:9 letterbox, DropZone, hover-driven controls overlay
   ├ Inspector.tsx        Reset (with Tooltip) + every settings slider
   ├ SeekBar.tsx          transport row + slider, lives inside the Viewport overlay
   ├ LoadingOverlay.tsx   centered sample-loading progress
   ├ UnsupportedScreen.tsx fallback for screens < 1024px (no Layout / Canvas mounted)
   └ controls.tsx         SliderRow / SwitchRow / SelectRow / ColorRow primitives
```

## Coordinates and geometry

- Camera at `[0, 0, 12]` looking at origin (perspective, FOV 32°)
- +X right, +Y up on screen, +Z toward camera
- Keyboard group positioned at `settings.keyboardY` (default `-2.0`)
- Keys are **flat planes** in XY, not boxes (boxes' side faces became visible at perspective edges and filled the gaps with the key colour)
- Dimensions follow real grand-piano spec at 1mm = 0.01 world units:
  - White: width 0.235, length 1.475 (z = 0)
  - Black: width 0.137, length 0.95 (z = 0.04, clearly in front of white to avoid z-fighting)
- 88 white keys × 0.235 = 12.22 world units total — matches the visible width of the default 16:9 viewport, so the keyboard spans edge-to-edge
- Hit line: `keyboardY + WHITE_KEY_LENGTH` (the back edge of the keyboard)
- Note plane z = **0.05** (in front of all keys). Notes are clipped at `vWorldY < uHitY` in the fragment shader, NOT via z-occlusion. Doing it per-pixel avoids perspective parallax — putting notes at a different z would visually pull them inward at the edges relative to the keys.
- Octave dividers (B↔C boundaries) at z = 0.02, gray, transparent — a thin vertical line per octave from the back edge of the keyboard up to the visible top
- Landing flashes at z = 0.06 (in front of keys), additive blending

## AudioEngine (`src/audio/engine.ts`)

Singleton (`audioEngine`). Self-driven clock using `performance.now() / 1000`. The visual layer reads `currentSongTime()` to align bars with audio.

`tick()` per-tick order: cleanup live notes → process pedal events → process note-ons → process note-offs → loop / stop on end-of-song.

Non-obvious details:
- **Two tick drivers**: `FallingNotes`'s `useFrame` calls `tick()` for visual sync (paused when tab hidden because rAF stops), AND a Web Worker `setInterval(25ms)` calls it while playing. Background-tab playback would otherwise stall and burst on return.
- **Unique `stopId` per note** is mandatory. smplr defaults `stopId` to the midi number, so back-to-back notes of the same pitch share an id and stopping one cancels another mid-release. We pass `s${noteId}` for song notes and `live${liveId}` for touch-triggered notes.
- **Lookahead scheduling**: notes are scheduled at `audioCtx.currentTime + 0.015s`. Without this, the audio starts mid-quantum and produces a click.
- **Stop buffer**: every `stop()` call passes `currentTime + 0.02s`. Without this, very short notes (high playback rate, on/off in same tick) would stop BEFORE the lookahead start, cancelling the source mid-playback.
- **Pedal sustain**: when pedal is engaged and a note's `endTime` arrives, its smplr stop fn is pushed onto `pedalHeld[]` instead of being called. Pedal-up (or `setPedalEnabled(false)`) flushes the queue.
- **Live notes** (`triggerKey(midi, velocity)`): returns `{ id, release }`. Tracked separately in `liveNotes[]` so they always render in 'up' (rising trail) mode regardless of `fallDirection`. They respect pedal sustain like song notes.
- The engine is decoupled from React. `Layout.tsx` syncs settings → engine via `useEffect`s.

## Sampler (`src/audio/sampler.ts`)

Wraps smplr's `SplendidGrandPiano` (~60 MB initial download, 4 velocity layers). Signal chain: sampler → master `GainNode` → dry/wet split → `ConvolverNode` (synthetic IR) → destination. Volume and reverb mix use `setTargetAtTime` ramps to avoid clicks.

**FadeInStorage** is critical. smplr's `Voice` sets `envelope.gain.value = 1` instantly (no attack envelope) — any sample whose first frame isn't exactly zero clicks on attack. We intercept the storage layer, decode each fetched sample, apply a 1.5 ms linear fade-in to the first samples per channel, re-encode to WAV via `audioBufferToWav`, and hand the buffer to smplr. The 1.5 ms ramp is short enough to preserve the piano hammer attack.

## Falling notes (`src/notes/FallingNotes.tsx`)

Single `InstancedMesh` using `PlaneGeometry(1,1)` and a custom `ShaderMaterial`.

- Per-instance `vec2 instanceSize` attribute carries world width × length to the shader.
- Vertex shader computes `vWorldY` from `modelMatrix * instanceMatrix * position` so the fragment shader can clip per-pixel against `uHitY` (the keyboard's hit line, set every frame from `settings.keyboardY + WHITE_KEY_LENGTH`).
- Fragment shader: clip `vWorldY < uHitY`, then a rounded-box SDF (`sdRoundedBox`) in world units. Per-pixel SDF keeps the corner radius geometrically correct regardless of bar length.
- Early `discard` for `vSize ≈ 0` (uninitialised instances). The InstancedMesh starts with `count={0}` and the useFrame sets the live count each frame.
- Emissive is **additive**: `col = uColor * (1.0 + uEmissive)`. This keeps `Emissive=0` showing the chosen colour faithfully and lets `Opacity` work as an independent alpha control.

CPU-side geometry per note (in `useFrame`):
- `bottomY = headY` (head can go far below `hitY` once the note has landed — it's hidden by shader clipping)
- `visualLength = max(settings.noteMinLength, naturalLength)` so very short notes stay visible while in the air
- Skip when `topY <= hitY` (entire visual rect has slid past the hit line)

Direction semantics (`settings.fallDirection`):
- `'down'` (default): notes spawn `fallDurationSec` before `note.time`, fall onto the keyboard, then slide past the hit line and clip away.
- `'up'`: notes spawn at the hit line at `note.time`, rise upward, exit `fallDurationSec` after the tail emerges. A "history trail".

Live notes are appended to the same instance buffer after song notes and always render 'up'.

## Landing flashes (`src/notes/LandingFlashes.tsx`)

One `InstancedMesh` instance per key (88), positioned at the hit line per key. White additive shader with a sharp gaussian core and `smoothstep` edge fade (so plane corners never read as a rectangle through Bloom). Falloff coefficient is divided by `flashHaloWidth²`, so the user-controlled "Halo" widens / tightens the soft edge.

- Subscribes to `audioEngine.addKeyListener`. On note-on: bumps `intensities[idx]` to a velocity-scaled sustain level instantly (no fade-in) and extends `heldUntil[idx] = now + 80ms`.
- On note-off: decrements `heldCount[idx]`. The flash holds steady; useFrame snaps to 0 only once the key has released AND the 80ms minimum-hold window has elapsed. This guarantees super-short notes still register visually.
- Plane is square per key (width = key.width × 2.6 × `flashSize`, with `flashWidth` as an extra horizontal multiplier), so changing Size never makes flashes elongate.

## Keyboard interaction (`src/keyboard/Keyboard.tsx`)

Per-key glow animation: `audioEngine.addKeyListener` receives 'on'/'off' events from both song playback and live touches. `held[]` is a **reference count** (++/--), not a flag — required because back-to-back retriggers on the same pitch may emit on/off in either order within a frame. Glow scales with `settings.keyboardBrightness`.

**Pointer input** (mouse + multi-touch):
- `onPointerDown` releases the touch's implicit pointer capture so sibling keys' `onPointerEnter` fires during a slide gesture.
- `pointerId → activePointers` map tracks which note each pointer holds.
- `onPointerEnter` on a different key while held switches to that key.
- A window-level `pointerup`/`pointercancel` listener releases notes dragged off the canvas.
- A touch during async sample loading is tracked in `pendingMidi`; releasing during the load clears the entry so no stuck note appears.

**PC keyboard input** (laid out per `PC_KEY_NOTES`):
- ZXCV row → C3..E4 white keys
- ASDF row → black keys for the QWERTY (top) octave (s=C#4, ;=D#5)
- QWERTY row → C4..G5 white keys
- Digit row → chromatic continuation A5..G#6
- Skipped on `INPUT` / `TEXTAREA` / `contenteditable` focus or modifier-key combos. Window blur releases everything.

**Octave dividers**: thin gray planes between each B and C, from the keyboard back edge up to the visible top of the camera frustum.

## Scene click area (`src/scene/Scene.tsx` → `PlayToggleArea`)

Two invisible meshes (above and below the keyboard) sharing one set of pointer handlers:
- Short click → `togglePlayback`
- Press-and-hold > 200 ms → 2× playback rate, with `setFastForward(true)` so the badge in `Viewport` shows. If the song was paused, the hold also starts playback; releasing pauses it again (preview / scrub).
- Window-level `pointerup`/`pointercancel`/`blur` always restore the rate, so the 2× state can never get stuck.

## State (`src/store.ts`)

- `settings` — every visual / audio param. Edited live in Inspector. `resetSettings` restores defaults.
- `song: ParsedSong | null`
- `transport: 'stopped' | 'playing' | 'paused'`
- `currentTime` — kept for SeekBar's onChange handler; **the live readout uses `useCurrentTime`** instead, so 60 Hz updates don't re-render the whole subtree.
- `loadStatus: 'idle' | { state: 'loading', loaded, total } | 'ready'` — drives `LoadingOverlay`.
- `loop` — synced into the engine's `setLoop`.
- `fastForward` — true while the user is holding the playback area; drives the top-center 2× badge.

## UI layout

`App.tsx` renders `<Layout />` only when the viewport is ≥ 1024 px (Tailwind `lg` breakpoint, watched via `matchMedia`). Below that it renders `<UnsupportedScreen />` instead — the 3D Canvas and audio engine never initialise on small screens.

`Layout.tsx`:
```
┌─ Toolbar ────────────────────────────────────┐
├──────────────────────────────┬───────────────┤
│  Viewport (16:9 letterboxed) │  Inspector    │
│  inside DropZone             │  (settings)   │
├──────────────────────────────┴───────────────┤
+ LoadingOverlay (fixed, z-50, pointer-events:none)
```

`Viewport.tsx` overlays:
- `<Scene />` (the Canvas)
- `<PausedIndicator />` — centered play badge, visible whenever transport ≠ 'playing'
- `<FastForwardIndicator />` — top-center 2× pill, shown while `fastForward` is true
- `<SeekBar />` inside a YouTube-style hover-revealed gradient at the bottom. The gradient is `pointer-events-none`; only the Buttons / Slider inside `SeekBar` re-enable `pointer-events-auto`, so empty space around the controls passes clicks through to the `PlayToggleArea` mesh on the canvas. Hover state uses `react-aria`'s `useHover` (touch-aware) and visibility transitions both `opacity` and `visibility` (with a delay on hide) so the controls really stop intercepting events when invisible.

The seek slider uses react-aria's `SliderTrackRenderProps.isHovered` + `state.isThumbDragging(0)` to expand the bar / brighten the fill on hover. The thumb is `sr-only` (visible track only).

`Inspector.tsx` slider rows reuse `useHover` via `SliderTrack`'s render props for the same hover-grow effect, mirroring the seek bar.

`Toolbar.tsx` uses react-aria `<FileTrigger>` for "Open MIDI"; `Viewport` uses `<DropZone>`. `Inspector`'s color rows are `<ColorPicker>` + `<ColorArea>` + `<ColorSlider>` + `<ColorField>` in a `<Popover>` (no native `<input type="color">`).

## Demo songs (`src/samples.ts`)

Three procedural patterns built without external MIDI files:
- **Scales** — chromatic scale up/down across 6 octaves at 0.18 s/note
- **Arpeggios** — broken chord patterns with bass octaves
- **Chords + Pedal** — short staccato chords with legato pedaling between bars (toggle Inspector → Pedal Enabled to hear the difference)

## Build / dev

```
npm install
npm run dev        # Vite dev server on :5173
npm run build      # tsc -b && vite build → dist/
npm run typecheck
```

`index.html` lives at the project root by Vite convention — it is the literal entry point Vite resolves (not a misplaced public file).

## License

PolyForm Shield 1.0.0 (source-available). Permits any use except providing a competing product or service. See `LICENSE.md`. Copyright holder: ekkx.
