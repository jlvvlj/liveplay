// Packs Surge's factory patches and wavetables, and each preset's parameter
// values (tools/preset-values.mjs), into one file the worklet unpacks into its
// in-memory filesystem.
//
//   node pack-data.mjs <surge>/resources/data <preset-values.json> <out.bin>
//
// Layout (little endian): "SXTD", u32 version (1), u32 index length, the index
// as UTF-8 JSON ([[path, size], ...] in file order), then the files' bytes.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const DIRS = ['patches_factory', 'wavetables'];

const [root, presetValues, out] = process.argv.slice(2);
if (!root || !presetValues || !out) {
  console.error('usage: node pack-data.mjs <surge resources/data> <preset-values.json> <out.bin>');
  process.exit(1);
}

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

const files = DIRS.flatMap((dir) => walk(join(root, dir))).filter(
  (path) => /\.(fxp|wt|wav)$/i.test(path)
);
const blobs = [...files.map((path) => readFileSync(path)), readFileSync(presetValues)];
const names = [...files.map((path) => relative(root, path).split(sep).join('/')), 'preset-values.json'];
const index = names.map((name, i) => [name, blobs[i].length]);
const indexBytes = Buffer.from(JSON.stringify(index), 'utf8');

const header = Buffer.alloc(12);
header.write('SXTD', 0, 'ascii');
header.writeUInt32LE(1, 4);
header.writeUInt32LE(indexBytes.length, 8);
const bundle = Buffer.concat([header, indexBytes, ...blobs]);
writeFileSync(out, bundle);

const count = (dir) => index.filter(([path]) => path.startsWith(dir + '/')).length;
console.log(
  `surge-xt-data: ${count('patches_factory')} patches, ${count('wavetables')} wavetables, ` +
    `${(bundle.length / 1048576).toFixed(1)} MB`
);
