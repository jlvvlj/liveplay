import { patchData, renderNotes } from '../../../../../../instrument-lab/engine/synth.mjs';
import { prepareDrum } from '../../../../../../instrument-lab/engine/drums.mjs';
import { JAM_TRACK_BARS, type JamTrack, type JamTrackNote } from './jamTracks';
import { matchJamLoudness } from './jamLoudness';

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
  const offsetOf = (step: number) => Math.round(swung(track, step) * sixteenth * sampleRate);
  const mixIn = (sound: Float32Array[], offset: number, gains: number[]) => {
    for (let c = 0; c < 2; c++) {
      const channel = sound[Math.min(c, sound.length - 1)];
      const target = loop[c];
      for (let i = 0; i < channel.length; i++) target[(offset + i) % loopLength] += channel[i] * gains[c];
    }
  };

  if (part < track.drums.length) {
    const { model, extra, lowpass } = track.drums[part];
    const prepared = prepareDrum({ detail: 0, ...extra, model }, { channels: [new Float32Array(1)], sampleRate }, sampleRate);
    const sound = lowpass ? prepared.map((channel) => lowPass(lowPass(channel, lowpass, sampleRate), lowpass, sampleRate)) : prepared;
    for (const { step, velocity } of notes) mixIn(sound, offsetOf(step), [velocity / 127, velocity / 127]);
    return withRoom(track, withEcho(track, loop, sampleRate));
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
    mixIn([sound], offsetOf(step), sides);
  }
  return withRoom(track, withEcho(track, loop, sampleRate));
}

// A 12 dB per octave low-pass (RBJ biquad, Q 0.707)
function lowPass(input: Float32Array, cutoff: number, sampleRate: number): Float32Array {
  const w = (2 * Math.PI * cutoff) / sampleRate;
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const c = Math.cos(w);
  const [b0, b1, b2, a0, a1, a2] = [(1 - c) / 2, 1 - c, (1 - c) / 2, 1 + alpha, -2 * c, 1 - alpha];
  const out = new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const y = (b0 * input[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = input[i];
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

// A step as played: an off-beat 8th comes late in a swung track
function swung(track: JamTrack, step: number): number {
  const inBeat = step - 4 * Math.floor(step / 4);
  return track.swing && Math.abs(inBeat - 2) < 1e-6 ? step + (track.swing - 0.5) * 4 : step;
}

// A track's room, folded into its loop: a Freeverb (eight damped combs, then
// four allpasses, per side) run over the loop twice, so the second pass's
// tail wraps around its start
const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES = [556, 441, 341, 225];
const STEREO_SPREAD = 23;
function withRoom(track: JamTrack, loop: [Float32Array, Float32Array]): [Float32Array, Float32Array] {
  if (!track.room) return loop;
  const { size, mix } = track.room;
  const length = loop[0].length;
  const feedback = 0.7 + 0.28 * size;
  const damp = 0.4;
  const input = loop[0].map((left, i) => (left + loop[1][i]) * 0.015);
  const wet = [0, 1].map((side) => {
    const combs = COMBS.map((delay) => ({ buffer: new Float32Array(delay + side * STEREO_SPREAD), at: 0, low: 0 }));
    const allpasses = ALLPASSES.map((delay) => ({ buffer: new Float32Array(delay + side * STEREO_SPREAD), at: 0 }));
    const out = new Float32Array(length);
    for (let pass = 0; pass < 2; pass++)
      for (let i = 0; i < length; i++) {
        let sum = 0;
        for (const comb of combs) {
          const y = comb.buffer[comb.at];
          comb.low = y * (1 - damp) + comb.low * damp;
          comb.buffer[comb.at] = input[i] + comb.low * feedback;
          comb.at = (comb.at + 1) % comb.buffer.length;
          sum += y;
        }
        for (const allpass of allpasses) {
          const y = allpass.buffer[allpass.at];
          allpass.buffer[allpass.at] = sum + y * 0.5;
          allpass.at = (allpass.at + 1) % allpass.buffer.length;
          sum = y - sum;
        }
        if (pass === 1) out[i] = sum;
      }
    return out;
  });
  for (let side = 0; side < 2; side++) for (let i = 0; i < length; i++) loop[side][i] += wet[side][i] * mix * 3;
  return loop;
}

// A track's ping-pong echo, folded into its loop: both channels summed, echoed
// every `beats` on alternate sides, starting on the left
function withEcho(track: JamTrack, loop: [Float32Array, Float32Array], sampleRate: number): [Float32Array, Float32Array] {
  if (!track.echo) return loop;
  const { beats, feedback, wet } = track.echo;
  const length = loop[0].length;
  const delay = Math.round(((beats * 60) / track.bpm) * sampleRate);
  const mono = loop[0].map((left, i) => left + loop[1][i]);
  for (let echo = 1, gain = wet; gain > 1e-4; echo++, gain *= feedback) {
    const side = loop[(echo - 1) % 2];
    const shift = (echo * delay) % length;
    for (let i = 0; i < length; i++) side[(i + shift) % length] += mono[i] * gain;
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

// A recorded instrument's clip per note, keyed by MIDI note: its one sound
// re-pitched from `root`. The rows move by whole octaves to sit around the
// root, so a bass stays low and a lead high, in the rows' key. All clips share
// one gain, as loud as the reference sounds.
export function renderJamSampleWavs(
  sound: Float32Array[],
  root: number,
  notes: number[],
  sampleRate: number
): { [note: number]: ArrayBuffer } {
  const rows = [...notes].sort((a, b) => a - b);
  const shift = 12 * Math.round((root - (rows[0] + rows[rows.length - 1]) / 2) / 12);
  const clips = rows.map((note) => {
    const rate = 2 ** ((note + shift - root) / 12);
    const length = Math.floor((sound[0].length - 1) / rate);
    return [0, 1].map((c) => {
      const source = sound[Math.min(c, sound.length - 1)];
      const out = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        const at = i * rate;
        const j = Math.floor(at);
        out[i] = source[j] + (source[j + 1] - source[j]) * (at - j);
      }
      return out;
    });
  });
  matchJamLoudness(clips, sampleRate);
  return Object.fromEntries(rows.map((note, row) => [note, encodeWav16(clips[row], sampleRate)]));
}

// A 16-bit stereo PCM WAV file
export function encodeWav16([left, right]: Float32Array[], sampleRate: number): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(44 + left.length * 4));
  const text = (at: number, value: string) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + left.length * 4, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, left.length * 4, true);
  for (let i = 0; i < left.length; i++) {
    view.setInt16(44 + i * 4, Math.max(-1, Math.min(1, left[i])) * 32767, true);
    view.setInt16(46 + i * 4, Math.max(-1, Math.min(1, right[i])) * 32767, true);
  }
  return view.buffer;
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
