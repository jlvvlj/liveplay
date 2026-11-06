import * as Tone from 'tone';
import workletUrl from '../worklets/melodicsSynth.worklet.ts?worker&url';
import { prepareJamSynthPatch } from '../../jamRenderer';
import { JAM_DEFAULT_PATCH, JAM_SYNTH_CONTROLS, SYNTH_FAMILIES, type JamSynthPatch } from '../../jamSynth';
import type { LiveInstrument, ParamSpec, ParamValues } from '../types';
import { paramValue } from '../types';

// The Melodics Synth: the Jam's synth patches played live by the
// melodics-synth worklet. Its parameters are the patch's settings; the
// waveform is a choice. Changing the waveform's shape (family, brightness,
// body, pulse width, FM) builds new wavetables in a worker; other settings
// reach the worklet straight away.

const FAMILY_KEY = 'family';
const SHAPE_KEYS = ['family', 'brightness', 'body', 'odd', 'fm', 'ratio'];

const GROUPS: Record<string, string> = {
  octave: 'Oscillator',
  brightness: 'Oscillator',
  body: 'Oscillator',
  odd: 'Oscillator',
  fm: 'Oscillator',
  ratio: 'Oscillator',
  detune: 'Oscillator',
  attack: 'Envelope',
  decay: 'Envelope',
  sustain: 'Envelope',
  hold: 'Envelope',
  release: 'Envelope',
  keyDecay: 'Envelope',
  cutoff: 'Filter',
  cutoffEnd: 'Filter',
  sweepTime: 'Filter',
  resonance: 'Filter',
  drive: 'Colour',
  vowel: 'Colour',
  vibrato: 'Colour',
  gain: 'Output',
};

export const MELODICS_SYNTH_PARAMS: ParamSpec[] = [
  {
    key: FAMILY_KEY,
    label: 'Waveform',
    min: 0,
    max: SYNTH_FAMILIES.length - 1,
    step: 1,
    default: SYNTH_FAMILIES.indexOf(JAM_DEFAULT_PATCH.family),
    options: SYNTH_FAMILIES.map((family) => (family === 'fm' ? 'FM' : family[0].toUpperCase() + family.slice(1))),
    group: 'Oscillator',
  },
  ...JAM_SYNTH_CONTROLS.map((control) => ({
    key: control.key,
    label: control.key === 'hold' ? 'Shortest note' : control.label,
    min: control.min,
    max: control.max,
    step: control.step,
    default: JAM_DEFAULT_PATCH[control.key] as number,
    group: GROUPS[control.key],
  })),
];

// A patch's settings as parameter values, and back
export const patchParams = (patch: JamSynthPatch): ParamValues =>
  Object.fromEntries(
    MELODICS_SYNTH_PARAMS.map((spec) => [
      spec.key,
      spec.key === FAMILY_KEY ? SYNTH_FAMILIES.indexOf(patch.family) : (patch[spec.key as keyof JamSynthPatch] as number),
    ])
  );
export const paramsPatch = (params: ParamValues): JamSynthPatch => {
  const value = (key: string) => paramValue(MELODICS_SYNTH_PARAMS, params, key);
  return {
    ...Object.fromEntries(MELODICS_SYNTH_PARAMS.map((spec) => [spec.key, value(spec.key)])),
    family: SYNTH_FAMILIES[Math.round(value(FAMILY_KEY))] ?? JAM_DEFAULT_PATCH.family,
  } as JamSynthPatch;
};

// The worklet module, added once to the audio context Tone plays through
let added: Promise<void> | null = null;
function addWorklet(): Promise<void> {
  added ??= (Tone.getContext().rawContext as unknown as BaseAudioContext).audioWorklet.addModule(workletUrl);
  return added;
}

export class MelodicsSynth implements LiveInstrument {
  readonly output = new Tone.Gain();
  readonly ready: Promise<void>;
  private node: AudioWorkletNode | null = null;
  private patch: JamSynthPatch;
  private shape = '';
  private token = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(params: ParamValues) {
    this.patch = paramsPatch(params);
    this.ready = this.start();
  }

  private async start() {
    await addWorklet();
    if (this.disposed) return;
    this.node = Tone.getContext().createAudioWorkletNode('melodics-synth', {
      numberOfInputs: 0,
      outputChannelCount: [2],
    }) as unknown as AudioWorkletNode;
    Tone.connect(this.node as unknown as Tone.OutputNode, this.output);
    await this.send();
  }

  // The patch to the worklet, with new wavetables when the waveform's shape changed
  private async send() {
    const token = ++this.token;
    const patch = this.patch;
    const shape = JSON.stringify(SHAPE_KEYS.map((key) => patch[key as keyof JamSynthPatch]));
    const withTables = shape !== this.shape;
    const prepared = await prepareJamSynthPatch(patch, Tone.getContext().sampleRate, withTables);
    if (token !== this.token || !this.node) return;
    if (withTables) this.shape = shape;
    this.node.port.postMessage(
      { type: 'patch', patch, gain: prepared.gain, tables: prepared.tables },
      (prepared.tables ?? []).map((table) => table.buffer)
    );
  }

  setParams(params: ParamValues) {
    this.patch = paramsPatch(params);
    clearTimeout(this.timer);
    // Slider drags send their latest value, a little after they stop
    this.timer = setTimeout(() => {
      if (this.node) void this.send();
    }, 40);
  }

  noteOn(note: number, velocity: number, time: number) {
    this.node?.port.postMessage({ type: 'on', note, velocity, time });
  }

  noteOff(note: number, time: number) {
    this.node?.port.postMessage({ type: 'off', note, time });
  }

  allOff() {
    this.node?.port.postMessage({ type: 'allOff' });
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.node?.disconnect();
    this.output.dispose();
  }
}
