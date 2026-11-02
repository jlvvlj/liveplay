import { Lesson } from '../../types/lesson';

// Songs for the Jam tab. Their audio is rendered by
// scripts/make-pentatonic-jam-audio.mjs into audio/samples/pentatonic_jam/.
export const PENTATONIC_GROOVE_JAM: Lesson = {
  id: 'pentatonic-groove-jam',
  title: 'Pentatonic Groove Jam',
  instrument: 'keys',
  bpm: 100,
  timeSignature: {
    numerator: 4,
    denominator: 4,
  },
  steps: [
    // Bar 1 (Am7)
    { tick: 0, note: 69, dur: 240, velocity: 100 },
    { tick: 240, note: 72, dur: 240, velocity: 100 },
    { tick: 480, note: 76, dur: 480, velocity: 100 },
    { tick: 1200, note: 74, dur: 240, velocity: 100 },
    { tick: 1440, note: 72, dur: 480, velocity: 100 },
    // Bar 2 (Fmaj7)
    { tick: 1920, note: 69, dur: 480, velocity: 100 },
    { tick: 2640, note: 67, dur: 240, velocity: 100 },
    { tick: 2880, note: 64, dur: 720, velocity: 100 },
    // Bar 3 (C)
    { tick: 3840, note: 67, dur: 240, velocity: 100 },
    { tick: 4080, note: 72, dur: 240, velocity: 100 },
    { tick: 4320, note: 76, dur: 240, velocity: 100 },
    { tick: 4560, note: 79, dur: 720, velocity: 100 },
    { tick: 5280, note: 76, dur: 480, velocity: 100 },
    // Bar 4 (G)
    { tick: 5760, note: 74, dur: 480, velocity: 100 },
    { tick: 6240, note: 72, dur: 240, velocity: 100 },
    { tick: 6480, note: 69, dur: 240, velocity: 100 },
    { tick: 6720, note: 67, dur: 960, velocity: 100 },
    // Bar 5 (Am7)
    { tick: 7680, note: 64, dur: 240, velocity: 100 },
    { tick: 7920, note: 69, dur: 240, velocity: 100 },
    { tick: 8160, note: 72, dur: 480, velocity: 100 },
    { tick: 8880, note: 69, dur: 240, velocity: 100 },
    { tick: 9120, note: 67, dur: 480, velocity: 100 },
    // Bar 6 (Fmaj7)
    { tick: 9600, note: 57, dur: 480, velocity: 100 },
    { tick: 10080, note: 60, dur: 240, velocity: 100 },
    { tick: 10320, note: 62, dur: 240, velocity: 100 },
    { tick: 10560, note: 64, dur: 960, velocity: 100 },
    // Bar 7 (C)
    { tick: 11520, note: 67, dur: 240, velocity: 100 },
    { tick: 11760, note: 64, dur: 240, velocity: 100 },
    { tick: 12000, note: 62, dur: 240, velocity: 100 },
    { tick: 12240, note: 60, dur: 720, velocity: 100 },
    { tick: 12960, note: 64, dur: 480, velocity: 100 },
    // Bar 8 (G)
    { tick: 13440, note: 62, dur: 480, velocity: 100 },
    { tick: 13920, note: 60, dur: 240, velocity: 100 },
    { tick: 14160, note: 57, dur: 1200, velocity: 100 },
  ],
  loop: {
    startTick: 0,
    endTick: 15360, // 8 bars, the length of the groove loop
  },
  samples: {
    57: 'samples/pentatonic_jam/pluck-57.wav',
    60: 'samples/pentatonic_jam/pluck-60.wav',
    62: 'samples/pentatonic_jam/pluck-62.wav',
    64: 'samples/pentatonic_jam/pluck-64.wav',
    67: 'samples/pentatonic_jam/pluck-67.wav',
    69: 'samples/pentatonic_jam/pluck-69.wav',
    72: 'samples/pentatonic_jam/pluck-72.wav',
    74: 'samples/pentatonic_jam/pluck-74.wav',
    76: 'samples/pentatonic_jam/pluck-76.wav',
    79: 'samples/pentatonic_jam/pluck-79.wav',
  },
  backingTrack: 'samples/pentatonic_jam/groove.wav',
  metadata: {
    difficulty: 1,
    genre: 'Jam',
    tags: ['jam', 'pentatonic', 'backing-track'],
    description: 'Ten pluck notes in A minor pentatonic over a looping groove: every note fits',
  },
};

export const JAM_SONGS: Lesson[] = [PENTATONIC_GROOVE_JAM];
