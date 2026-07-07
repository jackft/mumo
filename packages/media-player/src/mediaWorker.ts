/// <reference lib="webworker" />
import type { WorkerRequest, WorkerResponse, SpectrogramSettings } from './types.js'
import type { SignalPlugin, AudioCtx, SignalPost } from './plugins/signal/SignalPlugin.js'
import { setSampleBuffer } from './plugins/signal/spectrogram.js'
import { waveformPlugin } from './plugins/signal/waveform.js'
import { spectrogramPlugin } from './plugins/signal/spectrogram.js'

async function loadWasm(): Promise<void> {
  try {
    // bundler-target wasm-pack output self-initializes on import; it has no
    // default init function (calling one was throwing and silently forcing
    // the JS fallback)
    const mod = await import('audio-analysis-wasm')
    setSampleBuffer(mod.SampleBuffer)
    console.log('[worker] Rust/WASM spectrogram loaded')
  } catch (e) {
    console.warn('[worker] WASM load failed, using JS fallback:', e)
  }
}

function mixChannels(channels: Float32Array[], settings: SpectrogramSettings): Float32Array[] {
  if (!settings.monoMix || channels.length <= 1) return channels
  const len = channels[0]!.length
  const mixed = new Float32Array(len)
  const n = channels.length
  for (let i = 0; i < len; i++) {
    let sum = 0
    for (const ch of channels) sum += ch[i]!
    mixed[i] = sum / n
  }
  return [mixed]
}

const defaultPlugins: SignalPlugin[] = [waveformPlugin, spectrogramPlugin]
const _wasmPromise = loadWasm()

const post: SignalPost = (msg: WorkerResponse, transfer?: Transferable[]) => {
  self.postMessage(msg, transfer ?? [])
}

// Accumulated state across streaming messages
let _chunks: Float32Array[][] = []   // per-channel chunk lists
let _sampleRate = 0
let _channelCount = 0
let _settings: SpectrogramSettings | null = null
let _pluginSettings: Record<string, unknown> = {}

// Stored after analysis for reanalyze
let _channels: Float32Array[] | null = null
let _duration = 0

// Serialize message processing: chain each handler onto the previous so they
// never interleave at await points (prevents double-analysis when reanalyze
// arrives while finalizeStream's VAD await is in progress).
let _queue: Promise<void> = Promise.resolve()

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  _queue = _queue.then(() => handleMessage(e.data))
}

async function handleMessage(req: WorkerRequest): Promise<void> {
  await _wasmPromise

  if (req.type === 'initStream') {
    _chunks = []
    _sampleRate = 0
    _channelCount = 0
    _settings = req.settings
    _pluginSettings = req.pluginSettings ?? {}

  } else if (req.type === 'chunk') {
    _sampleRate    = req.sampleRate
    _channelCount  = req.channelCount
    for (let ch = 0; ch < req.channelData.length; ch++) {
      if (!_chunks[ch]) _chunks[ch] = []
      _chunks[ch]!.push(req.channelData[ch]!)
    }

  } else if (req.type === 'finalizeStream') {
    if (!_settings) return
    try {
      _duration = req.duration

      // Concatenate per-channel chunks into flat arrays
      _channels = _chunks.map(chunks => {
        const total = chunks.reduce((n, c) => n + c.length, 0)
        const out = new Float32Array(total)
        let pos = 0
        for (const c of chunks) { out.set(c, pos); pos += c.length }
        return out
      })
      _chunks = []  // free chunk references

      post({ type: 'decoded', sampleRate: _sampleRate, channelCount: _channelCount, duration: _duration })

      const ctx: AudioCtx = {
        channels: mixChannels(_channels, _settings), sampleRate: _sampleRate, duration: _duration,
        channelCount: _channelCount, settings: _settings, pluginSettings: _pluginSettings,
        trigger: 'analyze',
      }
      for (const plugin of defaultPlugins) {
        await plugin.analyze(ctx, post)
      }
    } catch (err) {
      post({ type: 'error', message: String(err) })
    }

  } else {  // req.type === 'reanalyze'
    // Always update stored settings so that if reanalyze arrives before
    // finalizeStream, the initial analysis uses the latest settings.
    _settings = req.settings
    if (!_channels) return
    try {
      const ctx: AudioCtx = {
        channels: mixChannels(_channels, req.settings), sampleRate: _sampleRate, duration: _duration,
        channelCount: _channelCount, settings: req.settings, pluginSettings: _pluginSettings,
        trigger: 'reanalyze',
      }
      await spectrogramPlugin.analyze(ctx, post)
    } catch (err) {
      post({ type: 'error', message: String(err) })
    }
  }
}
