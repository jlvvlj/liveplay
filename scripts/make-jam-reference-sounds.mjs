// Copies sample sets into the git-ignored audio folder as Jam tab reference
// sounds, and writes the list the app reads (samples/jam_reference/sounds.json).
// Each file is named <set>_<MIDI note>.<ext>, e.g. bells_45.m4a; every set
// becomes one sound in the sidebar's Reference group.
//
//   node scripts/make-jam-reference-sounds.mjs <source folder> [audio dir]
//
// Default audio dir: ./audio. Running it again replaces the list.
import fs from "node:fs";
import path from "node:path";

const AUDIO_EXTENSIONS = /\.(m4a|wav|mp3|ogg|aac|flac)$/i;
const FILE_PATTERN = /^(.+)_(\d{1,3})\.[a-z0-9]+$/i;

const [sourceArg, audioArg = "audio"] = process.argv.slice(2);
if (!sourceArg) {
  console.error("Usage: node scripts/make-jam-reference-sounds.mjs <source folder> [audio dir]");
  process.exit(1);
}
const sourceDir = path.resolve(sourceArg);
const referenceDir = path.join(path.resolve(audioArg), "samples", "jam_reference");

const sets = new Map();
for (const file of fs.readdirSync(sourceDir)) {
  if (!AUDIO_EXTENSIONS.test(file)) continue;
  const match = file.match(FILE_PATTERN);
  if (!match) continue;
  const [, id, note] = match;
  if (!sets.has(id)) sets.set(id, {});
  sets.get(id)[Number(note)] = file;
}
if (sets.size === 0) {
  console.error(`No <set>_<note> audio files found in ${sourceDir}`);
  process.exit(1);
}

const label = (id) => {
  const words = id.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const sounds = [...sets.keys()].sort().map((id) => {
  const setDir = path.join(referenceDir, id);
  fs.mkdirSync(setDir, { recursive: true });
  const samples = {};
  for (const [note, file] of Object.entries(sets.get(id)).sort((a, b) => a[0] - b[0])) {
    fs.copyFileSync(path.join(sourceDir, file), path.join(setDir, file));
    samples[note] = `samples/jam_reference/${id}/${file}`;
  }
  return { id: `reference:${id}`, label: label(id), samples };
});

fs.writeFileSync(path.join(referenceDir, "sounds.json"), JSON.stringify(sounds, null, 2) + "\n");
for (const sound of sounds)
  console.log(`${sound.label}: ${Object.keys(sound.samples).length} notes`);
console.log(`Wrote ${sounds.length} reference sounds to ${referenceDir}`);
