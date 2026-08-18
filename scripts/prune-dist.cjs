/**
 * Post-build cleanup: the per-file OGGs under `dist/samples/salamander-v3-close/`
 * are only needed as the pack source (see pack-samples.cjs) — the runtime loads
 * the single ZIP bundle, so shipping both would double the deploy size for
 * nothing. Removes the loose OGGs from the build output only.
 */
const fs = require('fs')
const path = require('path')

for (const sub of ['salamander-v3-close', 'salamander-v3-extras']) {
  const distDir = path.join(__dirname, '..', 'dist', 'samples', sub)
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true })
    console.log('Pruned loose OGGs from', distDir)
  } else {
    console.log('No loose OGG directory to prune:', distDir)
  }
}
