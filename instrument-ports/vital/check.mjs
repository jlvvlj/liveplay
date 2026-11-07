// Renders notes through dist/vital.worklet.js in Node, the way an AudioWorklet
// runs it. Each preset is read from its file by one instance and packed, the
// pack loaded by another (as the app's Worker and worklet do), and both play
// it. Fails when a preset does not load, its sound is silent or not finite,
// playing allocates, or the pack does not sound like the file. Prints how
// long loading and rendering take.
//
//   node check.mjs [--all] [--preset <id>] [--wav out.wav]

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(new URL(import.meta.url).pathname);
const dist = path.join(here, 'dist');
const args = process.argv.slice(2);
const option = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);

const SAMPLE_RATE = 48000;
const BLOCK = 128;
const failures = [];

class FakePort {
  constructor() {
    this.onmessage = null;
    this.sent = [];
  }
  postMessage(data) {
    this.sent.push(data);
  }
  send(data) {
    this.onmessage && this.onmessage({ data });
  }
  take(type) {
    const found = this.sent.findIndex((message) => message.type === type || message.type === 'error');
    return found >= 0 ? this.sent.splice(found, 1)[0] : null;
  }
}

const workletSource = fs.readFileSync(path.join(dist, 'vital.worklet.js'), 'utf8');
const wasmModule = new WebAssembly.Module(fs.readFileSync(path.join(dist, 'vital.wasm')));

// One worklet with its own clock, as in its own AudioWorkletGlobalScope
async function instance() {
  const clock = { frame: 0 };
  let Processor = null;
  const scope = vm.createContext({
    AudioWorkletProcessor: class {
      constructor() {
        this.port = new FakePort();
      }
    },
    registerProcessor: (_, cls) => {
      Processor = cls;
    },
    WebAssembly,
    BigInt,
    console,
    sampleRate: SAMPLE_RATE,
    get currentFrame() {
      return clock.frame;
    },
    get currentTime() {
      return clock.frame / SAMPLE_RATE;
    },
  });
  vm.runInContext(workletSource, scope);
  const processor = new Processor({ processorOptions: { wasm: wasmModule } });
  let ready = null;
  for (let i = 0; i < 200 && !ready; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    ready = processor.port.take('ready');
  }
  if (!ready || ready.type === 'error') throw new Error(`vital did not start: ${ready && ready.message}`);
  const render = (seconds, collect) => {
    for (let b = 0; b < Math.ceil((seconds * SAMPLE_RATE) / BLOCK); b++) {
      const outputs = [[new Float32Array(BLOCK), new Float32Array(BLOCK)]];
      processor.process([[]], outputs, {});
      if (collect) collect(outputs[0]);
      clock.frame += BLOCK;
    }
  };
  return { processor, ready, render, now: () => clock.frame / SAMPLE_RATE };
}

// A chord held for 0.8 s and released: its samples, loudness, whether it is
// finite, whether playing it allocated, and how long rendering it took
function play(player, label) {
  const { processor, render } = player;
  const wasm = processor.wasm;
  render(0.05);
  const allocations = wasm.mp_allocations();
  const start = performance.now();
  const at = player.now();
  for (const note of [48, 55, 60, 64]) processor.port.send({ type: 'noteOn', note, velocity: 100, time: at });
  let sum = 0;
  let count = 0;
  let finite = true;
  const samples = [];
  const collect = (channels) => {
    for (const channel of channels)
      for (const x of channel) {
        if (!Number.isFinite(x)) finite = false;
        sum += x * x;
        count++;
      }
    samples.push(Float32Array.from(channels[0]), Float32Array.from(channels[1]));
  };
  render(0.8, collect);
  for (const note of [48, 55, 60, 64]) processor.port.send({ type: 'noteOff', note, time: player.now() });
  render(0.6, collect);
  const elapsed = performance.now() - start;
  const allocated = wasm.mp_allocations() - allocations;
  processor.port.send({ type: 'allOff' });
  render(1.5);
  let db = 10 * Math.log10(sum / count + 1e-12);
  if (db < -90) {
    // A slow swell (the risers): the chord held for 8 seconds
    const at = player.now();
    for (const note of [48, 55, 60, 64]) processor.port.send({ type: 'noteOn', note, velocity: 100, time: at });
    let held = 0;
    let heldCount = 0;
    render(8, (channels) => {
      for (const channel of channels)
        for (const x of channel) {
          if (!Number.isFinite(x)) finite = false;
          held += x * x;
          heldCount++;
        }
    });
    processor.port.send({ type: 'allOff' });
    render(1.5);
    db = 10 * Math.log10(held / heldCount + 1e-12);
  }
  if (!finite) failures.push(`${label}: not finite`);
  else if (db < -90) failures.push(`${label}: silent (${db.toFixed(1)} dB over 8 seconds)`);
  if (allocated > 0) failures.push(`${label}: ${allocated} allocations while playing`);
  return { db, samples, realtime: elapsed / 1000 / 1.4 };
}

// Sends a preset (its file, or a pack) and waits for the answer
function load(player, id, bytes) {
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const start = performance.now();
  player.processor.port.send({ type: 'preset', id, data });
  const answer = player.processor.port.take('presetLoaded');
  const ms = performance.now() - start;
  if (!answer || answer.type === 'error') failures.push(`${id}: ${answer ? answer.message : 'no answer'}`);
  return ms;
}

// The loader reads each file and packs it (as vital.loader.js does in the
// app); the player loads the pack (as the app's worklet does). Both play the
// same chord, which must sound the same.
const loader = await instance();
const player = await instance();
const { ready } = player;
console.log(`ready: ${ready.params.length} parameters, ${ready.presets.length} presets`);

// The same history on both, so their random generators agree
play(loader, 'init');
const init = play(player, 'init');
console.log(`init: ${init.db.toFixed(1)} dB, rendering at ${(init.realtime * 100).toFixed(1)}% of real time`);

// A parameter takes effect: oscillator 1 (the init sound's only one) turned
// down to nothing, then back to where it was (on both, to keep their histories alike)
const level = player.ready.params.find((param) => param.key === 'osc_1_level');
let quiet = 0;
for (const instance of [loader, player]) {
  instance.processor.port.send({ type: 'param', key: 'osc_1_level', value: 0 });
  quiet = play(instance, 'osc_1_level at 0').db;
  instance.processor.port.send({ type: 'param', key: 'osc_1_level', value: level.default });
}
if (quiet > init.db - 40) failures.push(`osc_1_level at 0 left the init sound at ${quiet.toFixed(1)} dB`);
else console.log(`osc_1_level at 0: ${quiet.toFixed(1)} dB`);

const presets = option('--preset')
  ? ready.presets.filter((preset) => preset.id === option('--preset'))
  : args.includes('--all')
    ? ready.presets
    : ready.presets.filter((_, i) => i % 53 === 0);

const difference = (a, b) => {
  let error = 0;
  let total = 0;
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < a[i].length; j++) {
      error += (a[i][j] - b[i][j]) ** 2;
      total += a[i][j] ** 2;
    }
  return 10 * Math.log10(error / (total + 1e-20) + 1e-20);
};

let slowestRead = 0;
let slowestPack = 0;
let slowestRender = 0;
let largestPack = 0;
for (const preset of presets) {
  const file = fs.readFileSync(path.join(dist, 'presets', `${preset.id}.vital`));
  const read = load(loader, preset.id, file);
  const wasm = loader.processor.wasm;
  const packed = Buffer.from(new Uint8Array(wasm.memory.buffer, wasm.mp_pack_preset(), wasm.mp_pack_preset_size()));
  if (packed.length === 0) failures.push(`${preset.id}: not packed`);
  const fromFile = play(loader, `${preset.id} (file)`);
  const unpack = load(player, preset.id, packed);
  const fromPack = play(player, `${preset.id} (pack)`);
  const diff = difference(fromFile.samples, fromPack.samples);
  if (diff > -40) failures.push(`${preset.id}: the pack sounds different (${diff.toFixed(1)} dB)`);
  if (option('--wav')) writeWav(option('--wav'), fromPack.samples);
  slowestRead = Math.max(slowestRead, read);
  slowestPack = Math.max(slowestPack, unpack);
  slowestRender = Math.max(slowestRender, fromPack.realtime);
  largestPack = Math.max(largestPack, packed.length);
  console.log(
    `${preset.id.padEnd(36)} ${fromPack.db.toFixed(1).padStart(6)} dB  read ${read.toFixed(0).padStart(4)} ms  ` +
      `pack ${(packed.length / 1e6).toFixed(1).padStart(5)} MB, loaded in ${unpack.toFixed(1).padStart(5)} ms  ` +
      `render ${(fromPack.realtime * 100).toFixed(1).padStart(4)}%  pack vs file ${diff.toFixed(0)} dB`
  );
}
console.log(
  `${presets.length} presets; slowest read ${slowestRead.toFixed(0)} ms, slowest pack load ` +
    `${slowestPack.toFixed(1)} ms, largest pack ${(largestPack / 1e6).toFixed(1)} MB, slowest render ` +
    `${(slowestRender * 100).toFixed(1)}% of real time`
);

function writeWav(file, chunks) {
  const frames = chunks.reduce((n, c, i) => (i % 2 ? n : n + c.length), 0);
  const buffer = Buffer.alloc(44 + frames * 4);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + frames * 4, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(frames * 4, 40);
  let offset = 44;
  for (let i = 0; i < chunks.length; i += 2)
    for (let j = 0; j < chunks[i].length; j++) {
      for (const channel of [chunks[i], chunks[i + 1]]) {
        buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, channel[j])) * 32767), offset);
        offset += 2;
      }
    }
  fs.writeFileSync(file, buffer);
}

if (failures.length) {
  console.error(`FAILED:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('ok');
