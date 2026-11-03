import { renderNotes } from '../../../../../../instrument-lab/engine/synth.mjs';
import { renderDrums } from '../../../../../../instrument-lab/engine/drums.mjs';
import { JAM_TRACK_BARS, type JamTrack, type JamTrackNote } from './jamTracks';

// Renders a backing track's loop from its instruments and notes (one list per
// part, as jamTrackParts orders them): used by the render script and, for
// edited tracks, by the Jam tab's worker

const TAIL_SECONDS = 3;
export const JAM_TRACK_TARGET_RMS_DB = -20; // loudness of every original track over its whole loop

export function renderJamTrackLoop(track: JamTrack, parts: JamTrackNote[][], sampleRate: number) {
  const sixteenth = 60 / track.bpm / 4;
  const loopSeconds = JAM_TRACK_BARS * 16 * sixteenth;
  const duration = loopSeconds + TAIL_SECONDS;
  const drumParts = parts.slice(0, track.drums.length);
  const layerParts = parts.slice(track.drums.length);

  const out = [new Float32Array(Math.ceil(duration * sampleRate)), new Float32Array(Math.ceil(duration * sampleRate))];

  const drums = renderDrums(
    track.drums.map(({ id, model, extra }, d) => ({
      id,
      patch: { detail: 0, ...extra, model },
      asset: { channels: [new Float32Array(1)], sampleRate },
      notes: drumParts[d].map(({ step, velocity }) => ({ start: step * sixteenth, velocity })),
    })),
    duration,
    sampleRate
  );
  for (let c = 0; c < 2; c++) for (let i = 0; i < out[c].length; i++) out[c][i] += drums[c][i];

  track.layers.forEach(({ patch, gain, pan }, l) => {
    const notes = layerParts[l].map(({ pitch, step, length, velocity }) => ({
      pitch,
      start: step * sixteenth,
      end: (step + length) * sixteenth,
      velocity,
    }));
    const audio = renderNotes(patch, notes, duration, sampleRate);
    const sides = [Math.sqrt(1 - pan) * Math.SQRT2 * gain, Math.sqrt(pan) * Math.SQRT2 * gain];
    for (let c = 0; c < 2; c++) for (let i = 0; i < audio.length; i++) out[c][i] += audio[i] * sides[c];
  });

  // Only notes inside the 8 bars are rendered; their tails past the loop point
  // fold back onto its start, so the loop is seamless and every bar is as loud
  const loopLength = Math.round(loopSeconds * sampleRate);
  const loop: [Float32Array, Float32Array] = [new Float32Array(loopLength), new Float32Array(loopLength)];
  for (let c = 0; c < 2; c++) for (let i = 0; i < out[c].length; i++) loop[c][i % loopLength] += out[c][i];
  return { loop, loopSeconds };
}

// The gain that brings a loop to the target loudness
export function jamLoopScale(loop: Float32Array[]): number {
  let sum = 0;
  for (const ch of loop) for (const x of ch) sum += x * x;
  return 10 ** (JAM_TRACK_TARGET_RMS_DB / 20) / Math.sqrt(sum / (loop.length * loop[0].length));
}
