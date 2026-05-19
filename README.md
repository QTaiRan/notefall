# notefall

A browser-based piano visualizer. Notes fall onto an 88-key keyboard while a MIDI
plays — and you can play live, record, edit the MIDI right on the canvas, animate
the look along the timeline, and export it all to video.

**Your MIDI, recordings, and projects never leave your device.** No accounts, no
content uploads — everything is processed entirely client-side. (Anonymous,
opt-out usage stats only.)

<p align="center">
  <img src=".github/demo.gif" alt="notefall in action" width="800">
</p>

<p align="center">
  <strong><a href="https://notefall.app">▶ Try it live — notefall.app</a></strong>
</p>

## Features

- **Falling notes** — a MIDI plays back through a sampled concert grand while
  its notes fall onto a 3D 88-key keyboard, with glow, particles, and bloom.
- **Play live** — touch, mouse, PC keyboard, or a hardware MIDI keyboard via
  the Web MIDI API. Sustain pedal supported.
- **Record** — capture a live performance (optional 4-beat metronome count-in)
  and load it straight back as an editable song.
- **Edit on the canvas** — move, resize, split, delete, draw, and marquee-select
  notes directly on the visualizer. Full undo/redo.
- **Timeline pins** — drop settings keyframes along the timeline and the scene
  morphs between them (camera, colors, opacity, bloom, background, …).
- **Export** — offline render to WAV (audio), silent MP4 (video), or a full
  A/V MP4, with resolution / fps / quality options and live progress + ETA.
- **File-based projects** — save/load `.nfz` project files to your own
  filesystem (no cloud, no IndexedDB-only fragility), with recent-files support.

## Tech stack

- Vite + React 18 + TypeScript
- [`@react-three/fiber`](https://github.com/pmndrs/react-three-fiber) + drei +
  postprocessing (Bloom) for the 3D scene
- [`smplr`](https://github.com/danigb/smplr) for the sampled grand piano,
  [`tone`](https://tonejs.github.io) for AudioContext lifecycle
- [`@tonejs/midi`](https://github.com/Tonejs/Midi) for MIDI parse/serialize
- `react-aria-components` + Tailwind for the UI, `zustand` for state
- `mp4-muxer` + WebCodecs for offline MP4 export

## License

[PolyForm Shield 1.0.0](LICENSE.md) — source-available. Permits any use except
offering a competing product or service.
