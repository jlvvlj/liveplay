import { envelope, hz, patchData, type SynthPatch } from '../../../../../../../../instrument-lab/engine/synth.mjs';

// The Melodics Synth played live: the Instrument Lab oscillator and envelope
// with the Jam extras (filter sweep, resonance, vibrato, vowel, drive, shorter
// notes up high), one voice per note, started and released at the audio times
// the messages give. Same sound as renderJamClip (jamSynth.ts), note for note.

declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

interface Extras {
  hold: number;
  octave: number;
  drive: number;
  cutoff: number;
  cutoffEnd: number;
  sweepTime: number;
  resonance: number;
  vibrato: number;
  vowel: number;
  keyDecay: number;
}
type Patch = SynthPatch & Extras;

type Message =
  // The sound: its patch, the loudness gain that brings it to the reference
  // sounds' level, and its wavetables (one per MIDI pitch) when they changed
  | { type: 'patch'; patch: Patch; gain: number; tables?: Float32Array[] }
  | { type: 'on'; note: number; velocity: number; time: number }
  | { type: 'off'; note: number; time: number }
  | { type: 'allOff' };

const FILTER_OPEN = 32;
const OUTPUT_GAIN = 2.6;
const VIBRATO_HZ = 5.5;
const VIBRATO_FADE_IN = 1.5;
const VOWEL_FORMANTS: [number, number][] = [
  [730, 1],
  [1090, 0.5],
];
const VOWEL_Q = 6;
const CONTROL_BLOCK = 32;
const MAX_VOICES = 32;
// A stolen voice fades out over this long (seconds)
const STEAL_FADE = 0.008;

class StateVariableFilter {
  private ic1 = 0;
  private ic2 = 0;
  private g = 0;
  private a1 = 1;
  low = 0;
  band = 0;
  tune(cutoff: number, k: number) {
    this.g = Math.tan((Math.PI * Math.min(cutoff, sampleRate * 0.45)) / sampleRate);
    this.a1 = 1 / (1 + this.g * (this.g + k));
  }
  process(x: number) {
    const v1 = this.a1 * (this.ic1 + this.g * (x - this.ic2));
    const v2 = this.ic2 + this.g * v1;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.low = v2;
    this.band = v1;
  }
}

const LIVE_KEYS = ['cutoff', 'cutoffEnd', 'sweepTime', 'resonance', 'vibrato', 'vowel', 'drive'] as const;
const pick = (patch: Patch, keys: readonly (keyof Patch)[]) => Object.fromEntries(keys.map((key) => [key, patch[key]]));

class Voice {
  private age = 0; // samples
  private gate = Infinity; // seconds after the start when the note was released
  private fade = 1;
  private fadeStep = 0;
  private phase = 0;
  private phase2 = 0;
  private bend = 1;
  private readonly p: SynthPatch;
  private readonly played: number;
  private readonly size: number;
  private readonly step: number;
  private readonly detuneRatio: number;
  private filtered = false;
  private readonly filters = [new StateVariableFilter(), new StateVariableFilter()];
  private readonly formants = VOWEL_FORMANTS.map(([frequency]) => {
    const formant = new StateVariableFilter();
    formant.tune(frequency, 1 / VOWEL_Q);
    return formant;
  });
  private k = 2;
  private drives = 0;
  done = false;

  constructor(
    readonly note: number,
    private readonly velocity: number,
    private patch: Patch,
    private readonly table: Float32Array,
    private readonly gain: number
  ) {
    this.played = note + 12 * Math.round(patch.octave);
    const lengthScale = 2 ** ((-(this.played - 69) / 12) * patch.keyDecay);
    this.p = patchData({ ...patch, decay: patch.decay * lengthScale, release: patch.release * lengthScale });
    this.size = table.length - 1;
    this.step = (hz(this.played) / sampleRate) * this.size;
    this.detuneRatio = 2 ** (this.p.detune / 1200);
    this.colour(patch);
  }

  // The settings a sounding note follows as they change: filter, resonance,
  // vibrato, vowel, drive (its pitch, shape and envelope stay as it started)
  colour(patch: Patch) {
    this.patch = { ...this.patch, ...pick(patch, LIVE_KEYS) };
    this.filtered = this.patch.cutoff < FILTER_OPEN || this.patch.cutoffEnd < FILTER_OPEN;
    this.k = 2 - 1.9 * this.patch.resonance;
    this.drives = this.patch.drive > 0 ? 1 + this.patch.drive * 6 : 0;
  }

  get released() {
    return this.gate !== Infinity;
  }

  // Released now, but never before the patch's shortest length (`hold`)
  release() {
    if (!this.released) this.gate = Math.max(this.age / sampleRate, this.patch.hold);
  }

  steal() {
    this.fadeStep = 1 / Math.max(1, STEAL_FADE * sampleRate);
  }

  private read(phase: number) {
    const i = Math.floor(phase);
    const f = phase - i;
    return this.table[i] * (1 - f) + this.table[i + 1] * f;
  }

  sample(): number {
    const { patch, p } = this;
    const t = this.age / sampleRate;
    if (this.age % CONTROL_BLOCK === 0) {
      if (patch.vibrato) this.bend = 2 ** ((patch.vibrato * Math.min(1, t / VIBRATO_FADE_IN) * Math.sin(2 * Math.PI * VIBRATO_HZ * t)) / 1200);
      if (this.filtered) {
        const frequency = patch.cutoff * (patch.cutoffEnd / patch.cutoff) ** Math.min(1, t / patch.sweepTime) * hz(this.played);
        this.filters[0].tune(frequency, Math.SQRT2);
        this.filters[1].tune(frequency, this.k);
      }
    }
    let x = this.read(this.phase);
    this.phase = (this.phase + this.step * this.bend) % this.size;
    if (p.detune > 0) {
      x = (x + this.read(this.phase2)) * 0.5;
      this.phase2 = (this.phase2 + this.step * this.bend * this.detuneRatio) % this.size;
    }
    x *= envelope(p, t, this.gate) * (this.velocity / 127);
    if (this.filtered) {
      this.filters[0].process(x);
      this.filters[1].process(this.filters[0].low);
      x = this.filters[1].low;
    }
    if (patch.vowel > 0) {
      let voiced = 0;
      for (let f = 0; f < this.formants.length; f++) {
        this.formants[f].process(x);
        voiced += (this.formants[f].band / VOWEL_Q) * VOWEL_FORMANTS[f][1];
      }
      x = x * (1 - patch.vowel) + voiced * patch.vowel * 2;
    }
    if (this.drives) x = (Math.tanh((x * this.drives) / 0.3) * 0.3) / Math.tanh(this.drives);
    if (this.fadeStep) {
      this.fade -= this.fadeStep;
      if (this.fade <= 0) this.done = true;
    }
    this.age++;
    if (t > this.gate + 1.5 * p.release + 0.05) this.done = true;
    return x * p.gain * OUTPUT_GAIN * this.gain * Math.max(0, this.fade);
  }
}

class MelodicsSynthProcessor extends AudioWorkletProcessor {
  private patch: Patch | null = null;
  private gain = 1;
  private tables: Float32Array[] = [];
  private voices: Voice[] = [];
  // Notes waiting for their time, oldest first
  private queue: Message[] = [];

  constructor() {
    super();
    this.port.onmessage = ({ data }: MessageEvent<Message>) => {
      if (data.type === 'patch') {
        this.patch = data.patch;
        this.gain = data.gain;
        if (data.tables) this.tables = data.tables;
        for (const voice of this.voices) voice.colour(data.patch);
      } else if (data.type === 'allOff') {
        this.queue = [];
        this.voices.forEach((voice) => voice.steal());
      } else {
        this.queue.push(data);
        this.queue.sort((a, b) => ('time' in a ? a.time : 0) - ('time' in b ? b.time : 0));
      }
    };
  }

  private handle(message: Message) {
    if (message.type === 'on') {
      const pitch = message.note + 12 * Math.round(this.patch?.octave ?? 0);
      const table = this.tables[Math.max(0, Math.min(127, pitch))];
      if (!this.patch || !table) return;
      const sounding = this.voices.filter((voice) => !voice.done);
      if (sounding.length >= MAX_VOICES) (sounding.find((voice) => voice.released) ?? sounding[0]).steal();
      this.voices.push(new Voice(message.note, message.velocity, this.patch, table, this.gain));
    } else if (message.type === 'off') {
      // The oldest voice of that note still held
      this.voices.find((voice) => voice.note === message.note && !voice.released && !voice.done)?.release();
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const [left, right] = outputs[0];
    for (let i = 0; i < left.length; i++) {
      const now = currentTime + i / sampleRate;
      while (this.queue.length && 'time' in this.queue[0] && this.queue[0].time <= now) this.handle(this.queue.shift()!);
      let x = 0;
      for (const voice of this.voices) if (!voice.done) x += voice.sample();
      left[i] = x;
      if (right) right[i] = x;
    }
    if (this.voices.some((voice) => voice.done)) this.voices = this.voices.filter((voice) => !voice.done);
    return true;
  }
}

registerProcessor('melodics-synth', MelodicsSynthProcessor);
