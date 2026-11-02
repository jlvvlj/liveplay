// Melodics Instrument Lab — shared offline / AudioWorklet synthesis, MIT.
// All patches are data. The same voice implementation renders analysis and live input.
export const VERSION = 1;
export const DEFAULT_PATCH = Object.freeze({
  family: "saw",
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
});
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
export const FAMILIES = ["sine", "triangle", "saw", "square", "pulse", "fm"];
export const hz = (pitch) => 440 * 2 ** ((pitch - 69) / 12);
export function patchData(input = {}) {
  const p = { ...DEFAULT_PATCH };
  p.family = FAMILIES.includes(input.family) ? input.family : p.family;
  for (const [key, [lo, hi]] of Object.entries(PARAMS)) {
    const value = Number(input[key] ?? p[key]);
    p[key] = Number.isFinite(value)
      ? Math.max(lo, Math.min(hi, value))
      : p[key];
  }
  return p;
}
const TABLE_SIZE = 2048;
// Analysis works at 22.05 kHz. Keep its spectral bandwidth at higher device
// rates too, so live playing cannot add harmonics absent from the fitted sound.
const ANALYSIS_BANDWIDTH = 22050 * 0.45;
export function harmonicAmplitudes(raw, maxHarmonic = 80) {
  const p = patchData(raw),
    a = new Float64Array(maxHarmonic);
  // Fourier coefficients for FM are estimated from the same periodic waveform.
  if (p.family === "fm") {
    const ratio = Math.round(p.ratio);
    for (let k = 1; k <= maxHarmonic; k++) {
      let sum = 0;
      for (let i = 0; i < 512; i++) {
        const phase = (2 * Math.PI * i) / 512;
        sum +=
          Math.sin(phase + p.fm * Math.sin(ratio * phase)) *
          Math.sin(k * phase);
      }
      a[k - 1] = (sum * 2) / 512;
    }
  } else
    for (let k = 1; k <= maxHarmonic; k++) {
      if (p.family === "sine") a[k - 1] = k === 1 ? 1 : 0;
      if (p.family === "saw") a[k - 1] = 1 / k;
      if (p.family === "square") a[k - 1] = (k % 2 ? 1 : 0) / k;
      if (p.family === "triangle")
        a[k - 1] = (k % 2 ? (-1) ** ((k - 1) / 2) : 0) / (k * k);
      if (p.family === "pulse")
        a[k - 1] = Math.sin(Math.PI * k * (0.12 + 0.32 * p.odd)) / k;
    }
  for (let k = 1; k <= maxHarmonic; k++) {
    const cutoff = 2 + 55 * p.brightness * p.brightness;
    a[k - 1] *= Math.exp(-(k - 1) / cutoff);
    if (k === 1) a[k - 1] += p.body;
  }
  const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0)) || 1;
  return Array.from(a, (x) => x / norm);
}
const tableCache = new Map();
export function makeTable(raw, pitch, sampleRate) {
  const p = patchData(raw),
    harmonics = Math.min(
      80,
      Math.floor(Math.min(sampleRate * 0.45, ANALYSIS_BANDWIDTH) / hz(pitch)),
    );
  const key = JSON.stringify([
    p.family,
    p.brightness,
    p.body,
    p.odd,
    p.fm,
    p.ratio,
    harmonics,
  ]);
  if (tableCache.has(key)) return tableCache.get(key);
  const table = new Float32Array(TABLE_SIZE + 1),
    a = harmonicAmplitudes(p, harmonics);
  for (let i = 0; i < TABLE_SIZE; i++) {
    let sum = 0;
    for (let k = 1; k <= a.length; k++)
      sum += a[k - 1] * Math.sin((2 * Math.PI * k * i) / TABLE_SIZE);
    table[i] = sum * 0.3;
  }
  table[TABLE_SIZE] = table[0];
  if (tableCache.size > 512) tableCache.clear();
  tableCache.set(key, table);
  return table;
}
export function envelope(p, time, gate = Infinity) {
  function held(t) {
    if (t < p.attack) return t / p.attack;
    return (
      p.sustain + (1 - p.sustain) * Math.exp((-4 * (t - p.attack)) / p.decay)
    );
  }
  return time <= gate
    ? held(time)
    : held(gate) * Math.exp((-6 * (time - gate)) / p.release);
}
export class Voice {
  constructor(
    patch,
    pitch,
    velocity = 100,
    sampleRate = 44100,
    gate = Infinity,
    table = null,
  ) {
    this.patch = patchData(patch);
    this.pitch = pitch;
    this.sr = sampleRate;
    this.table = table || makeTable(this.patch, pitch, sampleRate);
    this.step = (hz(pitch) / sampleRate) * TABLE_SIZE;
    this.phase = 0;
    this.phase2 = 0;
    this.age = 0;
    this.gate = gate;
    this.velocity = velocity / 127;
    this.done = false;
  }
  off() {
    this.gate = Math.min(this.gate, this.age / this.sr);
  }
  seek(samples) {
    this.age = Math.max(0, Math.floor(samples));
    this.phase = (this.age * this.step) % TABLE_SIZE;
    this.phase2 =
      (this.age * this.step * 2 ** (this.patch.detune / 1200)) % TABLE_SIZE;
    this.done = this.age / this.sr > this.gate + this.patch.release * 1.5;
  }
  sample() {
    const p = this.patch,
      t = this.age++ / this.sr;
    if (t > this.gate + p.release * 1.5) {
      this.done = true;
      return 0;
    }
    const read = (phase) => {
      const i = Math.floor(phase),
        f = phase - i;
      return this.table[i] * (1 - f) + this.table[i + 1] * f;
    };
    let value = read(this.phase);
    this.phase = (this.phase + this.step) % TABLE_SIZE;
    if (p.detune > 0) {
      value = (value + read(this.phase2)) * 0.5;
      this.phase2 =
        (this.phase2 + this.step * 2 ** (p.detune / 1200)) % TABLE_SIZE;
    }
    return value * envelope(p, t, this.gate) * this.velocity * p.gain;
  }
}
export function renderNotes(patch, notes, duration, sampleRate = 22050) {
  const audio = new Float32Array(Math.ceil(duration * sampleRate));
  for (const note of notes) {
    const voice = new Voice(
      patch,
      note.pitch,
      note.velocity ?? 100,
      sampleRate,
      Math.max(0.025, note.end - note.start),
    );
    const start = Math.round(note.start * sampleRate);
    if (start < 0) voice.seek(-start);
    for (let i = Math.max(0, start); i < audio.length && !voice.done; i++)
      audio[i] += voice.sample();
  }
  return audio;
}
export function encodeWav(audio, sampleRate = 22050) {
  const buffer = new ArrayBuffer(44 + audio.length * 2),
    v = new DataView(buffer);
  const text = (offset, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  v.setUint32(4, 36 + audio.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, audio.length * 2, true);
  audio.forEach((x, i) =>
    v.setInt16(
      44 + i * 2,
      Math.round(Math.max(-1, Math.min(1, x)) * 32767),
      true,
    ),
  );
  return buffer;
}
