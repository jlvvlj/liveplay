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

// A recorded part's loop (see JamSampledPart), from the audio of its sounds,
// in their order. A re-pitched sound is read faster or slower.
export function renderJamSampledLoop(
  track: JamTrack,
  part: number,
  notes: JamTrackNote[],
  sounds: Float32Array[][],
  sampleRate: number
): [Float32Array, Float32Array] {
  const sixteenth = 60 / track.bpm / 4;
  const loopLength = Math.round(jamLoopSeconds(track) * sampleRate);
  const loopSteps = JAM_TRACK_BARS * 16;
  const loop: [Float32Array, Float32Array] = [new Float32Array(loopLength), new Float32Array(loopLength)];
  const { kind, sounds: recorded } = track.sampled![part - track.drums.length - track.layers.length];
  const fade = Math.round(0.01 * sampleRate);
  const hits = [...notes].sort((a, b) => a.step - b.step);

  hits.forEach((note, n) => {
    const s =
      kind === 'drum'
        ? 0
        : recorded.reduce(
            (best, sound, i) => (Math.abs(sound.root - note.pitch) < Math.abs(recorded[best].root - note.pitch) ? i : best),
            0
          );
    const sound = sounds[s];
    const rate = kind === 'drum' ? 1 : 2 ** ((note.pitch - recorded[s].root) / 12);
    const whole = Math.floor((sound[0].length - 1) / rate);
    let length: number;
    if (kind === 'drum') {
      // until the next hit, which after the last one is the first, a loop later
      const gap = (hits[(n + 1) % hits.length].step - note.step + loopSteps) % loopSteps || loopSteps;
      length = Math.min(whole, Math.round(gap * sixteenth * sampleRate));
    } else {
      const tail = Math.max(0, whole - (recorded[s].held * sixteenth * sampleRate) / rate);
      length = Math.min(whole, Math.round(note.length * sixteenth * sampleRate + tail));
    }
    const gain = note.velocity / recorded[s].velocity;
    const offset = Math.round(note.step * sixteenth * sampleRate);
    for (let c = 0; c < 2; c++) {
      const source = sound[Math.min(c, sound.length - 1)];
      const target = loop[c];
      for (let i = 0; i < length; i++) {
        const at = i * rate;
        const j = Math.floor(at);
        const cut = length < whole && i > length - fade ? (length - i) / fade : 1;
        target[(offset + i) % loopLength] += (source[j] + (source[j + 1] - source[j]) * (at - j)) * gain * cut;
      }
    }
  });
  return loop;
}

// The channels of a 16-bit PCM WAV file
export function decodeWav16(file: ArrayBuffer): { channels: Float32Array[]; sampleRate: number } {
  const view = new DataView(file);
  let channels = 0;
  let sampleRate = 0;
  for (let at = 12; at + 8 <= view.byteLength; ) {
    const id = String.fromCharCode(...new Uint8Array(file, at, 4));
    const size = view.getUint32(at + 4, true);
    if (id === 'fmt ') {
      if (view.getUint16(at + 8, true) !== 1 || view.getUint16(at + 22, true) !== 16) throw new Error('Not a 16-bit PCM WAV');
      channels = view.getUint16(at + 10, true);
      sampleRate = view.getUint32(at + 12, true);
    } else if (id === 'data') {
      const frames = Math.floor(size / (2 * channels));
      const out = Array.from({ length: channels }, () => new Float32Array(frames));
      for (let i = 0; i < frames; i++)
        for (let c = 0; c < channels; c++) out[c][i] = view.getInt16(at + 8 + (i * channels + c) * 2, true) / 32768;
      return { channels: out, sampleRate };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('The WAV has no audio');
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
