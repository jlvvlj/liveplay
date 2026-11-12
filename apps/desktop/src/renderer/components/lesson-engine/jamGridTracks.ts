import { SOUND_COLORS } from '../../styles/palette';
import type { JamTrackPart } from './jamTracks';
import { jamAddedIsDrum, type JamAddedPart } from './jamAddedParts';
import type { JamTrackNames } from './jamTrackEdits';

// A backing track as the grid shows it, a row per track: its drums together
// as one track, each of its notes parts, then each track added in the grid
// (an added kit's drums together). Parts are numbered as the edit's notes are.
// Each is named as named in the grid, else by its own part's name, or for
// an added track by what it plays: drums or an instrument.

export interface GridTrack {
  id: string;
  name: string;
  kind: 'drum' | 'notes';
  parts: number[];
  color: string;
  added?: string;
  // Plays a recording: it has a level, solo and mute, but no notes to edit
  recorded?: boolean;
}

export const partColor = (part: number) => SOUND_COLORS[part % SOUND_COLORS.length];

export function gridTracks(own: JamTrackPart[], added: JamAddedPart[], names: JamTrackNames = {}): GridTrack[] {
  const drums = own.flatMap((part, index) => (part.kind === 'drum' ? [index] : []));
  const addedTracks: GridTrack[] = [];
  added.forEach((part, index) => {
    const at = own.length + index;
    const existing = addedTracks.find((candidate) => candidate.added === part.track);
    if (existing) existing.parts.push(at);
    else
      addedTracks.push({
        id: `added-${part.track}`,
        name: jamAddedIsDrum(part) ? 'Drums' : 'Instrument',
        kind: jamAddedIsDrum(part) ? 'drum' : 'notes',
        parts: [at],
        color: partColor(at),
        added: part.track,
      });
  });
  const tracks: GridTrack[] = [
    ...(drums.length ? [{ id: 'drums', name: 'Drums', kind: 'drum' as const, parts: drums, color: partColor(drums[0]) }] : []),
    ...own.flatMap((part, index) =>
      part.kind === 'notes'
        ? [{ id: `part-${index}`, name: part.name, kind: 'notes' as const, parts: [index], color: partColor(index), ...(part.recorded ? { recorded: true } : {}) }]
        : []
    ),
    ...addedTracks,
  ];
  return tracks.map((track) => (names[track.id] ? { ...track, name: names[track.id] } : track));
}
