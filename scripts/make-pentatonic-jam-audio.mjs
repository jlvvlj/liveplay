// Renders the Jam tab's backing tracks (jamTracks.ts) with the Instrument Lab's
// offline synth and drum engines, looping seamlessly, so every note of the
// A minor pentatonic highway fits. The notes you play are synthesized live in
// the app (jamSynth.ts).
//
//   npx tsx scripts/make-pentatonic-jam-audio.mjs [audio dir]
//
// Writes 16-bit WAVs into <audio dir>/samples/pentatonic_jam/ (default: ./audio;
// the jam app's build passes apps/jam/dist/audio). All tracks are scaled to the
// same loudness, so switching tracks never changes the level.
import fs from "node:fs";
import path from "node:path";
import { renderNotes } from "../instrument-lab/engine/synth.mjs";
import { renderDrums } from "../instrument-lab/engine/drums.mjs";
import {
  JAM_TRACKS,
  JAM_TRACK_BARS as BARS,
  jamTrackParts,
} from "../apps/desktop/src/renderer/components/lesson-engine/jamTracks.ts";

const SAMPLE_RATE = 44100;
const TAIL_SECONDS = 3;
const TARGET_RMS_DB = -20; // loudness of every track over its whole loop
const MAX_PEAK_DB = -1;

function renderTrack(track) {
  const sixteenth = 60 / track.bpm / 4;
  const loopSeconds = BARS * 16 * sixteenth;
  const duration = loopSeconds + TAIL_SECONDS;
  const parts = jamTrackParts(track);
  const drumParts = parts.slice(0, track.drums.length);
  const layerParts = parts.slice(track.drums.length);

  const out = [new Float32Array(Math.ceil(duration * SAMPLE_RATE)), new Float32Array(Math.ceil(duration * SAMPLE_RATE))];

  const drums = renderDrums(
    track.drums.map(({ id, model, extra }, d) => ({
      id,
      patch: { detail: 0, ...extra, model },
      asset: { channels: [new Float32Array(1)], sampleRate: SAMPLE_RATE },
      notes: drumParts[d].notes.map(({ step, velocity }) => ({ start: step * sixteenth, velocity })),
    })),
    duration,
    SAMPLE_RATE,
  );
  for (let c = 0; c < 2; c++) for (let i = 0; i < out[c].length; i++) out[c][i] += drums[c][i];

  track.layers.forEach(({ patch, gain, pan }, l) => {
    const notes = layerParts[l].notes.map(({ pitch, step, length, velocity }) => ({
      pitch,
      start: step * sixteenth,
      end: (step + length) * sixteenth,
      velocity,
    }));
    const audio = renderNotes(patch, notes, duration, SAMPLE_RATE);
    const sides = [Math.sqrt(1 - pan) * Math.SQRT2 * gain, Math.sqrt(pan) * Math.SQRT2 * gain];
    for (let c = 0; c < 2; c++) for (let i = 0; i < audio.length; i++) out[c][i] += audio[i] * sides[c];
  });

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

// 16-bit stereo PCM: half the size of float, so phones load tracks twice as fast
function encodeWav16([left, right]) {
  const buffer = Buffer.alloc(44 + left.length * 4);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + left.length * 4, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(left.length * 4, 40);
  for (let i = 0; i < left.length; i++) {
    buffer.writeInt16LE(Math.round(left[i] * 32767), 44 + i * 4);
    buffer.writeInt16LE(Math.round(right[i] * 32767), 46 + i * 4);
  }
  return buffer;
}

const audioDir = path.resolve(process.argv[2] || "audio");
const outDir = path.join(audioDir, "samples", "pentatonic_jam");
fs.mkdirSync(outDir, { recursive: true });

for (const track of JAM_TRACKS) {
  const { loop, loopSeconds, peakDb } = renderTrack(track);
  fs.writeFileSync(path.join(outDir, track.file), encodeWav16(loop));
  console.log(`${track.file}: ${track.bpm} BPM, ${loopSeconds.toFixed(2)} s loop, peak ${peakDb.toFixed(1)} dBFS`);
}
console.log(`Wrote ${JAM_TRACKS.length} tracks to ${outDir}`);
