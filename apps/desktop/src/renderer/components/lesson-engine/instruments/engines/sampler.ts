import * as Tone from 'tone';
import { JAM_SOUND_LOUDNESS, jamLoudness } from '../../jamLoudness';
import type { LiveInstrument, ParamSpec, ParamValues } from '../types';
import { PAD_BASE_NOTE, paramValue } from '../types';

// The sampler: recorded instruments (each played note from the nearest
// recorded one, re-pitched, through an envelope and a filter) and kits (one
// sound per pad, pad i on note PAD_BASE_NOTE + i).

// Where a sound comes from: a file's URL, or audio made on the spot (a
// synthesised drum)
export type SampleSound = { url: string } | { make: () => Float32Array[] };

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

// Decoded sounds, shared by every instrument that plays them
const decoded = new Map<string, Promise<AudioBuffer>>();
function loadSound(sound: SampleSound, key: string): Promise<AudioBuffer> {
  if ('url' in sound) key = sound.url;
  if (!decoded.has(key)) {
    decoded.set(
      key,
      (async () => {
        const context = Tone.getContext();
        if ('url' in sound) {
          const response = await fetch(sound.url);
          if (!response.ok) throw new Error(`${sound.url}: HTTP ${response.status}`);
          return (await context.decodeAudioData(await response.arrayBuffer())) as unknown as AudioBuffer;
        }
        const channels = sound.make();
        const buffer = context.createBuffer(channels.length, channels[0].length, context.sampleRate) as unknown as AudioBuffer;
        channels.forEach((channel, c) => buffer.copyToChannel(channel as Float32Array<ArrayBuffer>, c));
        return buffer;
      })()
    );
  }
  return decoded.get(key)!;
}

const channelsOf = (buffer: AudioBuffer) => Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));

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
    this.buffers = await Promise.all(sounds.map((sound, i) => loadSound(sound, `${key}:${i}`)));
    if (this.source.kind === 'notes') this.roots = this.source.notes.map((note) => note.root);
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
