// Makes the Jam tab's Softer Lesson backing track and sound from the Softer
// Ableton project folder (its Live Set and its tracks exported one by one with
// File > Export Audio/Video > All Individual Tracks, rendered from 1.1.1), with
// the app's own Ableton import: every track is read and turned into a lesson
// exactly as the Lessons tab does it (audio tracks' hits detected by the
// server's analysis, notes grouped into one key per chord, each note a slice of
// the export, sound lengths measured).
//
//   npx tsx scripts/make-softer-jam.mjs "<project folder>"
//
// The backing track is the song's last 8 bars: every track playing there is a
// grid row, its lesson's keys the row's lanes, on the nearest 16ths. Each lane
// sounds like one of its notes there: the one with the longest slice (its
// effects' tail), the loudest of those. The Softer sound is the song's first 16
// tracks, in order, each with its most played lane's sound.
//
// Softer Jam (scripts/make_softer_jam.py) is the first way Softer was made,
// kept to compare.
//
// Writes lesson-engine/softer/*.wav and lesson-engine/jamSofter.ts.
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import {
  abletonTrackToLesson,
  audioTrackFromAnalysis,
  lessonStartBeat,
  readAbletonProject,
  withSoundLengths,
} from "../apps/desktop/src/renderer/utils/abletonImport.ts";
import { analyzeAudio } from "../server/analyze-audio.ts";
import { decodeWav16 } from "../apps/desktop/src/renderer/components/lesson-engine/jamTrackRender.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const engine = path.join(repoRoot, "apps/desktop/src/renderer/components/lesson-engine");
const WINDOW = [256, 288]; // beats: bars 65 to 72, the second drop's last 8 bars
const STEPS = (WINDOW[1] - WINDOW[0]) * 4;
const LANES = 16; // rows of the Jam tab's highway
const TICKS_PER_BEAT = 480;
const SAMPLE_RATE = 44100;
const FADE_SECONDS = 0.01;

// What the import needs from the browser: an XML parser, and decoding the
// exports (16-bit WAVs) for the sound lengths
globalThis.DOMParser = new JSDOM().window.DOMParser;
const decoded = new Map();
const decode = async (file) => {
  if (!decoded.has(file)) decoded.set(file, decodeWav16(await file.arrayBuffer()));
  return decoded.get(file);
};
globalThis.OfflineAudioContext = class {
  async decodeAudioData(data) {
    const { channels, sampleRate } = decodeWav16(data);
    return { sampleRate, numberOfChannels: channels.length, length: channels[0].length, getChannelData: (c) => channels[c] };
  }
};

function readFolder(dir, prefix = "") {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return readFolder(full, `${prefix}${entry.name}/`);
    const { mtimeMs } = fs.statSync(full);
    return [{ path: prefix + entry.name, file: new File([fs.readFileSync(full)], entry.name, { lastModified: mtimeMs }) }];
  });
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function encodeWav16(channels) {
  const frames = channels[0].length;
  const buffer = Buffer.alloc(44 + frames * 4);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + frames * 4, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < 2; c++) {
      const x = Math.max(-1, Math.min(1, channels[Math.min(c, channels.length - 1)][i]));
      buffer.writeInt16LE(Math.round(x * 32767), 44 + i * 4 + c * 2);
    }
  return buffer;
}

// A step's slice of the export, fading out at its end
async function cut(file, slice) {
  const { channels } = await decode(file);
  const start = Math.round(slice.offset * SAMPLE_RATE);
  const end = Math.min(channels[0].length, start + Math.round(slice.duration * SAMPLE_RATE));
  const fade = Math.round(FADE_SECONDS * SAMPLE_RATE);
  return channels.map((channel) => {
    const out = channel.slice(start, end);
    for (let i = 0; i < Math.min(fade, out.length); i++) out[out.length - 1 - i] *= i / fade;
    return out;
  });
}

async function level(file, slice) {
  const { channels } = await decode(file);
  const start = Math.round(slice.offset * SAMPLE_RATE);
  const end = Math.min(channels[0].length, start + Math.round(Math.min(slice.duration, 0.25) * SAMPLE_RATE));
  let sum = 0;
  for (let i = start; i < end; i++) sum += channels[0][i] ** 2;
  return sum / Math.max(1, end - start);
}

// Of a lane's steps, the one with the longest slice (within 10%), the loudest of those
async function pick(file, steps) {
  const longest = Math.max(...steps.map((s) => s.slice.duration));
  const long = steps.filter((s) => s.slice.duration >= longest * 0.9);
  const levels = await Promise.all(long.map((s) => level(file, s.slice)));
  return long[levels.indexOf(Math.max(...levels))];
}

const folder = process.argv[2];
if (!folder) throw new Error('Usage: npx tsx scripts/make-softer-jam.mjs "<project folder>"');
const files = readFolder(folder);
const project = await readAbletonProject(files);
const outDir = path.join(engine, "softer");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir);

// Every exported track (MIDI and audio) in the song's order, as in the Live Set
const setFile = files.find((f) => f.file.name.endsWith(".als") && !/(^|\/)Backup\//.test(f.path)).file;
const liveSet = new DOMParser()
  .parseFromString(await new Response(setFile.stream().pipeThrough(new DecompressionStream("gzip"))).text(), "application/xml")
  .querySelector("Ableton > LiveSet");
const order = Array.from(liveSet.querySelectorAll(":scope > Tracks > MidiTrack, :scope > Tracks > AudioTrack"))
  .map((track) => track.querySelector(":scope > Name > EffectiveName")?.getAttribute("Value"))
  .filter((name) => project.exports.has(name) && (project.tracks.some((t) => t.name === name) || project.audioTracks.includes(name)));
const midi = new Map(project.tracks.map((track) => [track.name, track]));
const parts = [];
const preset = [];
for (const [index, name] of order.entries()) {
  const file = project.exports.get(name);
  const track = midi.get(name) ?? audioTrackFromAnalysis(project, name, await analyzeAudio(repoRoot, Buffer.from(await file.arrayBuffer()), project.tempo));
  const lesson = await withSoundLengths(abletonTrackToLesson(project, track, { export: "export" }), file);
  const firstBar = lessonStartBeat(track);
  const beatOf = (step) => step.tick / TICKS_PER_BEAT + firstBar;
  const playing = lesson.steps.filter((step) => beatOf(step) >= WINDOW[0] && beatOf(step) < WINDOW[1]);
  const pool = playing.length ? playing : lesson.steps;
  const lanes = [...new Set(lesson.steps.map((step) => step.note))].sort((a, b) => a - b);

  const sounds = [];
  for (const note of [...new Set(pool.map((step) => step.note))].sort((a, b) => a - b)) {
    const step = await pick(file, pool.filter((s) => s.note === note));
    const audio = await cut(file, step.slice);
    const sound = {
      file: `softer/${slug(name)}${lanes.length > 1 ? `-lane-${lanes.indexOf(note) + 1}` : ""}.wav`,
      root: note,
      velocity: step.velocity,
      held: Math.round(((step.dur / TICKS_PER_BEAT) * 4) * 100) / 100,
    };
    fs.writeFileSync(path.join(engine, sound.file), encodeWav16(audio));
    sounds.push({ ...sound, uses: pool.filter((s) => s.note === note).length });
  }
  if (index < LANES) preset.push({ file: sounds.reduce((most, s) => (s.uses > most.uses ? s : most)).file, name });
  if (playing.length) {
    const kind = lanes.length === 1 ? "drum" : "notes";
    const notes = playing.map((step) => ({
      pitch: kind === "drum" ? 0 : step.note,
      step: Math.round((beatOf(step) - WINDOW[0]) * 4) % STEPS,
      length: Math.max(1, Math.round((step.dur / TICKS_PER_BEAT) * 4)),
      velocity: step.velocity,
    }));
    parts.push({ name, kind, sounds: sounds.map(({ uses: _uses, ...s }) => s), notes });
  }
  console.log(`${name.padEnd(18)} ${String(lanes.length).padStart(2)} lanes  ${String(sounds.length).padStart(2)} sounds  ${String(playing.length).padStart(3)} notes`);
}
// Lanes no part or the Softer sound uses are not kept
const used = new Set([...preset.map((sound) => sound.file), ...parts.flatMap((part) => part.sounds.map((s) => s.file))]);
for (const file of fs.readdirSync(outDir)) if (!used.has(`softer/${file}`)) fs.rmSync(path.join(outDir, file));

const json = (value) => JSON.stringify(value).replace(/"/g, "'");
fs.writeFileSync(
  path.join(engine, "jamSofter.ts"),
  `// Generated by scripts/make-softer-jam.mjs from the Softer Ableton project; do not edit.
import type { JamTrack } from './jamTracks';

// The song's last 8 bars at ${project.tempo} BPM: every track that plays there, its lanes
// as in the Ableton import, with their sounds in softer/
export const SOFTER_TRACK: JamTrack = {
  file: 'softer.wav',
  bpm: ${project.tempo},
  chords: [],
  layers: [],
  drums: [],
  sampled: [
${parts
  .map(
    (part) => `    {
      name: ${json(part.name)},
      kind: '${part.kind}',
      sounds: ${json(part.sounds)},
      notes: ${json(part.notes)},
    },`
  )
  .join("\n")}
  ],
};

// One sound per track, in the song's track order, as many as the highway has rows
export const SOFTER_SOUNDS: { file: string; name: string }[] = ${json(preset)};
`
);
