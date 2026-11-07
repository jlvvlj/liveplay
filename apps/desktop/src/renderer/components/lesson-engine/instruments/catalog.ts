import { JAM_SOUND_PRESETS, renderJamDrum, type JamSampleSound } from '../jamSynth';
import { jamSoundUrl } from '../jamSoundFiles';
import { effectSlot } from './effects';
import { MELODICS_SYNTH_PARAMS, MelodicsSynth, patchParams } from './engines/melodicsSynth';
import { SAMPLER_NOTE_PARAMS, SAMPLER_PAD_PARAMS, Sampler, type SamplerSource } from './engines/sampler';
import { PortInstrument, type PortEntry } from './engines/port';
import type { EffectSlot, InstrumentChoice, InstrumentDef, LiveInstrument, ParamValues, Preset } from './types';
import { PAD_BASE_NOTE } from './types';

// Every instrument the Jam and the Daw can play, with its presets

// The Jam's echo, as played notes have always had it
const ECHO = effectSlot('delay');

const preset = (id: string, name: string, params: ParamValues, effects: EffectSlot[]): Preset => ({ id, name, params, effects });

// Recorded instruments' presets
const NOTE_PRESETS: Preset[] = [
  preset('natural', 'Natural', {}, [ECHO]),
  preset('soft', 'Soft', { cutoff: 3200, attack: 0.02, velocity: 0.85, release: 0.6 }, [ECHO, effectSlot('reverb', { size: 2, mix: 0.25 })]),
  preset('bright', 'Bright', { velocity: 0.4 }, [effectSlot('eq', { low: -2, high: 5 }), ECHO]),
  preset('lofi', 'Lo-fi', { cutoff: 5000 }, [effectSlot('crusher', { bits: 8, mix: 0.6 }), effectSlot('filter', { type: 1, frequency: 180, q: 0.7 }), ECHO]),
  preset('ambient', 'Ambient', { attack: 0.15, release: 2.5 }, [
    effectSlot('delay', { time: 3, feedback: 0.6, mix: 0.35 }),
    effectSlot('reverb', { size: 6, mix: 0.5 }),
  ]),
];

// Kits' presets
const PAD_PRESETS: Preset[] = [
  preset('classic', 'Classic', {}, [ECHO]),
  preset('tight', 'Tight', { length: 0.35 }, [effectSlot('compressor', { threshold: -24, ratio: 4 })]),
  preset('room', 'Room', {}, [effectSlot('compressor', { threshold: -20, ratio: 3 }), effectSlot('reverb', { size: 1.5, mix: 0.25 })]),
  preset('crunch', 'Crunch', {}, [effectSlot('drive', { amount: 0.5, mix: 0.8 }), effectSlot('compressor', { threshold: -20, ratio: 6 })]),
  preset('lofi', 'Lo-fi', { cutoff: 6000 }, [effectSlot('crusher', { bits: 6, mix: 0.7 })]),
];

const middle = (roots: number[]) => Math.round((Math.min(...roots) + Math.max(...roots)) / 2);

const notesInstrument = (id: string, name: string, category: string, notes: { url: string; root: number }[]): InstrumentDef => ({
  id,
  name,
  category,
  engine: 'sampler',
  params: SAMPLER_NOTE_PARAMS,
  presets: NOTE_PRESETS,
  center: middle(notes.map((note) => note.root)),
  source: { kind: 'notes', notes } satisfies SamplerSource,
});

const padsInstrument = (id: string, name: string, category: string, source: Extract<SamplerSource, { kind: 'pads' }>): InstrumentDef => ({
  id,
  name,
  category,
  engine: 'sampler',
  params: SAMPLER_PAD_PARAMS,
  presets: PAD_PRESETS,
  pads: source.pads.map((pad) => pad.name),
  source,
});

// The kind of sound each Melodics Synth preset is
const SYNTH_TAGS: Record<string, string> = {
  chip: 'Lead',
  voice: 'Lead',
  fatsaw: 'Lead',
  flute: 'Lead',
  'mellow-sax': 'Lead',
  pad: 'Pad',
  'bee-drone': 'Pad',
  'wah-sweep': 'Pad',
  'dist-bass': 'Bass',
  epiano: 'Mallets & Keys',
  'night-rhodes': 'Mallets & Keys',
  vibes: 'Mallets & Keys',
  kalimba: 'Mallets & Keys',
  musicbox: 'Mallets & Keys',
  'sine-wood': 'Mallets & Keys',
  'square-stab': 'Pluck & Stab',
  pluck: 'Pluck & Stab',
  'jazz-guitar': 'Pluck & Stab',
  bell: 'Bell',
  'bell-stab': 'Bell',
};
export const SYNTH_TAG_ORDER = ['Lead', 'Pad', 'Bass', 'Mallets & Keys', 'Pluck & Stab', 'Bell'];
// Sampled categories in this order; songs' sounds and others after them
export const CATEGORY_ORDER = ['Keys', 'Orchestra', 'Band', 'General MIDI', 'Drums', 'Drum machines'];

function builtInInstruments(): InstrumentDef[] {
  const synthPresets = JAM_SOUND_PRESETS.flatMap((sound) =>
    'patch' in sound ? [{ ...preset(sound.id, sound.label, patchParams(sound.patch), [ECHO]), tag: SYNTH_TAGS[sound.id] ?? 'Lead' }] : []
  );
  const instruments: InstrumentDef[] = [
    {
      id: 'melodics-synth',
      name: 'Melodics Synth',
      category: 'Synth',
      engine: 'melodics-synth',
      params: MELODICS_SYNTH_PARAMS,
      presets: synthPresets,
      source: null,
    },
  ];
  for (const sound of JAM_SOUND_PRESETS) {
    if ('kit' in sound) {
      instruments.push(
        padsInstrument(sound.id, sound.label, 'Drums', {
          kind: 'pads',
          pads: sound.kit.map((drum, i) => ({ name: sound.names?.[i] ?? `Drum ${i + 1}`, make: () => [renderJamDrum(drum)] })),
        })
      );
    } else if ('sounds' in sound) {
      const category = 'song' in sound ? sound.song : sound.pack;
      const name = 'song' in sound ? `${sound.song} drums & FX` : sound.label;
      // A song's drums and loops are cut by their next hit, as in the song
      instruments.push(
        padsInstrument(sound.id, name, category, {
          kind: 'pads',
          pads: sound.sounds.map((pad) => ({ name: pad.name, url: jamSoundUrl(pad.file) })),
          choke: 'song' in sound,
        })
      );
    } else if ('sample' in sound) {
      const category = 'song' in sound ? sound.song : sound.pack;
      instruments.push(
        notesInstrument(sound.id, sound.label, category, sound.sample.map((note) => ({ url: jamSoundUrl(note.file), root: note.root })))
      );
    }
  }
  return instruments;
}

export const INSTRUMENTS: InstrumentDef[] = builtInInstruments();

// Recorded sounds kept on this machine only (see loadJamReferenceSounds), as instruments
export const referenceInstruments = (sounds: JamSampleSound[]): InstrumentDef[] =>
  sounds.map((sound) =>
    notesInstrument(
      sound.id,
      sound.label,
      'Reference',
      Object.entries(sound.samples).map(([note, file]) => ({ url: /^(blob|data|https?):|^\//.test(file) ? file : `/audio/${file}`, root: Number(note) }))
    )
  );

export const findInstrument = (instruments: InstrumentDef[], id: string): InstrumentDef | undefined =>
  instruments.find((instrument) => instrument.id === id);

// An instrument as its preset sets it
export const presetChoice = (instrument: InstrumentDef, presetId?: string): InstrumentChoice => {
  const chosen = instrument.presets.find((candidate) => candidate.id === presetId) ?? instrument.presets[0];
  return {
    instrument: instrument.id,
    preset: chosen.id,
    params: { ...chosen.params },
    effects: chosen.effects.map((slot) => ({ ...slot, params: { ...slot.params } })),
  };
};

// The instrument a Jam sound id plays: a synth sound is a Melodics Synth
// preset, a kit or recorded sound the instrument of the same id
export function choiceForSound(soundId: string): InstrumentChoice | null {
  const synth = INSTRUMENTS[0];
  if (synth.presets.some((preset) => preset.id === soundId)) return presetChoice(synth, soundId);
  const instrument = findInstrument(INSTRUMENTS, soundId);
  return instrument ? presetChoice(instrument) : null;
}

// Whether a choice still differs from the preset it started from
export const choiceEdited = (instrument: InstrumentDef, choice: InstrumentChoice): boolean => {
  const original = presetChoice(instrument, choice.preset);
  return JSON.stringify([original.params, original.effects]) !== JSON.stringify([choice.params, choice.effects]);
};

// The note an instrument plays for a Jam row (one of the song's sorted
// `rows`): a kit's pads from the lowest row up; an instrument with a range the
// rows moved by whole octaves to sit around its middle; else the row's pitch
export function jamRowNote(instrument: InstrumentDef, row: number, rows: number[]): number {
  if (instrument.pads) return PAD_BASE_NOTE + Math.max(0, rows.indexOf(row));
  if (instrument.center === undefined || rows.length === 0) return row;
  return row + 12 * Math.round((instrument.center - (rows[0] + rows[rows.length - 1]) / 2) / 12);
}

// The instrument ports (synths compiled to WebAssembly), as instruments with
// their own presets; an effect port (Clouds) is an effect instead
export const portInstruments = (entries: PortEntry[]): InstrumentDef[] =>
  entries
    .filter((entry) => !entry.effect)
    .map((entry) => ({
      id: `port:${entry.name}`,
      name: entry.label,
      category: 'Synth engines',
      engine: 'port',
      params: entry.params,
      presets: entry.presets.map((port) => ({ ...preset(port.id, port.name, port.params, [ECHO]), ...(port.tag ? { tag: port.tag } : {}) })),
      source: entry,
    }));

export function createInstrument(instrument: InstrumentDef, params: ParamValues, preset: string): LiveInstrument {
  switch (instrument.engine) {
    case 'melodics-synth':
      return new MelodicsSynth(params);
    case 'sampler':
      return new Sampler(instrument.source as SamplerSource, params, instrument.id);
    case 'port':
      return new PortInstrument(instrument.source as PortEntry, params, preset);
  }
}
