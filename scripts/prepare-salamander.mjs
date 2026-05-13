#!/usr/bin/env node
// Prepare Salamander Grand Piano V3 samples for notefall.
//
// Takes the upstream V3 release (WAV + SFZ) and:
//   1. Validates that all 30 sampled keys × 16 velocity layers exist
//      for the close-mic position
//   2. Transcodes each WAV → OGG Vorbis 96 kbps via ffmpeg
//   3. Writes the result to <out>/ with flat filenames
//      (`<note>v<layer>.ogg`) matching `salamanderDescriptor.ts`
//
// Usage:
//   node scripts/prepare-salamander.mjs <source-dir> <out-dir>
//
// Example:
//   node scripts/prepare-salamander.mjs \
//     ~/Downloads/SalamanderGrandPianoV3 \
//     public/samples/salamander-v3-close
//
// Requires `ffmpeg` on PATH. Skips already-converted files so the
// script can resume after a crash / cancel without re-encoding.

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, relative } from 'node:path'

const NOTES = [
  ['A0', 21], ['C1', 24], ['Ds1', 27], ['Fs1', 30],
  ['A1', 33], ['C2', 36], ['Ds2', 39], ['Fs2', 42],
  ['A2', 45], ['C3', 48], ['Ds3', 51], ['Fs3', 54],
  ['A3', 57], ['C4', 60], ['Ds4', 63], ['Fs4', 66],
  ['A4', 69], ['C5', 72], ['Ds5', 75], ['Fs5', 78],
  ['A5', 81], ['C6', 84], ['Ds6', 87], ['Fs6', 90],
  ['A6', 93], ['C7', 96], ['Ds7', 99], ['Fs7', 102],
  ['A7', 105], ['C8', 108],
]
const LAYERS = 16
const OGG_BITRATE = '96k'

function die(msg) {
  process.stderr.write(`error: ${msg}\n`)
  process.exit(1)
}

function runFfmpeg(input, output) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'ffmpeg',
      ['-y', '-loglevel', 'error', '-i', input, '-c:a', 'libvorbis', '-b:a', OGG_BITRATE, output],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    )
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}`))
    })
  })
}

// Walk a directory tree looking for any file matching `name` (case-
// insensitive, with .wav extension). Salamander V3 releases ship
// samples under various subdirectory layouts (Samples/, 48khz24bit/,
// etc.), so we scan rather than assume.
function findWav(rootDir, baseName) {
  const target = `${baseName.toLowerCase()}.wav`
  const stack = [rootDir]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry)
      let s
      try {
        s = statSync(full)
      } catch {
        continue
      }
      if (s.isDirectory()) {
        stack.push(full)
      } else if (entry.toLowerCase() === target) {
        return full
      }
    }
  }
  return null
}

async function main() {
  const [src, out] = process.argv.slice(2)
  if (!src || !out) {
    die('usage: prepare-salamander.mjs <source-dir> <out-dir>')
  }
  if (!existsSync(src)) die(`source dir not found: ${src}`)
  mkdirSync(out, { recursive: true })

  // First pass: validate every expected file is present BEFORE we
  // start writing — a long batch that aborts halfway leaves a
  // confusing partially-converted state.
  const tasks = []
  const missing = []
  for (const [note] of NOTES) {
    for (let v = 1; v <= LAYERS; v++) {
      const baseName = `${note}v${v}`
      const outFile = join(out, `${baseName}.ogg`)
      if (existsSync(outFile) && statSync(outFile).size > 0) {
        continue
      }
      const wav = findWav(src, baseName)
      if (!wav) missing.push(baseName)
      else tasks.push({ wav, outFile, baseName })
    }
  }

  if (missing.length) {
    process.stderr.write(
      `error: missing ${missing.length} source WAV file(s):\n` +
        missing.map((m) => `  - ${m}.wav`).join('\n') +
        '\n',
    )
    process.exit(2)
  }

  if (tasks.length === 0) {
    process.stdout.write(`nothing to do — all ${NOTES.length * LAYERS} OGGs already present in ${out}\n`)
    return
  }

  process.stdout.write(`transcoding ${tasks.length} samples → ${out} (OGG ${OGG_BITRATE})\n`)
  let done = 0
  for (const { wav, outFile, baseName } of tasks) {
    mkdirSync(dirname(outFile), { recursive: true })
    try {
      await runFfmpeg(wav, outFile)
    } catch (e) {
      die(`failed converting ${relative(process.cwd(), wav)}: ${e.message}`)
    }
    done++
    if (done % 16 === 0 || done === tasks.length) {
      process.stdout.write(`  ${done}/${tasks.length} (${baseName})\n`)
    }
  }
  process.stdout.write('done.\n')
}

main().catch((e) => die(e?.message ?? String(e)))
