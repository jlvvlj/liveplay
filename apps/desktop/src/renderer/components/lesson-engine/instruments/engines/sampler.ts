import * as Tone from 'tone';
import { JAM_SOUND_LOUDNESS, jamLoudness } from '../../jamLoudness';
import type { LiveInstrument, ParamSpec, ParamValues } from '../types';
import { PAD_BASE_NOTE, paramValue } from '../types';
import { pitchCheckFrames, soundsAtNote } from './pitchCheck';

// The sampler: recorded instruments (each played note from the nearest
// recorded one, re-pitched, through an envelope and a filter) and kits (one
// sound per pad, pad i on note PAD_BASE_NOTE + i).

// Where a sound comes from: a file's URL (or the slices of it where the sound
// is played, in seconds), or audio made on the spot (a synthesised drum)
export interface SampleSlice {
  offset: number;
  duration: number;
}
export type SampleSound = { url: string; slices?: SampleSlice[] } | { make: () => Float32Array[] };

export type SamplerSource =
  | { kind: 'notes'; notes: (SampleSound & { root: number })[] }
  // `choke`: a hit cuts the pad's last one (Softer's drums and loops)
  | { kind: 'pads'; pads: (SampleSound & { name: string })[]; choke?: boolean };

const p = (key: string, label: string, min: number, max: number, step: number, value: number, group: string): ParamSpec => ({
  key,
  label,
  min,
  max,
  step,
  default: value,
  group,
});

export const SAMPLER_NOTE_PARAMS: ParamSpec[] = [
  p('octave', 'Octave', -2, 2, 1, 0, 'Pitch'),
  p('tune', 'Tune', -12, 12, 1, 0, 'Pitch'),
  p('fine', 'Fine', -100, 100, 1, 0, 'Pitch'),
  p('attack', 'Attack', 0.001, 2, 0.001, 0.002, 'Envelope'),
  p('decay', 'Decay', 0.05, 8, 0.01, 2, 'Envelope'),
  p('sustain', 'Sustain', 0, 1, 0.01, 1, 'Envelope'),
  p('release', 'Release', 0.02, 6, 0.01, 0.35, 'Envelope'),
  p('cutoff', 'Filter', 80, 18000, 1, 18000, 'Filter'),
  p('resonance', 'Resonance', 0.1, 12, 0.1, 0.7, 'Filter'),
  p('velocity', 'Touch', 0, 1, 0.01, 0.6, 'Output'),
  p('gain', 'Level', 0, 2, 0.01, 1, 'Output'),
];

export const SAMPLER_PAD_PARAMS: ParamSpec[] = [
  p('tune', 'Tune', -12, 12, 0.1, 0, 'Pitch'),
  p('length', 'Length', 0.05, 1, 0.01, 1, 'Envelope'),
  p('cutoff', 'Filter', 80, 18000, 1, 18000, 'Filter'),
  p('resonance', 'Resonance', 0.1, 12, 0.1, 0.7, 'Filter'),
  p('velocity', 'Touch', 0, 1, 0.01, 0.6, 'Output'),
  p('gain', 'Level', 0, 2, 0.01, 1, 'Output'),
];

const channelsOf = (buffer: AudioBuffer) => Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));

async function decodeFile(url: string): Promise<AudioBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return (await Tone.getContext().decodeAudioData(await response.arrayBuffer())) as unknown as AudioBuffer;
}

// A slice ends where its sound does: this far below its peak
const SLICE_END_LEVEL = 0.001;
const SLICE_FADE_SECONDS = 0.01;
// Below this a slice has nothing to hear (-60 dB)
const SLICE_SILENT = 0.001;
// A slice is as good as the loudest of them down to this much of its peak
const SLICE_NEAR_LOUDEST = 0.5;

// How loud a slice of a recording peaks, and how many frames it sounds for
function measureSlice(recording: AudioBuffer, { offset, duration }: SampleSlice) {
  const start = Math.min(Math.round(offset * recording.sampleRate), recording.length - 1);
  const stop = Math.min(start + Math.round(duration * recording.sampleRate), recording.length);
  const channels = channelsOf(recording).map((channel) => channel.subarray(start, stop));
  let peak = 0;
  for (const channel of channels) for (const value of channel) peak = Math.max(peak, Math.abs(value));
  let frames = 0;
  for (const channel of channels) {
    let last = channel.length;
    while (last > frames && Math.abs(channel[last - 1]) <= peak * SLICE_END_LEVEL) last--;
    frames = Math.max(frames, last);
  }
  return { channels, peak, frames };
}

// How far into a slice a note may settle, looked for this often
const SETTLE_MOST_SECONDS = 1;
const SETTLE_STEP_SECONDS = 0.02;
const CLEAN_SLICES_ENOUGH = 8;
const SETTLE_MOST_SLICES = 8;
const SLICE_FADE_IN_SECONDS = 0.005;

// Where in a slice its note is heard alone, from its start or once it has
// settled (a note that slides in from the last one); null if it never is. Other
// notes may ring on in a recording, so a slice can hold anything.
function noteStart(recording: AudioBuffer, slice: SampleSlice, note: number, settle: boolean): number | null {
  const rate = recording.sampleRate;
  const start = Math.round(slice.offset * rate);
  const frames = pitchCheckFrames(note, rate);
  const last = settle ? Math.min(SETTLE_MOST_SECONDS, slice.duration / 2) : 0;
  const channels = channelsOf(recording);
  for (let seconds = 0; seconds <= last; seconds += SETTLE_STEP_SECONDS) {
    const from = start + Math.round((seconds + 0.01) * rate);
    if (from + frames > recording.length) return null;
    const mono = new Float32Array(frames);
    for (const channel of channels) for (let i = 0; i < frames; i++) mono[i] += channel[from + i];
    if (soundsAtNote(mono, rate, note)) return seconds;
  }
  return null;
}

// A note's slices as they can play it: those where it is heard alone from the
// start (enough of them to choose from), else those where it settles, each from there
function noteSlices(recording: AudioBuffer, slices: SampleSlice[], note: number): SampleSlice[] {
  const clean: SampleSlice[] = [];
  for (const slice of slices) {
    if (noteStart(recording, slice, note, false) === 0) clean.push(slice);
    if (clean.length === CLEAN_SLICES_ENOUGH) break;
  }
  if (clean.length) return clean;
  return slices.slice(0, SETTLE_MOST_SLICES).flatMap((slice) => {
    const settled = noteStart(recording, slice, note, true);
    return settled === null ? [] : [{ offset: slice.offset + settled, duration: slice.duration - settled }];
  });
}

// A sound played many times in a recording, as a sound of its own: of its
// slices (only those playing its note, if it has one) its longest sounding
// (its effects' tail) of those about as loud as the loudest (a note may be
// quiet or silent there, the track faded or muted), faded so it never clicks.
// A note never heard alone is a silent sound, which takes no key.
function cutSound(recording: AudioBuffer, slices: SampleSlice[], note?: number): AudioBuffer {
  const playable = note === undefined ? slices : noteSlices(recording, slices, note);
  const rate = recording.sampleRate;
  if (playable.length === 0) return Tone.getContext().createBuffer(recording.numberOfChannels, 1, rate) as unknown as AudioBuffer;
  const measured = playable.map((slice) => measureSlice(recording, slice));
  const loudest = Math.max(...measured.map(({ peak }) => peak));
  const { channels, frames } = measured
    .filter(({ peak }) => peak >= loudest * SLICE_NEAR_LOUDEST)
    .reduce((best, slice) => (slice.frames > best.frames ? slice : best));
  const fade = Math.round(SLICE_FADE_SECONDS * rate);
  const fadeIn = Math.round(SLICE_FADE_IN_SECONDS * rate);
  const length = Math.max(1, Math.min(frames + fade, channels[0].length));
  const buffer = Tone.getContext().createBuffer(channels.length, length, rate) as unknown as AudioBuffer;
  channels.forEach((channel, c) => {
    const cut = channel.slice(0, length);
    for (let i = 0; i < Math.min(fadeIn, length); i++) cut[i] *= i / fadeIn;
    for (let i = Math.max(0, length - fade); i < length; i++) cut[i] *= (length - i) / fade;
    buffer.copyToChannel(cut, c);
  });
  return buffer;
}

// Decoded sounds, shared by every instrument that plays them
const decoded = new Map<string, Promise<AudioBuffer>>();
const slicedKey = (url: string, slices: SampleSlice[]) => `${url}#${slices[0].offset}:${slices.length}`;

// Cuts the sounds not cut yet, one recording at a time: a song's recordings
// are long, and only the sounds are kept
async function cutSounds(sounds: SampleSound[]) {
  const missing = sounds.flatMap((sound) =>
    'url' in sound && sound.slices && !decoded.has(slicedKey(sound.url, sound.slices))
      ? [{ url: sound.url, slices: sound.slices, note: 'root' in sound ? (sound.root as number) : undefined }]
      : []
  );
  for (const url of new Set(missing.map((sound) => sound.url))) {
    const recording = await decodeFile(url);
    for (const sound of missing) {
      if (sound.url === url) decoded.set(slicedKey(url, sound.slices), Promise.resolve(cutSound(recording, sound.slices, sound.note)));
    }
  }
}

function loadSound(sound: SampleSound, key: string): Promise<AudioBuffer> {
  if ('url' in sound) key = sound.slices ? slicedKey(sound.url, sound.slices) : sound.url;
  if (!decoded.has(key)) {
    decoded.set(
      key,
      (async () => {
        const context = Tone.getContext();
        if ('url' in sound) return decodeFile(sound.url);
        const channels = sound.make();
        const buffer = context.createBuffer(channels.length, channels[0].length, context.sampleRate) as unknown as AudioBuffer;
        channels.forEach((channel, c) => buffer.copyToChannel(channel as Float32Array<ArrayBuffer>, c));
        return buffer;
      })()
    );
  }
  return decoded.get(key)!;
}

interface Voice {
  note: number;
  source: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  amp: GainNode;
  released: boolean;
}

export class Sampler implements LiveInstrument {
  readonly output = new Tone.Gain();
  readonly ready: Promise<void>;
  private buffers: AudioBuffer[] = [];
  private roots: number[] = [];
  // Brings the instrument to the reference sounds' loudness
  private loudness = 1;
  private voices: Voice[] = [];
  private params: ParamValues;
  private readonly specs: ParamSpec[];

  constructor(private readonly source: SamplerSource, params: ParamValues, key: string) {
    this.specs = source.kind === 'notes' ? SAMPLER_NOTE_PARAMS : SAMPLER_PAD_PARAMS;
    this.params = params;
    this.ready = this.load(key);
  }

  private async load(key: string) {
    const sounds = this.source.kind === 'notes' ? this.source.notes : this.source.pads;
    await cutSounds(sounds);
    const buffers = await Promise.all(sounds.map((sound, i) => loadSound(sound, `${key}:${i}`)));
    // A sound cut from a recording may never be heard in it (its notes muted
    // all along, or always under others): it takes no row or key of its own
    const heard = buffers.map((buffer, i) => !('slices' in sounds[i]) || channelsOf(buffer).some((channel) => channel.some((value) => Math.abs(value) > SLICE_SILENT)));
    this.buffers = buffers.filter((_, i) => heard[i]);
    if (this.source.kind === 'notes') this.roots = this.source.notes.filter((_, i) => heard[i]).map((note) => note.root);
    // Judged by the median sound, as the clips were (matchJamLoudness)
    const levels = this.buffers.map((buffer) => jamLoudness(channelsOf(buffer), buffer.sampleRate)).sort((a, b) => a - b);
    this.loudness = 10 ** ((JAM_SOUND_LOUDNESS - levels[Math.floor(levels.length / 2)]) / 20);
  }

  private value(key: string) {
    return paramValue(this.specs, this.params, key);
  }

  // Sounding notes follow the filter as it changes
  setParams(params: ParamValues) {
    this.params = params;
    const now = Tone.getContext().currentTime;
    for (const voice of this.voices) {
      voice.filter.frequency.setTargetAtTime(this.value('cutoff'), now, 0.02);
      voice.filter.Q.setTargetAtTime(this.value('resonance'), now, 0.02);
    }
  }

  noteOn(note: number, velocity: number, time: number) {
    if (!this.buffers.length) return;
    const context = Tone.getContext();
    const at = Math.max(time, context.currentTime);
    let buffer: AudioBuffer;
    let rate: number;
    if (this.source.kind === 'pads') {
      const pad = note - PAD_BASE_NOTE;
      if (pad < 0) return;
      buffer = this.buffers[pad % this.buffers.length];
      rate = 2 ** (this.value('tune') / 12);
      // The same pad cut short by its next hit
      if (this.source.choke) this.voices.filter((voice) => voice.note === note).forEach((voice) => this.stop(voice, at, 0.005));
    } else {
      const played = note + 12 * this.value('octave') + this.value('tune');
      const nearest = this.roots.reduce((best, root, i) => (Math.abs(root - played) < Math.abs(this.roots[best] - played) ? i : best), 0);
      buffer = this.buffers[nearest];
      rate = 2 ** ((played - this.roots[nearest] + this.value('fine') / 100) / 12);
    }
    const touch = this.value('velocity');
    const peak = this.loudness * this.value('gain') * (1 - touch + touch * (velocity / 127));
    const source = context.createBufferSource() as unknown as AudioBufferSourceNode;
    source.buffer = buffer;
    source.playbackRate.value = rate;
    const filter = context.createBiquadFilter() as unknown as BiquadFilterNode;
    filter.type = 'lowpass';
    filter.frequency.value = this.value('cutoff');
    filter.Q.value = this.value('resonance');
    const amp = context.createGain() as unknown as GainNode;
    source.connect(filter);
    filter.connect(amp);
    Tone.connect(amp as unknown as Tone.OutputNode, this.output);

    if (this.source.kind === 'pads') {
      const length = (buffer.duration / rate) * this.value('length');
      amp.gain.setValueAtTime(peak, at);
      if (this.value('length') < 1) {
        amp.gain.setValueAtTime(peak, at + length * 0.8);
        amp.gain.linearRampToValueAtTime(0, at + length);
      }
      source.start(at);
      source.stop(at + length + 0.01);
    } else {
      const attack = this.value('attack');
      amp.gain.setValueAtTime(0, at);
      amp.gain.linearRampToValueAtTime(peak, at + attack);
      amp.gain.setTargetAtTime(peak * this.value('sustain'), at + attack, this.value('decay') / 4);
      source.start(at);
    }
    const voice: Voice = { note, source, filter, amp, released: false };
    this.voices.push(voice);
    source.onended = () => {
      this.voices = this.voices.filter((other) => other !== voice);
      amp.disconnect();
    };
  }

  private stop(voice: Voice, time: number, release: number) {
    voice.released = true;
    const gain = voice.amp.gain as AudioParam & { cancelAndHoldAtTime?: (time: number) => void };
    if (gain.cancelAndHoldAtTime) gain.cancelAndHoldAtTime(time);
    else gain.cancelScheduledValues(time);
    gain.setTargetAtTime(0, time, release / 4);
    try {
      voice.source.stop(time + release * 1.5 + 0.02);
    } catch {
      // already stopped
    }
  }

  noteOff(note: number, time: number) {
    // Kits play their sounds through; notes release
    if (this.source.kind === 'pads') return;
    const voice = this.voices.find((candidate) => candidate.note === note && !candidate.released);
    if (voice) this.stop(voice, Math.max(time, Tone.getContext().currentTime), this.value('release'));
  }

  allOff() {
    const now = Tone.getContext().currentTime;
    this.voices.forEach((voice) => this.stop(voice, now, 0.02));
  }

  dispose() {
    this.allOff();
    this.output.dispose();
  }
}
