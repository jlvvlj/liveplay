import { patchData, renderNotes } from '../../../../../../instrument-lab/engine/synth.mjs';
import { prepareDrum } from '../../../../../../instrument-lab/engine/drums.mjs';
import { JAM_TRACK_BARS, type JamTrack, type JamTrackNote } from './jamTracks';

// Renders backing-track loops from their instruments and notes, one part (as
// jamTrackParts orders them) at a time: the Jam tab plays each part through its
// own volume and renders it in pieces on several workers, and the WAV export
// script adds them up. Parts are rendered unscaled; jamLoopScale gives the
// whole track's gain.

export const JAM_TRACK_TARGET_RMS_DB = -20; // loudness of every original track over its whole loop

export const jamLoopSeconds = (track: JamTrack) => JAM_TRACK_BARS * 16 * (60 / track.bpm / 4);

// A part's loop from some or all of its notes. Notes ringing past the loop
// point fold back onto its start, so the loop is seamless. A note sounds the
// same wherever it starts, so each distinct one is rendered once.
export function renderJamPartLoop(
  track: JamTrack,
  part: number,
  notes: JamTrackNote[],
  sampleRate: number
): [Float32Array, Float32Array] {
  const sixteenth = 60 / track.bpm / 4;
  const loopLength = Math.round(jamLoopSeconds(track) * sampleRate);
  const loop: [Float32Array, Float32Array] = [new Float32Array(loopLength), new Float32Array(loopLength)];
  const mixIn = (sound: Float32Array[], offset: number, gains: number[]) => {
    for (let c = 0; c < 2; c++) {
      const channel = sound[Math.min(c, sound.length - 1)];
      const target = loop[c];
      for (let i = 0; i < channel.length; i++) target[(offset + i) % loopLength] += channel[i] * gains[c];
    }
  };

  if (part < track.drums.length) {
    const { model, extra } = track.drums[part];
    const sound = prepareDrum({ detail: 0, ...extra, model }, { channels: [new Float32Array(1)], sampleRate }, sampleRate);
    for (const { step, velocity } of notes)
      mixIn(sound, Math.round(step * sixteenth * sampleRate), [velocity / 127, velocity / 127]);
    return loop;
  }

  const { patch, gain, pan } = track.layers[part - track.drums.length];
  const sides = [Math.sqrt(1 - pan) * Math.SQRT2 * gain, Math.sqrt(pan) * Math.SQRT2 * gain];
  const tail = patchData(patch).release * 1.5 + 0.05;
  const rendered = new Map<string, Float32Array>();
  for (const { pitch, step, length, velocity } of notes) {
    const key = `${pitch}|${length}|${velocity}`;
    let sound = rendered.get(key);
    if (!sound) {
      const seconds = length * sixteenth;
      sound = renderNotes(patch, [{ pitch, start: 0, end: seconds, velocity }], seconds + tail, sampleRate);
      rendered.set(key, sound);
    }
    mixIn([sound], Math.round(step * sixteenth * sampleRate), sides);
  }
  return loop;
}

// The gain that brings a whole track's loop (the sum of its parts) to the target loudness
export function jamLoopScale(parts: Float32Array[][]): number {
  const length = parts[0][0].length;
  let sum = 0;
  for (let c = 0; c < 2; c++)
    for (let i = 0; i < length; i++) {
      let x = 0;
      for (const part of parts) x += part[c][i];
      sum += x * x;
    }
  return 10 ** (JAM_TRACK_TARGET_RMS_DB / 20) / Math.sqrt(sum / (2 * length));
}
