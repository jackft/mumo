import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import wasm from 'vite-plugin-wasm'
import { resolve } from 'node:path'

// process.cwd() is the package root (packages/electron-mumo) when pnpm
// executes any script, so two levels up reaches the workspace root where all
// node_modules (including pnpm's virtual store) live.
const workspaceRoot = resolve(process.cwd(), '../..')

export default defineConfig({
  main: {
    // Only production dependencies are externalized — that is better-sqlite3,
    // the one native module. Workspace packages are devDependencies and get
    // bundled into the main process output along with their ESM-only deps.
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [svelte(), wasm()],
    worker: { format: 'es', plugins: () => [wasm()] },
    publicDir: resolve(process.cwd(), '../mumo/public'),
    optimizeDeps: {
      exclude: ['@ricky0123/vad-web', 'onnxruntime-web'],
    },
    server: {
      port: 5192,
      strictPort: true,
      fs: {
        allow: [workspaceRoot],
      },
    },
  },
})
