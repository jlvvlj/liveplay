// Loads every factory preset in the built engine and writes the exposed
// parameters' values for each, where they differ from the defaults (the init
// patch): { "<preset id>": { "<param key>": value } }. The worklet lists them
// as each preset's `params` in its ready message.
//
//   node preset-values.mjs <dist dir> <out.json>

import { writeFileSync } from 'node:fs';
import { startProcessor } from './worklet-host.mjs';

const [dist, out] = process.argv.slice(2);
if (!dist || !out) {
  console.error('usage: node preset-values.mjs <dist dir> <out.json>');
  process.exit(1);
}

const { processor, ready } = await startProcessor(dist);
const engine = processor.engine;
const round = (spec, v) => (spec.step >= 1 ? Math.round(v) : Math.round(v * 10000) / 10000);

const values = {};
for (const preset of ready.presets) {
  processor.port.deliver({ type: 'preset', id: preset.id });
  const params = {};
  ready.params.forEach((spec, i) => {
    const v = round(spec, engine._sxt_param_value(i));
    if (v !== round(spec, spec.default)) params[spec.key] = v;
  });
  values[preset.id] = params;
}
writeFileSync(out, JSON.stringify(values));
console.log(`preset values: ${ready.presets.length} presets`);
