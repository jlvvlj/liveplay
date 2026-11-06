import { JAM_SOUND_PRESETS, type JamDrum, type JamSoundPreset, type JamSynthPatch } from './jamSynth';

// Tracks added to a backing track in the Jam tab's grid: one of the Jam's
// instruments, or one of its drum kits with a part per drum. Added parts are
// kept in the track's edit after the track's own parts, and rendered from
// their sound like the track's own.

export interface JamAddedPart {
  // The added track the part belongs to: a kit's parts share it
  track: string;
  // An instrument's or a kit's id (JAM_SOUND_PRESETS)
  sound: string;
  // A kit's drum, lowest row first
  drum?: number;
}

// What plays an added part: an instrument, or one drum of a kit
export type JamAddedInstrument = { patch: JamSynthPatch } | { drum: JamDrum };

type InstrumentPreset = Extract<JamSoundPreset, { patch: JamSynthPatch }>;
type KitPreset = Extract<JamSoundPreset, { kit: JamDrum[] }>;

// The sounds a track can be added with: the instruments, then the kits
export const JAM_ADDABLE_INSTRUMENTS = JAM_SOUND_PRESETS.filter((preset): preset is InstrumentPreset => 'patch' in preset);
export const JAM_ADDABLE_KITS = JAM_SOUND_PRESETS.filter((preset): preset is KitPreset => 'kit' in preset);

const instrumentOf = (sound: string) => JAM_ADDABLE_INSTRUMENTS.find((preset) => preset.id === sound);
const kitOf = (sound: string) => JAM_ADDABLE_KITS.find((preset) => preset.id === sound);

// The parts a new track adds: one for an instrument, one per drum for a kit
export function jamNewAddedParts(sound: string, track: string): JamAddedPart[] {
  const kit = kitOf(sound);
  if (kit) return kit.kit.map((_, drum) => ({ track, sound, drum }));
  return instrumentOf(sound) ? [{ track, sound }] : [];
}

export function jamAddedInstrument(part: JamAddedPart): JamAddedInstrument | null {
  const kit = kitOf(part.sound);
  if (kit) return part.drum !== undefined && kit.kit[part.drum] ? { drum: kit.kit[part.drum] } : null;
  const instrument = instrumentOf(part.sound);
  return instrument ? { patch: instrument.patch } : null;
}

// The added track's name (its sound's), and a part's (a kit's drum's)
export const jamAddedTrackName = (part: JamAddedPart): string =>
  kitOf(part.sound)?.label ?? instrumentOf(part.sound)?.label ?? part.sound;
export function jamAddedPartName(part: JamAddedPart): string {
  const kit = kitOf(part.sound);
  return kit && part.drum !== undefined ? (kit.names?.[part.drum] ?? `${kit.label} ${part.drum + 1}`) : jamAddedTrackName(part);
}

// Whether a kit's part is played as drum hits (else as notes)
export const jamAddedIsDrum = (part: JamAddedPart): boolean => part.drum !== undefined;

// A part's place across edits, so a mixer keeps each part's audio when tracks come and go
export const jamPartKey = (part: number, added: JamAddedPart | undefined): string =>
  added ? `${added.track}:${added.drum ?? ''}` : `own:${part}`;

// A saved or shared added part that still names a sound
export function validJamAddedPart(part: unknown): part is JamAddedPart {
  if (!part || typeof part !== 'object') return false;
  const { track, sound, drum } = part as Partial<JamAddedPart>;
  if (typeof track !== 'string' || typeof sound !== 'string') return false;
  return jamAddedInstrument({ track, sound, ...(typeof drum === 'number' ? { drum } : {}) }) !== null;
}
