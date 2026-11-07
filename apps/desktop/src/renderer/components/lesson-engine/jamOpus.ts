// An imported track's export as Opus in WebM, encoded in the browser
// (WebCodecs): about a tenth of its WAV, decodable by Web Audio again. The
// muxer is loaded only when a project is imported.

const SAMPLE_RATE = 48000; // Opus's own
const BITRATE = 128000;
const CHUNK_FRAMES = 4800;

export async function encodeOpusWebm(file: Blob): Promise<ArrayBuffer> {
  if (typeof AudioEncoder === 'undefined') throw new Error('This browser cannot encode audio (WebCodecs is missing).');
  const decoder = new OfflineAudioContext(2, 1, SAMPLE_RATE);
  const audio = await decoder.decodeAudioData(await file.arrayBuffer());
  const channels = Math.min(2, audio.numberOfChannels);

  const { ArrayBufferTarget, Muxer } = await import('webm-muxer');
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    audio: { codec: 'A_OPUS', sampleRate: SAMPLE_RATE, numberOfChannels: channels },
  });
  let failure: unknown = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (error) => {
      failure = error;
    },
  });
  encoder.configure({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: channels, bitrate: BITRATE });

  const data = Array.from({ length: channels }, (_, c) => audio.getChannelData(c));
  for (let start = 0; start < audio.length; start += CHUNK_FRAMES) {
    const frames = Math.min(CHUNK_FRAMES, audio.length - start);
    const planar = new Float32Array(frames * channels);
    data.forEach((channel, c) => planar.set(channel.subarray(start, start + frames), c * frames));
    const chunk = new AudioData({
      format: 'f32-planar',
      sampleRate: SAMPLE_RATE,
      numberOfFrames: frames,
      numberOfChannels: channels,
      timestamp: Math.round((start / SAMPLE_RATE) * 1e6),
      data: planar,
    });
    encoder.encode(chunk);
    chunk.close();
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  muxer.finalize();
  return muxer.target.buffer;
}
