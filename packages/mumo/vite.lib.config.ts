import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import wasm from 'vite-plugin-wasm'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

// Library build — produces dist-lib/mumo.esm.js and dist-lib/mumo.js (IIFE).
// Serve all files in dist-lib from the same directory (worker + WASM are referenced relatively).
// CMU Serif font is bundled via lib.ts → computer-modern/cmu-serif.css.

export default defineConfig({
  plugins: [svelte(), wasm(), {
    name: 'copy-static-assets',
    closeBundle() {
      const pub = resolve(__dirname, 'public')
      const out = resolve(__dirname, 'dist-lib')
      copyFileSync(resolve(__dirname, 'public/mumo.png'), `${out}/mumo.png`)
      for (const f of ['silero_vad_legacy.onnx', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs']) {
        copyFileSync(`${pub}/${f}`, `${out}/${f}`)
      }
    },
    writeBundle() {
      const out = resolve(__dirname, 'dist-lib')
      const hash = createHash('sha256')
        .update(readFileSync(`${out}/mumo.esm.js`))
        .digest('hex')
        .slice(0, 8)
      writeFileSync(`${out}/version.txt`, hash)
    },
  }],
  worker: {
    format: 'es',
    plugins: () => [wasm()],
    rollupOptions: {
      output: {
        entryFileNames: 'mumo.worker.js',
      },
    },
  },
  // Don't copy the webapp's public dir (ONNX model, VAD, demo media) into the lib output.
  publicDir: false,
  optimizeDeps: {
    exclude: ['@ricky0123/vad-web', 'onnxruntime-web'],
  },
  build: {
    target: 'esnext',
    lib: {
      entry: 'src/lib.ts',
      name: 'mumo',
      formats: ['es', 'iife'],
      fileName: (format) => format === 'es' ? 'mumo.esm.js' : 'mumo.js',
    },
    outDir: 'dist-lib',
    minify: false,
    rollupOptions: {
      output: {
        chunkFileNames: 'mumo.[name].js',
        assetFileNames: 'mumo.[name][extname]',
      },
    },
  },
})
