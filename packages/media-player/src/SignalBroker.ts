import type { SpectrogramTile, WaveformBins } from '@mumo/timeline'
import type { SpectrogramSettings, WorkerResponse, VadSegment, VadSettings, PitchTrack, PitchSettings } from './types.js'

export interface SignalCallbacks {
  onDecoded(sampleRate: number, channelCount: number, duration: number): void
  onWaveform(channelIndex: number, bins: WaveformBins): void
  onSpectrogramOverview(channelIndex: number, tile: SpectrogramTile): void
  onSpectrogramTile(channelIndex: number, tile: SpectrogramTile): void
  onOnsets(channelIndex: number, timestamps: Float32Array, strengths: Float32Array, bandTimestamps: Float32Array[], bandStrengths: Float32Array[]): void
  onVad(segments: VadSegment[]): void
  onVadProgress(done: number, total: number): void
  onPitch(channelIndex: number, track: PitchTrack): void
  onPitchProgress(done: number, total: number): void
  onProgress(done: number, total: number): void
  onError(message: string): void
  onCustom(pluginId: string, data: unknown): void
}

/**
 * Manages the signal analysis worker.
 * The worker decodes the media file itself (via mediabunny over the `media://` protocol)
 * and analyzes it — all off the main thread, so a multi-minute whole-file scan never
 * competes with playback or UI rendering.
 */
export class SignalBroker {
  private _worker: Worker | null = null

  constructor(
    private readonly _callbacks: SignalCallbacks,
    private readonly _workerUrl?: string,
  ) {}

  /** Start decoding + analyzing a new file in the worker. Terminates any previous worker. */
  analyze(url: string, settings: SpectrogramSettings, pluginSettings?: Record<string, unknown>): void {
    this._worker?.terminate()
    this._worker = this._createWorker()
    // Resolve VAD asset URLs here (renderer): document.baseURI points at the app root — next to
    // which the public model + ort wasm are served — in dev, web, and packaged Electron alike.
    // The worker can't resolve these reliably itself (its import.meta.url is under assets/).
    this._worker.postMessage({ type: 'analyze', url, settings, pluginSettings: { ...pluginSettings, ...this._assets() } })
  }

  /** ONNX asset URLs (Silero + SwiftF0 models, ort wasm dir), resolved against document.baseURI —
   *  the app root next to which the public assets are served in dev, web, and packaged Electron. */
  private _assets(): Record<string, unknown> {
    const wasmBase = new URL('./', document.baseURI).href
    return {
      __vad: { modelUrl: new URL('silero_vad_legacy.onnx', document.baseURI).href, wasmBase },
      __pitchAssets: { modelUrl: new URL('swift-f0.onnx', document.baseURI).href, wasmBase },
    }
  }

  /** Re-run spectrogram analysis with new settings using the worker's stored audio. */
  reanalyze(settings: SpectrogramSettings): void {
    this._worker?.postMessage({ type: 'reanalyze', settings })
  }

  /** Re-derive VAD segments from the worker's cached per-frame probs with new settings (instant). */
  resegmentVad(vadSettings: VadSettings): void {
    this._worker?.postMessage({ type: 'resegmentVad', vadSettings })
  }

  /** Re-run pitch detection with new settings (re-decodes; backend/frequency/threshold changes). */
  reanalyzePitch(pitchSettings: PitchSettings): void {
    this._worker?.postMessage({ type: 'reanalyzePitch', pitchSettings, pluginSettings: this._assets() })
  }

  /** Compute VAD as a deferred pass (re-decodes) so it doesn't delay spectrogram/waveform. */
  analyzeVad(vadSettings: VadSettings): void {
    this._worker?.postMessage({ type: 'analyzeVad', vadSettings, pluginSettings: this._assets() })
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
        case 'vadProgress':
          this._callbacks.onVadProgress(msg.done, msg.total); break
        case 'pitch':
          this._callbacks.onPitch(msg.channelIndex, msg.track); break
        case 'pitchProgress':
          this._callbacks.onPitchProgress(msg.done, msg.total); break
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
