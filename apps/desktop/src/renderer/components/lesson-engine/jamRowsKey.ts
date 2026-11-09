import { abletonChordClasses, abletonNoteKey } from '../../utils/abletonImport';
import { jamAddedIsDrum } from './jamAddedParts';
import type { JamAbletonSong, JamAbletonTrack } from './jamRoomProtocol';
import type { JamTrackEdit } from './jamTrackEdits';

// The key of a room's rows. They are a minor pentatonic, A's unless moved
// (jamSongs.ts). A built-in song is written in its key; a Daw song, written
// here or imported, is in whatever key its notes are, read from them.

const PENTATONIC = [0, 3, 5, 7, 10];
const ROWS_ROOT = 9;

// How long a track plays each pitch class, and how low it plays on average
interface Harmony {
  time: number[];
  low: number;
}

// The minor pentatonic with the most notes the song uses, then the most of its
// lowest track's time (the bass says what the key is), then the most of all
// its time, as the semitones the rows move by. Rows stay in A when nothing
// tells them apart, as for a song with no pitches.
function rowsTranspose(tracks: Harmony[]): number {
  if (tracks.length === 0) return 0;
  const lowest = tracks.reduce((best, track) => (track.low < best.low ? track : best));
  const all = Array.from({ length: 12 }, (_, pitchClass) => tracks.reduce((sum, track) => sum + track.time[pitchClass], 0));
  const total = (time: number[], classes: number[]) => classes.reduce((sum, pitchClass) => sum + time[pitchClass], 0);
  const scored = Array.from({ length: 12 }, (_, step) => {
    const root = (ROWS_ROOT + step) % 12;
    const classes = PENTATONIC.map((interval) => (root + interval) % 12);
    return { root, score: [classes.filter((pitchClass) => all[pitchClass] > 0).length, total(lowest.time, classes), total(all, classes)] };
  });
  const { root } = scored.reduce((best, candidate) => {
    const differ = candidate.score.findIndex((value, i) => value !== best.score[i]);
    return differ >= 0 && candidate.score[differ] > best.score[differ] ? candidate : best;
  });
  return ((root - ROWS_ROOT + 18) % 12) - 6;
}

// An imported track's lanes are named after their notes or chords; a track of
// one lane or of unpitched sounds (a drum rack's flam) says nothing
function importedHarmony(track: JamAbletonTrack): Harmony | null {
  const steps = track.lesson.steps.filter((step) => !!step.slice);
  const notes = [...new Set(steps.map((step) => step.note))];
  if (notes.length < 2) return null;
  const time = Array<number>(12).fill(0);
  const keys: number[] = [];
  for (const note of notes) {
    const label = track.lesson.laneLabels?.[note] ?? '';
    const key = abletonNoteKey(label);
    const classes = key !== null ? [key % 12] : abletonChordClasses(label);
    if (!classes) return null;
    if (key !== null) keys.push(key);
    const played = steps.reduce((sum, step) => (step.note === note ? sum + step.dur : sum), 0);
    for (const pitchClass of classes) time[pitchClass] += played;
  }
  return { time, low: keys.length ? keys.reduce((sum, key) => sum + key, 0) / keys.length : Infinity };
}

export const jamImportedTranspose = (song: JamAbletonSong): number => rowsTranspose(song.tracks.flatMap((track) => importedHarmony(track) ?? []));

// A song written in the Daw: its notes, leaving out the parts playing a kit,
// whose pitches are pads. `own` is how many parts its track has of its own.
export function jamWrittenTranspose(edit: JamTrackEdit, own: number): number {
  const added = edit.added ?? [];
  const tracks = edit.parts.flatMap((notes, part): Harmony[] => {
    const addedPart = part >= own ? added[part - own] : undefined;
    if (notes.length === 0 || (addedPart && jamAddedIsDrum(addedPart))) return [];
    const time = Array<number>(12).fill(0);
    for (const { pitch, length } of notes) time[((pitch % 12) + 12) % 12] += length;
    return [{ time, low: notes.reduce((sum, { pitch }) => sum + pitch, 0) / notes.length }];
  });
  return rowsTranspose(tracks);
}
