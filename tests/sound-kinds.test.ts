/**
 * @jest-environment node
 */
import { soundKind } from '../apps/desktop/src/renderer/components/lesson-engine/instruments/soundKinds';

describe('sound kinds', () => {
  it('maps each synth\'s own tags onto one list of kinds', () => {
    // Surge XT, OB-Xf, Helm, Mutable Instruments and the Melodics Synth name them differently
    expect(soundKind('Anything', 'Leads')).toBe('Lead');
    expect(soundKind('Anything', 'Basses')).toBe('Bass');
    expect(soundKind('Anything', 'Polysynths')).toBe('Chords');
    expect(soundKind('Anything', 'Soundscapes')).toBe('Pad');
    expect(soundKind('Anything', 'SFX')).toBe('FX');
    expect(soundKind('Anything', 'Percussion')).toBe('Drums');
    expect(soundKind('Anything', 'Mallets & Keys')).toBe('Keys');
    expect(soundKind('Anything', 'Pluck & Stab')).toBe('Pluck');
  });

  it('reads the kind from the name when the tag says none', () => {
    // Dexed's and some of Vital's presets have no tag; a tag with no kind (Surge's Templates) neither
    expect(soundKind('E.PIANO 1 (Dexed 01)')).toBe('Keys');
    expect(soundKind('BRASS   2 (Dexed 01)')).toBe('Brass & Wind');
    expect(soundKind('SYNBASS 54 (SynprezFM 13)')).toBe('Bass');
    expect(soundKind('TECNO-XYLO (SynprezFM 14)')).toBe('Bell & Mallet');
    expect(soundKind('Init Saw', 'Templates')).toBeNull();
    expect(soundKind('PHAROH (Dexed 01)')).toBeNull();
  });

  it('names sampled instruments by what they are', () => {
    expect(soundKind('Grand piano')).toBe('Keys');
    expect(soundKind('Bassoon')).toBe('Brass & Wind');
    expect(soundKind('Double bass')).toBe('Bass');
    expect(soundKind('Steel drums')).toBe('Bell & Mallet');
    expect(soundKind('Halo pad')).toBe('Pad');
    expect(soundKind('Vocal Chop')).toBe('Voice');
    expect(soundKind('Deep Space')).toBeNull();
  });
});
