// Full entry: the ProseMirror-free kernel plus the PM schema and plugins.
// Standalone consumers that don't need the editor stack should import
// '@mumo/core/kernel' instead.
export * from './kernel.js'

export { schema } from './schema.js'
export type { ImageProvenance } from './schema.js'
// eslint-disable-next-line @typescript-eslint/no-deprecated -- docFromBlocks is the test-suite doc builder; re-exported until tests migrate
export { createControllerPlugin, createUttSyncPlugin, createEmptyDoc, docFromUtterances, docFromBlocks, controllerKey } from './controller.js'
export type { ControllerMeta } from './controller.js'
