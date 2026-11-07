/**
 * @jest-environment node
 */
import { jamLessonFromSong, jamSongTracks } from '../apps/desktop/src/renderer/components/lesson-engine/jamLessonRooms';
import { JAM_SONGS, jamRoomSongOf } from '../apps/desktop/src/renderer/components/lesson-engine/jamSongs';
import { jamTrackByFile, jamTrackParts } from '../apps/desktop/src/renderer/components/lesson-engine/jamTracks';

const CHIP = jamRoomSongOf(JAM_SONGS.find((song) => song.id === 'chip-run-jam')!);
const parts = jamTrackParts(jamTrackByFile(CHIP.file)!);

describe('lesson rooms', () => {
  it('lists a song\'s tracks as the grid shows them', () => {
    expect(jamSongTracks(CHIP.file, null).map((track) => track.name)).toEqual(['Drums', 'Bass', 'Arp']);
  });

  it('makes an instrument track a lesson with a lane per pitch, looping with the song', () => {
    const made = jamLessonFromSong(CHIP, null, 'part-3')!;
    const bass = parts[3].notes;
    expect(made.parts).toEqual([3]);
    expect(made.lanes.map((lane) => lane.note)).toEqual([...new Set(bass.map((note) => note.pitch))].sort((a, b) => a - b));
    expect(made.lesson.steps).toHaveLength(bass.length);
    expect(made.lesson.bpm).toBe(CHIP.bpm);
    expect(made.lesson.loop).toEqual({ startTick: 0, endTick: 8 * 16 * 120 });
    // Steps in order, 120 ticks a 16th
    expect(made.lesson.steps[0].tick).toBe(Math.min(...bass.map((note) => note.step)) * 120);
  });

  it('makes a kit a lesson with a lane per drum that plays', () => {
    const made = jamLessonFromSong(CHIP, null, 'drums')!;
    const drums = parts.flatMap((part, index) => (part.kind === 'drum' && part.notes.length ? [index] : []));
    expect(made.parts).toEqual(parts.flatMap((part, index) => (part.kind === 'drum' ? [index] : [])));
    expect(made.lanes.map((lane) => lane.part)).toEqual(drums);
    expect(made.lanes.map((lane) => lane.note)).toEqual(drums.map((_, lane) => 36 + lane));
    expect(made.lesson.laneLabels?.[36]).toBe(parts[drums[0]].name);
  });

  it('knows no track the song does not have', () => {
    expect(jamLessonFromSong(CHIP, null, 'part-99')).toBeNull();
  });
});

describe('a lesson room at another tempo', () => {
  it('plays its built-in song over the track at that tempo, its lesson too', () => {
    const faster = { ...CHIP, bpm: 130, file: `${CHIP.file}@130` };
    const made = jamLessonFromSong(faster, null, 'drums')!;
    expect(made.lesson.bpm).toBe(130);
    expect(made.lesson.backingTrack).toBe(`samples/pentatonic_jam/${CHIP.file}@130`);
    // The same notes, at the new tempo
    expect(made.lesson.steps).toEqual(jamLessonFromSong(CHIP, null, 'drums')!.lesson.steps);
    expect(jamLessonFromSong(CHIP, null, 'drums')!.lesson.bpm).toBe(CHIP.bpm);
  });
});
