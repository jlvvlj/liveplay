// Converts Helm's factory patches (.helm JSON) into a compact C++ table for
// the port, applying the same version upgrades Helm's LoadSave::varToState
// does when it opens an older patch.
//
// node convert-presets.mjs <helm checkout> <out presets.inc> <out authors.json>

import fs from 'node:fs';
import path from 'node:path';

const [helmDir, outFile, authorsFile] = process.argv.slice(2);
if (!helmDir || !outFile || !authorsFile) {
  console.error('usage: node convert-presets.mjs <helm checkout> <out presets.inc> <out authors.json>');
  process.exit(2);
}

// The parameter list, in the order of ValueDetailsLookup::parameter_list
const common = fs.readFileSync(path.join(helmDir, 'src/common/helm_common.cpp'), 'utf8');
const list = common.slice(common.indexOf('parameter_list[] = {'));
const params = [];
const re = /\{\s*"(\w+)",\s*([-\d.e]+),\s*([-\d.e]+),\s*(\d+),\s*([-\d.e]+)/g;
for (let m; (m = re.exec(list)); ) params.push({ name: m[1], def: Number(m[5]) });
const paramIndex = new Map(params.map((p, i) => [p.name, i]));
if (params.length < 100) throw new Error(`only ${params.length} parameters found in helm_common.cpp`);

// Helm's compareVersionStrings: numeric, component by component
function compareVersions(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// A JUCE var read as a number: missing or non-numeric values are 0
const num = (s, key) => {
  const v = s[key];
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return 0;
};

function upgrade(state) {
  let version = state.synth_version || '0.4.1';
  let properties = state;
  if (compareVersions(version, '0.4.1') <= 0) properties = { settings: state };
  const s = { ...properties.settings };
  let modulations = (s.modulations || []).map((m) => ({ ...m }));
  delete s.modulations;

  if (compareVersions(version, '0.5.0') <= 0) {
    if ('osc_mix' in s) {
      const mix = num(s, 'osc_mix');
      s.osc_1_volume = Math.sqrt(1 - mix);
      s.osc_2_volume = Math.sqrt(mix);
      delete s.osc_mix;
    }
    const added = [];
    modulations = modulations.filter((m) => {
      if (m.destination !== 'osc_mix') return true;
      added.push({ source: m.source, destination: 'osc_1_volume', amount: -m.amount });
      added.push({ source: m.source, destination: 'osc_2_volume', amount: m.amount });
      return false;
    });
    modulations.push(...added);
  }

  if (compareVersions(version, '0.7.2') <= 0) {
    if (num(s, 'stutter_on')) {
      s.stutter_resample_sync = 0;
      s.stutter_sync = 0;
    }
  }

  if (compareVersions(version, '0.8.6') <= 0) {
    const voices1 = num(s, 'osc_1_unison_voices');
    const voices2 = num(s, 'osc_2_unison_voices');
    const old1 = num(s, 'osc_1_volume') ** 2;
    const old2 = num(s, 'osc_2_volume') ** 2;
    const ratio1 = (voices1 + 1) / 2;
    const ratio2 = (voices2 + 1) / 2;
    s.osc_1_volume = Math.sqrt(old1 * Math.sqrt(0.5 / ratio1));
    s.osc_2_volume = Math.sqrt(old2 * Math.sqrt(0.5 / ratio2));
    s.sub_volume = Math.sqrt(0.5) * num(s, 'sub_volume');

    if (compareVersions(version, '0.5.0') <= 0) {
      s.sub_octave = 1;
      s.cutoff = num(s, 'cutoff') - num(s, 'keytrack') * 12;
    }

    const filterType = num(s, 'filter_type');
    if (filterType >= 6) s.filter_on = 0;
    else if (filterType >= 3) {
      if (filterType >= 5) s.filter_shelf = 1;
      else if (filterType >= 4) s.filter_shelf = 2;
      else s.filter_shelf = 0;
      s.filter_on = 1;
      s.filter_style = 2;
    } else {
      if (filterType >= 2) s.filter_blend = 1;
      else if (filterType >= 1) s.filter_blend = 2;
      s.filter_on = 1;
      s.filter_style = 0;
    }

    s.distortion_on = 1;
    s.distortion_type = 0;
    s.distortion_mix = 1;
    const saturation = num(s, 'filter_saturation');
    if (filterType >= 6) s.distortion_drive = saturation;
    else {
      s.distortion_drive = saturation + 12;
      s.filter_drive = -12;
    }
    for (const m of modulations) if (m.destination === 'filter_saturation') m.destination = 'distortion_drive';

    let volume = num(s, 'volume');
    const delayWet = num(s, 'delay_dry_wet');
    if (num(s, 'delay_on') && delayWet !== 0 && delayWet !== 1) {
      const ratio = delayWet / (1 - delayWet);
      const newWet = 1 - 1 / (1 + ratio * ratio);
      s.delay_dry_wet = newWet;
      volume *= Math.sqrt(delayWet / Math.sqrt(newWet));
    }
    const reverbWet = num(s, 'reverb_dry_wet');
    if (num(s, 'reverb_on') && reverbWet !== 0 && reverbWet !== 1) {
      const ratio = reverbWet / (1 - reverbWet);
      const newWet = 1 - 1 / (1 + ratio * ratio);
      s.reverb_dry_wet = newWet;
      volume *= Math.sqrt(reverbWet / Math.sqrt(newWet));
    }
    s.volume = volume;
    s.beats_per_minute = num(s, 'beats_per_minute') / 60;
  }
  return { settings: s, modulations };
}

const root = path.join(helmDir, 'patches/Factory Presets');
const folders = fs
  .readdirSync(root)
  .filter((f) => fs.statSync(path.join(root, f)).isDirectory())
  .sort();
const presets = [];
for (const folder of folders) {
  const files = fs
    .readdirSync(path.join(root, folder))
    .filter((f) => f.endsWith('.helm'))
    .sort((a, b) => a.localeCompare(b));
  for (const file of files) {
    const state = JSON.parse(fs.readFileSync(path.join(root, folder, file), 'utf8'));
    const { settings, modulations } = upgrade(state);
    // Helm names a patch after its file and lists it under its folder
    const name = path.basename(file, '.helm');
    const values = [];
    for (const [key, value] of Object.entries(settings)) {
      const index = paramIndex.get(key);
      if (index === undefined || typeof value !== 'number' && typeof value !== 'boolean') continue;
      const v = Number(value);
      if (Math.fround(v) !== Math.fround(params[index].def)) values.push([index, v]);
    }
    const mods = modulations
      .filter((m) => typeof m.amount === 'number' && m.amount !== 0)
      .map((m) => [String(m.source), String(m.destination), m.amount]);
    presets.push({ id: `${folder}/${name}`, name, tag: folder, author: String(state.author || ''), values, mods });
  }
}

const ids = new Set();
for (const p of presets) {
  if (ids.has(p.id)) throw new Error(`duplicate preset id ${p.id}`);
  ids.add(p.id);
}

const strings = [];
const stringIndex = new Map();
const intern = (s) => {
  if (!stringIndex.has(s)) {
    stringIndex.set(s, strings.length);
    strings.push(s);
  }
  return stringIndex.get(s);
};
const cstr = (s) => JSON.stringify(s);
const fl = (v) => {
  const f = Math.fround(v);
  return Number.isInteger(f) ? `${f}.0f` : `${f}f`;
};

let out = '// Generated by convert-presets.mjs from Helm\'s factory patches. Do not edit.\n\n';
const allValues = [];
const allMods = [];
const defs = [];
for (const p of presets) {
  defs.push({ ...p, valueStart: allValues.length, modStart: allMods.length });
  allValues.push(...p.values);
  for (const [source, destination, amount] of p.mods) allMods.push([intern(source), intern(destination), amount]);
}
out += `static const char* const kHelmModNames[] = {\n${strings.map((s) => `  ${cstr(s)},`).join('\n')}\n};\n\n`;
out += `static const HelmPresetValue kHelmPresetValues[] = {\n${allValues.map(([i, v]) => `  {${i}, ${fl(v)}},`).join('\n')}\n};\n\n`;
out += `static const HelmPresetMod kHelmPresetMods[] = {\n${allMods.map(([s, d, a]) => `  {${s}, ${d}, ${fl(a)}},`).join('\n')}\n};\n\n`;
out += `static const HelmPresetDef kHelmPresets[] = {\n${defs
  .map(
    (p) =>
      `  {${cstr(p.id)}, ${cstr(p.name)}, ${cstr(p.tag)}, ${p.valueStart}, ${p.values.length}, ${p.modStart}, ${p.mods.length}},`
  )
  .join('\n')}\n};\n\n`;
out += `static const int kHelmParameterListSize = ${params.length};\n`;
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, out);

const authors = {};
for (const p of presets) authors[p.author || '(none)'] = (authors[p.author || '(none)'] || 0) + 1;
fs.writeFileSync(authorsFile, JSON.stringify({ count: presets.length, authors }, null, 2));
console.log(`${presets.length} presets, ${allValues.length} values, ${allMods.length} modulations`);
