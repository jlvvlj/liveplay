import { encodeWav16 } from './jamTrackRender';

const SAMPLE_RATE = 44100;

// A recording (a URL) at `rate` times its speed, at its own pitch, as a WAV's blob URL
export async function stretchJamAudio(url: string, rate: number): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
  const decoder = new OfflineAudioContext(2, 1, SAMPLE_RATE);
  const audio = await decoder.decodeAudioData(await response.arrayBuffer());
  const channels = [0, audio.numberOfChannels > 1 ? 1 : 0].map((channel) => audio.getChannelData(channel).slice());
  const worker = new Worker(new URL('./jamStretch.worker.ts', import.meta.url), { type: 'module' });
  try {
    const stretched = await new Promise<Float32Array[]>((resolve, reject) => {
      worker.onmessage = ({ data }) => resolve(data);
      worker.onerror = (event) => reject(new Error(event.message));
      worker.postMessage({ channels, rate }, channels.map((channel) => channel.buffer));
    });
    return URL.createObjectURL(new Blob([encodeWav16(stretched, SAMPLE_RATE)], { type: 'audio/wav' }));
  } finally {
    worker.terminate();
  }
}
