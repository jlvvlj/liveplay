// The Jam's instruments: every one has presets, its parameters and effects are
// well formed, and Jam rows map to the notes each instrument plays
jest.mock('tone', () => ({}));

import { INSTRUMENTS, choiceEdited, findInstrument, jamRowNote, presetChoice } from '../apps/desktop/src/renderer/components/lesson-engine/instruments/catalog';
import { EFFECTS } from '../apps/desktop/src/renderer/components/lesson-engine/instruments/effects';
import { paramsPatch, patchParams } from '../apps/desktop/src/renderer/components/lesson-engine/instruments/engines/melodicsSynth';
import { EFFECT_KINDS, PAD_BASE_NOTE } from '../apps/desktop/src/renderer/components/lesson-engine/instruments/types';
import { JAM_SOUND_PRESETS } from '../apps/desktop/src/renderer/components/lesson-engine/jamSynth';
import { jamPartTracks, validInstrumentChoice } from '../apps/desktop/src/renderer/components/lesson-engine/jamTrackInstruments';
import { liveEvents } from '../apps/desktop/src/renderer/components/lesson-engine/instruments/liveTracks';

const ROWS = [45, 48, 50, 52, 55, 57, 60, 62, 64, 67, 69, 72, 74, 76, 79, 81];

describe('instrument catalog', () => {
  it('has every Jam sound as an instrument or a Melodics Synth preset', () => {
    const synth = findInstrument(INSTRUMENTS, 'melodics-synth')!;
    for (const sound of JAM_SOUND_PRESETS) {
      if ('patch' in sound) expect(synth.presets.map((preset) => preset.id)).toContain(sound.id);
      else expect(findInstrument(INSTRUMENTS, sound.id)).toBeDefined();
    }
  });

  it('gives every instrument at least three presets, each with known parameters and effects', () => {
    for (const instrument of INSTRUMENTS) {
      expect(instrument.presets.length).toBeGreaterThanOrEqual(3);
      const keys = instrument.params.map((spec) => spec.key);
      for (const preset of instrument.presets) {
        for (const key of Object.keys(preset.params)) expect(keys).toContain(key);
        for (const slot of preset.effects) {
          expect(EFFECT_KINDS).toContain(slot.kind);
          const effectKeys = EFFECTS[slot.kind].params.map((spec) => spec.key);
          for (const key of Object.keys(slot.params)) expect(effectKeys).toContain(key);
        }
      }
    }
  });

  it('keeps every parameter default inside its range', () => {
    for (const specs of [...INSTRUMENTS.map((instrument) => instrument.params), ...Object.values(EFFECTS).map((effect) => effect.params)])
      for (const spec of specs) {
        expect(spec.default).toBeGreaterThanOrEqual(spec.min);
        expect(spec.default).toBeLessThanOrEqual(spec.max);
      }
  });
});

describe('presets', () => {
  it('starts a choice from its preset and tells when it was edited', () => {
    const piano = findInstrument(INSTRUMENTS, 'keys:grand-piano')!;
    const soft = presetChoice(piano, 'soft');
    expect(soft).toMatchObject({ instrument: 'keys:grand-piano', preset: 'soft' });
    expect(choiceEdited(piano, soft)).toBe(false);
    expect(choiceEdited(piano, { ...soft, params: { ...soft.params, cutoff: 900 } })).toBe(true);
    // editing a choice never changes its preset
    soft.params.cutoff = 900;
    expect(presetChoice(piano, 'soft').params.cutoff).toBe(3200);
  });

  it('turns a synth patch into parameters and back', () => {
    const fatsaw = JAM_SOUND_PRESETS.find((sound) => sound.id === 'fatsaw');
    if (!fatsaw || !('patch' in fatsaw)) throw new Error('No Fat saw preset');
    expect(paramsPatch(patchParams(fatsaw.patch))).toEqual(fatsaw.patch);
  });
});

describe('Jam rows', () => {
  it('plays a kit from its first pad on the lowest row up', () => {
    const kit = findInstrument(INSTRUMENTS, 'groove-kit')!;
    expect(ROWS.map((row) => jamRowNote(kit, row, ROWS))).toEqual(ROWS.map((_, i) => PAD_BASE_NOTE + i));
  });

  it('moves the rows by whole octaves to sit in a recorded instrument range', () => {
    const bass = findInstrument(INSTRUMENTS, 'band:electric-bass')!;
    const shift = jamRowNote(bass, ROWS[0], ROWS) - ROWS[0];
    expect(Math.abs(shift) % 12).toBe(0);
    for (const row of ROWS) expect(jamRowNote(bass, row, ROWS)).toBe(row + shift);
    const middle = (ROWS[0] + ROWS[ROWS.length - 1]) / 2 + shift;
    expect(Math.abs(middle - bass.center!)).toBeLessThanOrEqual(6);
  });

  it('plays the synth at the rows own pitch', () => {
    const synth = findInstrument(INSTRUMENTS, 'melodics-synth')!;
    expect(ROWS.map((row) => jamRowNote(synth, row, ROWS))).toEqual(ROWS);
  });
});

describe('Daw tracks', () => {
  it('keys each part by its grid track, drums by pad', () => {
    const tracks = jamPartTracks(
      [{ kind: 'drum' }, { kind: 'drum' }, { kind: 'notes' }],
      [{ track: 'a', sound: 'groove-kit', drum: 0 }, { track: 'a', sound: 'groove-kit', drum: 1 }, { track: 'b', sound: 'keys:grand-piano' }]
    );
    expect(tracks).toEqual([
      { key: 'drums', kind: 'drum', pad: 0 },
      { key: 'drums', kind: 'drum', pad: 1 },
      { key: 'part-2', kind: 'notes', pad: 0 },
      { key: 'added-a', kind: 'drum', pad: 0 },
      { key: 'added-a', kind: 'drum', pad: 1 },
      { key: 'added-b', kind: 'notes', pad: 0 },
    ]);
  });

  it('checks a shared instrument choice', () => {
    const piano = presetChoice(findInstrument(INSTRUMENTS, 'keys:grand-piano')!, 'ambient');
    expect(validInstrumentChoice(piano)).toBe(true);
    expect(validInstrumentChoice({ ...piano, params: { cutoff: 'high' } })).toBe(false);
    expect(validInstrumentChoice({ ...piano, effects: [{ kind: 'reverb' }] })).toBe(false);
  });

  it('sends the notes that sound in the window, every loop, swung, on their pad', () => {
    const sixteenth = 0.125;
    const notes = [
      { pitch: 60, step: 0, length: 2, velocity: 100 },
      { pitch: 64, step: 2, length: 1, velocity: 80 },
    ];
    const timing = { sixteenth, loopSteps: 16, swing: (step: number) => (step % 4 === 2 ? step + 0.5 : step) };
    // The second loop's first beat: 16 steps of 0.125 s after a start at 1 s
    const events = liveEvents({ start: 1, from: 3, to: 3.5 }, timing, [{ notes, pad: null, level: 1 }]);
    expect(events).toEqual([
      { note: 60, velocity: 100, on: 3, off: 3.25 },
      { note: 64, velocity: 80, on: 3 + 2.5 * sixteenth, off: 3 + 2.5 * sixteenth + sixteenth },
    ]);
    const drums = liveEvents({ start: 1, from: 1, to: 1.1 }, timing, [{ notes, pad: 3, level: 0.5 }]);
    expect(drums).toEqual([{ note: PAD_BASE_NOTE + 3, velocity: 50, on: 1, off: 1.25 }]);
    expect(liveEvents({ start: 1, from: 1, to: 1.1 }, timing, [{ notes, pad: null, level: 0 }])).toEqual([]);
  });
});
