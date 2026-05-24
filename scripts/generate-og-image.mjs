/**
 * Generates the social-share Open Graph image (1200×630).
 *
 * Builds an SVG that mirrors the app's look — dark scene, cyan notes
 * falling onto an 88-key-style keyboard, with the wordmark + tagline —
 * and rasterizes it to `public/og-image.png` (PNG, because X / Facebook /
 * Slack do not render SVG or animated GIF link previews).
 *
 * The SVG source is also written to `public/og-image.svg` for editing.
 *
 * Rasterization uses @resvg/resvg-js, which has no system dependencies.
 * It is NOT a project dependency (this script is a one-off asset tool):
 *
 *     npm install --no-save @resvg/resvg-js
 *     node scripts/generate-og-image.mjs
 *
 * Without it the script still emits the SVG and tells you to install it.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const W = 1200
const H = 630
const here = dirname(fileURLToPath(import.meta.url))
const publicDir = resolve(here, '..', 'public')

// ── Palette (matches favicon.svg / the app's default scene) ──────────────
const BG_TOP = '#070a12'
const BG_BOTTOM = '#03040a'
const CYAN = '#5ad7ff'
const WHITE_KEY = '#f5f5f5'
const BLACK_KEY = '#141414'

// ── Keyboard geometry ────────────────────────────────────────────────────
const KB_TOP = 486 // hit line sits here
const KB_BOTTOM = H
const KB_HEIGHT = KB_BOTTOM - KB_TOP
const N_WHITE = 36
const whiteW = W / N_WHITE
const blackW = whiteW * 0.58
const blackH = KB_HEIGHT * 0.6
// Within an octave, a black key follows these white indices: C D _ F G A _
const BLACK_AFTER = new Set([0, 1, 3, 4, 5])

function whiteKeys() {
  let s = ''
  for (let i = 0; i < N_WHITE; i++) {
    const x = i * whiteW
    s += `<rect x="${(x + 0.6).toFixed(2)}" y="${KB_TOP}" width="${(whiteW - 1.2).toFixed(2)}" height="${KB_HEIGHT}" rx="3" fill="${WHITE_KEY}"/>`
  }
  return s
}

function blackKeys() {
  let s = ''
  for (let i = 0; i < N_WHITE - 1; i++) {
    if (!BLACK_AFTER.has(i % 7)) continue
    const cx = (i + 1) * whiteW
    s += `<rect x="${(cx - blackW / 2).toFixed(2)}" y="${KB_TOP}" width="${blackW.toFixed(2)}" height="${blackH.toFixed(2)}" rx="2.5" fill="${BLACK_KEY}"/>`
  }
  return s
}

// ── Falling notes ─────────────────────────────────────────────────────────
// Cyan-dominant, aligned to white-key columns, with one warm accent so the
// image reads as "colour automation" without fighting the favicon's cyan.
const ACCENT = '#ff8bd8'
const NOTES = [
  { col: 6, y: 70, h: 150 },
  { col: 6, y: 250, h: 90 },
  { col: 11, y: 120, h: 210 },
  { col: 15, y: 40, h: 120, c: ACCENT },
  { col: 15, y: 200, h: 130 },
  { col: 19, y: 96, h: 170 },
  { col: 23, y: 180, h: 240 },
  { col: 28, y: 60, h: 110 },
  { col: 28, y: 210, h: 150, c: ACCENT },
  { col: 32, y: 130, h: 200 },
]

function fallingNotes() {
  let s = ''
  for (const n of NOTES) {
    const noteW = whiteW * 0.62
    const x = n.col * whiteW + (whiteW - noteW) / 2
    const c = n.c ?? CYAN
    s += `<rect x="${x.toFixed(2)}" y="${n.y}" width="${noteW.toFixed(2)}" height="${n.h}" rx="6" fill="${c}" filter="url(#glow)" opacity="0.95"/>`
  }
  return s
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${BG_TOP}"/>
      <stop offset="1" stop-color="${BG_BOTTOM}"/>
    </linearGradient>
    <linearGradient id="scrim" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#03040a" stop-opacity="0.92"/>
      <stop offset="0.55" stop-color="#03040a" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#03040a" stop-opacity="0"/>
    </linearGradient>
    <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="7" result="b"/>
      <feMerge>
        <feMergeNode in="b"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <filter id="hitglow" x="-20%" y="-400%" width="140%" height="900%">
      <feGaussianBlur stdDeviation="10"/>
    </filter>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>

  ${fallingNotes()}

  <!-- Hit line glow just above the keys -->
  <rect x="0" y="${KB_TOP - 3}" width="${W}" height="6" fill="${CYAN}" opacity="0.5" filter="url(#hitglow)"/>
  <rect x="0" y="${KB_TOP - 1.5}" width="${W}" height="3" fill="${CYAN}" opacity="0.85"/>

  <!-- Keyboard -->
  ${whiteKeys()}
  ${blackKeys()}

  <!-- Left scrim for text legibility -->
  <rect width="${W}" height="${KB_TOP}" fill="url(#scrim)"/>

  <!-- Wordmark + tagline -->
  <g font-family="Helvetica Neue, Helvetica, Arial, sans-serif">
    <text x="80" y="232" font-size="104" font-weight="700" fill="#ffffff" letter-spacing="-3">notefall</text>
    <text x="84" y="296" font-size="38" font-weight="500" fill="#cdd9e8">Piano MIDI visualizer in your browser</text>
    <text x="84" y="350" font-size="27" font-weight="500" fill="${CYAN}" letter-spacing="0.5">Falling notes · play live · record · edit · export to video</text>
  </g>
</svg>
`

writeFileSync(resolve(publicDir, 'og-image.svg'), svg)
console.log('wrote public/og-image.svg')

try {
  const { Resvg } = await import('@resvg/resvg-js')
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: W },
    font: { loadSystemFonts: true },
    background: BG_BOTTOM,
  })
  const png = resvg.render().asPng()
  writeFileSync(resolve(publicDir, 'og-image.png'), png)
  console.log(`wrote public/og-image.png (${png.length} bytes)`)
} catch {
  console.log(
    'Skipped PNG: @resvg/resvg-js not installed.\n' +
      '  npm install --no-save @resvg/resvg-js && node scripts/generate-og-image.mjs',
  )
}
