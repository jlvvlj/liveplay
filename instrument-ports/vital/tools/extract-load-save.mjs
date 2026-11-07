// Takes Vital's preset loading functions out of upstream's load_save.cpp,
// unchanged, for the port to build without the rest of the file (which reads
// and writes files through JUCE)
//
//   node tools/extract-load-save.mjs <load_save.cpp> <out.cpp>
import fs from 'node:fs';

const [source, out] = process.argv.slice(2);
const FUNCTIONS = [
  'convertBufferToPcm',
  'convertPcmToFloatBuffer',
  'loadControls',
  'loadModulations',
  'loadSample',
  'loadWavetables',
  'loadLfos',
  'updateFromOldVersion',
  'compareFeatureVersionStrings',
  'compareVersionStrings',
];

const lines = fs.readFileSync(source, 'utf8').split('\n');
const parts = ['// Taken from Vital src/common/load_save.cpp by tools/extract-load-save.mjs', '#include "port_load_save.h"', ''];
for (const name of FUNCTIONS) {
  const start = lines.findIndex((line) => /^\S/.test(line) && line.includes(`LoadSave::${name}(`));
  if (start < 0) throw new Error(`load_save.cpp has no LoadSave::${name}`);
  // A definition ends at the first closing brace in the first column
  const end = lines.findIndex((line, i) => i > start && line === '}');
  if (end < 0) throw new Error(`LoadSave::${name} does not end`);
  parts.push(...lines.slice(start, end + 1), '');
}
fs.writeFileSync(out, parts.join('\n'));
