// Exports the Jam tab's backing tracks (jamTracks.ts) as WAV files, rendered by
// jamTrackRender.ts with the Instrument Lab's offline synth and drum engines,
// looping seamlessly. The Jam tab itself renders them live, so edits in its
// grid can be heard.
//
//   npx tsx scripts/make-pentatonic-jam-audio.mjs [audio dir]
//
// Writes 16-bit WAVs into <audio dir>/samples/pentatonic_jam/ (default: ./audio).
// All tracks are scaled to the same loudness, so switching tracks never changes
// the level.
import fs from "node:fs";
import path from "node:path";
import { JAM_TRACKS, jamTrackParts } from "../apps/desktop/src/renderer/components/lesson-engine/jamTracks.ts";
import {
  JAM_TRACK_TARGET_RMS_DB,
  jamLoopScale,
  jamLoopSeconds,
  renderJamPartLoop,
} from "../apps/desktop/src/renderer/components/lesson-engine/jamTrackRender.ts";

const SAMPLE_RATE = 44100;
const MAX_PEAK_DB = -1;

function renderTrack(track) {
  const parts = jamTrackParts(track).map((part, p) => renderJamPartLoop(track, p, part.notes, SAMPLE_RATE));
  const scale = jamLoopScale(parts);
  const loop = [0, 1].map((c) => {
    const channel = new Float32Array(parts[0][c].length);
    for (const part of parts) for (let i = 0; i < channel.length; i++) channel[i] += part[c][i];
    return channel;
  });
  let peak = 0;
  for (const ch of loop) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs((ch[i] *= scale)));
  const peakDb = 20 * Math.log10(peak);
  if (peakDb > MAX_PEAK_DB) {
    throw new Error(`${track.file}: peak ${peakDb.toFixed(1)} dBFS at ${JAM_TRACK_TARGET_RMS_DB} dB RMS; lower its loudest layer`);
  }
  return { loop, loopSeconds: jamLoopSeconds(track), peakDb };
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

// Softer plays sounds recorded from its own song (softer/); only the synthesized tracks are exported
const SYNTHESIZED = JAM_TRACKS.filter((track) => !track.sampled);
for (const track of SYNTHESIZED) {
  const { loop, loopSeconds, peakDb } = renderTrack(track);
  fs.writeFileSync(path.join(outDir, track.file), encodeWav16(loop));
  console.log(`${track.file}: ${track.bpm} BPM, ${loopSeconds.toFixed(2)} s loop, peak ${peakDb.toFixed(1)} dBFS`);
}
console.log(`Wrote ${SYNTHESIZED.length} tracks to ${outDir}`);
