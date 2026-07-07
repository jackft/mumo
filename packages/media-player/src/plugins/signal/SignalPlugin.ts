import type { WorkerResponse, SpectrogramSettings } from '../../types.js'

export interface AudioCtx {
  channels: Float32Array[]
  sampleRate: number
  duration: number
  channelCount: number
  settings: SpectrogramSettings
  pluginSettings: Record<string, unknown>
  trigger: 'analyze' | 'reanalyze'
}

export type SignalPost = (msg: WorkerResponse, transfer?: Transferable[]) => void

export interface SignalPlugin {
  id: string
  analyze(ctx: AudioCtx, post: SignalPost): Promise<void>
}
