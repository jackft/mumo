import type { SpectrogramTile, WaveformBins } from '@mumo/timeline'
import type { SpectrogramSettings, WorkerResponse, VadSegment } from './types.js'

export interface SignalCallbacks {
  onDecoded(sampleRate: number, channelCount: number, duration: number): void
  onWaveform(channelIndex: number, bins: WaveformBins): void
  onSpectrogramOverview(channelIndex: number, tile: SpectrogramTile): void
  onSpectrogramTile(channelIndex: number, tile: SpectrogramTile): void
  onOnsets(channelIndex: number, timestamps: Float32Array, strengths: Float32Array, bandTimestamps: Float32Array[], bandStrengths: Float32Array[]): void
  onVad(segments: VadSegment[]): void
  onProgress(done: number, total: number): void
  onError(message: string): void
  onCustom(pluginId: string, data: unknown): void
}

/**
 * Manages the signal analysis worker.
 * Audio decoding happens on the main thread (AudioBuffer requires the window context);
 * decoded chunks are streamed to the worker via feedChunk/endStream so the main thread
 * never accumulates the full PCM buffer.
 */
export class SignalBroker {
  private _worker: Worker | null = null

  constructor(
    private readonly _callbacks: SignalCallbacks,
    private readonly _workerUrl?: string,
  ) {}

  /** Start a new analysis for a new file. Terminates any previous worker. */
  startStream(settings: SpectrogramSettings, pluginSettings?: Record<string, unknown>): void {
    this._worker?.terminate()
    this._worker = this._createWorker()
    this._worker.postMessage({ type: 'initStream', settings, pluginSettings })
  }

  /** Send one decoded audio chunk. Buffers are transferred (zero-copy). */
  feedChunk(channelData: Float32Array[], sampleRate: number, channelCount: number): void {
    if (!this._worker) return
    this._worker.postMessage(
      { type: 'chunk', channelData, sampleRate, channelCount },
      channelData.map(c => c.buffer),
    )
  }

  /** Signal that all chunks have been sent and analysis should begin. */
  endStream(duration: number): void {
    this._worker?.postMessage({ type: 'finalizeStream', duration })
  }

  /** Re-run spectrogram analysis with new settings using the worker's stored audio. */
  reanalyze(settings: SpectrogramSettings): void {
    this._worker?.postMessage({ type: 'reanalyze', settings })
  }

  dispose(): void {
    this._worker?.terminate()
    this._worker = null
  }

  private _createWorker(): Worker {
    const w = this._workerUrl
      ? new Worker(new URL(this._workerUrl, location.href), { type: 'module' })
      : new Worker(new URL('./mediaWorker.ts', import.meta.url), { type: 'module' })
    this._attach(w)
    return w
  }

  private _attach(worker: Worker): void {
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      if (worker !== this._worker) return
      const msg = e.data
      switch (msg.type) {
        case 'decoded':
          this._callbacks.onDecoded(msg.sampleRate, msg.channelCount, msg.duration); break
        case 'waveform':
          this._callbacks.onWaveform(msg.channelIndex, msg.bins); break
        case 'spectrogramOverview':
          this._callbacks.onSpectrogramOverview(msg.channelIndex, msg.tile); break
        case 'spectrogramTile':
          this._callbacks.onSpectrogramTile(msg.channelIndex, msg.tile); break
        case 'onsets':
          this._callbacks.onOnsets(msg.channelIndex, msg.timestamps, msg.strengths, msg.bandTimestamps, msg.bandStrengths); break
        case 'vad':
          this._callbacks.onVad(msg.segments); break
        case 'progress':
          this._callbacks.onProgress(msg.done, msg.total); break
        case 'error':
          this._callbacks.onError(msg.message); break
        case 'custom':
          this._callbacks.onCustom(msg.pluginId, msg.data); break
      }
    }
  }
}
