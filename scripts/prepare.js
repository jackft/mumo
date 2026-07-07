const { execSync } = require('child_process')
const { copyFileSync, realpathSync } = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')

// Copy large runtime assets from node_modules to packages/mumo/public/ so they
// are not committed to git but still available for dev and production builds.
function copyPublicAssets() {
  const dest = path.join(root, 'packages/mumo/public')

  // pnpm symlinks @ricky0123/vad-web into media-player's node_modules;
  // realpathSync gets the pnpm store path so we can find onnxruntime-web beside it.
  const vadWebReal = realpathSync(
    path.join(root, 'packages/media-player/node_modules/@ricky0123/vad-web'),
  )
  const vadWebDist = path.join(vadWebReal, 'dist')
  const ortDist = path.join(vadWebReal, '..', '..', 'onnxruntime-web', 'dist')

  const copies = [
    [path.join(vadWebDist, 'silero_vad_legacy.onnx'), path.join(dest, 'silero_vad_legacy.onnx')],
    [path.join(ortDist, 'ort-wasm-simd-threaded.wasm'), path.join(dest, 'ort-wasm-simd-threaded.wasm')],
    [path.join(ortDist, 'ort-wasm-simd-threaded.jsep.wasm'), path.join(dest, 'ort-wasm-simd-threaded.jsep.wasm')],
  ]

  for (const [src, dst] of copies) {
    copyFileSync(src, dst)
    console.log(`copied ${path.basename(src)} -> public/`)
  }
}

try {
  copyPublicAssets()
} catch (e) {
  console.warn('Could not copy public assets from node_modules:', e.message)
}

try {
  execSync('wasm-pack --version', { stdio: 'ignore' })
} catch {
  console.log('wasm-pack not found — skipping WASM build (run pnpm build:wasm manually)')
  process.exit(0)
}
execSync('pnpm run build:wasm', { stdio: 'inherit' })
