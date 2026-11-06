import type * as Tone from 'tone';

// Live instruments: notes started and stopped as they are played (in the Jam)
// or scheduled (in the Daw), each instrument with its own parameters, several
// presets and an effects chain on its track.

// One parameter of an instrument or an effect. A parameter with `options` is a
// choice: its value is the index of the chosen option.
export interface ParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  options?: string[];
  // Shown under this heading in the instrument's panel
  group?: string;
}
export type ParamValues = Record<string, number>;

export const EFFECT_KINDS = [
  'eq',
  'filter',
  'drive',
  'crusher',
  'chorus',
  'phaser',
  'tremolo',
  'autopan',
  'compressor',
  'delay',
  'reverb',
] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];

// One effect in a track's chain, in order from the instrument to the mixer
export interface EffectSlot {
  kind: EffectKind;
  on: boolean;
  params: ParamValues;
}

export interface Preset {
  id: string;
  name: string;
  // The kind of sound it is, for a synth's presets: Lead, Pad, Bass...
  tag?: string;
  // Values for the instrument's parameters; the rest keep their defaults
  params: ParamValues;
  effects: EffectSlot[];
}

export type EngineId = 'melodics-synth' | 'sampler';

// A pad instrument plays one sound per pad: pad i on note PAD_BASE_NOTE + i
export const PAD_BASE_NOTE = 36;

export interface InstrumentDef {
  id: string;
  name: string;
  // Heading it is listed under: Synth, Drums, Keys, Orchestra...
  category: string;
  engine: EngineId;
  params: ParamSpec[];
  presets: Preset[];
  // The note its range is centred on: rows played in the Jam move by whole
  // octaves to sit around it. Unset: rows play at their own pitch.
  center?: number;
  // Pad instruments: each pad's name, pad 0 first
  pads?: string[];
  // What the engine plays (see engines/)
  source: unknown;
}

// What a track plays: an instrument, the preset it started from, and the
// parameters and effects as they are now
export interface InstrumentChoice {
  instrument: string;
  preset: string;
  params: ParamValues;
  effects: EffectSlot[];
}

export interface LiveInstrument {
  // `time` is in the audio context's seconds; velocity 1-127
  noteOn(note: number, velocity: number, time: number): void;
  noteOff(note: number, time: number): void;
  allOff(): void;
  setParams(params: ParamValues): void;
  readonly output: Tone.ToneAudioNode;
  // Resolves once the instrument can sound (its samples loaded, its tables built)
  readonly ready: Promise<void>;
  dispose(): void;
}

// A parameter's value in a set, else its default
export const paramValue = (specs: ParamSpec[], values: ParamValues, key: string): number =>
  values[key] ?? specs.find((spec) => spec.key === key)?.default ?? 0;

export const paramDefaults = (specs: ParamSpec[]): ParamValues =>
  Object.fromEntries(specs.map((spec) => [spec.key, spec.default]));
