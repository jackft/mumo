import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/mumo/src/**', 'packages/editor/src/**'],
      reporter: ['text', 'html'],
    },
    // jsdom provides DOMParser (eaf-parse tests) and DOM APIs (editor tests);
    // node-only suites (core, server) run fine under it too
    environment: 'jsdom',
    include: ['packages/*/tests/**/*.test.ts'],
    // Suppress Node.js ExperimentalWarning spam (localStorage, WebSocket, etc.)
    // (top-level since Vitest 4; formerly poolOptions.forks.execArgv)
    execArgv: ['--no-warnings=ExperimentalWarning'],
  },
})
