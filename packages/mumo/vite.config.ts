import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import wasm from 'vite-plugin-wasm'
import { visualizer } from 'rollup-plugin-visualizer'

export default defineConfig({
  plugins: [
    process.env['ANALYZE'] && visualizer({ open: true, gzipSize: true, brotliSize: true }),
    svelte({
    onwarn(warning, defaultHandler) {
      // currentDoc is intentionally non-reactive (plain assignment for perf)
      if (warning.code === 'non_reactive_update' && warning.message?.includes('currentDoc')) return
      defaultHandler(warning)
    },
  }), wasm()],
  worker: {
    format: 'es',
    plugins: () => [wasm()],
    rollupOptions: {
      output: { format: 'es' },
    },
  },
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('prosemirror')) return 'vendor-pm'
          if (id.includes('/yjs/') || id.includes('y-websocket') || id.includes('y-protocols') || id.includes('lib0')) return 'vendor-yjs'
          if (id.includes('/d3') || id.includes('/d3-') || id.includes('internmap') || id.includes('delaunator') || id.includes('robust-predicates')) return 'vendor-d3'
          if (id.includes('tabulator')) return 'vendor-tabulator'
        },
      },
    },
  },
  optimizeDeps: {
    exclude: ['@ricky0123/vad-web', 'onnxruntime-web'],
  },
})
