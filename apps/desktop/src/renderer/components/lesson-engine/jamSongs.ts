import { Lesson } from '../../types/lesson';

// Songs for the Jam tab. Their audio is rendered by
// scripts/make-pentatonic-jam-audio.mjs into audio/samples/pentatonic_jam/.

const JAM_NOTES = [45, 48, 50, 52, 55, 57, 60, 62, 64, 67, 69, 72, 74, 76, 79, 81];

const jamSamples = (setId: string): { [note: number]: string } =>
  Object.fromEntries(JAM_NOTES.map((note) => [note, `samples/pentatonic_jam/${setId}-${note}.wav`]));

// Sounds the notes can be played with, chosen in the Jam tab's sidebar
export interface JamSoundSet {
  id: string;
  label: string;
  samples: { [note: number]: string };
}

export const JAM_SOUND_SETS: JamSoundSet[] = [
  { id: 'stab', label: '8-bit stab', samples: jamSamples('stab') },
  { id: 'bell', label: 'Synth bell', samples: jamSamples('bell') },
  { id: 'wood', label: 'Woody', samples: jamSamples('wood') },
];

export const PENTATONIC_GROOVE_JAM: Lesson = {
  id: 'pentatonic-groove-jam',
  title: 'Pentatonic Groove Jam',
  instrument: 'keys',
  bpm: 90,
  timeSignature: {
    numerator: 4,
    denominator: 4,
  },
  steps: [
    // Bar 1 (Am7)
    { tick: 0, note: 45, dur: 240, velocity: 100 },
    { tick: 240, note: 52, dur: 240, velocity: 100 },
    { tick: 480, note: 57, dur: 240, velocity: 100 },
    { tick: 720, note: 60, dur: 240, velocity: 100 },
    { tick: 960, note: 64, dur: 480, velocity: 100 },
    { tick: 1440, note: 60, dur: 480, velocity: 100 },
    // Bar 2 (Fmaj7)
    { tick: 1920, note: 57, dur: 480, velocity: 100 },
    { tick: 2400, note: 55, dur: 240, velocity: 100 },
    { tick: 2640, note: 52, dur: 240, velocity: 100 },
    { tick: 2880, note: 50, dur: 480, velocity: 100 },
    { tick: 3360, note: 48, dur: 480, velocity: 100 },
    // Bar 3 (C)
    { tick: 3840, note: 48, dur: 240, velocity: 100 },
    { tick: 4080, note: 55, dur: 240, velocity: 100 },
    { tick: 4320, note: 60, dur: 240, velocity: 100 },
    { tick: 4560, note: 64, dur: 240, velocity: 100 },
    { tick: 4800, note: 67, dur: 480, velocity: 100 },
    { tick: 5280, note: 72, dur: 480, velocity: 100 },
    // Bar 4 (G)
    { tick: 5760, note: 74, dur: 480, velocity: 100 },
    { tick: 6240, note: 72, dur: 240, velocity: 100 },
    { tick: 6480, note: 67, dur: 240, velocity: 100 },
    { tick: 6720, note: 62, dur: 960, velocity: 100 },
    // Bar 5 (Am7)
    { tick: 7680, note: 69, dur: 240, velocity: 100 },
    { tick: 7920, note: 72, dur: 240, velocity: 100 },
    { tick: 8160, note: 76, dur: 480, velocity: 100 },
    { tick: 8640, note: 79, dur: 240, velocity: 100 },
    { tick: 8880, note: 81, dur: 720, velocity: 100 },
    // Bar 6 (Fmaj7)
    { tick: 9600, note: 79, dur: 240, velocity: 100 },
    { tick: 9840, note: 76, dur: 240, velocity: 100 },
    { tick: 10080, note: 72, dur: 480, velocity: 100 },
    { tick: 10560, note: 69, dur: 960, velocity: 100 },
    // Bar 7 (C)
    { tick: 11520, note: 67, dur: 240, velocity: 100 },
    { tick: 11760, note: 64, dur: 240, velocity: 100 },
    { tick: 12000, note: 62, dur: 240, velocity: 100 },
    { tick: 12240, note: 60, dur: 720, velocity: 100 },
    { tick: 12960, note: 64, dur: 480, velocity: 100 },
    // Bar 8 (G)
    { tick: 13440, note: 62, dur: 480, velocity: 100 },
    { tick: 13920, note: 55, dur: 240, velocity: 100 },
    { tick: 14160, note: 50, dur: 240, velocity: 100 },
    { tick: 14400, note: 45, dur: 960, velocity: 100 },
  ],
  loop: {
    startTick: 0,
    endTick: 15360, // 8 bars, the length of the groove loop
  },
  samples: jamSamples('stab'),
  backingTrack: 'samples/pentatonic_jam/groove.wav',
  metadata: {
    difficulty: 1,
    genre: 'Jam',
    tags: ['jam', 'pentatonic', 'backing-track'],
    description: 'Sixteen notes in A minor pentatonic, A2 to A5, over a looping groove: every note fits',
  },
};

export const JAM_SONGS: Lesson[] = [PENTATONIC_GROOVE_JAM];
