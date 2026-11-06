import type { InstrumentChoice } from './instruments/types';
import type { JamAddedPart } from './jamAddedParts';
import type { JamTrackPart } from './jamTracks';

// The instruments a backing track's tracks play, by track: the grid's
// 'drums' (the track's own drums together), 'part-N' (one of its own
// instrument parts) or 'added-<id>' (a track added in the grid). A track of
// its own with none plays its original sound; an added track always has one.
export type JamTrackInstruments = Record<string, InstrumentChoice>;

// Each part's track, and for a drum part its pad (its place among the
// track's drums, lowest row first)
export interface JamPartTrack {
  key: string;
  kind: 'drum' | 'notes';
  pad: number;
}

export function jamPartTracks(own: Pick<JamTrackPart, 'kind'>[], added: JamAddedPart[]): JamPartTrack[] {
  let drum = 0;
  return [
    ...own.map((part, index): JamPartTrack =>
      part.kind === 'drum' ? { key: 'drums', kind: 'drum', pad: drum++ } : { key: `part-${index}`, kind: 'notes', pad: 0 }
    ),
    ...added.map((part): JamPartTrack => ({
      key: `added-${part.track}`,
      kind: part.drum !== undefined ? 'drum' : 'notes',
      pad: part.drum ?? 0,
    })),
  ];
}

const isNumberRecord = (value: unknown): boolean =>
  !!value && typeof value === 'object' && Object.values(value).every((entry) => typeof entry === 'number' && Number.isFinite(entry));

// A saved or shared choice as the room server can check it (which
// instruments exist is the client's to know)
export function validInstrumentChoice(choice: unknown): choice is InstrumentChoice {
  if (!choice || typeof choice !== 'object') return false;
  const { instrument, preset, params, effects } = choice as Partial<InstrumentChoice>;
  return (
    typeof instrument === 'string' &&
    typeof preset === 'string' &&
    isNumberRecord(params) &&
    Array.isArray(effects) &&
    effects.every(
      (slot) => !!slot && typeof slot === 'object' && typeof slot.kind === 'string' && typeof slot.on === 'boolean' && isNumberRecord(slot.params)
    )
  );
}

export const validJamTrackInstruments = (value: unknown): value is JamTrackInstruments =>
  !!value && typeof value === 'object' && Object.entries(value).every(([key, choice]) => typeof key === 'string' && validInstrumentChoice(choice));
