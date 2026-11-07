// Writes the instrument ports' catalog for the app: each built port's
// parameters and presets, every preset with the values it sets (the ones
// other than the defaults), so the instruments panel can show a port and its
// presets before the port has loaded, and how loud a note of each preset is,
// so the app can bring it to its other instruments' level. Each worklet is run
// in Node the way an AudioWorklet runs it, as common/check.mjs does.
//
//   node instrument-ports/catalog.mjs <out dir>
//
// Copies each built port's files into <out dir>/<name>/ and writes
// <out dir>/catalog.json, each big file also gzipped beside it (.gz) for
// browsers that take it. Ports not built (no dist/) are left out.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';

const here = path.dirname(new URL(import.meta.url).pathname);
const out = process.argv[2];
if (!out) {
  console.error('usage: node instrument-ports/catalog.mjs <out dir>');
  process.exit(2);
}

// Each port: its folder's dist, the files the app loads, and how it is listed
const PORTS = [
  { name: 'surge-xt', dist: 'surge-xt/dist', label: 'Surge XT', data: 'surge-xt-data.bin' },
  { name: 'obxf', dist: 'obxf/dist', label: 'OB-Xf' },
  { name: 'dexed', dist: 'dexed/dist', label: 'Dexed' },
  { name: 'helm', dist: 'helm/dist', label: 'Helm' },
  { name: 'plaits', dist: 'mutable/dist', label: 'Plaits' },
  { name: 'braids', dist: 'mutable/dist', label: 'Braids' },
  { name: 'rings', dist: 'mutable/dist', label: 'Rings' },
  { name: 'elements', dist: 'mutable/dist', label: 'Elements' },
  { name: 'clouds', dist: 'mutable/dist', label: 'Clouds', effect: true },
];

const SAMPLE_RATE = 48000;
const BLOCK = 128;
// The scope's clock, moved on as blocks are rendered
const clock = { frame: 0 };

// A worklet's processor class, from its file run in a minimal AudioWorkletGlobalScope
function processorClass(file) {
  let registered = null;
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
    send(data) {
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
    registerProcessor: (_, cls) => {
      registered = cls;
    },
    WebAssembly,
    console,
    BigInt,
    sampleRate: SAMPLE_RATE,
    get currentFrame() {
      return clock.frame;
    },
    get currentTime() {
      return clock.frame / SAMPLE_RATE;
    },
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  if (!registered) throw new Error(`${file} registered no processor`);
  return registered;
}

const bytes = (file) => {
  const buffer = fs.readFileSync(file);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
};

// How loud a note is (dB RMS over its first 0.4 s): note 60 at velocity 100,
// after 50 ms for what the port was sent to take effect (Helm loads a preset
// at its next block)
function noteLoudness(processor) {
  for (let block = 0; block < Math.ceil((0.05 * SAMPLE_RATE) / BLOCK); block++) {
    processor.process([[]], [[new Float32Array(BLOCK), new Float32Array(BLOCK)]], {});
    clock.frame += BLOCK;
  }
  const start = clock.frame;
  processor.port.send({ type: 'noteOn', note: 60, velocity: 100, time: start / SAMPLE_RATE });
  let sum = 0;
  let count = 0;
  const blocks = Math.ceil((0.4 * SAMPLE_RATE) / BLOCK);
  for (let block = 0; block < blocks; block++) {
    const outputs = [[new Float32Array(BLOCK), new Float32Array(BLOCK)]];
    processor.process([[]], outputs, {});
    for (const channel of outputs[0]) for (const x of channel) sum += x * x;
    count += 2 * BLOCK;
    clock.frame += BLOCK;
  }
  processor.port.send({ type: 'allOff' });
  for (let block = 0; block < 40; block++) {
    processor.process([[]], [[new Float32Array(BLOCK), new Float32Array(BLOCK)]], {});
    clock.frame += BLOCK;
  }
  return 10 * Math.log10(sum / count + 1e-12);
}

const gzipBeside = (file) => {
  if (fs.statSync(file).size > 100_000) fs.writeFileSync(`${file}.gz`, zlib.gzipSync(fs.readFileSync(file), { level: 9 }));
};

const entries = [];
fs.mkdirSync(out, { recursive: true });
for (const port of PORTS) {
  const dist = path.join(here, port.dist);
  const files = [`${port.name}.worklet.js`, `${port.name}.wasm`, ...(port.data ? [port.data] : [])];
  if (!files.every((file) => fs.existsSync(path.join(dist, file)))) {
    console.log(`${port.label}: not built, left out`);
    continue;
  }
  const Processor = processorClass(path.join(dist, files[0]));
  const processor = new Processor({
    processorOptions: { wasm: bytes(path.join(dist, files[1])), ...(port.data ? { data: bytes(path.join(dist, port.data)) } : {}) },
  });
  const ready = await processor.port.next('ready');
  if (ready.type === 'error') throw new Error(`${port.label}: ${ready.message}`);
  const defaults = Object.fromEntries(ready.params.map((param) => [param.key, param.default]));
  const loudness = port.effect ? null : noteLoudness(processor);
  const presets = [];
  for (const preset of ready.presets) {
    processor.port.send({ type: 'preset', id: preset.id });
    let values = preset.params;
    if (!values) {
      // The values a preset sets, as the port reports them once it has loaded it
      const loaded = await processor.port.next('presetLoaded');
      if (loaded.type === 'error') throw new Error(`${port.label} preset ${preset.id}: ${loaded.message}`);
      values = Object.fromEntries(Object.entries(loaded.values).filter(([key, value]) => value !== defaults[key]));
    }
    presets.push({
      id: String(preset.id),
      raw: preset.id,
      name: preset.name,
      ...(preset.tag ? { tag: preset.tag } : {}),
      params: values,
      ...(port.effect ? {} : { loudness: Math.round(noteLoudness(processor) * 10) / 10 }),
    });
  }
  fs.mkdirSync(path.join(out, port.name), { recursive: true });
  for (const file of files) {
    fs.copyFileSync(path.join(dist, file), path.join(out, port.name, file));
    gzipBeside(path.join(out, port.name, file));
  }
  entries.push({
    name: port.name,
    label: port.label,
    effect: !!port.effect,
    files: { worklet: files[0], wasm: files[1], ...(port.data ? { data: port.data } : {}) },
    params: ready.params,
    presets,
    ...(loudness !== null ? { loudness: Math.round(loudness * 10) / 10 } : {}),
  });
  console.log(`${port.label}: ${ready.params.length} parameters, ${presets.length} presets${loudness !== null ? `, ${loudness.toFixed(1)} dB RMS` : ''}`);
}
fs.writeFileSync(path.join(out, 'catalog.json'), JSON.stringify({ ports: entries }));
gzipBeside(path.join(out, 'catalog.json'));
console.log(`catalog.json: ${entries.length} ports in ${out}`);
