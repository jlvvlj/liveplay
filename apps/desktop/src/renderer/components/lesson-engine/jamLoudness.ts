// How loud a Jam sound is: the K-weighted level (ITU-R BS.1770, as in LUFS) of
// its first moments, where a played note is heard. Rendered sounds are brought
// to the level of the reference sounds, so every sound plays as loud.

// The reference sounds' typical level (the median over their notes), and how long a note is heard for
const JAM_SOUND_LOUDNESS = -18;
const HEARD_SECONDS = 0.4;
const MAX_PEAK = 0.95;

// One biquad pass (direct form I)
function biquad(input: Float32Array, b: number[], a: number[]): Float32Array {
  const out = new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = (b[0] * x + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2) / a[0];
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

// The K-weighting filter: a high shelf (+4 dB above about 1.7 kHz), then a high pass at 38 Hz
function kWeight(channel: Float32Array, sampleRate: number): Float32Array {
  const shelf = () => {
    const A = 10 ** (3.99984385397 / 40);
    const w = (2 * Math.PI * 1681.9744509555319) / sampleRate;
    const alpha = Math.sin(w) / (2 * 0.7071752369554193);
    const c = Math.cos(w);
    const s = 2 * Math.sqrt(A) * alpha;
    return {
      b: [A * (A + 1 + (A - 1) * c + s), -2 * A * (A - 1 + (A + 1) * c), A * (A + 1 + (A - 1) * c - s)],
      a: [A + 1 - (A - 1) * c + s, 2 * (A - 1 - (A + 1) * c), A + 1 - (A - 1) * c - s],
    };
  };
  const highPass = () => {
    const w = (2 * Math.PI * 38.13547087613982) / sampleRate;
    const alpha = Math.sin(w) / (2 * 0.5003270373253953);
    const c = Math.cos(w);
    return { b: [(1 + c) / 2, -(1 + c), (1 + c) / 2], a: [1 + alpha, -2 * c, 1 - alpha] };
  };
  const first = shelf();
  const second = highPass();
  return biquad(biquad(channel, first.b, first.a), second.b, second.a);
}

// A sound's loudness, LUFS-like, over its first moments
export function jamLoudness(channels: Float32Array[], sampleRate: number): number {
  const length = Math.min(channels[0].length, Math.round(HEARD_SECONDS * sampleRate));
  let sum = 0;
  for (const channel of channels) {
    const weighted = kWeight(channel.subarray(0, length), sampleRate);
    for (let i = 0; i < length; i++) sum += weighted[i] ** 2;
  }
  return -0.691 + 10 * Math.log10(sum / Math.max(1, length) + 1e-12);
}

// Scales a sound's notes (each as its channels) in place, together, to the
// reference sounds' level `offsetDb` up, judged by their median note; never
// past MAX_PEAK
export function matchJamLoudness(notes: Float32Array[][], sampleRate: number, offsetDb = 0): void {
  const levels = notes.map((channels) => jamLoudness(channels, sampleRate)).sort((a, b) => a - b);
  const median = levels[Math.floor(levels.length / 2)];
  let peak = 0;
  for (const channels of notes) for (const channel of channels) for (let i = 0; i < channel.length; i++) peak = Math.max(peak, Math.abs(channel[i]));
  const gain = Math.min(10 ** ((JAM_SOUND_LOUDNESS + offsetDb - median) / 20), peak > 0 ? MAX_PEAK / peak : 1);
  for (const channels of notes) for (const channel of channels) for (let i = 0; i < channel.length; i++) channel[i] *= gain;
}
