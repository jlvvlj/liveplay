import {
  DEFAULT_PATCH,
  PARAMS,
  FAMILIES,
  encodeWav,
  envelope,
  hz,
  makeTable,
  patchData,
  type SynthFamily,
  type SynthParam,
  type SynthPatch,
} from '../../../../../../instrument-lab/engine/synth.mjs';
import { prepareDrum, type DrumPatchData } from '../../../../../../instrument-lab/engine/drums.mjs';

// Jam tab sounds: Instrument Lab synth patches and drums rendered in the
// browser into one short clip per note, so every setting can be changed live.

export type { SynthFamily };

// Settings the Jam tab adds on top of the Instrument Lab synth
export interface JamSynthExtras {
  hold: number; // how long each note is held before its release starts (seconds)
  octave: number; // octaves above (+) or below (-) the row's pitch
  drive: number; // 0-1 saturation
  cutoff: number; // 4-pole low-pass filter at the start of the note, in harmonics of the note
  cutoffEnd: number; // where the filter has moved to after `sweepTime`
  sweepTime: number; // seconds
  resonance: number; // 0-1
  vibrato: number; // depth in cents, fading in over the first 1.5 seconds
  vowel: number; // 0-1 mix of an "ah" vowel's formants
  keyDecay: number; // 0-1: higher notes die away faster, lower ones ring longer
}
export type JamSynthPatch = SynthPatch & JamSynthExtras;
export type JamSynthKey = SynthParam | keyof JamSynthExtras;

// One drum: layers of the Instrument Lab drum engine, each `delay` seconds in
// and narrowed to a band around `band` Hz (width set by `q`) if set, scaled so
// the drum peaks at `level`, and stopped after `cut` seconds if set
export type JamDrumLayer = DrumPatchData & { delay?: number; band?: number; q?: number };
export interface JamDrum {
  level: number;
  layers: JamDrumLayer[];
  cut?: number;
}

export type JamSoundPreset =
  | { id: string; label: string; patch: JamSynthPatch }
  // A kit plays one drum per row, from the lowest row up
  | { id: string; label: string; kit: JamDrum[] };

const SAMPLE_RATE = 44100;
const VELOCITY = 110;
// Fixed boost from the engine's level to the clip; presets set `gain` so their
// loudest note peaks near 0.8
const OUTPUT_GAIN = 2.6;
// A cutoff this many harmonics up leaves the sound unfiltered
export const JAM_FILTER_OPEN = 32;
const VIBRATO_HZ = 5.5;
const VIBRATO_FADE_IN = 1.5;
// "ah": first two formants (Hz) and the second one's level
const VOWEL_FORMANTS: [number, number][] = [
  [730, 1],
  [1090, 0.5],
];
const VOWEL_Q = 6;

const JAM_EXTRAS: JamSynthExtras = {
  hold: 0.1,
  octave: 0,
  drive: 0,
  cutoff: JAM_FILTER_OPEN,
  cutoffEnd: JAM_FILTER_OPEN,
  sweepTime: 0.3,
  resonance: 0,
  vibrato: 0,
  vowel: 0,
  keyDecay: 0,
};

const preset = (id: string, label: string, patch: Partial<JamSynthPatch>): JamSoundPreset => ({
  id,
  label,
  patch: { ...DEFAULT_PATCH, detune: 0, ...JAM_EXTRAS, ...patch },
});

// Drum layer shorthand: engine model, then the patch's other settings
const hit = (model: DrumPatchData['model'], extra: Omit<JamDrumLayer, 'model'> = {}): JamDrumLayer => ({
  model,
  ...extra,
});
const drum = (level: number, ...layers: JamDrum['layers']): JamDrum => ({ level, layers });
const gated = (cut: number, sound: JamDrum): JamDrum => ({ ...sound, cut });
// A cut drum fades out over this long (seconds)
const CUT_FADE = 0.005;

export const JAM_SOUND_PRESETS: JamSoundPreset[] = [
  // Chiptune: plain square wave held flat, then cut short
  preset('square-stab', '8-bit stab', { family: 'square', brightness: 1, body: 0, attack: 0.002, decay: 2, sustain: 1, release: 0.04, gain: 1.45, hold: 0.16 }),
  // Chiptune lead: held square wave
  preset('chip', 'Chip lead', { family: 'square', brightness: 0.6, body: 0.1, attack: 0.005, decay: 0.3, sustain: 0.55, release: 0.1, detune: 6, gain: 1.5, hold: 0.25 }),
  // Two octaves down: a saturated square, its filter closing fast
  preset('dist-bass', 'Dist bass', { family: 'square', octave: -2, brightness: 1, body: 0.3, attack: 0.003, decay: 2, sustain: 1, release: 0.22, gain: 1.03, hold: 0.22, drive: 0.8, cutoff: 32, cutoffEnd: 7, sweepTime: 0.2, resonance: 0.2 }),
  // An octave down: a long, buzzing insect drone
  preset('bee-drone', 'Bee buzz', { family: 'saw', octave: -1, brightness: 0.8, body: 0.1, attack: 0.12, decay: 2, sustain: 1, release: 1.6, gain: 1.02, hold: 2.3 }),
  // An octave down, a resonant filter closing slowly over a long note
  preset('wah-sweep', 'Wah sweep', { family: 'saw', octave: -1, brightness: 1, body: 0, attack: 0.02, decay: 2, sustain: 1, release: 0.9, gain: 0.44, hold: 2.5, cutoff: 13, cutoffEnd: 2.5, sweepTime: 2.5, resonance: 0.97 }),
  // Sung "ah" with a vibrato that grows in
  preset('voice', 'Voice', { family: 'saw', brightness: 0.5, body: 0.3, attack: 0.05, decay: 2, sustain: 1, release: 0.75, gain: 0.85, hold: 2.6, vibrato: 30, vowel: 0.8 }),
  // FM bell: bright strike on the 4th harmonic that rings out
  preset('bell', 'Synth bell', { family: 'fm', fm: 1.8, ratio: 4, brightness: 0.65, body: 0.35, attack: 0.002, decay: 0.7, sustain: 0.02, release: 0.9, detune: 3, gain: 1.12, hold: 0.12 }),
  // An octave up: hollow FM strike (odd harmonics) ringing with a slow beat
  preset('bell-stab', 'Bell stab', { family: 'fm', octave: 1, fm: 1.3, ratio: 2, brightness: 0.9, body: 0, attack: 0.002, decay: 2, sustain: 1, release: 1.3, detune: 10, gain: 1.39, hold: 0.15 }),
  // Tiny metal comb: deep FM on the 5th harmonic, no body
  preset('musicbox', 'Music box', { family: 'fm', fm: 2.6, ratio: 5, brightness: 0.8, body: 0, attack: 0.002, decay: 0.45, sustain: 0.02, release: 0.7, gain: 0.82, hold: 0.05 }),
  // Thumb piano: round tine with a light 6th-harmonic shimmer
  preset('kalimba', 'Kalimba', { family: 'fm', fm: 1.1, ratio: 6, brightness: 0.45, body: 0.5, attack: 0.002, decay: 0.35, sustain: 0.02, release: 0.5, gain: 1.12, hold: 0.05 }),
  // Mallet on wood: a pure tone knocked, low notes ringing longer than high ones
  preset('sine-wood', 'Woody', { family: 'sine', attack: 0.008, decay: 0.33, sustain: 0.02, release: 0.5, gain: 1.19, hold: 0.05, keyDecay: 0.6 }),
  // Electric piano: 1:1 FM tine that fades slowly
  preset('epiano', 'Electric piano', { family: 'fm', fm: 1.3, ratio: 1, brightness: 0.45, body: 0.4, attack: 0.003, decay: 0.9, sustain: 0.25, release: 0.45, detune: 4, gain: 0.98, hold: 0.3 }),
  // Synth pluck: detuned saw with a fast filter-like decay
  preset('pluck', 'Synth pluck', { family: 'saw', brightness: 0.5, body: 0.2, attack: 0.002, decay: 0.22, sustain: 0.04, release: 0.25, detune: 10, gain: 1.13, hold: 0.08 }),
  // Wide, buzzy detuned saw, bright and loud
  preset('fatsaw', 'Fat saw', { family: 'saw', brightness: 0.85, body: 0.4, attack: 0.004, decay: 0.5, sustain: 0.6, release: 0.12, detune: 18, gain: 1.18, hold: 0.22 }),
  // Soft pad: dark detuned saw with slow attack and long release
  preset('pad', 'Warm pad', { family: 'saw', brightness: 0.22, body: 0.5, attack: 0.3, decay: 1.2, sustain: 0.7, release: 1, detune: 14, gain: 1.25, hold: 0.5 }),
  // Breathy flute: soft triangle that fades in
  preset('flute', 'Soft flute', { family: 'triangle', brightness: 0.25, body: 0.3, attack: 0.07, decay: 0.5, sustain: 0.75, release: 0.2, detune: 2, gain: 1.1, hold: 0.3 }),

  // Room kit, lowest row to highest: kicks, toms, snares, clap, wood, cowbell, shaker, hats, crash
  {
    id: 'groove-kit',
    label: 'Groove kit',
    kit: [
      drum(0.9, hit({ frequency: 50, sweep: 140, sweepDecay: 0.03, toneLevel: 1, toneDecay: 0.25, noiseLevel: 0.04, noiseDecay: 0.01 })),
      drum(0.85, hit({ frequency: 58, sweep: 220, sweepDecay: 0.02, toneLevel: 1, toneDecay: 0.14, noiseLevel: 0.08, noiseDecay: 0.008 }, { brightness: 0.8 })),
      drum(0.75, hit({ frequency: 82, sweep: 40, sweepDecay: 0.05, toneLevel: 1, toneDecay: 0.3, noiseLevel: 0.1, noiseDecay: 0.03 }, { brightness: 0.6 })),
      drum(0.72, hit({ frequency: 105, sweep: 45, sweepDecay: 0.05, toneLevel: 1, toneDecay: 0.26, noiseLevel: 0.1, noiseDecay: 0.03 }, { brightness: 0.6 })),
      drum(0.7, hit({ frequency: 135, sweep: 50, sweepDecay: 0.05, toneLevel: 1, toneDecay: 0.22, noiseLevel: 0.1, noiseDecay: 0.03 }, { brightness: 0.6 })),
      drum(0.68, hit({ frequency: 170, sweep: 55, sweepDecay: 0.05, toneLevel: 1, toneDecay: 0.18, noiseLevel: 0.1, noiseDecay: 0.03 }, { brightness: 0.6 })),
      drum(0.7, hit({ frequency: 190, toneLevel: 0.35, toneDecay: 0.07, noiseLevel: 0.9, noiseDecay: 0.13 }, { brightness: 0.8 })),
      drum(0.65, hit({ frequency: 230, toneLevel: 0.3, toneDecay: 0.05, noiseLevel: 1, noiseDecay: 0.08 }, { brightness: 1.1 })),
      drum(
        0.6,
        hit({ frequency: 1100, toneLevel: 0, noiseLevel: 1, noiseDecay: 0.006 }, { brightness: 0.25 }),
        hit({ frequency: 1100, toneLevel: 0, noiseLevel: 1, noiseDecay: 0.006 }, { brightness: 0.25, delay: 0.011 }),
        hit({ frequency: 1100, toneLevel: 0, noiseLevel: 1, noiseDecay: 0.12 }, { brightness: 0.25, delay: 0.022 })
      ),
      drum(0.55, hit({ frequency: 1700, toneLevel: 0.5, toneDecay: 0.018, noiseLevel: 0.4, noiseDecay: 0.02 }, { brightness: 1.2 })),
      drum(0.5, hit({ frequency: 880, sweep: 200, sweepDecay: 0.005, toneLevel: 0.8, toneDecay: 0.035, noiseLevel: 0.1, noiseDecay: 0.01 })),
      drum(
        0.45,
        hit({ frequency: 540, toneLevel: 0.7, toneDecay: 0.12, noiseLevel: 0 }, { drive: 0.3 }),
        hit({ frequency: 800, toneLevel: 0.6, toneDecay: 0.12, noiseLevel: 0 }, { drive: 0.3 })
      ),
      drum(0.35, hit({ frequency: 9000, toneLevel: 0, noiseLevel: 0.5, noiseDecay: 0.04 }, { brightness: 1.4 })),
      drum(0.4, hit({ frequency: 9000, toneLevel: 0, noiseLevel: 0.6, noiseDecay: 0.025 }, { brightness: 1.8 })),
      drum(0.38, hit({ frequency: 9000, toneLevel: 0, noiseLevel: 0.6, noiseDecay: 0.25 }, { brightness: 1.8 })),
      drum(0.4, hit({ frequency: 9000, toneLevel: 0, noiseLevel: 0.7, noiseDecay: 0.9 }, { brightness: 1.6 })),
    ],
  },
  // 8-bit kit, lowest row to highest: driven kicks, laser toms, noise snares and
  // clap, blips, coin, laser, hats, crash
  {
    id: 'chip-kit',
    label: 'Chip kit',
    kit: [
      drum(0.9, hit({ frequency: 58, sweep: 320, sweepDecay: 0.015, toneLevel: 1, toneDecay: 0.12, noiseLevel: 0.1, noiseDecay: 0.008 }, { drive: 0.3 })),
      drum(0.85, hit({ frequency: 45, sweep: 900, sweepDecay: 0.03, toneLevel: 1, toneDecay: 0.18 }, { drive: 0.5 })),
      drum(0.72, hit({ frequency: 90, sweep: 600, sweepDecay: 0.04, toneLevel: 1, toneDecay: 0.15 }, { drive: 0.4 })),
      drum(0.7, hit({ frequency: 120, sweep: 600, sweepDecay: 0.04, toneLevel: 1, toneDecay: 0.14 }, { drive: 0.4 })),
      drum(0.68, hit({ frequency: 160, sweep: 600, sweepDecay: 0.04, toneLevel: 1, toneDecay: 0.13 }, { drive: 0.4 })),
      drum(0.66, hit({ frequency: 210, sweep: 600, sweepDecay: 0.04, toneLevel: 1, toneDecay: 0.12 }, { drive: 0.4 })),
      drum(0.65, hit({ frequency: 240, toneLevel: 0.25, toneDecay: 0.04, noiseLevel: 1, noiseDecay: 0.09 }, { brightness: 1.1, drive: 0.4 })),
      drum(0.6, hit({ frequency: 300, toneLevel: 0.2, toneDecay: 0.03, noiseLevel: 1, noiseDecay: 0.05 }, { brightness: 0.6, drive: 0.6 })),
      drum(
        0.55,
        hit({ frequency: 1100, toneLevel: 0, noiseLevel: 1, noiseDecay: 0.008 }, { brightness: 0.4, drive: 0.5 }),
        hit({ frequency: 1100, toneLevel: 0, noiseLevel: 1, noiseDecay: 0.07 }, { brightness: 0.4, drive: 0.5, delay: 0.015 })
      ),
      drum(0.5, hit({ frequency: 800, toneLevel: 1, toneDecay: 0.04, noiseLevel: 0 }, { drive: 0.7 })),
      drum(0.48, hit({ frequency: 1600, toneLevel: 1, toneDecay: 0.03, noiseLevel: 0 }, { drive: 0.7 })),
      drum(
        0.45,
        hit({ frequency: 988, toneLevel: 0.8, toneDecay: 0.03, noiseLevel: 0 }, { drive: 0.5 }),
        hit({ frequency: 1319, toneLevel: 0.8, toneDecay: 0.12, noiseLevel: 0 }, { drive: 0.5, delay: 0.06 })
      ),
      drum(0.5, hit({ frequency: 300, sweep: 2500, sweepDecay: 0.06, toneLevel: 0.9, toneDecay: 0.12, noiseLevel: 0 }, { drive: 0.6 })),
      drum(0.38, hit({ frequency: 9000, toneLevel: 0, noiseLevel: 0.6, noiseDecay: 0.014 }, { brightness: 1.6, drive: 0.2 })),
      drum(0.36, hit({ frequency: 9000, toneLevel: 0, noiseLevel: 0.6, noiseDecay: 0.12 }, { brightness: 1.6, drive: 0.3 })),
      drum(0.38, hit({ frequency: 9000, toneLevel: 0, noiseLevel: 0.7, noiseDecay: 0.6 }, { brightness: 1.2, drive: 0.4 })),
    ],
  },
  // Small electronic kit, lowest row to highest, at the levels of the reference
  // drums it was measured from: kick, short snare, closed and open hats, a tick,
  // a blip, a cymbal, a shaker, a ping, two bright hats, two falling toms, a
  // snap, a driven low kick and a deep falling tom
  {
    id: 'arcade-kit',
    label: 'Arcade kit',
    kit: [
      gated(0.35, drum(0.9, hit({ frequency: 70, sweep: 260, sweepDecay: 0.02, toneLevel: 1, toneDecay: 0.08, noiseLevel: 0.03, noiseDecay: 0.005 }, { drive: 0.5 }))),
      drum(
        0.7,
        hit({ frequency: 230, toneLevel: 0.5, toneDecay: 0.01, noiseLevel: 0 }),
        hit({ frequency: 230, toneLevel: 0, noiseLevel: 1, noiseDecay: 0.02 }, { band: 5500, q: 1.5 })
      ),
      drum(0.44, hit({ frequency: 9000, toneLevel: 0, noiseLevel: 1, noiseDecay: 0.02 }, { band: 8800, q: 3 })),
      drum(0.48, hit({ frequency: 9000, toneLevel: 0, noiseLevel: 1, noiseDecay: 0.1 }, { band: 9000, q: 3 })),
      drum(0.57, hit({ frequency: 2400, toneLevel: 1, toneDecay: 0.008, noiseLevel: 0 })),
      gated(0.065, drum(0.69, hit({ frequency: 790, toneLevel: 1, toneDecay: 0.04, noiseLevel: 0 }))),
      gated(0.76, drum(0.57, hit({ frequency: 9000, toneLevel: 0, noiseLevel: 1, noiseDecay: 0.2 }, { band: 5600, q: 4 }))),
      gated(0.27, drum(0.59, hit({ frequency: 9000, toneLevel: 0, noiseLevel: 1, noiseDecay: 0.2 }, { band: 3900, q: 4 }))),
      gated(0.07, drum(0.72, hit({ frequency: 5860, toneLevel: 1, toneDecay: 0.025, noiseLevel: 0 }))),
      drum(
        0.62,
        hit({ frequency: 9000, toneLevel: 0, noiseLevel: 1, noiseDecay: 0.015 }, { band: 8300, q: 3 }),
        hit({ frequency: 9000, toneLevel: 0, noiseLevel: 0.6, noiseDecay: 0.07 }, { band: 11000, q: 3 })
      ),
      drum(0.33, hit({ frequency: 9000, toneLevel: 0, noiseLevel: 1, noiseDecay: 0.08 }, { band: 12500, q: 3 })),
      gated(0.06, drum(0.3, hit({ frequency: 700, sweep: 1200, sweepDecay: 0.025, toneLevel: 1, toneDecay: 0.05, noiseLevel: 0 }, { drive: 0.4 }))),
      gated(0.13, drum(0.33, hit({ frequency: 300, sweep: 680, sweepDecay: 0.06, toneLevel: 1, toneDecay: 0.2, noiseLevel: 0 }, { drive: 0.4 }))),
      gated(
        0.065,
        drum(
          0.45,
          hit({ frequency: 205, toneLevel: 0.25, toneDecay: 0.08, noiseLevel: 0 }),
          hit({ frequency: 205, toneLevel: 0, noiseLevel: 1, noiseDecay: 0.08 }, { band: 3000, q: 1.5 })
        )
      ),
      gated(
        0.13,
        drum(
          0.36,
          hit({ frequency: 80, sweep: 100, sweepDecay: 0.02, toneLevel: 1, toneDecay: 0.3, noiseLevel: 0 }, { drive: 0.8 }),
          hit({ frequency: 80, toneLevel: 0, noiseLevel: 2, noiseDecay: 0.1 }, { band: 2000, q: 1 })
        )
      ),
      gated(0.13, drum(0.25, hit({ frequency: 180, sweep: 620, sweepDecay: 0.018, toneLevel: 1, toneDecay: 0.3, noiseLevel: 0 }, { drive: 0.4 }))),
    ],
  },
];

export const SYNTH_FAMILIES: SynthFamily[] = FAMILIES;

export interface JamSynthControl {
  key: JamSynthKey;
  label: string;
  min: number;
  max: number;
  step: number;
  // Only shown for these waveforms
  families?: SynthFamily[];
}

const control = (key: SynthParam, label: string, step: number, families?: SynthFamily[]): JamSynthControl => ({
  key,
  label,
  min: PARAMS[key][0],
  max: PARAMS[key][1],
  step,
  families,
});

export const JAM_SYNTH_CONTROLS: JamSynthControl[] = [
  { key: 'octave', label: 'Octave', min: -2, max: 2, step: 1 },
  control('brightness', 'Brightness', 0.01),
  control('body', 'Body', 0.01),
  control('odd', 'Pulse width', 0.01, ['pulse']),
  control('fm', 'FM amount', 0.05, ['fm']),
  control('ratio', 'FM ratio', 1, ['fm']),
  control('attack', 'Attack', 0.001),
  control('decay', 'Decay', 0.01),
  control('sustain', 'Sustain', 0.01),
  { key: 'hold', label: 'Hold', min: 0.02, max: 3, step: 0.01 },
  control('release', 'Release', 0.01),
  { key: 'keyDecay', label: 'Shorter up high', min: 0, max: 1, step: 0.01 },
  { key: 'cutoff', label: 'Filter', min: 1, max: JAM_FILTER_OPEN, step: 0.1 },
  { key: 'cutoffEnd', label: 'Filter end', min: 1, max: JAM_FILTER_OPEN, step: 0.1 },
  { key: 'sweepTime', label: 'Filter sweep', min: 0.01, max: 3, step: 0.01 },
  { key: 'resonance', label: 'Resonance', min: 0, max: 1, step: 0.01 },
  { key: 'drive', label: 'Drive', min: 0, max: 1, step: 0.01 },
  { key: 'vowel', label: 'Vowel', min: 0, max: 1, step: 0.01 },
  { key: 'vibrato', label: 'Vibrato', min: 0, max: 100, step: 1 },
  control('detune', 'Detune', 0.5),
  control('gain', 'Level', 0.01),
];

// Topology-preserving state-variable filter (Zavalishin), one sample at a time
class StateVariableFilter {
  private ic1 = 0;
  private ic2 = 0;
  private g = 0;
  private a1 = 1;
  low = 0;
  band = 0;
  tune(cutoff: number, k: number) {
    this.g = Math.tan((Math.PI * Math.min(cutoff, SAMPLE_RATE * 0.45)) / SAMPLE_RATE);
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

// Filter sweep and vibrato move this often (samples)
const CONTROL_BLOCK = 32;

// One note of a synth patch: the Instrument Lab oscillator and envelope, then
// the Jam extras (pitch vibrato, filter sweep, vowel, drive)
export function renderJamClip(patch: JamSynthPatch, pitch: number): Float32Array {
  const { hold, octave, drive, cutoff, cutoffEnd, sweepTime, resonance, vibrato, vowel, keyDecay, ...synth } = patch;
  const played = pitch + 12 * Math.round(octave);
  const lengthScale = 2 ** ((-(played - 69) / 12) * keyDecay);
  const p = patchData({ ...synth, decay: synth.decay * lengthScale, release: synth.release * lengthScale });
  const table = makeTable(p, played, SAMPLE_RATE);
  const size = table.length - 1;
  const step = (hz(played) / SAMPLE_RATE) * size;
  const detuneRatio = 2 ** (p.detune / 1200);
  const audio = new Float32Array(Math.ceil((hold + p.release * 1.5 + 0.05) * SAMPLE_RATE));

  const filtered = cutoff < JAM_FILTER_OPEN || cutoffEnd < JAM_FILTER_OPEN;
  const filters = [new StateVariableFilter(), new StateVariableFilter()];
  const k = 2 - 1.9 * resonance;
  const formants = VOWEL_FORMANTS.map(([frequency]) => {
    const formant = new StateVariableFilter();
    formant.tune(frequency, 1 / VOWEL_Q);
    return formant;
  });
  const drives = drive > 0 ? 1 + drive * 6 : 0;
  const read = (phase: number) => {
    const i = Math.floor(phase);
    const f = phase - i;
    return table[i] * (1 - f) + table[i + 1] * f;
  };

  let phase = 0;
  let phase2 = 0;
  let bend = 1;
  for (let i = 0; i < audio.length; i++) {
    const t = i / SAMPLE_RATE;
    if (i % CONTROL_BLOCK === 0) {
      if (vibrato) bend = 2 ** ((vibrato * Math.min(1, t / VIBRATO_FADE_IN) * Math.sin(2 * Math.PI * VIBRATO_HZ * t)) / 1200);
      if (filtered) {
        const frequency = cutoff * (cutoffEnd / cutoff) ** Math.min(1, t / sweepTime) * hz(played);
        filters[0].tune(frequency, Math.SQRT2);
        filters[1].tune(frequency, k);
      }
    }
    let x = read(phase);
    phase = (phase + step * bend) % size;
    if (p.detune > 0) {
      x = (x + read(phase2)) * 0.5;
      phase2 = (phase2 + step * bend * detuneRatio) % size;
    }
    x *= envelope(p, t, hold) * (VELOCITY / 127);
    if (filtered) {
      filters[0].process(x);
      filters[1].process(filters[0].low);
      x = filters[1].low;
    }
    if (vowel > 0) {
      let voiced = 0;
      formants.forEach((formant, f) => {
        formant.process(x);
        voiced += (formant.band / VOWEL_Q) * VOWEL_FORMANTS[f][1];
      });
      x = x * (1 - vowel) + voiced * vowel * 2;
    }
    // Saturation that leaves the engine's full level (0.3) where it was
    if (drives) x = (Math.tanh((x * drives) / 0.3) * 0.3) / Math.tanh(drives);
    audio[i] = x * p.gain * OUTPUT_GAIN;
  }
  return audio;
}

const NO_RECORDING = { channels: [new Float32Array(1)], sampleRate: SAMPLE_RATE };

// One drum: its layers mixed to mono and scaled to the drum's level
export function renderJamDrum(drum: JamDrum): Float32Array {
  const layers = drum.layers.map(({ delay = 0, band, q = 4, ...data }) => {
    const [left, right] = prepareDrum({ detail: 0, ...data }, NO_RECORDING, SAMPLE_RATE);
    const mono = left.map((x, i) => (x + right[i]) * 0.5);
    if (band) {
      const filter = new StateVariableFilter();
      filter.tune(band, 1 / q);
      for (let i = 0; i < mono.length; i++) {
        filter.process(mono[i]);
        mono[i] = filter.band / q;
      }
    }
    return { offset: Math.round(delay * SAMPLE_RATE), mono };
  });
  const full = Math.max(...layers.map((layer) => layer.offset + layer.mono.length));
  const audio = new Float32Array(drum.cut ? Math.min(full, Math.round(drum.cut * SAMPLE_RATE)) : full);
  for (const { offset, mono } of layers)
    for (let i = 0; i < mono.length && offset + i < audio.length; i++) audio[offset + i] += mono[i];
  const fade = Math.round(CUT_FADE * SAMPLE_RATE);
  if (drum.cut) for (let i = 0; i < fade && i < audio.length; i++) audio[audio.length - 1 - i] *= i / fade;
  const peak = audio.reduce((max, x) => Math.max(max, Math.abs(x)), 0);
  if (peak > 0) for (let i = 0; i < audio.length; i++) audio[i] *= drum.level / peak;
  return audio;
}

// What a Jam sound is rendered from: a synth patch, or a kit
export type JamSoundSource = { patch: JamSynthPatch } | { kit: JamDrum[] };

// One WAV clip per note, keyed by MIDI note. A kit plays its drums on the rows
// from the lowest up, starting over after the last drum.
export function renderJamWavs(source: JamSoundSource, notes: number[]): { [note: number]: ArrayBuffer } {
  const rows = [...notes].sort((a, b) => a - b);
  return Object.fromEntries(
    rows.map((pitch, row) => {
      const audio = 'kit' in source ? renderJamDrum(source.kit[row % source.kit.length]) : renderJamClip(source.patch, pitch);
      return [pitch, encodeWav(audio, SAMPLE_RATE)];
    })
  );
}

// Effects on the played notes (not the backing track)
export type JamEchoTime = '1/16' | '1/8' | '1/8.' | '1/4';

export interface JamEffects {
  reverbMix: number; // 0-1
  reverbSize: number; // decay, seconds
  echoMix: number; // 0-1
  echoTime: JamEchoTime; // synced to the song's tempo
  echoFeedback: number; // 0-0.9
}

export const JAM_ECHO_BEATS: Record<JamEchoTime, number> = {
  '1/16': 0.25,
  '1/8': 0.5,
  '1/8.': 0.75,
  '1/4': 1,
};

export const DEFAULT_JAM_EFFECTS: JamEffects = {
  reverbMix: 0.25,
  reverbSize: 2.5,
  echoMix: 0.2,
  echoTime: '1/8.',
  echoFeedback: 0.35,
};

// Recorded sample sets kept on this machine only (git-ignored audio folder),
// listed by scripts/make-jam-reference-sounds.mjs; shown as "Reference" sounds
export interface JamSampleSound {
  id: string;
  label: string;
  samples: { [note: number]: string };
}

export const JAM_REFERENCE_SOUNDS_URL = '/audio/samples/jam_reference/sounds.json';

// The reference list, or none when this machine has no reference folder
export async function loadJamReferenceSounds(): Promise<JamSampleSound[]> {
  // /audio/ is served with a year-long cache; the list must reflect the latest script run
  const response = await fetch(JAM_REFERENCE_SOUNDS_URL, { cache: 'no-store' });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Reference sounds list: HTTP ${response.status}`);
  return (await response.json()) as JamSampleSound[];
}
