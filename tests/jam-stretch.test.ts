import { jamAudioOnsets, stretchJamChannels } from '../apps/desktop/src/renderer/components/lesson-engine/jamStretch';

const SR = 44100;
const click = (a: Float32Array, at: number) => {
  for (let i = 0; i < 200; i++) a[at + i] += Math.exp(-i / 40) * Math.sin(i * 0.8);
};
const peakNear = (a: Float32Array, center: number, range: number) => {
  let peak = 0;
  let at = center;
  for (let i = Math.max(0, center - range); i < Math.min(a.length, center + range); i++) {
    if (Math.abs(a[i]) > peak) {
      peak = Math.abs(a[i]);
      at = i;
    }
  }
  return { peak, at };
};
const level = (a: Float32Array, from: number, to: number) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += a[i] ** 2;
  return Math.sqrt(sum / (to - from));
};

describe('stretchJamChannels', () => {
  it.each([0.25, 0.5, 0.75, 1.5, 2])('keeps its length over the rate and every attack on its new time, at rate %d', (rate) => {
    const period = SR / 2;
    const input = new Float32Array(SR * 8);
    for (let at = 0; at < input.length; at += period) click(input, at);
    const [out] = stretchJamChannels([input, input], rate);
    expect(out.length).toBe(Math.round(input.length / rate));
    const clickPeak = peakNear(input, 0, 200).at;
    for (let k = 0; k * period < input.length; k++) {
      const due = Math.round((k * period) / rate);
      const { peak, at } = peakNear(out, due + clickPeak, 2000);
      // Within 2 ms
      expect(Math.abs(at - due - clickPeak)).toBeLessThan(88);
      expect(peak).toBeGreaterThan(0.5);
    }
  });

  it('plays an attack once, not again in what is drawn out after it', () => {
    const input = new Float32Array(SR * 4);
    for (let at = 0; at < input.length; at += SR) click(input, at);
    const [out] = stretchJamChannels([input], 0.5);
    // Halfway to the next attack and beyond there is nothing
    expect(peakNear(out, SR, SR - 3000).peak).toBeLessThan(0.05);
  });

  it.each([0.25, 0.5, 1.5])('keeps a tone\'s pitch and level, with no dips, at rate %d', (rate) => {
    const input = new Float32Array(SR * 4);
    for (let i = 0; i < input.length; i++) input[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
    const [out] = stretchJamChannels([input, input], rate);
    let crossings = 0;
    for (let i = 0; i < out.length - 1; i++) if (out[i] <= 0 && out[i + 1] > 0) crossings++;
    expect(crossings / (out.length / SR)).toBeCloseTo(440, -1);
    for (let from = 0; from + 4096 < out.length; from += 4096) {
      expect(level(out, from, from + 4096)).toBeGreaterThan(0.25);
    }
  });

  it('keeps a tone with attacks in it whole around each attack', () => {
    const input = new Float32Array(SR * 4);
    for (let i = 0; i < input.length; i++) input[i] = 0.3 * Math.sin((2 * Math.PI * 110 * i) / SR);
    for (let at = SR / 2; at < input.length - 1000; at += SR / 2) click(input, at);
    const [out] = stretchJamChannels([input], 0.5);
    for (let from = 0; from + 2048 < out.length; from += 2048) {
      expect(level(out, from, from + 2048)).toBeGreaterThan(0.1);
    }
  });

  it('finds the attacks of a recording', () => {
    const input = new Float32Array(SR * 2);
    click(input, 11025);
    click(input, 44100);
    const onsets = jamAudioOnsets(input);
    expect(onsets[0]).toBe(0);
    expect(onsets.slice(1).map((at) => Math.round(at / 16))).toEqual([Math.round(11025 / 16), Math.round(44100 / 16)]);
  });
});
