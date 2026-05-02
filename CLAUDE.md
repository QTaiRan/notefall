# notefall

Browser-based piano visualizer. Notes fall onto a flat 88-key keyboard while a MIDI plays. Users can also touch the keys directly to play live. All processing is client-side. Source-available under PolyForm Shield 1.0.0.

## Stack

- Vite + React 18 + TypeScript
- `@react-three/fiber` + `drei` + `@react-three/postprocessing` (Three.js scene with Bloom)
- `smplr` (`SplendidGrandPiano`) for sampled piano playback
- `@tonejs/midi` for MIDI parsing; `tone` for AudioContext lifecycle only
- `react-aria-components` + Tailwind for UI controls
- `zustand` for app state

## Directory layout

```
src/
├ App.tsx, main.tsx
├ store.ts            Zustand store: settings, song, transport, loadStatus, loop
├ samples.ts          procedural demo songs (Scales, Arpeggios, Chords + Pedal)
├ midi/
│  ├ types.ts         NoteEvent / PedalEvent / ParsedSong
│  └ parse.ts         @tonejs/midi → ParsedSong (sorted by time)
├ audio/
│  ├ sampler.ts       PianoInstrument wrapper around smplr + FadeInStorage
│  └ engine.ts        AudioEngine singleton (scheduler, pedal, live notes)
├ keyboard/
│  ├ layout.ts        88-key XY-plane layout (MIDI 21..108)
│  └ Keyboard.tsx     flat-plane keys with glow + pointer interaction
├ notes/
│  └ FallingNotes.tsx single InstancedMesh + SDF rounded-rect shader
├ scene/
│  └ Scene.tsx        Canvas, lights, EffectComposer/Bloom
└ ui/
   ├ Layout.tsx, Toolbar.tsx, SeekBar.tsx, Inspector.tsx, Viewport.tsx
   ├ LoadingOverlay.tsx
   └ controls.tsx     SliderRow / SwitchRow / SelectRow / ColorRow
```

## Coordinates and geometry

- Camera at `[0, 0, 12]` looking at origin (perspective, FOV 32°)
- +X right, +Y up on screen, +Z toward camera
- Keyboard group positioned at `settings.keyboardY` (default `-2.0`)
- Keys are **flat planes** in XY (not boxes — boxes' side faces became visible at perspective edges and filled the gaps with the key color)
- White keys: z=0, length 1.6, width 0.23
- Black keys: z=0.04 (clearly in front of white to avoid z-fighting), length 1.0, width 0.13
- Falling note hit line: `keyboardY + WHITE_KEY_LENGTH` (the back edge of the keyboard, top of screen)
- Note plane z = 0.05 (in front of all keys)
- Visible falling distance: 3.5 world units from spawn to hit line

## AudioEngine (`src/audio/engine.ts`)

Singleton (`audioEngine`). Self-driven clock using `performance.now() / 1000`. `tick()` is called every frame from `FallingNotes`'s `useFrame`. The visual layer reads `currentSongTime()` to align bars with audio.

Per-tick order: cleanup live notes → process pedal events → process note-ons → process note-offs → loop/stop on end-of-song.

Non-obvious details:
- **Unique `stopId` per note** is mandatory. smplr defaults `stopId` to the midi number, so back-to-back notes of the same pitch share an id and stopping one cancels another mid-release. We pass `s${noteId}` for song notes and `live${liveId}` for touch-triggered notes.
- **Lookahead scheduling**: notes are scheduled at `audioCtx.currentTime + 0.015s`. Without this, the audio starts mid-quantum and produces a click.
- **Pedal sustain**: when pedal is engaged and a note's `endTime` arrives, its smplr stop fn is pushed onto `pedalHeld[]` instead of being called. Pedal-up (or `setPedalEnabled(false)`) flushes the queue.
- **Live notes** (`triggerKey(midi, velocity)`): returns `{ id, release }`. Tracked separately in `liveNotes[]` so they can be drawn in 'up' (rising trail) mode regardless of the `fallDirection` setting. They respect pedal sustain like song notes.
- The engine is decoupled from React. `Layout.tsx` syncs settings → engine via `useEffect`s.

## Sampler (`src/audio/sampler.ts`)

Wraps smplr's `SplendidGrandPiano` (~60 MB initial download with 4 velocity layers). A `GainNode` between the sampler output and `context.destination` provides volume control with `setTargetAtTime` ramps to avoid clicks when the slider moves.

**FadeInStorage** is critical. smplr's `Voice` sets `envelope.gain.value = 1` instantly (no attack envelope) — any sample whose first frame isn't exactly zero will click on attack. We intercept the storage layer, decode each fetched sample with `decodeAudioData`, apply a 1.5 ms linear fade-in to the first samples per channel, re-encode to WAV via `audioBufferToWav`, and hand the buffer to smplr. The 1.5 ms ramp is short enough to preserve the piano hammer attack character.

## Falling notes (`src/notes/FallingNotes.tsx`)

Single `InstancedMesh` using `PlaneGeometry(1,1)` and a custom `ShaderMaterial`.

- Per-instance `vec2 instanceSize` attribute carries world width × length to the shader.
- Vertex shader: `vUv = uv; vSize = instanceSize;` then standard `instanceMatrix` transform.
- Fragment shader runs a rounded-box SDF (`sdRoundedBox`) in world units. This keeps the corner radius geometrically correct regardless of bar length — uniform scaling would distort the corners into ellipses.
- Early `discard` for `vSize ≈ 0` (uninitialized instances). The InstancedMesh starts with `count={0}` and the useFrame sets the live count each frame.
- Emissive is **additive**: `col = uColor * (1.0 + uEmissive)`. This keeps `Emissive=0` showing the chosen color faithfully (instead of going black) and lets `Opacity` work as an independent alpha control. The two sliders are intentionally orthogonal.

Direction semantics (`settings.fallDirection`):
- `'down'` (default): notes spawn above the keyboard `fallDurationSec` seconds before `note.time`, fall to the hit line, then get consumed.
- `'up'`: notes spawn at the hit line at `note.time`, rise upward, exit `fallDurationSec` after the tail emerges. This is a "history trail" of recently-played notes. Both directions always draw notes ABOVE the keyboard.

The visual loop iterates the song's sorted note array and `break`s when no later notes can be visible yet (different break conditions per direction). Live notes are appended to the same instance buffer after song notes.

## Keyboard interaction (`src/keyboard/Keyboard.tsx`)

Per-key glow animation: `audioEngine.addKeyListener` receives 'on'/'off' events from both song playback and live touches. Glow energy decays with `settings.keyGlowDecay` and scales with `settings.keyboardBrightness` (so darkening the keyboard dims the glow too).

Pointer handling supports mouse + multi-touch:
- `onPointerDown` releases the touch's implicit pointer capture so sibling keys' `onPointerEnter` fires during a slide gesture.
- `pointerId → activePointers` map tracks which note each pointer holds.
- `onPointerEnter` on a different key while held switches to that key (releases previous, triggers new).
- A window-level `pointerup`/`pointercancel` listener releases notes when dragged off the canvas.
- If a touch happens during async sample loading, the desired midi is recorded in `pendingMidi`. Releasing during loading clears the entry so no stuck note appears once samples finish loading. `pointerEnter` updates the pending entry to the latest hovered key.

## State (`src/store.ts`)

- `settings` — all visual/audio params, edited live in Inspector, resettable.
- `transport` — `'stopped' | 'playing' | 'paused'`.
- `currentTime` — written from Layout's RAF loop polling `audioEngine.currentSongTime()`.
- `loadStatus` — `'idle' | 'loading' (with progress) | 'ready'`. Drives the `LoadingOverlay` (rendered at the Layout root with `fixed inset-0`).
- `loop` — synced into the engine's `setLoop`.
- `song` — `ParsedSong | null`.

## UI layout

`Layout.tsx`:
```
┌─ Toolbar ────────────────────────────────────┐
├──────────────────────────────┬───────────────┤
│  Viewport (16:9 letterboxed) │  Inspector    │
│  + drag-and-drop MIDI        │  (settings)   │
├──────────────────────────────┴───────────────┤
│  SeekBar (transport row + slider)            │
└──────────────────────────────────────────────┘
+ LoadingOverlay (fixed, z-50, pointer-events:none)
```

Transport row layout uses a 3-column grid: time on the left, centered button group (Rewind / Play-Pause / Loop), reserved right column.

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
