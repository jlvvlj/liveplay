import {
  DEFAULT_PATCH,
  PARAMS,
  FAMILIES,
  renderNotes,
  encodeWav,
  type SynthFamily,
  type SynthParam,
  type SynthPatch,
} from '../../../../../../instrument-lab/engine/synth.mjs';

// Jam tab sounds: Instrument Lab synth patches rendered in the browser into one
// short clip per note, so every setting can be changed live.

export type { SynthFamily };

// A patch plus how long each note is held before its release starts (seconds)
export type JamSynthPatch = SynthPatch & { hold: number };

export interface JamSoundPreset {
  id: string;
  label: string;
  patch: JamSynthPatch;
}

const SAMPLE_RATE = 44100;
const VELOCITY = 110;
// Fixed boost from the engine's level to the clip; presets set `gain` so their
// loudest note peaks near 0.8
const OUTPUT_GAIN = 2.6;

const preset = (id: string, label: string, patch: Partial<JamSynthPatch>): JamSoundPreset => ({
  id,
  label,
  patch: { ...DEFAULT_PATCH, detune: 0, hold: 0.1, ...patch },
});

export const JAM_SOUND_PRESETS: JamSoundPreset[] = [
  // Chiptune: 25% pulse with a quick decay, like an 8-bit console note
  preset('stab', '8-bit stab', { family: 'pulse', odd: 0.4, brightness: 0.75, body: 0.1, attack: 0.002, decay: 0.16, sustain: 0.12, release: 0.12, detune: 4, gain: 0.63, hold: 0.09 }),
  // Chiptune lead: held square wave
  preset('chip', 'Chip lead', { family: 'square', brightness: 0.6, body: 0.1, attack: 0.005, decay: 0.3, sustain: 0.55, release: 0.1, detune: 6, gain: 1.5, hold: 0.25 }),
  // Thin 12% pulse with a slow swell: a buzzing insect drone
  preset('bee', 'Bee buzz', { family: 'pulse', odd: 0, brightness: 0.95, body: 0, attack: 0.02, decay: 0.4, sustain: 0.7, release: 0.15, detune: 9, gain: 0.56, hold: 0.3 }),
  // FM bell: bright strike on the 4th harmonic that rings out
  preset('bell', 'Synth bell', { family: 'fm', fm: 1.8, ratio: 4, brightness: 0.65, body: 0.35, attack: 0.002, decay: 0.7, sustain: 0.02, release: 0.9, detune: 3, gain: 1.12, hold: 0.12 }),
  // Tiny metal comb: deep FM on the 5th harmonic, no body
  preset('musicbox', 'Music box', { family: 'fm', fm: 2.6, ratio: 5, brightness: 0.8, body: 0, attack: 0.002, decay: 0.45, sustain: 0.02, release: 0.7, gain: 0.82, hold: 0.05 }),
  // Thumb piano: round tine with a light 6th-harmonic shimmer
  preset('kalimba', 'Kalimba', { family: 'fm', fm: 1.1, ratio: 6, brightness: 0.45, body: 0.5, attack: 0.002, decay: 0.35, sustain: 0.02, release: 0.5, gain: 1.12, hold: 0.05 }),
  // Mallet on wood: dark, strong fundamental, short knock
  preset('wood', 'Woody', { family: 'fm', fm: 0.7, ratio: 4, brightness: 0.3, body: 0.6, attack: 0.002, decay: 0.2, sustain: 0.02, release: 0.18, gain: 1.24, hold: 0.06 }),
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
];

export const SYNTH_FAMILIES: SynthFamily[] = FAMILIES;

export interface JamSynthControl {
  key: SynthParam | 'hold';
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
  control('brightness', 'Brightness', 0.01),
  control('body', 'Body', 0.01),
  control('odd', 'Pulse width', 0.01, ['pulse']),
  control('fm', 'FM amount', 0.05, ['fm']),
  control('ratio', 'FM ratio', 1, ['fm']),
  control('attack', 'Attack', 0.001),
  control('decay', 'Decay', 0.01),
  control('sustain', 'Sustain', 0.01),
  { key: 'hold', label: 'Hold', min: 0.02, max: 1.5, step: 0.01 },
  control('release', 'Release', 0.01),
  control('detune', 'Detune', 0.5),
  control('gain', 'Level', 0.01),
];

// Renders one clip per note and returns them as blob URLs, keyed by MIDI note
export function renderJamSamples(patch: JamSynthPatch, notes: number[]): { [note: number]: string } {
  const { hold, ...synth } = patch;
  const length = hold + synth.release * 1.5 + 0.05;
  const samples: { [note: number]: string } = {};
  for (const pitch of notes) {
    const audio = renderNotes(synth, [{ pitch, start: 0, end: hold, velocity: VELOCITY }], length, SAMPLE_RATE);
    for (let i = 0; i < audio.length; i++) audio[i] *= OUTPUT_GAIN;
    samples[pitch] = URL.createObjectURL(new Blob([encodeWav(audio, SAMPLE_RATE)], { type: 'audio/wav' }));
  }
  return samples;
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
