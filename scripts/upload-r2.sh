#!/usr/bin/env bash
# Upload Salamander V3 OGG samples to Cloudflare R2 via a one-shot
# Docker container running rclone — so the host never gets rclone,
# aws-cli, or any other CLI dependency installed.
#
# Required env vars:
#   R2_ACCOUNT_ID         — Cloudflare account ID (32 hex chars)
#   R2_ACCESS_KEY_ID      — R2 API token: Access Key ID
#   R2_SECRET_ACCESS_KEY  — R2 API token: Secret Access Key
#   R2_BUCKET             — bucket name, e.g. "notefall-samples"
#
# Optional:
#   R2_PREFIX             — key prefix inside the bucket
#                           (default: "salamander-v3-close")
#   SAMPLES_DIR           — local source dir
#                           (default: public/samples/salamander-v3-close)
#
# Usage (from repo root):
#   export R2_ACCOUNT_ID=...
#   export R2_ACCESS_KEY_ID=...
#   export R2_SECRET_ACCESS_KEY=...
#   export R2_BUCKET=notefall-samples
#   bash scripts/upload-r2.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SAMPLES_DIR="${SAMPLES_DIR:-$REPO_ROOT/public/samples/salamander-v3-close}"
R2_PREFIX="${R2_PREFIX:-salamander-v3-close}"

# Auto-load credentials from .env if it exists. Pre-existing shell
# env still wins (we use ${VAR:-} expansion) — useful for one-off
# overrides or CI where the secrets come from a vault.
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env"
  set +a
fi

for var in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do
  if [ -z "${!var:-}" ]; then
    echo "error: missing env var: $var" >&2
    exit 1
  fi
done

if [ ! -d "$SAMPLES_DIR" ]; then
  echo "error: samples dir not found: $SAMPLES_DIR" >&2
  echo "       run 'npm run fetch-salamander' first" >&2
  exit 1
fi

file_count=$(find "$SAMPLES_DIR" -name '*.ogg' | wc -l | tr -d ' ')
echo ">> uploading $file_count OGG files from $SAMPLES_DIR"
echo ">> target: r2://$R2_BUCKET/$R2_PREFIX/"

# rclone's S3 remote supports R2 via the Cloudflare endpoint URL.
# `--checksum` makes re-runs idempotent (skip if size + ETag match)
# without HEAD-ing every key, so a re-deploy of unchanged samples
# is a no-op. `--header-upload` pins the public Cache-Control to a
# year + immutable so browsers (and CDN edges) hold the bytes
# forever — sample filenames are content-addressed enough by the
# `<note>v<layer>.ogg` convention that we'll never need to
# overwrite in place.
docker run --rm \
  -v "$SAMPLES_DIR:/data:ro" \
  -e RCLONE_CONFIG_R2_TYPE=s3 \
  -e RCLONE_CONFIG_R2_PROVIDER=Cloudflare \
  -e RCLONE_CONFIG_R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  -e RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
  -e RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
  -e RCLONE_CONFIG_R2_REGION=auto \
  rclone/rclone:latest \
  copy /data "r2:${R2_BUCKET}/${R2_PREFIX}" \
    --header-upload "Cache-Control: public, max-age=31536000, immutable" \
    --header-upload "Content-Type: audio/ogg" \
    --checksum \
    --transfers 16 \
    --progress

echo ">> done."
