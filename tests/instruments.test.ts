// The Jam's instruments: every one has presets, its parameters and effects are
// well formed, and Jam rows map to the notes each instrument plays
jest.mock('tone', () => ({}));

import { INSTRUMENTS, choiceEdited, findInstrument, jamRowNote, presetChoice } from '../apps/desktop/src/renderer/components/lesson-engine/instruments/catalog';
import { EFFECTS } from '../apps/desktop/src/renderer/components/lesson-engine/instruments/effects';
import { paramsPatch, patchParams } from '../apps/desktop/src/renderer/components/lesson-engine/instruments/engines/melodicsSynth';
import { EFFECT_KINDS, PAD_BASE_NOTE } from '../apps/desktop/src/renderer/components/lesson-engine/instruments/types';
import { JAM_SOUND_PRESETS } from '../apps/desktop/src/renderer/components/lesson-engine/jamSynth';

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
