import * as Tone from 'tone';
import { JamPingPong } from '../jamPingPong';
import type { EffectKind, EffectSlot, ParamSpec, ParamValues } from './types';
import { paramValue } from './types';

// The effects a track's chain can hold, with their parameters

const p = (key: string, label: string, min: number, max: number, step: number, value: number, options?: string[]): ParamSpec => ({
  key,
  label,
  min,
  max,
  step,
  default: value,
  ...(options ? { options } : {}),
});
const MIX = p('mix', 'Mix', 0, 1, 0.01, 0.35);

export const ECHO_TIMES = ['1/16', '1/8', '1/8.', '1/4', '1/4.', '1/2'];
const ECHO_BEATS = [0.25, 0.5, 0.75, 1, 1.5, 2];
const FILTER_TYPES: BiquadFilterType[] = ['lowpass', 'highpass', 'bandpass', 'notch'];

export const EFFECTS: Record<EffectKind, { label: string; params: ParamSpec[] }> = {
  eq: {
    label: 'EQ',
    params: [p('low', 'Low', -24, 12, 0.5, 0), p('mid', 'Mid', -24, 12, 0.5, 0), p('high', 'High', -24, 12, 0.5, 0)],
  },
  filter: {
    label: 'Filter',
    params: [
      p('type', 'Type', 0, 3, 1, 0, ['Low-pass', 'High-pass', 'Band-pass', 'Notch']),
      p('frequency', 'Frequency', 40, 18000, 1, 2400),
      p('q', 'Resonance', 0.1, 18, 0.1, 1),
    ],
  },
  drive: { label: 'Drive', params: [p('amount', 'Amount', 0, 1, 0.01, 0.4), { ...MIX, default: 1 }] },
  crusher: { label: 'Bit crusher', params: [p('bits', 'Bits', 1, 16, 1, 6), { ...MIX, default: 1 }] },
  chorus: {
    label: 'Chorus',
    params: [p('rate', 'Rate', 0.1, 8, 0.1, 1.5), p('depth', 'Depth', 0, 1, 0.01, 0.6), { ...MIX, default: 0.5 }],
  },
  phaser: {
    label: 'Phaser',
    params: [p('rate', 'Rate', 0.05, 8, 0.05, 0.5), p('octaves', 'Octaves', 0.5, 6, 0.5, 3), { ...MIX, default: 0.5 }],
  },
  tremolo: { label: 'Tremolo', params: [p('rate', 'Rate', 0.5, 16, 0.1, 5), p('depth', 'Depth', 0, 1, 0.01, 0.6)] },
  autopan: { label: 'Auto-pan', params: [p('rate', 'Rate', 0.05, 8, 0.05, 0.5), p('depth', 'Depth', 0, 1, 0.01, 0.8)] },
  compressor: {
    label: 'Compressor',
    params: [p('threshold', 'Threshold', -60, 0, 1, -20), p('ratio', 'Ratio', 1, 20, 0.5, 4)],
  },
  delay: {
    label: 'Echo',
    params: [p('time', 'Time', 0, ECHO_TIMES.length - 1, 1, 2, ECHO_TIMES), p('feedback', 'Feedback', 0, 0.9, 0.01, 0.5), { ...MIX, default: 0.25 }],
  },
  reverb: { label: 'Reverb', params: [p('size', 'Size', 0.3, 10, 0.1, 2.5), { ...MIX, default: 0.3 }] },
};

export const effectSlot = (kind: EffectKind, params: ParamValues = {}, on = true): EffectSlot => ({ kind, on, params });

// A built effect: its input and output, and how its parameters are set
interface BuiltEffect {
  input: Tone.InputNode;
  output: Tone.ToneAudioNode;
  set(params: ParamValues, bpm: number): void;
  dispose(): void;
}

// An effect with a dry/wet mix around a Tone effect
function single<T extends Tone.ToneAudioNode & { wet?: Tone.Signal<'normalRange'> }>(
  node: T,
  set: (node: T, value: (key: string) => number, bpm: number) => void,
  kind: EffectKind
): BuiltEffect {
  return {
    input: node,
    output: node,
    set(params, bpm) {
      const value = (key: string) => paramValue(EFFECTS[kind].params, params, key);
      set(node, value, bpm);
      if (node.wet && EFFECTS[kind].params.some((spec) => spec.key === 'mix')) node.wet.value = value('mix');
    },
    dispose: () => node.dispose(),
  };
}

function build(kind: EffectKind): BuiltEffect {
  switch (kind) {
    case 'eq':
      return single(new Tone.EQ3(), (node, v) => {
        node.low.value = v('low');
        node.mid.value = v('mid');
        node.high.value = v('high');
      }, kind);
    case 'filter':
      return single(new Tone.Filter({ rolloff: -24 }), (node, v) => {
        node.type = FILTER_TYPES[Math.round(v('type'))] ?? 'lowpass';
        node.frequency.value = v('frequency');
        node.Q.value = v('q');
      }, kind);
    case 'drive':
      return single(new Tone.Distortion({ oversample: '2x' }), (node, v) => {
        node.distortion = v('amount');
      }, kind);
    case 'crusher':
      return single(new Tone.BitCrusher(6), (node, v) => {
        node.bits.value = v('bits');
      }, kind);
    case 'chorus':
      return single(new Tone.Chorus().start(), (node, v) => {
        node.frequency.value = v('rate');
        node.depth = v('depth');
      }, kind);
    case 'phaser':
      return single(new Tone.Phaser(), (node, v) => {
        node.frequency.value = v('rate');
        node.octaves = v('octaves');
      }, kind);
    case 'tremolo':
      return single(new Tone.Tremolo().start(), (node, v) => {
        node.frequency.value = v('rate');
        node.depth.value = v('depth');
      }, kind);
    case 'autopan':
      return single(new Tone.AutoPanner().start(), (node, v) => {
        node.frequency.value = v('rate');
        node.depth.value = v('depth');
      }, kind);
    case 'compressor':
      return single(new Tone.Compressor(), (node, v) => {
        node.threshold.value = v('threshold');
        node.ratio.value = v('ratio');
      }, kind);
    case 'reverb':
      return single(new Tone.Reverb(), (node, v) => {
        // A new size makes a new impulse response: only when it changed
        if (Math.abs(Number(node.decay) - v('size')) > 1e-6) node.decay = v('size');
      }, kind);
    case 'delay': {
      // The Jam's ping-pong echo, its time a fraction of a beat at the song's tempo
      const echo = new JamPingPong();
      return {
        input: echo.input,
        output: echo.output,
        set(params, bpm) {
          const value = (key: string) => paramValue(EFFECTS.delay.params, params, key);
          echo.delayTime = (ECHO_BEATS[Math.round(value('time'))] ?? 0.75) * (60 / bpm);
          echo.feedback = value('feedback');
          echo.wet = value('mix');
        },
        dispose: () => echo.dispose(),
      };
    }
  }
}

// A track's effects chain between `input` and `output`. Changing which effects
// there are rebuilds the chain; changing their parameters only sets them.
export class EffectsChain {
  readonly input = new Tone.Gain();
  readonly output = new Tone.Gain();
  private built: BuiltEffect[] = [];
  private shape = '';
  private bpm = 120;

  constructor(slots: EffectSlot[] = []) {
    this.set(slots);
  }

  set(slots: EffectSlot[], bpm = this.bpm) {
    this.bpm = bpm;
    const active = slots.filter((slot) => slot.on);
    const shape = active.map((slot) => slot.kind).join(',');
    if (shape !== this.shape) {
      this.input.disconnect();
      this.built.forEach((effect) => effect.dispose());
      this.built = active.map((slot) => build(slot.kind));
      const nodes = [this.input, ...this.built.flatMap((effect) => [effect.input, effect.output]), this.output];
      // input -> e1.in, e1.out -> e2.in, ... -> output
      for (let i = 0; i < nodes.length; i += 2) Tone.connect(nodes[i] as Tone.OutputNode, nodes[i + 1] as Tone.InputNode);
      this.shape = shape;
    }
    active.forEach((slot, i) => this.built[i].set(slot.params, bpm));
  }

  dispose() {
    this.built.forEach((effect) => effect.dispose());
    this.input.dispose();
    this.output.dispose();
  }
}
