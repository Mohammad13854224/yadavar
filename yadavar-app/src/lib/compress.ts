import { ArrayBufferTarget, Muxer } from 'webm-muxer'

/**
 * Big uncompressed sounds (WAV, what older versions stored every recording as: 5.8 MB a minute) turned into Opus in
 * WebM, the format new recordings use: about 0.7 MB a minute at 96 kb/s, which sounds the same for a voice. Everything
 * runs on the device (WebCodecs' own Opus encoder), quickly, not in real time. The file carries its length, so players
 * show the right duration and can jump.
 */

const RATE = 48000 // Opus works at 48 kHz
const BITRATE = 96_000

/** can this device encode Opus? (Android's WebView and desktop Chrome can) */
export async function canCompressSound(): Promise<boolean> {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return false
  try {
    const r = await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: RATE, numberOfChannels: 1, bitrate: BITRATE })
    return !!r.supported
  } catch {
    return false
  }
}

/** a sound file (WAV or anything the browser can decode) as Opus in WebM; null if it cannot be done */
export async function soundToOpus(input: Blob): Promise<Blob | null> {
  const ctx = new AudioContext({ sampleRate: RATE })
  let buf: AudioBuffer
  try {
    buf = await ctx.decodeAudioData(await input.arrayBuffer())
  } catch {
    return null
  } finally {
    void ctx.close()
  }
  const channels = Math.min(2, buf.numberOfChannels)
  const muxer = new Muxer({ target: new ArrayBufferTarget(), audio: { codec: 'A_OPUS', numberOfChannels: channels, sampleRate: RATE } })
  let failed: unknown = null
  const enc = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => (failed = e),
  })
  enc.configure({ codec: 'opus', sampleRate: RATE, numberOfChannels: channels, bitrate: BITRATE })
  // one second at a time, planar float samples
  const step = RATE
  for (let at = 0; at < buf.length; at += step) {
    const n = Math.min(step, buf.length - at)
    const data = new Float32Array(n * channels)
    for (let c = 0; c < channels; c++) data.set(buf.getChannelData(c).subarray(at, at + n), c * n)
    const frame = new AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfFrames: n, numberOfChannels: channels, timestamp: Math.round((at / RATE) * 1e6), data })
    enc.encode(frame)
    frame.close()
    if (failed) break
  }
  await enc.flush().catch((e) => (failed = e))
  enc.close()
  if (failed) return null
  muxer.finalize()
  return new Blob([muxer.target.buffer], { type: 'audio/webm;codecs=opus' })
}
