import { stretchJamChannels } from './jamStretch';

// Stretches recorded audio off the main thread (see jamStretchWorker.ts)
self.onmessage = ({ data: { channels, rate } }: MessageEvent<{ channels: Float32Array[]; rate: number }>) => {
  const stretched = stretchJamChannels(channels, rate);
  (self as unknown as Worker).postMessage(stretched, stretched.map((channel) => channel.buffer));
};
