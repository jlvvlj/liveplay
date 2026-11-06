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

// Wavetable choosers: a factory wavetable changes the sound, "Patch's own" (0)
// gives the preset's sound back, with the oscillator's type and modulation
{
  const chooser = ready.params.find((p) => p.key === 'osc1_wavetable');
  if (!chooser || chooser.options?.length !== chooser.max + 1 || chooser.options[0] !== "Patch's own") {
    fail('osc1_wavetable has no options list starting with "Patch\'s own"');
  }
  const triangle = chooser.options.indexOf('Basic/Triangle NES');
  if (triangle < 1) fail('no Basic/Triangle NES wavetable among the options');

  // The magnitude spectrum of a held note's last 4096 samples
  const spectrum = () => {
    const r = render(scope, processor, 0.6, [[0, { type: 'noteOn', note: 57, velocity: 100 }]]);
    processor.port.deliver({ type: 'allOff' });
    render(scope, processor, 0.5);
    const m = measure(r);
    const N = 4096;
    const x = r.left.subarray(r.left.length - N);
    const mags = new Float64Array(N / 8);
    for (let k = 0; k < mags.length; k++) {
      let re = 0;
      let im = 0;
      for (let n = 0; n < N; n++) {
        const w = x[n] * (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N));
        re += w * Math.cos((2 * Math.PI * k * n) / N);
        im -= w * Math.sin((2 * Math.PI * k * n) / N);
      }
      mags[k] = Math.hypot(re, im);
    }
    return { mags, ...m };
  };
  // 0 for the same spectrum, 1 for nothing in common
  const distance = (a, b) => {
    let d = 0;
    let t = 0;
    for (let k = 0; k < a.mags.length; k++) {
      d += Math.abs(a.mags[k] - b.mags[k]);
      t += a.mags[k] + b.mags[k];
    }
    return d / t;
  };
  const choose = (value) => processor.port.deliver({ type: 'param', key: 'osc1_wavetable', value });

  for (const id of ['Templates/Init Saw', 'Templates/Init Wavetable']) {
    processor.port.deliver({ type: 'preset', id });
    const type = engine._sxt_osc_type(0);
    const own = spectrum();
    choose(triangle);
    const table = spectrum();
    choose(0);
    const back = spectrum();
    const changed = distance(own, table);
    const restored = distance(own, back);
    console.log(`${id}: Basic/Triangle NES on osc 1 changes the sound by ${changed.toFixed(2)}, back to its own by ${restored.toFixed(3)}`);
    for (const [name, m] of [['own', own], ['wavetable', table], ['restored', back]]) {
      if (m.nan || m.peak < 1e-3) fail(`${id}, ${name}: silent or NaN`);
    }
    if (changed < 0.1) fail(`${id}: choosing a wavetable does not change the sound`);
    if (restored > 0.05) fail(`${id}: choosing "Patch's own" does not give its sound back`);
    if (engine._sxt_osc_type(0) !== type) fail(`${id}: osc 1 type not restored`);
  }

  // A preset whose osc 1 is not a wavetable oscillator and has modulation on its settings
  const modulated = ready.presets.find((p) => {
    processor.port.deliver({ type: 'preset', id: p.id });
    const type = engine._sxt_osc_type(0);
    return type !== 2 && type !== 7 && engine._sxt_osc_routings(0) > 1;
  });
  if (!modulated) fail('no preset with modulation on a non-wavetable osc 1');
  else {
    processor.port.deliver({ type: 'preset', id: modulated.id });
    const type = engine._sxt_osc_type(0);
    const routings = engine._sxt_osc_routings(0);
    choose(triangle);
    const kept = engine._sxt_osc_routings(0);
    const table = measure(render(scope, processor, 0.5, [[0, { type: 'noteOn', note: 60, velocity: 100 }]]));
    processor.port.deliver({ type: 'allOff' });
    choose(0);
    const back = measure(render(scope, processor, 0.5, [[0, { type: 'noteOn', note: 60, velocity: 100 }]]));
    processor.port.deliver({ type: 'allOff' });
    console.log(
      `${modulated.id}: ${routings} modulations on osc 1, ${kept} kept on the wavetable, ` +
        `${engine._sxt_osc_routings(0)} after "Patch's own"`
    );
    if (table.nan || table.peak < 1e-3 || back.nan || back.peak < 1e-3) fail(`${modulated.id}: silent or NaN`);
    if (engine._sxt_osc_routings(0) !== routings) fail(`${modulated.id}: osc 1 modulation not restored`);
    if (engine._sxt_osc_type(0) !== type) fail(`${modulated.id}: osc 1 type not restored`);
  }
  processor.port.deliver({ type: 'preset', id: 'Templates/Init Saw' });
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
  let presetIndex = 0;
  let swaps = 0;
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

    // Every 10th preset: a wavetable on each oscillator, then each back to its own
    if (presetIndex++ % 10 === 0) {
      const tables = ready.params.find((q) => q.key === 'osc1_wavetable').max;
      for (const o of [1, 2, 3]) {
        const key = `osc${o}_wavetable`;
        processor.port.deliver({ type: 'param', key, value: 1 + ((presetIndex * 37 + o * 11) % tables) });
      }
      const swapped = measure(render(scope, processor, 0.5, [[0, { type: 'noteOn', note: 60, velocity: 110 }]]));
      processor.port.deliver({ type: 'allOff' });
      for (const o of [1, 2, 3]) processor.port.deliver({ type: 'param', key: `osc${o}_wavetable`, value: 0 });
      const back = measure(render(scope, processor, 0.5, [[0, { type: 'noteOn', note: 60, velocity: 110 }]]));
      if (swapped.nan || back.nan) fail(`${p.id}: NaN with wavetables chosen`);
      if (back.peak < 1e-3) fail(`${p.id}: silent after "Patch's own"`);
      swaps++;
    }
  }
  console.log(`wavetables swapped in and back on ${swaps} presets`);
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
