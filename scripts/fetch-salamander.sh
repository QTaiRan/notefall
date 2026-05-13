#!/usr/bin/env bash
# Fetch + install Salamander Grand Piano V3 (close mic, OGG Vorbis)
# samples into `public/samples/salamander-v3-close/` via a one-shot
# Docker container — so the host never gets `curl`, `tar`, or any
# Salamander build artefacts beyond the final 480 OGGs.
#
# Source: https://archive.org/details/SalamanderGrandPianoV3
#   - File: SalamanderGrandPianoV3_OggVorbis.tar.bz2 (~78 MB)
#   - License: CC-BY 3.0 (Alexander Holm)
#
# Usage (from repo root):
#   bash scripts/fetch-salamander.sh
#
# Re-running is safe — cp -n style behavior would be nice but
# tarball is small enough that a fresh extract is cheap. Existing
# files in the output directory are overwritten.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$REPO_ROOT/public/samples/salamander-v3-close"
TARBALL_URL="https://archive.org/download/SalamanderGrandPianoV3/SalamanderGrandPianoV3_OggVorbis.tar.bz2"

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker not found on PATH" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

docker run --rm \
  -v "$OUT_DIR:/output" \
  alpine:latest sh -ec "
    apk add --no-cache --quiet curl tar bzip2 >/dev/null 2>&1
    cd /tmp
    echo '>> downloading OGG tarball (~78 MB)...'
    curl -fL --retry 3 --silent --show-error -o sal.tbz '$TARBALL_URL'
    echo '>> extracting...'
    tar xjf sal.tbz
    echo '>> copying + renaming piano samples...'
    count=0
    skipped=0
    for f in SalamanderGrandPianoV3_OggVorbis/ogg/*.ogg; do
      base=\$(basename \"\$f\")
      # Filename pattern: <note><sharp?><octave>v<layer>.ogg
      # e.g. A0v1.ogg, C5v8.ogg, D#3v13.ogg. The sharp glyph '#'
      # would be interpreted as a URL fragment when the browser
      # fetches the sample, so rename to 's' (Ds, Fs) — matching
      # the convention in salamanderDescriptor.ts.
      if echo \"\$base\" | grep -qE '^[A-G]#?[0-9]+v[0-9]+\.ogg\$'; then
        new=\$(echo \"\$base\" | tr '#' 's')
        cp \"\$f\" \"/output/\$new\"
        count=\$((count + 1))
      else
        # rel* / harm* / pedal* — release noise, sympathetic
        # resonance, pedal noise. Useful for future expansion but
        # not wired in by the current descriptor.
        skipped=\$((skipped + 1))
      fi
    done
    echo \">> done: copied \$count files, skipped \$skipped non-main samples\"
  "
