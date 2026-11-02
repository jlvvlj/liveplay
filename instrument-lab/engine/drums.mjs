// Editable hybrid one-shot engine shared by the server and browser workers.
// detail=1 retains the recovered example; detail=0 is synthesized percussion.
export const DRUM_PARAMS = {
  tune: [-24, 24],
  decay: [0.25, 3],
  transient: [0, 2],
  tone: [0, 2],
  noise: [0, 2],
  brightness: [0.15, 2],
  drive: [0, 1],
  gain: [0, 2],
  detail: [0, 1],
};
export const DRUM_LABELS = {
  tune: "Tune (semitones)",
  decay: "Decay length",
  transient: "Transient",
  tone: "Tonal body",
  noise: "Noise",
  brightness: "Brightness",
  drive: "Drive",
  gain: "Level",
  detail: "Recovered detail",
};
export function drumPatch(data = {}) {
  const patch = {
    engine: "drum",
    model: { ...data.model },
    chokeGroup:
      typeof data.chokeGroup === "string" ? data.chokeGroup.slice(0, 40) : "",
  };
  for (const [key, [min, max]] of Object.entries(DRUM_PARAMS))
    patch[key] = Math.max(
      min,
      Math.min(
        max,
        Number.isFinite(data[key])
          ? data[key]
          : ["tune", "drive"].includes(key)
            ? 0
            : 1,
      ),
    );
  const bounds = {
    frequency: [20, 18000, 120],
    phase: [-Math.PI, Math.PI, 0],
    sweep: [0, 8000, 80],
    sweepDecay: [0.001, 1, 0.018],
    toneDecay: [0.005, 3, 0.15],
    toneLevel: [0, 2, 0.2],
    noiseLevel: [0, 2, 0.1],
    noiseDecay: [0.005, 3, 0.1],
    pan: [0, 1, 0.5],
  };
  for (const [key, [min, max, fallback]] of Object.entries(bounds))
    patch.model[key] = Math.max(
      min,
      Math.min(
        max,
        Number.isFinite(data.model?.[key]) ? data.model[key] : fallback,
      ),
    );
  return patch;
}
export function decodeDrumWav(buffer) {
  const view = new DataView(buffer);
  const word = (o) => String.fromCharCode(...new Uint8Array(buffer, o, 4));
  if (word(0) !== "RIFF" || word(8) !== "WAVE")
    throw new Error("Invalid drum audio");
  let format, channels, sampleRate, bits, start, length;
  for (let offset = 12; offset + 8 <= view.byteLength; ) {
    const size = view.getUint32(offset + 4, true),
      tag = word(offset);
    if (offset + 8 + size > view.byteLength)
      throw new Error("Truncated drum audio");
    if (tag === "fmt ") {
      format = view.getUint16(offset + 8, true);
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bits = view.getUint16(offset + 22, true);
    }
    if (tag === "data") {
      start = offset + 8;
      length = size;
    }
    offset += 8 + size + (size % 2);
  }
  if (
    !start ||
    ![1, 2].includes(channels) ||
    !((format === 3 && bits === 32) || (format === 1 && bits === 16))
  )
    throw new Error("Unsupported drum audio");
  const output = Array.from(
    { length: channels },
    () => new Float32Array(length / (bits / 8) / channels),
  );
  for (let i = 0; i < output[0].length; i++)
    for (let c = 0; c < channels; c++) {
      const o = start + ((i * channels + c) * bits) / 8;
      output[c][i] =
        format === 3
          ? view.getFloat32(o, true)
          : view.getInt16(o, true) / 32768;
    }
  return { channels: output, sampleRate };
}
export function encodeStereoWav(channels, sampleRate = 44100) {
  const count = channels.length,
    length = channels[0].length;
  const buffer = new ArrayBuffer(44 + length * count * 4),
    v = new DataView(buffer);
  const text = (at, s) =>
    [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, buffer.byteLength - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 3, true);
  v.setUint16(22, count, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * count * 4, true);
  v.setUint16(32, count * 4, true);
  v.setUint16(34, 32, true);
  text(36, "data");
  v.setUint32(40, length * count * 4, true);
  for (let i = 0; i < length; i++)
    for (let c = 0; c < count; c++)
      v.setFloat32(44 + (i * count + c) * 4, channels[c][i], true);
  return buffer;
}
const interpolate = (x, p) => {
  const i = Math.floor(p),
    a = x[i] || 0;
  return a + ((x[i + 1] || 0) - a) * (p - i);
};
export function prepareDrum(data, asset, sampleRate = 44100) {
  const p = drumPatch(data),
    m = p.model,
    ratio = 2 ** (p.tune / 12),
    duration = Math.min(
      8,
      (Math.max(
        asset.channels[0].length / asset.sampleRate,
        m.toneDecay * 7,
        m.noiseDecay * 7,
      ) *
        Math.max(1, p.decay)) /
        ratio,
    );
  const channels = [
    new Float32Array(Math.ceil(duration * sampleRate)),
    new Float32Array(Math.ceil(duration * sampleRate)),
  ];
  let seed = 9127,
    lastNoise = 0,
    filtered = [0, 0];
  const pan = [
    Math.sqrt(1 - m.pan) * Math.SQRT2,
    Math.sqrt(m.pan) * Math.SQRT2,
  ];
  const cutoff = Math.min(sampleRate * 0.45, 18000 * p.brightness),
    alpha = 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate);
  for (let i = 0; i < channels[0].length; i++) {
    const t = (i / sampleRate) * ratio;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const white = seed / 2147483648 - 1;
    const noise = (white - lastNoise) * 0.7;
    lastNoise = white;
    const attack = Math.min(1, t / 0.0007),
      phase =
        2 *
        Math.PI *
        (m.frequency * t +
          m.sweep * m.sweepDecay * (1 - Math.exp(-t / m.sweepDecay)));
    const tone =
      Math.sin(phase + m.phase) *
      m.toneLevel *
      Math.exp(-t / m.toneDecay) *
      attack;
    const hiss = noise * m.noiseLevel * Math.exp(-t / m.noiseDecay) * attack;
    const envelope = Math.exp(
      Math.min(
        3,
        (-t / Math.max(0.025, m.toneDecay, m.noiseDecay)) * (1 / p.decay - 1),
      ),
    );
    const transient = 1 + (p.transient - 1) * Math.exp(-t / 0.012);
    for (let c = 0; c < 2; c++) {
      const recovered = interpolate(
        asset.channels[Math.min(c, asset.channels.length - 1)],
        t * asset.sampleRate,
      );
      let x =
        ((tone * p.tone + hiss * p.noise) * pan[c] +
          p.detail * (recovered - (tone + hiss) * pan[c])) *
        envelope *
        transient;
      filtered[c] += alpha * (x - filtered[c]);
      x =
        p.brightness < 1
          ? filtered[c]
          : x + (x - filtered[c]) * (p.brightness - 1);
      if (p.drive) x = Math.tanh(x * (1 + p.drive * 8)) / (1 + p.drive * 2);
      const fade = Math.min(1, (channels[c].length - i) / (sampleRate * 0.005));
      channels[c][i] = x * p.gain * fade;
    }
  }
  return channels;
}
export class DrumVoice {
  constructor(channels, velocity = 100) {
    this.channels = channels;
    this.gain = Math.max(0, Math.min(127, velocity)) / 127;
    this.position = 0;
    this.done = false;
    this.fade = null;
  }
  off() {} // MIDI release never truncates a one-shot.
  choke(samples = 128) {
    this.fade = samples;
    this.fadeLength = samples;
  }
  sample() {
    if (this.done) return [0, 0];
    const scale =
      this.gain *
      (this.fade === null ? 1 : Math.max(0, this.fade--) / this.fadeLength);
    const result = this.channels.map((c) => (c[this.position] || 0) * scale);
    this.position++;
    this.done = this.position >= this.channels[0].length || this.fade === 0;
    return result;
  }
}
export function renderDrums(
  parts,
  duration,
  sampleRate = 44100,
  {
    selectedId = null,
    start = 0,
    speed = 1,
    end = start + duration * speed,
  } = {},
) {
  const mix = [
    new Float32Array(Math.ceil(duration * sampleRate)),
    new Float32Array(Math.ceil(duration * sampleRate)),
  ];
  const prepared = new Map(
    parts.map((p) => [p.id, prepareDrum(p.patch, p.asset, sampleRate)]),
  );
  const events = parts
    .flatMap((part) =>
      part.notes.filter((n) => n.start < end).map((note) => ({ part, note })),
    )
    .sort((a, b) => a.note.start - b.note.start);
  for (let e = 0; e < events.length; e++) {
    const { part, note } = events[e];
    if (part.id === selectedId) continue;
    const sound = prepared.get(part.id),
      offset = Math.round(((note.start - start) / speed) * sampleRate),
      gain = note.velocity / 127;
    let length = sound[0].length;
    if (part.patch.chokeGroup) {
      const next = events
        .slice(e + 1)
        .find(
          (x) =>
            x.part.patch.chokeGroup === part.patch.chokeGroup &&
            x.note.start > note.start + 0.001,
        );
      if (next)
        length = Math.min(
          length,
          Math.round(((next.note.start - note.start) / speed) * sampleRate) +
            128,
        );
    }
    for (
      let i = Math.max(0, -offset);
      i < length && offset + i < mix[0].length;
      i++
    )
      for (let c = 0; c < 2; c++)
        mix[c][offset + i] +=
          sound[c][i] *
          gain *
          (length < sound[c].length ? Math.min(1, (length - i) / 128) : 1);
  }
  return mix;
}
