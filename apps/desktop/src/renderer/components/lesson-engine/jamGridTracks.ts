import { SOUND_COLORS } from '../../styles/palette';
import type { JamTrackPart } from './jamTracks';
import { jamAddedIsDrum, jamAddedTrackName, type JamAddedPart } from './jamAddedParts';

// A backing track as the grid shows it, a row per track: its drums together
// as one track, each of its notes parts, then each track added in the grid
// (an added kit's drums together). Parts are numbered as the edit's notes are.

export interface GridTrack {
  id: string;
  name: string;
  kind: 'drum' | 'notes';
  parts: number[];
  color: string;
  added?: string;
}

export const partColor = (part: number) => SOUND_COLORS[part % SOUND_COLORS.length];

export function gridTracks(own: JamTrackPart[], added: JamAddedPart[]): GridTrack[] {
  const drums = own.flatMap((part, index) => (part.kind === 'drum' ? [index] : []));
  const addedTracks: GridTrack[] = [];
  added.forEach((part, index) => {
    const at = own.length + index;
    const existing = addedTracks.find((candidate) => candidate.added === part.track);
    if (existing) existing.parts.push(at);
    else
      addedTracks.push({
        id: `added-${part.track}`,
        name: jamAddedTrackName(part),
        kind: jamAddedIsDrum(part) ? 'drum' : 'notes',
        parts: [at],
        color: partColor(at),
        added: part.track,
      });
  });
  return [
    ...(drums.length ? [{ id: 'drums', name: 'Drums', kind: 'drum' as const, parts: drums, color: partColor(drums[0]) }] : []),
    ...own.flatMap((part, index) =>
      part.kind === 'notes' ? [{ id: `part-${index}`, name: part.name, kind: 'notes' as const, parts: [index], color: partColor(index) }] : []
    ),
    ...addedTracks,
  ];
}
