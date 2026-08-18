/**
 * Packs the Salamander V3 OGG samples into a single stored-mode ZIP
 * (`public/samples/salamander-v3-close.zip`) so the browser downloads
 * ONE ~76 MB request instead of 480 round-trips. Stored mode (level 0)
 * because OGG is already compressed — re-deflating buys nothing.
 *
 * The unpacking happens in the browser (`src/audio/zipBundle.ts`)
 * using fflate, which is already a runtime dependency.
 */
const fs = require('fs')
const path = require('path')
const { zipSync } = require('fflate')

const samplesDir = path.join(__dirname, '..', 'public', 'samples', 'salamander-v3-close')
const outZip = path.join(__dirname, '..', 'public', 'samples', 'salamander-v3-close.zip')

if (!fs.existsSync(samplesDir)) {
  console.error('Sample directory missing:', samplesDir)
  process.exit(1)
}

const files = fs.readdirSync(samplesDir).filter((f) => f.endsWith('.ogg'))
if (files.length !== 480) {
  console.error('Expected 480 OGG samples, found', files.length)
  process.exit(1)
}

const input = {}
for (const f of files) {
  input[f] = fs.readFileSync(path.join(samplesDir, f))
}

const zipped = zipSync(input, { level: 0 })
fs.writeFileSync(outZip, zipped)
console.log(
  `Packed ${files.length} samples -> ${path.basename(outZip)} (${(zipped.length / 1048576).toFixed(1)} MB)`,
)
