// Helm-specific checks on dist/helm.wasm, after the shared check:
// - every factory modulation routing resolves to a source and a destination
// - after each preset loads, playing (notes, chords, renders) allocates nothing
// - a note starts at its own sample
//
// node check-presets.mjs <dist dir>

import fs from 'node:fs';
import path from 'node:path';

const dist = process.argv[2];
const bytes = fs.readFileSync(path.join(dist, 'helm.wasm'));
let memory;
const view = () => new DataView(memory.buffer);
const { instance } = await WebAssembly.instantiate(bytes, {
  env: { emscripten_notify_memory_growth() {} },
  wasi_snapshot_preview1: {
    fd_close: () => 0,
    environ_sizes_get(count, size) {
      view().setUint32(count, 0, true);
      view().setUint32(size, 0, true);
      return 0;
    },
    environ_get: () => 0,
  },
});
const w = instance.exports;
memory = w.memory;
w._initialize();
const SR = 48000;
w.mp_init(SR);
const description = JSON.parse(
  Buffer.from(new Uint8Array(memory.buffer, w.mp_describe(), w.mp_describe_length())).toString('utf8')
);
const failures = [];

const unresolved = w.helm_unresolved_modulations();
if (unresolved) failures.push(`${unresolved} factory modulation routings do not resolve`);

const block = (n) => w.mp_render(0, n);
const out = () => new Float32Array(memory.buffer, w.mp_output(0), 128);

// Onset: a note 37 frames into a block, rendered as the worklet does
block(128);
block(37);
w.mp_note_on(60, 100);
block(91);
const first = out().subarray(37, 128).findIndex((v) => Math.abs(v) > 1e-6);
console.log(`  onset: first sound ${first} frame(s) after the note`);
if (first < 0 || first > 2) failures.push(`note starts ${first} frames late`);
w.mp_all_off();
for (let i = 0; i < 400; i++) block(128);

// Every switch turned on from the parameters, then played
description.params.forEach((p, i) => {
  if (p.options && p.options.length === 2) w.mp_set_param(i, 1);
});
{
  const before = w.mp_allocations();
  for (let i = 0; i < 40; i++) {
    if (i === 1) for (let n = 0; n < 6; n++) w.mp_note_on(48 + n * 4, 90);
    if (i === 20) w.mp_all_off();
    block(128);
  }
  const during = w.mp_allocations() - before;
  console.log(`  allocations while playing with every switch on: ${during || 'none'}`);
  if (during) failures.push(`playing with every switch on allocated ${during} times`);
}

let worst = 0;
let worstName = '';
for (let p = 0; p < description.presets.length; p++) {
  w.mp_load_preset(p);
  const before = w.mp_allocations();
  for (let i = 0; i < 40; i++) {
    if (i === 1) for (let n = 0; n < 6; n++) w.mp_note_on(48 + n * 4, 90);
    if (i === 20) for (let n = 0; n < 6; n++) w.mp_note_off(48 + n * 4);
    if (i === 25) w.mp_note_on(72, 127);
    block(i % 3 === 0 ? 128 : 64);
  }
  w.mp_all_off();
  for (let i = 0; i < 4; i++) block(128);
  const during = w.mp_allocations() - before;
  if (during > worst) {
    worst = during;
    worstName = description.presets[p].name;
  }
}
console.log(`  allocations while playing after a preset load: ${worst ? `${worst} (${worstName})` : 'none'}`);
if (worst) failures.push(`playing after loading "${worstName}" allocated ${worst} times`);

if (failures.length) {
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log('  ok');
