// Stand-in for instrument-lab/engine/synth.mjs (a plain ES module Jest does
// not transform): same exports, silent output
export const DEFAULT_PATCH = {
  family: 'saw',
  brightness: 0.55,
  body: 0.3,
  odd: 0.5,
  fm: 1.5,
  ratio: 2,
  attack: 0.012,
  decay: 0.25,
  sustain: 0.65,
  release: 0.2,
  detune: 0,
  gain: 0.7,
};
export const PARAMS = {
  brightness: [0.03, 1],
  body: [0, 1],
  odd: [0, 1],
  fm: [0, 6],
  ratio: [1, 6],
  attack: [0.002, 1.5],
  decay: [0.03, 2],
  sustain: [0.02, 1],
  release: [0.02, 2],
  detune: [0, 25],
  gain: [0, 1.5],
};
export const FAMILIES = ['sine', 'triangle', 'saw', 'square', 'pulse', 'fm'];
export const renderNotes = (_patch: unknown, _notes: unknown, duration: number, sampleRate = 22050) =>
  new Float32Array(Math.ceil(duration * sampleRate));
export const encodeWav = (audio: Float32Array) => new ArrayBuffer(44 + audio.length * 2);
