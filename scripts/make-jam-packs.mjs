// Makes the Jam tab's sound packs: recorded instruments and drum machines
// downloaded from their sources, and General MIDI instruments rendered from
// the GeneralUser GS soundfont with SpessaSynth. Every note is cut to a few
// seconds, mono, 44.1 kHz 16-bit, so a pack loads quickly in a room.
//
//   node scripts/make-jam-packs.mjs
//
// Instruments keep one recorded note every few semitones (each row plays the
// nearest one re-pitched); drum machines one sound per drum, the rows from the
// lowest up in kit order (kick, toms, snare, ... cymbals).
//
// Needs ffmpeg. Downloads are kept in node_modules/.cache/jam-packs.
//
// Writes lesson-engine/packs/<pack>/*.wav and lesson-engine/jamPacks.ts.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SoundBankLoader, SpessaSynthProcessor } from "spessasynth_core";

const repoRoot = path.resolve(import.meta.dirname, "..");
const engine = path.join(repoRoot, "apps/desktop/src/renderer/components/lesson-engine");
const packsDir = path.join(engine, "packs");
const cacheDir = path.join(repoRoot, "node_modules/.cache/jam-packs");
const SAMPLE_RATE = 44100;
const FADE_SECONDS = 0.15;
// Recorded notes kept: one every this many semitones, so no row is re-pitched by more than half of it
const NOTE_SPACING = 6;
const DRUM_SECONDS = 2;

// Sources
const TONEJS_INSTRUMENTS = "https://raw.githubusercontent.com/nbrosowsky/tonejs-instruments/master/samples";
const SALAMANDER = "https://tonejs.github.io/audio/salamander";
const JRHODES = "https://raw.githubusercontent.com/sfzinstruments/jlearman.jRhodes3d/master/jRhodes3d-mono";
const DRUM_MACHINES = "https://raw.githubusercontent.com/geikha/tidal-drum-machines/main/machines";
const GENERALUSER_GS = "https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/main/GeneralUser-GS.sf2";

// Salamander's notes in the Tone.js set: every minor third from A0 to C8
const SALAMANDER_NOTES = Array.from({ length: 30 }, (_, i) => 21 + 3 * i);

// Instruments: [id, label, where their notes come from, seconds kept, lowest and highest note]
const tonejs = (folder) => ({ kind: "tonejs", folder });
const gm = (program) => ({ kind: "gm", program });
const PACKS = [
  {
    id: "keys",
    name: "Keys",
    instruments: [
      ["grand-piano", "Grand piano", { kind: "salamander" }, 3, [33, 96]],
      ["rhodes", "Rhodes", { kind: "jrhodes" }, 3, [29, 96]],
      ["organ", "Organ", tonejs("organ"), 2],
      ["harmonium", "Harmonium", tonejs("harmonium"), 2],
      ["harp", "Harp", tonejs("harp"), 2.5],
      ["xylophone", "Xylophone", tonejs("xylophone"), 1.5],
    ],
  },
  {
    id: "orchestra",
    name: "Orchestra",
    instruments: [
      ["violin", "Violin", tonejs("violin"), 2],
      ["cello", "Cello", tonejs("cello"), 2],
      ["contrabass", "Double bass", tonejs("contrabass"), 2],
      ["flute", "Flute", tonejs("flute"), 2],
      ["clarinet", "Clarinet", tonejs("clarinet"), 2],
      ["bassoon", "Bassoon", tonejs("bassoon"), 2],
      ["trumpet", "Trumpet", tonejs("trumpet"), 2],
      ["french-horn", "French horn", tonejs("french-horn"), 2],
      ["trombone", "Trombone", tonejs("trombone"), 2],
      ["tuba", "Tuba", tonejs("tuba"), 2],
    ],
  },
  {
    id: "band",
    name: "Band",
    instruments: [
      ["acoustic-guitar", "Acoustic guitar", tonejs("guitar-acoustic"), 2.5],
      ["nylon-guitar", "Nylon guitar", tonejs("guitar-nylon"), 2.5],
      ["electric-guitar", "Electric guitar", tonejs("guitar-electric"), 2.5],
      ["electric-bass", "Electric bass", tonejs("bass-electric"), 2],
      ["saxophone", "Saxophone", tonejs("saxophone"), 2],
    ],
  },
  {
    id: "general-midi",
    name: "General MIDI",
    instruments: [
      ["strings", "Strings", gm(48), 2, [36, 84]],
      ["pizzicato", "Pizzicato", gm(45), 1.5, [36, 84]],
      ["choir", "Choir", gm(52), 2, [48, 84]],
      ["brass-section", "Brass section", gm(61), 2, [36, 84]],
      ["synth-brass", "Synth brass", gm(62), 2, [36, 84]],
      ["marimba", "Marimba", gm(12), 1.5, [36, 96]],
      ["accordion", "Accordion", gm(21), 2, [48, 84]],
      ["harmonica", "Harmonica", gm(22), 2, [48, 84]],
      ["pan-flute", "Pan flute", gm(75), 2, [48, 96]],
      ["sitar", "Sitar", gm(104), 2.5, [36, 84]],
      ["koto", "Koto", gm(107), 2, [36, 96]],
      ["steel-drums", "Steel drums", gm(114), 1.5, [48, 96]],
      ["synth-bass", "Synth bass", gm(38), 1.5, [24, 60]],
      ["polysynth", "Polysynth", gm(90), 2, [36, 84]],
      ["halo-pad", "Halo pad", gm(94), 2.5, [36, 84]],
    ],
  },
];
// Drum machines: [id, label, folder]
const MACHINES = [
  ["tr-808", "TR-808", "RolandTR808"],
  ["tr-909", "TR-909", "RolandTR909"],
  ["tr-707", "TR-707", "RolandTR707"],
  ["cr-78", "CR-78", "RolandCompurhythm78"],
  ["linndrum", "LinnDrum", "LinnDrum"],
  ["dmx", "DMX", "OberheimDMX"],
];
// A machine's drums, lowest row first, and their names
const DRUMS = [
  ["bd", "Kick"],
  ["lt", "Low tom"],
  ["mt", "Mid tom"],
  ["ht", "High tom"],
  ["sd", "Snare"],
  ["rim", "Rim"],
  ["cp", "Clap"],
  ["cb", "Cowbell"],
  ["sh", "Shaker"],
  ["tb", "Tambourine"],
  ["perc", "Perc"],
  ["hh", "Closed hat"],
  ["oh", "Open hat"],
  ["cr", "Crash"],
  ["rd", "Ride"],
];

const NOTE_NAMES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
// "Cs4" (or "C#4") -> 61
const midiOf = (name) => {
  const [, letter, sharp, octave] = /^([A-G])(s|#)?(-?\d)$/.exec(name);
  return 12 * (Number(octave) + 1) + NOTE_NAMES[letter] + (sharp ? 1 : 0);
};

// About one note every NOTE_SPACING semitones within `range`, from the lowest
// to the highest recorded one
function spaced(notes, range = [0, 127]) {
  const inRange = [...notes].sort((a, b) => a - b).filter((note) => note >= range[0] && note <= range[1]);
  const kept = [];
  for (const note of inRange) if (!kept.length || note - kept[kept.length - 1] >= NOTE_SPACING - 1) kept.push(note);
  const highest = inRange[inRange.length - 1];
  if (kept[kept.length - 1] !== highest) kept.push(highest);
  return kept;
}

async function download(url) {
  const cached = path.join(cacheDir, url.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9.-]+/g, "_"));
  if (!fs.existsSync(cached)) {
    const response = await fetch(url, process.env.GITHUB_TOKEN && url.includes("api.github.com") ? { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } } : {});
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cached, Buffer.from(await response.arrayBuffer()));
  }
  return cached;
}

// Every file in a GitHub repo's branch
async function repoFiles(repo, branch) {
  const tree = JSON.parse(fs.readFileSync(await download(`https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`), "utf8"));
  if (tree.truncated) throw new Error(`${repo}: file list truncated`);
  return tree.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path);
}

// A recorded file as the pack's note: from its first sound, `seconds` long, faded out, mono
function convert(input, output, seconds) {
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-i", input,
    "-af", `silenceremove=start_periods=1:start_threshold=-50dB,atrim=0:${seconds},afade=t=out:st=${Math.max(0, seconds - FADE_SECONDS)}:d=${FADE_SECONDS}`,
    "-ac", "1", "-ar", String(SAMPLE_RATE), "-c:a", "pcm_s16le", output,
  ]);
}

// A recorded instrument's notes: { root: MIDI note, url }
async function recordedNotes(source) {
  if (source.kind === "salamander")
    return SALAMANDER_NOTES.map((root) => {
      const name = ["C", "Cs", "D", "Ds", "E", "F", "Fs", "G", "Gs", "A", "As", "B"][root % 12] + (Math.floor(root / 12) - 1);
      return { root, url: `${SALAMANDER}/${name}.mp3` };
    });
  if (source.kind === "jrhodes") {
    // A_<MIDI note>__<name>_<velocity layer 1-5>.flac: the middle layer
    const files = (await repoFiles("sfzinstruments/jlearman.jRhodes3d", "master")).filter((file) => /^jRhodes3d-mono\/A_\d+__[^_]+_3\.flac$/.test(file));
    return files.map((file) => ({ root: Number(/A_(\d+)__/.exec(file)[1]), url: `${JRHODES}/${path.basename(file)}` }));
  }
  // Notes named like "Cs4.wav" (the folder's other takes, like "F2 v2.wav", are left out)
  const files = (await repoFiles("nbrosowsky/tonejs-instruments", "master")).filter((file) =>
    new RegExp(`^samples/${source.folder}/[A-G]s?\\d\\.wav$`).test(file)
  );
  return files.map((file) => ({ root: midiOf(path.basename(file, ".wav")), url: `${TONEJS_INSTRUMENTS}/${source.folder}/${path.basename(file)}` }));
}

// A 16-bit mono PCM WAV file
function encodeMonoWav(audio) {
  const view = new DataView(new ArrayBuffer(44 + audio.length * 2));
  const text = (at, value) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + audio.length * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, audio.length * 2, true);
  audio.forEach((x, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x)) * 32767, true));
  return Buffer.from(view.buffer);
}

// One synth with GeneralUser GS, made once and silenced between notes
let synth;
async function renderGm(program, root, seconds) {
  if (!synth) {
    synth = new SpessaSynthProcessor(SAMPLE_RATE, { effectsEnabled: false });
    synth.soundBankManager.addSoundBank(SoundBankLoader.fromArrayBuffer(fs.readFileSync(await download(GENERALUSER_GS)).buffer), "gu");
    await synth.ready;
  }
  synth.stopAll(true);
  synth.programChange(0, program);
  const length = Math.round(seconds * SAMPLE_RATE);
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const release = Math.round((seconds - 0.5) * SAMPLE_RATE);
  const quantum = 128;
  synth.noteOn(0, root, 100);
  for (let i = 0; i < length; i += quantum) {
    if (i <= release && release < i + quantum) synth.noteOff(0, root);
    synth.process(left, right, i, Math.min(quantum, length - i));
  }
  const mono = left.map((x, i) => (x + right[i]) / 2);
  const fade = Math.round(FADE_SECONDS * SAMPLE_RATE);
  for (let i = 0; i < fade; i++) mono[length - 1 - i] *= i / fade;
  return mono;
}

const sounds = [];
fs.rmSync(packsDir, { recursive: true, force: true });

for (const pack of PACKS) {
  const dir = path.join(packsDir, pack.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, label, source, seconds, range] of pack.instruments) {
    const sample = [];
    if (source.kind === "gm") {
      // Rendered notes, all at one gain so the instrument keeps its own balance across its range
      const roots = spaced(Array.from({ length: 128 }, (_, note) => note), range);
      const notes = [];
      for (const root of roots) notes.push(await renderGm(source.program, root, seconds));
      const peak = Math.max(...notes.flatMap((note) => note.reduce((max, x) => Math.max(max, Math.abs(x)), 0)));
      roots.forEach((root, n) => {
        const file = `${id}-${root}.wav`;
        fs.writeFileSync(path.join(dir, file), encodeMonoWav(notes[n].map((x) => (x * 0.9) / peak)));
        sample.push({ file: `packs/${pack.id}/${file}`, root });
      });
    } else {
      const available = await recordedNotes(source);
      const roots = spaced(available.map((note) => note.root), range);
      for (const root of roots) {
        const file = `${id}-${root}.wav`;
        convert(await download(available.find((note) => note.root === root).url), path.join(dir, file), seconds);
        sample.push({ file: `packs/${pack.id}/${file}`, root });
      }
    }
    sounds.push({ id: `${pack.id}:${id}`, label, pack: pack.name, sample });
    console.log(`${pack.name} / ${label}: ${sample.length} notes`);
  }
}

const machineFiles = await repoFiles("geikha/tidal-drum-machines", "main");
const machinesDir = path.join(packsDir, "drum-machines");
fs.mkdirSync(machinesDir, { recursive: true });
for (const [id, label, folder] of MACHINES) {
  const drums = [];
  for (const [type, name] of DRUMS) {
    // The first take of the drum
    const file = machineFiles.filter((candidate) => candidate.startsWith(`machines/${folder}/${folder.toLowerCase()}-${type}/`)).sort()[0];
    if (!file) continue;
    const out = `${id}-${type}.wav`;
    convert(await download(`${DRUM_MACHINES}/${file.slice("machines/".length)}`), path.join(machinesDir, out), DRUM_SECONDS);
    drums.push({ file: `packs/drum-machines/${out}`, name });
  }
  if (!drums.length) throw new Error(`${folder}: no drums found`);
  sounds.push({ id: `drum-machines:${id}`, label, pack: "Drum machines", sounds: drums });
  console.log(`Drum machines / ${label}: ${drums.length} drums`);
}

const entry = (sound) =>
  `  { id: ${JSON.stringify(sound.id)}, label: ${JSON.stringify(sound.label)}, pack: ${JSON.stringify(sound.pack)}, ` +
  ("sample" in sound
    ? `sample: [${sound.sample.map((note) => `{ file: ${JSON.stringify(note.file)}, root: ${note.root} }`).join(", ")}] },`
    : `sounds: [${sound.sounds.map((drum) => `{ file: ${JSON.stringify(drum.file)}, name: ${JSON.stringify(drum.name)} }`).join(", ")}] },`);
fs.writeFileSync(
  path.join(engine, "jamPacks.ts"),
  `// Generated by scripts/make-jam-packs.mjs; do not edit.
import type { JamSoundPreset } from './jamSynth';

// The sound packs, each listed under its name: recorded and General MIDI
// instruments (one recorded note every ${NOTE_SPACING} semitones), and drum machines (one sound per row)
export const JAM_PACK_SOUNDS: JamSoundPreset[] = [
${sounds.map(entry).join("\n")}
];
`
);
console.log(`${sounds.length} sounds written to ${path.relative(repoRoot, packsDir)}`);
