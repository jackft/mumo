/// <reference lib="webworker" />
import { Input, UrlSource, AudioSampleSink, ALL_FORMATS } from 'mediabunny'
import type { WorkerRequest, WorkerResponse, SpectrogramSettings } from './types.js'
import type { SignalPlugin, SignalRun, AudioSegment, SignalPost } from './plugins/signal/SignalPlugin.js'
import { setSampleBuffer, spectrogramPlugin, specFrameParams } from './plugins/signal/spectrogram.js'
import { waveformPlugin } from './plugins/signal/waveform.js'
import { sileroVadPlugin, resegmentVad } from './plugins/signal/sileroVad.js'
import { pitchPlugin } from './plugins/signal/pitch.js'
import { SegmentProducer } from './segmenter.js'

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

// VAD (Silero/ONNX) and pitch each run as their own deferred decode pass, so the fast
// spectrogram/waveform appear first instead of being blocked by per-segment model inference.
const defaultPlugins: SignalPlugin[] = [waveformPlugin, spectrogramPlugin]
const _wasmPromise = loadWasm()

const post: SignalPost = (msg: WorkerResponse, transfer?: Transferable[]) => {
  self.postMessage(msg, transfer ?? [])
}

// Retained for reanalyze / reanalyzePitch (re-decode; no PCM is kept).
let _url: string | null = null
let _pluginSettings: Record<string, unknown> = {}
let _settings: SpectrogramSettings | null = null  // last spectrogram settings, reused for segment framing

const SEGMENT_SEC = 90  // ~1.5 min per segment

async function decodeAndAnalyze(
  url: string, settings: SpectrogramSettings, pluginSettings: Record<string, unknown>,
  trigger: 'analyze' | 'reanalyze', plugins: SignalPlugin[], postDecoded = true,
): Promise<void> {
  const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(url) })
  try {
    const at = await input.getPrimaryAudioTrack()
    // A video with no audio track is normal, not an error — just skip audio analysis; the video
    // still plays and its duration comes from the video renderer.
    if (!at) { console.log('[worker] no audio track — skipping audio analysis'); return }
    const durationSec = await at.computeDuration()
    const sink = new AudioSampleSink(at)
    const gen = sink.samples()
    const first = await gen.next()
    if (first.done) { console.log('[worker] no audio samples — skipping audio analysis'); return }

    const srcChannels = first.value.numberOfChannels
    const sampleRate  = first.value.sampleRate
    const mono = settings.monoMix && srcChannels > 1
    const channelCount = mono ? 1 : srcChannels
    // The pitch second pass (and pitch re-run) skip this: re-posting 'decoded' would re-fire the
    // primary state-change handler, which clears the first pass's spectrogram/waveform signals.
    if (postDecoded) post({ type: 'decoded', sampleRate, channelCount, duration: durationSec })

    const { hop, windowSize, tileFrames } = specFrameParams(settings, sampleRate)
    const totalSamples = Math.max(windowSize, Math.round(durationSec * sampleRate))
    const totalFrames  = Math.max(1, Math.floor((totalSamples - windowSize) / hop) + 1)
    const framesPerSeg = Math.round(SEGMENT_SEC * sampleRate / hop)
    const segFrames    = Math.max(tileFrames, Math.round(framesPerSeg / tileFrames) * tileFrames)

    const runs: SignalRun[] = plugins.map(p => p.createRun({ sampleRate, channelCount, durationSec, settings, pluginSettings, trigger }, post))
    const producer = new SegmentProducer(channelCount, hop, windowSize, segFrames, totalFrames)

    const pushSample = (s: import('mediabunny').AudioSample): void => {
      const frames = s.numberOfFrames
      const perCh: Float32Array[] = []
      if (mono) {
        const acc = new Float32Array(frames)
        const tmp = new Float32Array(frames)
        for (let ch = 0; ch < srcChannels; ch++) { s.copyTo(tmp, { planeIndex: ch, format: 'f32-planar' }); for (let i = 0; i < frames; i++) acc[i]! += tmp[i]! }
        for (let i = 0; i < frames; i++) acc[i]! /= srcChannels
        perCh.push(acc)
      } else {
        for (let ch = 0; ch < channelCount; ch++) { const arr = new Float32Array(frames); s.copyTo(arr, { planeIndex: ch, format: 'f32-planar' }); perCh.push(arr) }
      }
      producer.add(perCh, frames)
      s.close()
    }

    const drain = async (final: boolean): Promise<void> => {
      let seg: AudioSegment | null
      while ((seg = producer.tryCut(final)) !== null) for (const r of runs) await r.pushSegment(seg)
    }

    pushSample(first.value)
    await drain(false)
    for await (const s of gen) { pushSample(s); await drain(false) }
    await drain(true)
    for (const r of runs) await r.finish()
  } catch (err) {
    post({ type: 'error', message: String(err) })
  } finally {
    input.dispose()
  }
}

// Serialize message processing: chain each handler onto the previous so a reanalyze that
// arrives mid-analyze runs after it, not concurrently.
let _queue: Promise<void> = Promise.resolve()

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  _queue = _queue.then(() => handleMessage(e.data))
}

async function handleMessage(req: WorkerRequest): Promise<void> {
  await _wasmPromise

  if (req.type === 'analyze') {
    _url = req.url
    _pluginSettings = req.pluginSettings ?? {}
    _settings = req.settings
    await decodeAndAnalyze(req.url, req.settings, _pluginSettings, 'analyze', defaultPlugins)
    // Pitch is computed lazily (on demand) via reanalyzePitch — NOT on load.
  } else if (req.type === 'resegmentVad') {
    // Re-threshold the cached per-frame probs — no decode or model inference.
    resegmentVad(req.vadSettings, post)
  } else if (req.type === 'analyzeVad') {
    // Deferred VAD pass: re-decode and run only Silero VAD (waveform/spectrogram unchanged).
    if (!_url || !_settings) return
    const ps = { ..._pluginSettings, ...(req.pluginSettings ?? {}), __vadSettings: req.vadSettings }
    await decodeAndAnalyze(_url, _settings, ps, 'analyze', [sileroVadPlugin], false)
  } else if (req.type === 'reanalyzePitch') {
    // Re-decode and re-run only pitch with new settings (waveform/spectrogram/VAD unchanged).
    if (!_url || !_settings) return
    const ps = { ..._pluginSettings, ...(req.pluginSettings ?? {}), __pitch: req.pitchSettings }
    await decodeAndAnalyze(_url, _settings, ps, 'analyze', [pitchPlugin], false)
  } else {  // reanalyze — re-decode with new spectrogram settings (waveform/VAD are settings-independent)
    if (!_url) return
    await decodeAndAnalyze(_url, req.settings, _pluginSettings, 'reanalyze', [spectrogramPlugin])
  }
}
