// A loop of recorded audio made slower or faster at its own pitch. Each attack
// (a drum, a plucked note) is copied as it is to exactly where the new tempo
// puts it, so hits stay on the grid and never double; what lies between attacks
// is drawn out or tightened by overlapping pieces of it (WSOLA), each chosen to
// continue the waveform of the one before.

const FRAME = 2048;
const HOP = FRAME / 2;
// How far from its place a piece may be taken, to line up with the one before
const SEARCH = 512;
const SEARCH_STEP = 4;
const ATTACK = 1024;
const ATTACK_FADE = 32;
// Attacks: the signal's energy jumping above its recent level, at most this often
const ONSET_BLOCK = 256;
const ONSET_RECENT_BLOCKS = 8;
const ONSET_JUMP = 2.5;
const ONSET_FLOOR = 1e-5;
const ONSET_MIN_GAP = 2205;

// Where the attacks are (sample positions), the loop's start always first
export function jamAudioOnsets(mono: Float32Array): number[] {
  const onsets = [0];
  const energy = new Float32Array(Math.floor(mono.length / ONSET_BLOCK));
  for (let block = 0; block < energy.length; block++) {
    let sum = 0;
    for (let i = 0; i < ONSET_BLOCK; i++) sum += mono[block * ONSET_BLOCK + i] ** 2;
    energy[block] = sum / ONSET_BLOCK;
  }
  for (let block = ONSET_RECENT_BLOCKS; block < energy.length; block++) {
    let recent = 0;
    for (let back = 1; back <= ONSET_RECENT_BLOCKS; back++) recent += energy[block - back];
    recent /= ONSET_RECENT_BLOCKS;
    if (energy[block] <= ONSET_FLOOR || energy[block] <= recent * ONSET_JUMP) continue;
    // To the sample: where the block first rises well above what came before
    const start = block * ONSET_BLOCK;
    const threshold = Math.sqrt(energy[block]) / 2;
    let at = start;
    while (at < start + ONSET_BLOCK - 1 && Math.abs(mono[at]) < threshold) at++;
    if (at - onsets[onsets.length - 1] >= ONSET_MIN_GAP) onsets.push(at);
  }
  return onsets;
}

// The offset within `SEARCH` of `at` whose audio best continues `target`, keeping within [min, max]
function bestOffset(mono: Float32Array, target: number, at: number, length: number, min: number, max: number): number {
  const score = (offset: number, step: number) => {
    let sum = 0;
    let power = 1e-9;
    for (let i = 0; i < length; i += step) {
      const sample = mono[at + offset + i];
      sum += mono[target + i] * sample;
      power += sample * sample;
    }
    return sum / Math.sqrt(power);
  };
  const best = (from: number, to: number, stride: number, step: number) => {
    let found = from;
    let top = -Infinity;
    for (let offset = from; offset <= to; offset += stride) {
      const value = score(offset, step);
      if (value > top) {
        top = value;
        found = offset;
      }
    }
    return found;
  };
  const low = Math.max(-SEARCH, min - at);
  const high = Math.min(SEARCH, max - at);
  const coarse = best(low, high, SEARCH_STEP, SEARCH_STEP);
  return best(Math.max(low, coarse - SEARCH_STEP), Math.min(high, coarse + SEARCH_STEP), 1, 1);
}

// `channels` at `rate` times their speed: their length over `rate`
export function stretchJamChannels(channels: Float32Array[], rate: number): Float32Array[] {
  const length = channels[0].length;
  const outLength = Math.round(length / rate);
  const mono = new Float32Array(length);
  for (const channel of channels) for (let i = 0; i < length; i++) mono[i] += channel[i] / channels.length;

  const out = channels.map(() => new Float32Array(outLength));
  const weight = new Float32Array(outLength);
  const add = (from: number, to: number, count: number, fade: (i: number) => number) => {
    for (let i = 0; i < count; i++) {
      const at = to + i;
      if (at < 0 || at >= outLength) continue;
      const w = fade(i);
      weight[at] += w;
      channels.forEach((channel, c) => {
        out[c][at] += channel[from + i] * w;
      });
    }
  };

  // Attacks too close for the new tempo to fit them whole are drawn out with what lies between
  const onsets = jamAudioOnsets(mono).filter((onset, index, all) => {
    const next = all[index + 1] ?? length;
    return index === 0 || ((next - onset) / rate >= ATTACK + HOP && next - onset >= ATTACK + HOP);
  });

  onsets.forEach((onset, index) => {
    const end = onsets[index + 1] ?? length;
    const outStart = Math.round(onset / rate);
    const outEnd = index + 1 < onsets.length ? Math.round(end / rate) : outLength;
    const attack = Math.min(ATTACK, Math.floor((end - onset) / 2), Math.floor((outEnd - outStart) / 2));
    const tail = Math.min(HOP, end - onset - attack, outEnd - outStart - attack);
    // The attack as it is, fading into what follows
    add(onset, outStart, attack + tail, (i) =>
      i < ATTACK_FADE ? (i + 1) / ATTACK_FADE : i < attack ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (i - attack)) / tail)
    );

    const inFrom = onset + attack;
    const outFrom = outStart + attack;
    const slope = (end - inFrom) / Math.max(1, outEnd - outFrom);
    const size = Math.min(FRAME, end - inFrom);
    if (size < 2) return;
    const half = size / 2;
    const hann = (i: number) => 0.5 - 0.5 * Math.cos((Math.PI * i) / half);
    const frame = (i: number) => (i < half ? hann(i) : hann(size - i));
    const lastIn = end - size;
    let previous = inFrom;
    let previousOut = outFrom;
    for (let at = outFrom; ; at += HOP) {
      // The last piece ends where the next attack begins, in the audio and the output
      const last = at + size >= outEnd;
      const to = last ? outEnd - size : at;
      let from = Math.min(lastIn, Math.round(inFrom + (to - outFrom) * slope));
      if (to > outFrom && !last) {
        const compare = Math.min(HOP, size);
        const target = Math.min(previous + (to - previousOut), length - compare);
        from += bestOffset(mono, target, from, compare, onset, lastIn);
      }
      if (last) from = lastIn;
      add(from, to, size, frame);
      previous = from;
      previousOut = to;
      if (last) break;
    }
  });

  // Overlaps in proportion, so the level stays what it was
  for (let i = 0; i < outLength; i++) {
    if (weight[i] > 1e-4) for (const channel of out) channel[i] /= weight[i];
  }
  return out;
}
