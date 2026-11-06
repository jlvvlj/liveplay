// Renders notes through a built worklet in Node, the way an AudioWorklet runs
// it, and fails when the sound is silent, not finite, or allocates while
// playing.
//
// node check.mjs <dist dir> <name> [--effect] [--note 60] [--presets 8|all] [--wav out.wav]

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const args = process.argv.slice(2);
const [dist, name] = args;
if (!dist || !name) {
  console.error('usage: node check.mjs <dist dir> <name> [--effect] [--note 60] [--presets 8|all] [--wav out.wav]');
  process.exit(2);
}
const option = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};
const isEffect = args.includes('--effect');
const note = Number(option('--note', 60));
const presetOption = option('--presets', '8');
const wavPath = option('--wav', null);

const SAMPLE_RATE = 48000;
const BLOCK = 128;
const failures = [];
const fail = (message) => failures.push(message);

// A minimal AudioWorkletGlobalScope
const scope = { sampleRate: SAMPLE_RATE, currentTime: 0, currentFrame: 0, registered: null };
class FakePort {
  constructor() {
    this.onmessage = null;
    this.sent = [];
    this.waiters = [];
  }
  postMessage(data) {
    this.sent.push(data);
    for (const waiter of this.waiters.splice(0)) waiter();
  }
  receive(data) {
    this.onmessage && this.onmessage({ data });
  }
  async next(type) {
    for (;;) {
      const found = this.sent.findIndex((m) => m.type === type || m.type === 'error');
      if (found >= 0) return this.sent.splice(found, 1)[0];
      await new Promise((resolve) => this.waiters.push(resolve));
    }
  }
}
class AudioWorkletProcessor {
  constructor() {
    this.port = new FakePort();
  }
}
const context = vm.createContext({
  AudioWorkletProcessor,
  registerProcessor: (processorName, cls) => {
    scope.registered = { processorName, cls };
  },
  WebAssembly,
  console,
  BigInt,
  get sampleRate() {
    return scope.sampleRate;
  },
  get currentTime() {
    return scope.currentTime;
  },
  get currentFrame() {
    return scope.currentFrame;
  },
});

const workletFile = path.join(dist, `${name}.worklet.js`);
const wasmFile = path.join(dist, `${name}.wasm`);
vm.runInContext(fs.readFileSync(workletFile, 'utf8'), context, { filename: workletFile });
if (!scope.registered) throw new Error('the worklet registered no processor');
if (scope.registered.processorName !== `melodics-${name}`) {
  fail(`processor is named ${scope.registered.processorName}, not melodics-${name}`);
}
const wasmBytes = fs.readFileSync(wasmFile);
const processor = new scope.registered.cls({ processorOptions: { wasm: wasmBytes.buffer.slice(0) } });
const ready = await processor.port.next('ready');
if (ready.type === 'error') {
  console.error(`${name}: ${ready.message}`);
  process.exit(1);
}

// Protocol shape
for (const p of ready.params) {
  for (const field of ['key', 'label', 'min', 'max', 'step', 'default']) {
    if (p[field] === undefined) fail(`param ${p.key} has no ${field}`);
  }
  if (!(p.min <= p.default && p.default <= p.max)) fail(`param ${p.key} default ${p.default} is outside ${p.min}..${p.max}`);
}
for (const p of ready.presets) if (p.id === undefined || !p.name) fail(`preset without id or name: ${JSON.stringify(p)}`);
if (new Set(ready.params.map((p) => p.key)).size !== ready.params.length) fail('parameter keys are not unique');
if (new Set(ready.presets.map((p) => String(p.id))).size !== ready.presets.length) fail('preset ids are not unique');

// Renders `seconds` of audio, sending each scheduled message before the block it falls in
let frame = 0;
function render(seconds, events = [], input = null) {
  const total = Math.round(seconds * SAMPLE_RATE);
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  const pending = events.slice();
  let cpu = 0;
  for (let at = 0; at < total; at += BLOCK) {
    const n = Math.min(BLOCK, total - at);
    scope.currentFrame = frame;
    scope.currentTime = frame / SAMPLE_RATE;
    // Messages arrive ahead of their time, as from the main thread
    while (pending.length && pending[0].send <= (at + BLOCK * 4) / SAMPLE_RATE) {
      const event = pending.shift().message;
      processor.port.receive({ ...event, time: event.time === undefined ? undefined : scope.currentTime - at / SAMPLE_RATE + event.time });
    }
    const out = [new Float32Array(n), new Float32Array(n)];
    let inputs = [[]];
    if (input) inputs = [[input[0].subarray(at, at + n), input[1].subarray(at, at + n)]];
    const started = process.hrtime.bigint();
    processor.process(inputs, [out]);
    cpu += Number(process.hrtime.bigint() - started);
    left.set(out[0], at);
    right.set(out[1], at);
    frame += n;
  }
  return { left, right, cpu: cpu / 1e9 };
}

function analyse(result) {
  let sum = 0;
  let peak = 0;
  let nonFinite = 0;
  let first = -1;
  for (const channel of [result.left, result.right]) {
    for (let i = 0; i < channel.length; i++) {
      const v = channel[i];
      if (!Number.isFinite(v)) {
        nonFinite++;
        continue;
      }
      sum += v * v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
      if (first < 0 && Math.abs(v) > 1e-5) first = i;
    }
  }
  const rms = Math.sqrt(sum / (result.left.length * 2));
  return { rms, peak, nonFinite, first };
}

const dB = (v) => (v > 0 ? (20 * Math.log10(v)).toFixed(1) : '-inf');

function sine(seconds) {
  const total = Math.round(seconds * SAMPLE_RATE);
  const l = new Float32Array(total);
  const r = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const t = i / SAMPLE_RATE;
    // A plucked two-note phrase, so time-based effects have something to work on
    const env = Math.exp(-4 * (t % 0.5));
    l[i] = 0.4 * env * Math.sin(2 * Math.PI * (t % 1 < 0.5 ? 220 : 330) * t);
    r[i] = l[i];
  }
  return [l, r];
}

const wasm = processor.wasm;
const allocationsBefore = () => (wasm.mp_allocations ? wasm.mp_allocations() : 0);
const memoryBefore = processor.memory.buffer.byteLength;

// Warm up one block: anything lazily prepared by the upstream code happens here
render(BLOCK / SAMPLE_RATE);
const allocStart = allocationsBefore();

// One second: a note at 10 ms held to 700 ms. The note starts 37 frames into a block.
const onsetTime = (BLOCK * 3 + 37) / SAMPLE_RATE;
const mainEvents = [
  { send: 0, message: { type: 'noteOn', note, velocity: 100, time: onsetTime } },
  { send: 0.6, message: { type: 'noteOff', note, time: 0.7 } },
];
const input = isEffect ? sine(1) : null;
const main = render(1, mainEvents, input);
const stats = analyse(main);
const allocDuring = allocationsBefore() - allocStart;

console.log(`${name}: ${ready.params.length} params, ${ready.presets.length} presets`);
console.log(
  `  default sound: rms ${dB(stats.rms)} dBFS, peak ${dB(stats.peak)} dBFS, first sound at frame ${stats.first}` +
    (isEffect ? '' : ` (note at frame ${BLOCK * 3 + 37} of the second)`) +
    `, ${(main.cpu * 1000).toFixed(1)} ms of CPU for 1 s (${(1 / main.cpu).toFixed(0)}x realtime)`
);
if (stats.nonFinite) fail(`default sound has ${stats.nonFinite} non-finite samples`);
if (stats.rms < 1e-4) fail(`default sound is silent (rms ${dB(stats.rms)} dBFS)`);
if (!isEffect && stats.first >= 0 && stats.first < BLOCK * 3 + 37 - 1) {
  console.log(`  note: sound before the note's onset (frame ${stats.first}); the synth makes sound at rest`);
}
if (allocDuring) fail(`${allocDuring} allocations while playing`);

if (wavPath) {
  const data = Buffer.alloc(44 + main.left.length * 4);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + main.left.length * 4, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(2, 22);
  data.writeUInt32LE(SAMPLE_RATE, 24);
  data.writeUInt32LE(SAMPLE_RATE * 4, 28);
  data.writeUInt16LE(4, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(main.left.length * 4, 40);
  for (let i = 0; i < main.left.length; i++) {
    const s = (v) => Math.max(-32768, Math.min(32767, Math.round((Number.isFinite(v) ? v : 0) * 32767)));
    data.writeInt16LE(s(main.left[i]), 44 + i * 4);
    data.writeInt16LE(s(main.right[i]), 46 + i * 4);
  }
  fs.writeFileSync(wavPath, data);
}

// Chords, voice stealing and every parameter at its extremes
if (!isEffect) {
  const chord = [];
  for (let i = 0; i < 24; i++) {
    chord.push({ send: 0, message: { type: 'noteOn', note: 48 + i, velocity: 40 + i * 3, time: 0.001 * i } });
  }
  chord.push({ send: 0.2, message: { type: 'noteOff', note: 50, time: 0.3 } });
  chord.push({ send: 0.3, message: { type: 'allOff' } });
  const stolen = analyse(render(0.5, chord));
  if (stolen.nonFinite) fail(`24 notes at once: ${stolen.nonFinite} non-finite samples`);
  console.log(`  24 notes at once: peak ${dB(stolen.peak)} dBFS`);
  render(0.3);
}
for (const p of ready.params) {
  for (const value of [p.min, p.max, p.default]) processor.port.receive({ type: 'param', key: p.key, value });
}
const sweep = analyse(
  render(0.4, [{ send: 0, message: { type: 'noteOn', note, velocity: 100, time: 0.01 } }], isEffect ? sine(0.4) : null)
);
if (sweep.nonFinite) fail(`after every parameter's extremes: ${sweep.nonFinite} non-finite samples`);
processor.port.receive({ type: 'allOff' });
render(0.2);

// Presets: an even sample of them, or all
const presets = ready.presets;
const count = presetOption === 'all' ? presets.length : Math.min(presets.length, Number(presetOption));
const silent = [];
let checked = 0;
for (let k = 0; k < count; k++) {
  const preset = presets[count === presets.length ? k : Math.floor((k * presets.length) / count)];
  processor.port.receive({ type: 'preset', id: preset.id });
  const loaded = await processor.port.next('presetLoaded');
  if (loaded.type === 'error' || String(loaded.id) !== String(preset.id)) fail(`preset ${preset.id} was not loaded`);
  const result = analyse(
    render(
      0.8,
      [
        { send: 0, message: { type: 'noteOn', note, velocity: 100, time: 0.01 } },
        { send: 0.4, message: { type: 'noteOff', note, time: 0.5 } },
      ],
      isEffect ? sine(0.8) : null
    )
  );
  processor.port.receive({ type: 'allOff' });
  render(0.3, [], isEffect ? sine(0.3) : null);
  checked++;
  if (result.nonFinite) fail(`preset "${preset.name}": ${result.nonFinite} non-finite samples`);
  if (result.rms < 1e-4) silent.push(preset.name);
}
if (count) {
  console.log(`  presets: ${checked} played, ${checked - silent.length} sounding${silent.length ? `, silent at note ${note}: ${silent.join(', ')}` : ''}`);
  if (silent.length === checked) fail('every preset played is silent');
}

const allocTotal = allocationsBefore() - allocStart;
const presetAllocNote = count ? ' (preset loads included)' : '';
console.log(`  allocations after start: ${allocTotal}${presetAllocNote}; memory ${memoryBefore} -> ${processor.memory.buffer.byteLength} bytes`);

if (failures.length) {
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log('  ok');
