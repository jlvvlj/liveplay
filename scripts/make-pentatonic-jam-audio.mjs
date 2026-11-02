// Renders the Jam tab's backing tracks with the Instrument Lab's offline synth
// and drum engines: 8 bars in A minor each, looping seamlessly, so every note
// of the A minor pentatonic highway fits. Each track's BPM must match its song
// in jamSongs.ts. The notes you play are synthesized live in the app (jamSynth.ts).
//
//   node scripts/make-pentatonic-jam-audio.mjs [audio dir]
//
// Writes into <audio dir>/samples/pentatonic_jam/ (default: ./audio). All tracks
// are scaled to the same loudness, so switching tracks never changes the level.
import fs from "node:fs";
import path from "node:path";
import { renderNotes } from "../instrument-lab/engine/synth.mjs";
import { renderDrums, encodeStereoWav } from "../instrument-lab/engine/drums.mjs";

const SAMPLE_RATE = 44100;
const BARS = 8;
const TAIL_SECONDS = 3;
const TARGET_RMS_DB = -20; // loudness of every track over its whole loop
const MAX_PEAK_DB = -1;

// A layer plays per bar: (chord, bar) => [{ pitch, step, length, velocity }],
// steps and lengths in 16ths
const layer = (patch, gain, pan, notesForBar) => ({ patch, gain, pan, notesForBar });
// A drum plays the same hits every bar: [16th, velocity]
const drum = (id, model, extra, hits) => ({ id, model, extra, hits });

const TRACKS = [
  {
    // Laid-back groove: triangle bass, dark saw pad, kick / snare / hats
    file: "groove.wav",
    bpm: 90,
    // Am7 | Fmaj7 | C | G
    chords: [
      { root: 45, tones: [57, 60, 64, 67] },
      { root: 41, tones: [53, 57, 60, 64] },
      { root: 48, tones: [55, 60, 64, 67] },
      { root: 43, tones: [55, 59, 62, 67] },
    ],
    layers: [
      layer({ family: "triangle", brightness: 0.3, attack: 0.005, decay: 0.3, sustain: 0.45, release: 0.12, gain: 1.1 }, 0.55, 0.5,
        (chord) => [[0, 3], [3, 2], [6, 2], [8, 4], [14, 2]].map(([step, length]) =>
          ({ pitch: chord.root, step, length: length * 0.9, velocity: step === 0 ? 120 : 95 }))),
      layer({ family: "saw", brightness: 0.18, body: 0.5, attack: 0.45, decay: 1.2, sustain: 0.6, release: 0.9, detune: 14, gain: 0.35 }, 0.46, 0.45,
        (chord) => chord.tones.map((pitch) => ({ pitch, step: 0, length: 16, velocity: 90 }))),
    ],
    drums: [
      drum("kick", { frequency: 52, sweep: 140, sweepDecay: 0.03, toneLevel: 1, toneDecay: 0.22, noiseLevel: 0.04, noiseDecay: 0.01 }, { gain: 1.1 },
        [[0, 120], [6, 90], [8, 120], [11, 70]]),
      drum("snare", { frequency: 190, toneLevel: 0.35, toneDecay: 0.07, noiseLevel: 0.9, noiseDecay: 0.13, pan: 0.45 }, { gain: 0.6, brightness: 0.8 },
        [[4, 110], [12, 110], [15, 35]]),
      drum("hat", { frequency: 9000, toneLevel: 0, noiseLevel: 0.6, noiseDecay: 0.025, pan: 0.6 }, { gain: 0.35, brightness: 1.8 },
        [[0, 70], [2, 110], [4, 70], [6, 110], [8, 70], [10, 110], [12, 70], [14, 110], [7, 40], [13, 40]]),
    ],
  },
  {
    // 8-bit: pulse bass bouncing in octaves, a soft square arpeggio, chip drums
    file: "chip_run.wav",
    bpm: 112,
    // Am | G | F | G
    chords: [
      { root: 45, tones: [57, 60, 64, 69] },
      { root: 43, tones: [55, 59, 62, 67] },
      { root: 41, tones: [53, 57, 60, 65] },
      { root: 43, tones: [55, 59, 62, 67] },
    ],
    layers: [
      layer({ family: "pulse", odd: 0.4, brightness: 0.6, body: 0.2, attack: 0.002, decay: 0.12, sustain: 0.5, release: 0.04, gain: 0.8 }, 0.5, 0.5,
        (chord) => Array.from({ length: 8 }, (_, i) =>
          ({ pitch: chord.root - 12 + (i % 2) * 12, step: i * 2, length: 1.6, velocity: i % 4 === 0 ? 120 : 100 }))),
      layer({ family: "square", brightness: 0.45, body: 0.1, attack: 0.002, decay: 0.09, sustain: 0.15, release: 0.05, gain: 0.5 }, 0.22, 0.62,
        (chord) => Array.from({ length: 16 }, (_, i) =>
          ({ pitch: chord.tones[[0, 1, 2, 3, 2, 1][i % 6]], step: i, length: 0.7, velocity: i % 4 === 0 ? 110 : 80 }))),
    ],
    drums: [
      drum("kick", { frequency: 58, sweep: 320, sweepDecay: 0.015, toneLevel: 1, toneDecay: 0.12, noiseLevel: 0.1, noiseDecay: 0.008 }, { gain: 1, drive: 0.3 },
        [[0, 120], [7, 90], [8, 115], [10, 80]]),
      drum("snare", { frequency: 240, toneLevel: 0.25, toneDecay: 0.04, noiseLevel: 1, noiseDecay: 0.09, pan: 0.5 }, { gain: 0.55, brightness: 1.1, drive: 0.4 },
        [[4, 110], [12, 110]]),
      drum("hat", { frequency: 9000, toneLevel: 0, noiseLevel: 0.6, noiseDecay: 0.014, pan: 0.42 }, { gain: 0.3, brightness: 1.6, drive: 0.2 },
        Array.from({ length: 16 }, (_, i) => [i, i % 2 === 0 ? 100 : 55])),
    ],
  },
  {
    // Ambient: slow warm pad, sine sub, sparse soft bells, light rim and shaker
    file: "night_drift.wav",
    bpm: 76,
    // Am7 | Fmaj7 | Cmaj7 | Em7
    chords: [
      { root: 45, tones: [57, 60, 64, 67], bells: [76, 72] },
      { root: 41, tones: [53, 57, 60, 64], bells: [72, 69] },
      { root: 48, tones: [52, 55, 59, 64], bells: [74, 67] },
      { root: 40, tones: [52, 55, 59, 62], bells: [71, 67] },
    ],
    layers: [
      layer({ family: "saw", brightness: 0.16, body: 0.55, attack: 0.7, decay: 1.6, sustain: 0.75, release: 1.4, detune: 16, gain: 0.35 }, 0.5, 0.5,
        (chord) => chord.tones.map((pitch) => ({ pitch, step: 0, length: 16, velocity: 90 }))),
      layer({ family: "sine", brightness: 0.2, body: 0.8, attack: 0.02, decay: 0.8, sustain: 0.7, release: 0.4, gain: 1.1 }, 0.62, 0.5,
        (chord) => [{ pitch: chord.root, step: 0, length: 11, velocity: 110 }, { pitch: chord.root, step: 12, length: 3.5, velocity: 85 }]),
      layer({ family: "fm", fm: 1.1, ratio: 6, brightness: 0.45, body: 0.5, attack: 0.002, decay: 0.6, sustain: 0.02, release: 0.9, gain: 0.8 }, 0.16, 0.66,
        (chord) => [{ pitch: chord.bells[0], step: 2, length: 1, velocity: 90 }, { pitch: chord.bells[1], step: 10, length: 1, velocity: 70 }]),
    ],
    drums: [
      drum("kick", { frequency: 46, sweep: 90, sweepDecay: 0.04, toneLevel: 1, toneDecay: 0.3, noiseLevel: 0.02, noiseDecay: 0.01 }, { gain: 1, brightness: 0.5 },
        [[0, 110], [10, 85]]),
      drum("rim", { frequency: 1700, toneLevel: 0.5, toneDecay: 0.018, noiseLevel: 0.4, noiseDecay: 0.02, pan: 0.38 }, { gain: 0.45, brightness: 1.2 },
        [[8, 100]]),
      drum("shaker", { frequency: 9000, toneLevel: 0, noiseLevel: 0.5, noiseDecay: 0.04, pan: 0.62 }, { gain: 0.22, brightness: 1.4 },
        Array.from({ length: 8 }, (_, i) => [i * 2, i % 2 === 0 ? 70 : 105])),
    ],
  },
  {
    // Organic: woody FM bass, soft electric piano stabs, clap, shaker, woodblock
    file: "wood_steps.wav",
    bpm: 100,
    // Am7 | Dm7 | G | Em7
    chords: [
      { root: 45, tones: [55, 60, 64, 69] },
      { root: 50, tones: [53, 57, 60, 65] },
      { root: 43, tones: [55, 59, 62, 67] },
      { root: 40, tones: [55, 59, 62, 64] },
    ],
    layers: [
      layer({ family: "fm", fm: 0.7, ratio: 4, brightness: 0.3, body: 0.7, attack: 0.002, decay: 0.25, sustain: 0.1, release: 0.12, gain: 1.2 }, 0.6, 0.5,
        (chord) => [[0, 2], [3, 1], [6, 2], [8, 2], [10, 1], [11, 2], [14, 1]].map(([step, length]) =>
          ({ pitch: chord.root - (chord.root > 45 ? 12 : 0), step, length, velocity: step === 0 ? 120 : 95 }))),
      layer({ family: "fm", fm: 1.3, ratio: 1, brightness: 0.4, body: 0.4, attack: 0.003, decay: 0.7, sustain: 0.2, release: 0.35, detune: 4, gain: 0.6 }, 0.3, 0.42,
        (chord) => [4, 11].flatMap((step) => chord.tones.map((pitch) => ({ pitch, step, length: 2, velocity: 85 })))),
    ],
    drums: [
      drum("kick", { frequency: 50, sweep: 120, sweepDecay: 0.03, toneLevel: 1, toneDecay: 0.18, noiseLevel: 0.05, noiseDecay: 0.01 }, { gain: 1, brightness: 0.7 },
        [[0, 120], [7, 80], [10, 105]]),
      drum("clap", { frequency: 1100, toneLevel: 0.1, toneDecay: 0.02, noiseLevel: 1, noiseDecay: 0.11, pan: 0.52 }, { gain: 0.5, brightness: 0.9 },
        [[4, 110], [12, 110]]),
      drum("shaker", { frequency: 9000, toneLevel: 0, noiseLevel: 0.5, noiseDecay: 0.03, pan: 0.64 }, { gain: 0.24, brightness: 1.3 },
        Array.from({ length: 16 }, (_, i) => [i, i % 4 === 2 ? 115 : i % 2 === 0 ? 75 : 50])),
      drum("block", { frequency: 880, sweep: 200, sweepDecay: 0.005, toneLevel: 0.8, toneDecay: 0.035, noiseLevel: 0.1, noiseDecay: 0.01, pan: 0.32 }, { gain: 0.35 },
        [[3, 90], [14, 70]]),
    ],
  },
];

function renderTrack(track) {
  const sixteenth = 60 / track.bpm / 4;
  const loopSeconds = BARS * 16 * sixteenth;
  const duration = loopSeconds + TAIL_SECONDS;
  const chordAt = (bar) => track.chords[bar % track.chords.length];

  const out = [new Float32Array(Math.ceil(duration * SAMPLE_RATE)), new Float32Array(Math.ceil(duration * SAMPLE_RATE))];

  const drums = renderDrums(
    track.drums.map(({ id, model, extra, hits }) => ({
      id,
      patch: { detail: 0, ...extra, model },
      asset: { channels: [new Float32Array(1)], sampleRate: SAMPLE_RATE },
      notes: Array.from({ length: BARS }, (_, bar) =>
        hits.map(([step, velocity]) => ({ start: (bar * 16 + step) * sixteenth, velocity }))).flat(),
    })),
    duration,
    SAMPLE_RATE,
  );
  for (let c = 0; c < 2; c++) for (let i = 0; i < out[c].length; i++) out[c][i] += drums[c][i];

  for (const { patch, gain, pan, notesForBar } of track.layers) {
    const notes = Array.from({ length: BARS }, (_, bar) =>
      notesForBar(chordAt(bar), bar).map(({ pitch, step, length, velocity }) => ({
        pitch,
        start: (bar * 16 + step) * sixteenth,
        end: (bar * 16 + step + length) * sixteenth,
        velocity,
      }))).flat();
    const audio = renderNotes(patch, notes, duration, SAMPLE_RATE);
    const sides = [Math.sqrt(1 - pan) * Math.SQRT2 * gain, Math.sqrt(pan) * Math.SQRT2 * gain];
    for (let c = 0; c < 2; c++) for (let i = 0; i < audio.length; i++) out[c][i] += audio[i] * sides[c];
  }

  // Only notes inside the 8 bars are rendered; their tails past the loop point
  // fold back onto its start, so the loop is seamless and every bar is as loud
  const loopLength = Math.round(loopSeconds * SAMPLE_RATE);
  const loop = [new Float32Array(loopLength), new Float32Array(loopLength)];
  for (let c = 0; c < 2; c++) for (let i = 0; i < out[c].length; i++) loop[c][i % loopLength] += out[c][i];

  let sum = 0;
  for (const ch of loop) for (const x of ch) sum += x * x;
  const scale = 10 ** (TARGET_RMS_DB / 20) / Math.sqrt(sum / (2 * loopLength));
  let peak = 0;
  for (const ch of loop) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs((ch[i] *= scale)));
  const peakDb = 20 * Math.log10(peak);
  if (peakDb > MAX_PEAK_DB) {
    throw new Error(`${track.file}: peak ${peakDb.toFixed(1)} dBFS at ${TARGET_RMS_DB} dB RMS; lower its loudest layer`);
  }
  return { loop, loopSeconds, peakDb };
}

const audioDir = path.resolve(process.argv[2] || "audio");
const outDir = path.join(audioDir, "samples", "pentatonic_jam");
fs.mkdirSync(outDir, { recursive: true });

for (const track of TRACKS) {
  const { loop, loopSeconds, peakDb } = renderTrack(track);
  fs.writeFileSync(path.join(outDir, track.file), Buffer.from(encodeStereoWav(loop, SAMPLE_RATE)));
  console.log(`${track.file}: ${track.bpm} BPM, ${loopSeconds.toFixed(2)} s loop, peak ${peakDb.toFixed(1)} dBFS`);
}
console.log(`Wrote ${TRACKS.length} tracks to ${outDir}`);
