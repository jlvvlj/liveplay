// Lists the free preset banks' presets for the port: every .vital file this
// engine's version can load (upstream refuses presets saved by a newer feature
// version: 1.5), each written to <dist>/presets/<id>.vital for the browser to
// fetch when it is played, and their table (id, name, tag) for the module.
// Files that are not JSON (one bank has a broken one) and presets that play
// nothing are refused too.
//
//   node tools/list-presets.mjs <banks dir> <presets.inc> <dist>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [banksDir, inc, dist] = process.argv.slice(2);

// Each bank: its folder under <banks dir>, the folder of its presets, its id prefix
export const BANKS = [
  { dir: 'jpriebe_qub1t-vital-presets', presets: 'Presets/vol1', prefix: 'qub1t-1' },
  { dir: 'jpriebe_qub1t-vital-presets', presets: 'Presets/vol2', prefix: 'qub1t-2' },
  { dir: 'nahush2321_Vitalium-presets', presets: 'Presets (1)', prefix: 'nahush' },
  { dir: 'Mxm40b_vital-presets', presets: '.', prefix: 'mxm40b' },
  { dir: 'abstractionmage_Vital-Presets', presets: 'Presets', prefix: 'abstractionmage' },
  { dir: 'christ-offer_vitalium-presets', presets: 'Presets', prefix: 'christ-offer' },
];

// Presets that play nothing (check.mjs holds a chord for 8 seconds): nahush's
// "rewrite" has its only oscillator at level 0, and "check23" turns its
// oscillators down with velocity, to nothing
const SILENT = new Set(['nahush2321_Vitalium-presets/Presets (1)/rewrite.vital', 'nahush2321_Vitalium-presets/Presets (1)/check23.vital']);

// The open-source Vital's version (shims/JuceHeader.h): presets of a newer
// major.minor are refused, as LoadSave::jsonToState does
const ENGINE_FEATURE = [1, 0];

const slug = (text) =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'preset';
const cString = (text) => JSON.stringify(text).replace(/\?/g, '\\?');

const tooNew = (version) => {
  const [major = 0, minor = 0] = String(version || '').split('.').map((part) => parseInt(part, 10) || 0);
  return major > ENGINE_FEATURE[0] || (major === ENGINE_FEATURE[0] && minor > ENGINE_FEATURE[1]);
};

const presets = [];
const refused = [];
const ids = new Set();
fs.rmSync(path.join(dist, 'presets'), { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'presets'), { recursive: true });
for (const bank of BANKS) {
  // Read from the bank's git checkout, not its folder: one bank has files
  // whose names differ only in case, which a case-insensitive file system
  // (macOS) keeps only one of
  const repository = path.join(banksDir, bank.dir);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { maxBuffer: 1 << 28 });
  const prefix = bank.presets === '.' ? '' : `${bank.presets}/`;
  const files = git('ls-tree', '--name-only', '-z', `HEAD:${bank.presets === '.' ? '' : bank.presets}`)
    .toString('utf8')
    .split('\0')
    .filter((file) => file.endsWith('.vital'))
    .sort((a, b) => a.localeCompare(b, 'en') || (a < b ? -1 : 1));
  for (const file of files) {
    if (SILENT.has(`${bank.dir}/${bank.presets}/${file}`)) {
      refused.push(`${bank.prefix}: ${file} (plays nothing)`);
      continue;
    }
    let data;
    try {
      data = JSON.parse(git('show', `HEAD:${prefix}${file}`).toString('utf8'));
    } catch {
      refused.push(`${bank.prefix}: ${file} (not a readable preset file)`);
      continue;
    }
    const name = (data.preset_name || path.basename(file, '.vital')).trim();
    if (tooNew(data.synth_version)) {
      refused.push(`${bank.prefix}: ${name} (saved by Vital ${data.synth_version})`);
      continue;
    }
    let id = `${bank.prefix}-${slug(path.basename(file, '.vital'))}`;
    for (let n = 2; ids.has(id); n++) id = `${bank.prefix}-${slug(path.basename(file, '.vital'))}-${n}`;
    ids.add(id);
    fs.writeFileSync(path.join(dist, 'presets', `${id}.vital`), JSON.stringify(data));
    presets.push({ id, name, tag: data.preset_style || '' });
  }
}
fs.writeFileSync(inc, presets.map((p) => `{ ${cString(p.id)}, ${cString(p.name)}, ${cString(p.tag)} },`).join('\n') + '\n');
console.log(`${presets.length} presets listed, ${refused.length} refused:`);
for (const line of refused) console.log(`  ${line}`);
