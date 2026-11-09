import { JAM_MAX_BARS, JAM_SECTION_BARS, JAM_TRACK_BARS, jamTrackByFile, jamTrackParts, type JamTrackNote } from './jamTracks';
import { validJamAddedPart, type JamAddedPart } from './jamAddedParts';
import { validJamTrackInstruments, type JamTrackInstruments } from './jamTrackInstruments';

// An edited backing track: its notes, one list per part (its own parts, then
// the ones added in the grid, played by `added`), its length in bars when
// the grid made it other than its own 8, and the instruments its tracks play
// (see jamTrackInstruments.ts)
export interface JamTrackEdit {
  parts: JamTrackNote[][];
  added?: JamAddedPart[];
  bars?: number;
  instruments?: JamTrackInstruments;
}

const validNote = (note: unknown): boolean => {
  if (!note || typeof note !== 'object') return false;
  const { pitch, step, length, velocity } = note as JamTrackNote;
  return [pitch, step, length, velocity].every((value) => typeof value === 'number' && Number.isFinite(value));
};

function validEdit(edit: unknown, ownParts: number, ownBars: number, leastBars: number, mostBars: number): edit is JamTrackEdit {
  if (!edit || typeof edit !== 'object') return false;
  const { parts, added = [], bars = ownBars, instruments = {} } = edit as Partial<JamTrackEdit>;
  return (
    validJamTrackInstruments(instruments) &&
    typeof bars === 'number' &&
    Number.isInteger(bars / JAM_SECTION_BARS) &&
    bars >= leastBars &&
    bars <= mostBars &&
    Array.isArray(added) &&
    added.every(validJamAddedPart) &&
    Array.isArray(parts) &&
    parts.length === ownParts + added.length &&
    parts.every((part) => Array.isArray(part) && part.every(validNote))
  );
}

// A saved or shared edit that still matches its track's parts
export function validJamTrackEdit(file: string, edit: unknown): edit is JamTrackEdit {
  const track = jamTrackByFile(file);
  return !!track && validEdit(edit, jamTrackParts(track).length, JAM_TRACK_BARS, JAM_SECTION_BARS, JAM_MAX_BARS);
}

// The edit of an imported song: its recordings have no notes, and it lasts at
// least as long as they do
export function validJamRecordedEdit(recordings: number, recordedBars: number, edit: unknown): edit is JamTrackEdit {
  return (
    validEdit(edit, recordings, recordedBars, recordedBars, Math.max(JAM_MAX_BARS, recordedBars)) &&
    edit.parts.slice(0, recordings).every((part) => part.length === 0)
  );
}
