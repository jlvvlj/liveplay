// Renders one second of a note through dist/surge-xt.worklet.js, run the way
// an AudioWorklet runs it, and fails on silence or NaN. Also checks note
// timing, a few parameters, that each preset's listed values are what loading
// it gives, and that process() never allocates.
//
//   node check.mjs [--preset "Category/Name"] [--all] [--wav out.wav]
//
// --all also plays a chord on every factory preset and checks each one sounds.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLE_RATE, measure, render as renderOnce, startProcessor } from './tools/worklet-host.mjs';

const dist = join(dirname(fileURLToPath(import.meta.url)), 'dist');
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

let failed = false;
let grewInProcess = false;
const fail = (message) => {
  console.error(`FAIL ${message}`);
  failed = true;
};
const render = (...a) => {
  const result = renderOnce(...a);
  grewInProcess ||= result.grew;
  return result;
};

const { scope, processor, ready, startMs } = await startProcessor(dist);
const engine = processor.engine;
console.log(`ready in ${startMs.toFixed(0)} ms: ${ready.params.length} params, ${ready.presets.length} presets`);
for (const p of ready.params) {
  for (const field of ['key', 'label', 'min', 'max', 'step', 'default']) {
    if (typeof p[field] !== (field === 'key' || field === 'label' ? 'string' : 'number')) {
      fail(`param ${p.key} has no ${field}`);
    }
  }
}
for (const p of ready.presets) {
  if (typeof p.id !== 'string' || typeof p.name !== 'string') fail(`preset without id or name`);
}

const preset = option('--preset');
if (preset) {
  if (!ready.presets.some((p) => p.id === preset)) fail(`no preset ${preset}`);
  processor.port.deliver({ type: 'preset', id: preset });
}

// One second: a note at 0.1 s (between two engine blocks), released at 0.7 s
const NOTE_FRAME = 4810;
const note = [
  [NOTE_FRAME, { type: 'noteOn', note: 60, velocity: 100 }],
  [33600, { type: 'noteOff', note: 60 }],
];
const out = render(scope, processor, 1, note);
const level = measure(out);
console.log(
  `${preset ?? 'Templates/Init Saw'}: peak ${level.peak.toFixed(3)}, rms ${level.rms.toFixed(4)}, ` +
    `rendered 1000 ms of audio in ${out.cpuMs.toFixed(0)} ms`
);
if (level.nan) fail('output has NaN or infinite samples');
if (level.peak < 1e-3) fail('output is silent');

// The note starts at the engine block edge nearest its time (Init Saw has no attack)
if (!preset) {
  const onset = out.left.findIndex((x) => Math.abs(x) > 1e-5);
  const block = processor.blockSize;
  console.log(`note at frame ${NOTE_FRAME}, first sound at frame ${onset} (engine blocks of ${block})`);
  if (Math.abs(onset - NOTE_FRAME) > block / 2) fail(`note started at frame ${onset}`);
}

if (option('--wav')) writeWav(option('--wav'), out);

if (!preset) {
  // A parameter change takes effect: the same note with the volume at its lowest
  processor.port.deliver({ type: 'allOff' });
  render(scope, processor, 0.5);
  processor.port.deliver({ type: 'param', key: 'volume', value: 0 });
  render(scope, processor, 0.1);
  const muted = measure(render(scope, processor, 0.6, note.map(([f, m]) => [f - NOTE_FRAME, m])));
  processor.port.deliver({ type: 'allOff' });
  console.log(`volume at its lowest: peak ${muted.peak.toFixed(4)}`);
  if (muted.peak > level.peak * 0.1) fail('the volume parameter has no effect');

  // Raising a muted oscillator's level unmutes it (Init Saw plays osc 1 only)
  const held = (n) => [[0, { type: 'noteOn', note: n, velocity: 100 }]];
  processor.port.deliver({ type: 'preset', id: 'Templates/Init Saw' });
  processor.port.deliver({ type: 'param', key: 'osc1_level', value: 0 });
  render(scope, processor, 0.1);
  const none = measure(render(scope, processor, 0.3, held(60)));
  processor.port.deliver({ type: 'allOff' });
  processor.port.deliver({ type: 'param', key: 'osc2_level', value: 0.8 });
  render(scope, processor, 0.3);
  const osc2 = measure(render(scope, processor, 0.3, held(62)));
  processor.port.deliver({ type: 'allOff' });
  console.log(`osc 1 down: peak ${none.peak.toFixed(4)}; osc 2 up: peak ${osc2.peak.toFixed(3)}`);
  if (none.peak > 0.01) fail('osc 1 level 0 still sounds');
  if (osc2.peak < 0.05) fail('raising osc 2 level does not unmute it');
}

// Each preset's listed values are the parameters loading it gives
const sample = args.includes('--all') ? ready.presets : ready.presets.filter((_, i) => i % 50 === 0);
let mismatches = 0;
for (const p of sample) {
  processor.port.deliver({ type: 'preset', id: p.id });
  ready.params.forEach((spec, i) => {
    const expected = p.params?.[spec.key] ?? spec.default;
    const got = engine._sxt_param_value(i);
    if (Math.abs(got - expected) > 1e-3) {
      mismatches++;
      if (mismatches <= 10) console.log(`  ${p.id} ${spec.key}: listed ${expected}, loaded ${got}`);
    }
  });
}
console.log(`preset values checked on ${sample.length} presets: ${mismatches} mismatches`);
if (mismatches) fail('preset parameter values differ from the loaded patches');

if (args.includes('--all')) {
  const quiet = [];
  const formula = [];
  let cpu = 0;
  for (const p of ready.presets) {
    processor.port.deliver({ type: 'allOff' });
    processor.port.deliver({ type: 'preset', id: p.id });
    if (engine._sxt_patch_uses_formula()) formula.push(p.id);
    const r = render(scope, processor, 1, [
      [0, { type: 'noteOn', note: 48, velocity: 110 }],
      [0, { type: 'noteOn', note: 60, velocity: 110 }],
      [0, { type: 'noteOn', note: 67, velocity: 110 }],
    ]);
    cpu = Math.max(cpu, r.cpuMs);
    const m = measure(r);
    if (m.nan) fail(`${p.id}: NaN`);
    if (m.peak < 1e-3) quiet.push(p.id);
  }
  console.log(
    `all ${ready.presets.length} presets: ${ready.presets.length - quiet.length} sound, ` +
      `slowest renders 1 s of a 3-note chord in ${cpu.toFixed(0)} ms`
  );
  if (quiet.length) fail(`silent with a held chord: ${quiet.join(', ')}`);
  if (formula.length) fail(`presets that route a formula modulator (no Lua in this build): ${formula.join(', ')}`);
}

console.log(`engine memory ${(engine.HEAPU8.length / 1048576).toFixed(0)} MB`);
if (grewInProcess) fail('the engine heap grew inside process()');
const allocations = engine._sxt_render_allocations();
console.log(`heap allocations inside process(): ${allocations}`);
if (allocations) fail('the engine allocated inside process()');

if (failed) process.exit(1);
console.log('OK');

function writeWav(path, { left, right }) {
  const n = left.length;
  const buffer = Buffer.alloc(44 + n * 4);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + n * 4, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(n * 4, 40);
  const s = (x) => Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
  for (let i = 0; i < n; i++) {
    buffer.writeInt16LE(s(left[i]), 44 + i * 4);
    buffer.writeInt16LE(s(right[i]), 46 + i * 4);
  }
  writeFileSync(path, buffer);
}
