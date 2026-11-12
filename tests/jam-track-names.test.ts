/**
 * @jest-environment node
 */
import { gridTracks } from '../apps/desktop/src/renderer/components/lesson-engine/jamGridTracks';
import { jamLessonChoices } from '../apps/desktop/src/renderer/components/lesson-engine/jamLessonRooms';
import { JAM_SONGS, jamRoomSongOf } from '../apps/desktop/src/renderer/components/lesson-engine/jamSongs';
import { JAM_TRACK_NAME_MAX, validJamTrackEdit, type JamTrackEdit } from '../apps/desktop/src/renderer/components/lesson-engine/jamTrackEdits';
import { jamTrackByFile, jamTrackParts } from '../apps/desktop/src/renderer/components/lesson-engine/jamTracks';
import type { JamAddedPart } from '../apps/desktop/src/renderer/components/lesson-engine/jamAddedParts';

const CHIP = jamRoomSongOf(JAM_SONGS.find((song) => song.id === 'chip-run-jam')!);
const own = jamTrackParts(jamTrackByFile(CHIP.file)!);
const added: JamAddedPart[] = [
  { track: 'a', sound: 'square-stab' },
  { track: 'b', sound: 'groove-kit', drum: 0 },
  { track: 'b', sound: 'groove-kit', drum: 1 },
];
const edit = (names: unknown): JamTrackEdit =>
  ({ parts: [...own.map((part) => part.notes), [], [], []], added, names }) as JamTrackEdit;

describe('track names', () => {
  it('names each track by its own part, or an added one by what it plays', () => {
    expect(gridTracks(own, added).map((track) => track.name)).toEqual(['Drums', 'Bass', 'Arp', 'Instrument', 'Drums']);
  });

  it('uses the names given to tracks in the grid', () => {
    const names = { drums: 'Beat', 'part-4': 'Lead line', 'added-a': 'Stabs' };
    expect(gridTracks(own, added, names).map((track) => track.name)).toEqual(['Beat', 'Bass', 'Lead line', 'Stabs', 'Drums']);
  });

  it('keeps names with the song, as long as each is a trimmed, non-empty name', () => {
    expect(validJamTrackEdit(CHIP.file, edit({ 'part-3': 'Low end' }))).toBe(true);
    expect(validJamTrackEdit(CHIP.file, edit({ 'part-3': '' }))).toBe(false);
    expect(validJamTrackEdit(CHIP.file, edit({ 'part-3': ' Low ' }))).toBe(false);
    expect(validJamTrackEdit(CHIP.file, edit({ 'part-3': 'x'.repeat(JAM_TRACK_NAME_MAX + 1) }))).toBe(false);
    expect(validJamTrackEdit(CHIP.file, edit({ 'part-3': 3 }))).toBe(false);
  });

  it('offers lesson rooms the tracks by their given names', () => {
    const choices = jamLessonChoices(CHIP.file, edit({ drums: 'Beat', 'part-3': 'Low end' }));
    expect(choices.find((choice) => choice.id === 'drum-0')).toEqual({ id: 'drum-0', name: 'Kick', kit: 'Beat' });
    expect(choices.find((choice) => choice.id === 'part-3')).toEqual({ id: 'part-3', name: 'Low end' });
  });
});
