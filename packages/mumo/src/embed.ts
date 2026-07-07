import type { DocumentJSON } from '@mumo/core'
import type { SnapPlugin } from '@mumo/timeline'
import type { SignalPlugin } from '@mumo/media-player'

export type { DocumentJSON }

/** Which collab transport(s) are available in this build. */
export type CollabCapability = 'none' | 'webrtc' | 'server' | 'both'

export interface CollabConfig {
  /** Which transport(s) to expose. Default: 'both' */
  capability?: CollabCapability
  /** Override the default WebSocket server URL. */
  serverUrl?: string
  /** Override the default WebRTC signaling server URL. */
  signalingUrl?: string
  /**
   * Show the email field in the collab identity prompt.
   * Set to false for public deployments where you don't want users sharing email.
   * Default: true
   */
  allowEmail?: boolean
}

export interface EmbedFeatures {
  /** Show the menu bar (File, Edit, Tier, …). Default: true */
  menuBar?: boolean
  /** Show the media player pane. Default: true */
  mediaPlayer?: boolean
  /** Show the timeline pane. Default: true */
  timeline?: boolean
  /** Show the pattern inspector panel. Default: true */
  inspector?: boolean
  /** Show Open and Import items in the File menu. Set false when the host manages files. Default: true */
  fileOpen?: boolean
}

/** A plugin passed via EmbedConfig.plugins. */
export type mumoPlugin =
  | ({ kind: 'signal' } & SignalPlugin)
  | ({ kind: 'snap'   } & SnapPlugin)

export interface EmbedConfig {
  /** URL for the app icon shown in the menu bar. Default: '/mumo.svg' */
  appIconUrl?: string
  /** Pre-loaded document to show on startup. */
  doc?: DocumentJSON
  /** Media URL to load on startup (playback only — no audio analysis in embed mode). */
  mediaUrl?: string

  /** Toggle UI sections. All default to true. */
  features?: EmbedFeatures

  /**
   * Plugins to register.
   * 'snap'   plugins extend timeline cursor snapping (main thread).
   * 'signal' plugins run in the media worker (audio analysis).
   */
  plugins?: mumoPlugin[]

  /**
   * URL of the mumo.worker.js file for media analysis (waveform, spectrogram).
   * Only needed if you want audio visualization alongside media playback.
   * Default: '/mumo.worker.js'  — override if serving from a subdirectory.
   * Example: './static/mumo.worker.js'
   */
  workerUrl?: string

  /** Collaboration configuration. */
  collab?: CollabConfig

  /**
   * Identity of the local user.
   * Used as the display name in collab awareness; email is stored locally only.
   * Both fields are optional — if omitted, a generic "User N" label is shown.
   */
  user?: { name?: string; email?: string }

  /**
   * Called on mount instead of showing an empty doc.
   * Return value is applied immediately.
   */
  onLoad?: () => Promise<{ doc: DocumentJSON; mediaUrl?: string }>

  /**
   * Called after the document is loaded. Receives the live annotation store, token store,
   * and an `addMark(fromWordId, toWordId)` helper that creates a PM annotation mark
   * spanning the given word IDs and returns the new markId (or null on failure).
   * Useful for seeding textlets with real marks in test harnesses.
   */
  onReady?: (
    store: import('@mumo/core').AnnotationStore,
    tokenStore: import('@mumo/core').TokenStore,
    addMark: (fromWordId: string, toWordId: string) => string | null,
  ) => void

  /**
   * If set, Save JSON routes here instead of triggering a browser download.
   */
  onSave?: (doc: DocumentJSON) => Promise<void>

  /**
   * Called after every store/document change once the app is loaded.
   */
  onChange?: (doc: DocumentJSON) => void
}

export interface mumoHandle {
  /** Replace the current document. */
  loadDoc(doc: DocumentJSON): void
  /** Load media from a URL (playback only). */
  loadMediaUrl(url: string): Promise<void>
  /** Return the current document as a plain object. */
  getDoc(): DocumentJSON
  /** Update the local user identity shown in collab awareness. */
  setUser(user: { name?: string; email?: string }): void
  /** Open the EAF import dialog with the provided XML content. */
  openEAF(xml: string): void
  /** Unmount the app and clean up. */
  destroy(): void
}
