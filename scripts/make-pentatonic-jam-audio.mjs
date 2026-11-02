// Renders the audio for the "Pentatonic Groove Jam" lesson with the Instrument
// Lab's offline synth and drum engines: three sets of sixteen notes (A minor
// pentatonic, A2-A5: 8-bit stab, synth bell, woody mallet) and an 8-bar groove
// that loops seamlessly at 90 BPM. BPM must match the song's bpm in jamSongs.ts.
//
//   node scripts/make-pentatonic-jam-audio.mjs [audio dir]
//
// Writes into <audio dir>/samples/pentatonic_jam/ (default: ./audio).
import fs from "node:fs";
import path from "node:path";
import { renderNotes, encodeWav } from "../instrument-lab/engine/synth.mjs";
import { renderDrums, encodeStereoWav } from "../instrument-lab/engine/drums.mjs";

const SAMPLE_RATE = 44100;
const BPM = 90;
const BARS = 8;
const SIXTEENTH = 60 / BPM / 4;
const LOOP_SECONDS = BARS * 16 * SIXTEENTH;
const TAIL_SECONDS = 2;

export const JAM_NOTES = [45, 48, 50, 52, 55, 57, 60, 62, 64, 67, 69, 72, 74, 76, 79, 81];

// One entry per sound set: synth patch, how long the key is held and how long
// each note file runs (seconds)
const SOUND_SETS = {
  // Short, bright 25% pulse-wave stab with a quick decay, like an 8-bit console note
  stab: {
    patch: {
      family: "pulse",
      brightness: 0.75,
      odd: 0.4, // duty cycle 0.12 + 0.32 * odd = 25%
      body: 0.1,
      attack: 0.002,
      decay: 0.16,
      sustain: 0.12,
      release: 0.12,
      detune: 4,
      gain: 0.9,
    },
    hold: 0.09,
    length: 0.6,
  },
  // Glassy FM bell: bright strike that rings out
  bell: {
    patch: {
      family: "fm",
      fm: 1.8,
      ratio: 4,
      brightness: 0.65,
      body: 0.35,
      attack: 0.002,
      decay: 0.7,
      sustain: 0.02,
      release: 0.9,
      detune: 3,
      gain: 0.9,
    },
    hold: 0.12,
    length: 1.6,
  },
  // Soft, hollow mallet on wood: round fundamental with a short knock
  wood: {
    patch: {
      family: "fm",
      fm: 0.7,
      ratio: 4,
      brightness: 0.3,
      body: 0.6,
      attack: 0.001,
      decay: 0.2,
      sustain: 0.02,
      release: 0.18,
      gain: 1,
    },
    hold: 0.06,
    length: 0.7,
  },
};
const BASS = {
  family: "triangle",
  brightness: 0.3,
  attack: 0.005,
  decay: 0.3,
  sustain: 0.45,
  release: 0.12,
  gain: 1.1,
};
const PAD = {
  family: "saw",
  brightness: 0.18,
  body: 0.5,
  attack: 0.45,
  decay: 1.2,
  sustain: 0.6,
  release: 0.9,
  detune: 14,
  gain: 0.35,
};

// One chord per bar, twice: Am7 | Fmaj7 | C | G
const CHORDS = [
  { root: 45, pad: [57, 60, 64, 67] },
  { root: 41, pad: [53, 57, 60, 64] },
  { root: 48, pad: [55, 60, 64, 67] },
  { root: 43, pad: [55, 59, 62, 67] },
];
// Bass rhythm within a bar: [16th, length in 16ths]
const BASS_RHYTHM = [[0, 3], [3, 2], [6, 2], [8, 4], [14, 2]];

const drum = (id, model, extra, hits) => ({
  id,
  patch: { detail: 0, ...extra, model },
  asset: { channels: [new Float32Array(1)], sampleRate: SAMPLE_RATE },
  notes: hits,
});

function hitsPerBar(steps, velocity) {
  const notes = [];
  for (let bar = 0; bar < BARS + 1; bar++)
    for (const [step, vel = velocity] of steps)
      notes.push({ start: (bar * 16 + step) * SIXTEENTH, velocity: vel });
  return notes;
}

function renderGroove() {
  const duration = LOOP_SECONDS + TAIL_SECONDS;
  const drums = renderDrums(
    [
      drum("kick", { frequency: 52, sweep: 140, sweepDecay: 0.03, toneLevel: 1, toneDecay: 0.22, noiseLevel: 0.04, noiseDecay: 0.01 }, { gain: 1.1 },
        hitsPerBar([[0], [6, 90], [8], [11, 70]], 120)),
      drum("snare", { frequency: 190, toneLevel: 0.35, toneDecay: 0.07, noiseLevel: 0.9, noiseDecay: 0.13, pan: 0.45 }, { gain: 0.6, brightness: 0.8 },
        hitsPerBar([[4], [12], [15, 35]], 110)),
      drum("hat", { frequency: 9000, toneLevel: 0, noiseLevel: 0.6, noiseDecay: 0.025, pan: 0.6 }, { gain: 0.35, brightness: 1.8 },
        hitsPerBar([[0, 70], [2, 110], [4, 70], [6, 110], [8, 70], [10, 110], [12, 70], [14, 110], [7, 40], [13, 40]], 90)),
    ],
    duration,
    SAMPLE_RATE,
  );

  const bassNotes = [];
  const padNotes = [];
  for (let bar = 0; bar < BARS + 1; bar++) {
    const chord = CHORDS[bar % CHORDS.length];
    const barStart = bar * 16 * SIXTEENTH;
    for (const [step, length] of BASS_RHYTHM)
      bassNotes.push({
        pitch: chord.root,
        start: barStart + step * SIXTEENTH,
        end: barStart + (step + length) * SIXTEENTH * 0.9,
        velocity: step === 0 ? 120 : 95,
      });
    for (const pitch of chord.pad)
      padNotes.push({ pitch, start: barStart, end: barStart + 16 * SIXTEENTH, velocity: 90 });
  }
  const bass = renderNotes(BASS, bassNotes, duration, SAMPLE_RATE);
  const pad = renderNotes(PAD, padNotes, duration, SAMPLE_RATE);

  // Fold everything past the loop point back onto its start so the loop is seamless
  const loopLength = Math.round(LOOP_SECONDS * SAMPLE_RATE);
  const out = [new Float32Array(loopLength), new Float32Array(loopLength)];
  for (let c = 0; c < 2; c++)
    for (let i = 0; i < drums[c].length; i++)
      out[c][i % loopLength] += drums[c][i] + bass[i] * 0.55 + pad[i] * (c === 0 ? 0.5 : 0.42);

  const peak = Math.max(...out.map((ch) => ch.reduce((m, x) => Math.max(m, Math.abs(x)), 0)));
  for (const ch of out) for (let i = 0; i < ch.length; i++) ch[i] *= 0.8 / peak;
  return out;
}

function renderSoundSet({ patch, hold, length }) {
  const notes = JAM_NOTES.map((pitch) =>
    renderNotes(patch, [{ pitch, start: 0, end: hold, velocity: 110 }], length, SAMPLE_RATE),
  );
  // One gain for all notes so their relative loudness stays natural
  const peak = Math.max(...notes.map((a) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0)));
  for (const a of notes) for (let i = 0; i < a.length; i++) a[i] *= 0.85 / peak;
  return notes;
}

const audioDir = path.resolve(process.argv[2] || "audio");
const outDir = path.join(audioDir, "samples", "pentatonic_jam");
fs.mkdirSync(outDir, { recursive: true });

for (const [id, set] of Object.entries(SOUND_SETS))
  renderSoundSet(set).forEach((audio, i) =>
    fs.writeFileSync(path.join(outDir, `${id}-${JAM_NOTES[i]}.wav`), Buffer.from(encodeWav(audio, SAMPLE_RATE))),
  );
fs.writeFileSync(path.join(outDir, "groove.wav"), Buffer.from(encodeStereoWav(renderGroove(), SAMPLE_RATE)));
console.log(
  `Wrote ${Object.keys(SOUND_SETS).length} sound sets of ${JAM_NOTES.length} notes and groove.wav (${LOOP_SECONDS.toFixed(2)} s loop) to ${outDir}`,
);
