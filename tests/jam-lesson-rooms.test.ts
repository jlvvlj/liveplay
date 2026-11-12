/**
 * @jest-environment node
 */
import {
  jamLessonChoices,
  jamLessonFromSong,
  jamLessonName,
  jamStackLanes,
} from '../apps/desktop/src/renderer/components/lesson-engine/jamLessonRooms';
import { jamAbletonLessonOfTracks } from '../apps/desktop/src/renderer/components/lesson-engine/jamAbletonImport';
import type { JamAbletonTrack } from '../apps/desktop/src/renderer/components/lesson-engine/jamRoomProtocol';
import { JAM_SONGS, jamRoomSongOf } from '../apps/desktop/src/renderer/components/lesson-engine/jamSongs';
import { jamTrackByFile, jamTrackParts } from '../apps/desktop/src/renderer/components/lesson-engine/jamTracks';

const CHIP = jamRoomSongOf(JAM_SONGS.find((song) => song.id === 'chip-run-jam')!);
const parts = jamTrackParts(jamTrackByFile(CHIP.file)!);

describe('lesson rooms', () => {
  it('offers a kit\'s drums each on its own, under the kit, then the other tracks', () => {
    expect(jamLessonChoices(CHIP.file, null)).toEqual([
      { id: 'drum-0', name: 'Kick', kit: 'Drums' },
      { id: 'drum-1', name: 'Snare', kit: 'Drums' },
      { id: 'drum-2', name: 'Hats', kit: 'Drums' },
      { id: 'part-3', name: 'Bass' },
      { id: 'part-4', name: 'Arp' },
    ]);
  });

  it('names a lesson by its tracks in the song\'s order, a whole kit by the kit', () => {
    const choices = jamLessonChoices(CHIP.file, null);
    expect(jamLessonName(choices, ['drum-1', 'drum-0'])).toBe('Kick + Snare');
    expect(jamLessonName(choices, ['part-4', 'drum-0', 'drum-1', 'drum-2'])).toBe('Drums + Arp');
    expect(jamLessonName(choices, ['part-3'])).toBe('Bass');
  });

  it('makes an instrument track a lesson with a lane per pitch, looping with the song', () => {
    const made = jamLessonFromSong(CHIP, null, ['part-3'])!;
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
    const made = jamLessonFromSong(CHIP, null, ['drums'])!;
    const drums = parts.flatMap((part, index) => (part.kind === 'drum' && part.notes.length ? [index] : []));
    expect(made.parts).toEqual(parts.flatMap((part, index) => (part.kind === 'drum' ? [index] : [])));
    expect(made.lanes.map((lane) => lane.part)).toEqual(drums);
    expect(made.lanes.map((lane) => lane.note)).toEqual(drums.map((_, lane) => 36 + lane));
    expect(made.lesson.laneLabels?.[36]).toBe(parts[drums[0]].name);
    // Its drums all chosen one by one make the same lesson
    expect(jamLessonFromSong(CHIP, null, ['drum-0', 'drum-1', 'drum-2'])!.lesson.steps).toEqual(made.lesson.steps);
  });

  it('makes kick and snare a lesson of those two drums, the others left in the backing', () => {
    const made = jamLessonFromSong(CHIP, null, ['drum-1', 'drum-0'])!;
    expect(made.parts).toEqual([0, 1]);
    expect(made.lanes).toEqual([
      { note: 36, part: 0, pitch: parts[0].notes[0].pitch },
      { note: 37, part: 1, pitch: parts[1].notes[0].pitch },
    ]);
    expect(made.lesson.steps).toHaveLength(parts[0].notes.length + parts[1].notes.length);
    expect(made.lesson.laneLabels).toEqual({ 36: 'Kick', 37: 'Snare' });
    expect(made.lesson.title).toBe(`Kick + Snare — ${CHIP.title}`);
    expect(made.lesson.instrument).toBe('drums');
  });

  it('puts tracks whose lanes meet one above the other, each lane on its own sound', () => {
    const made = jamLessonFromSong(CHIP, null, ['part-4', 'part-3'])!;
    const pitches = (part: number) => [...new Set(parts[part].notes.map((note) => note.pitch))].sort((a, b) => a - b);
    const bass = pitches(3);
    const arp = pitches(4);
    const shift = Math.min(...arp) <= Math.max(...bass) ? Math.max(...bass) + 1 - Math.min(...arp) : 0;
    expect(made.parts).toEqual([3, 4]);
    expect(made.lanes).toEqual([
      ...bass.map((pitch) => ({ note: pitch, part: 3, pitch })),
      ...arp.map((pitch) => ({ note: pitch + shift, part: 4, pitch })),
    ]);
    // No two lanes share a note
    expect(new Set(made.lanes.map((lane) => lane.note)).size).toBe(made.lanes.length);
    expect(made.lesson.steps).toHaveLength(parts[3].notes.length + parts[4].notes.length);
  });

  it('knows no track the song does not have', () => {
    expect(jamLessonFromSong(CHIP, null, ['part-99'])).toBeNull();
    expect(jamLessonFromSong(CHIP, null, ['part-3', 'drum-99'])).toBeNull();
    expect(jamLessonFromSong(CHIP, null, [])).toBeNull();
  });
});

describe('lanes of several tracks', () => {
  it('keeps each track\'s notes, unless they meet an earlier track\'s', () => {
    expect(jamStackLanes([[36, 37], [40, 45]])).toEqual([0, 0]);
    expect(jamStackLanes([[36, 37], [36]])).toEqual([0, 2]);
    expect(jamStackLanes([[40, 52], [48, 60], [36]])).toEqual([0, 5, 30]);
    expect(jamStackLanes([[], [36]])).toEqual([0, 0]);
  });
});

describe('several of an imported song\'s tracks', () => {
  const track = (name: string, note: number, offset: number): JamAbletonTrack => ({
    name,
    audio: name,
    lesson: {
      id: name,
      title: name,
      instrument: 'drums',
      bpm: 122,
      loop: { startTick: 0, endTick: 1920 },
      laneLabels: { [note]: name },
      steps: [
        { tick: 0, note, dur: 120, velocity: 100, slice: { offset, duration: 0.2 } },
        { tick: 480, note, dur: 120, velocity: 90, slice: { offset: offset + 0.5, duration: 0.2 } },
      ],
    },
  });

  it('makes one lesson, each hit a slice of its own track in the joined recording', () => {
    const made = jamAbletonLessonOfTracks('song', 'Paris', [track('Kick', 36, 0), track('Snare', 36, 0.25)], {
      url: 'blob:joined',
      offsets: [0, 8],
    });
    expect(made.title).toBe('Kick + Snare — Paris');
    expect(made.stemAudio).toBe('blob:joined');
    expect(made.laneLabels).toEqual({ 36: 'Kick', 37: 'Snare' });
    expect(made.steps.map((step) => [step.tick, step.note, step.slice!.offset])).toEqual([
      [0, 36, 0],
      [0, 37, 8.25],
      [480, 36, 0.5],
      [480, 37, 8.75],
    ]);
    expect(made.loop).toEqual({ startTick: 0, endTick: 1920 });
  });
});

describe('a lesson room at another tempo', () => {
  it('plays its built-in song over the track at that tempo, its lesson too', () => {
    const faster = { ...CHIP, bpm: 130, file: `${CHIP.file}@130` };
    const made = jamLessonFromSong(faster, null, ['drums'])!;
    expect(made.lesson.bpm).toBe(130);
    expect(made.lesson.backingTrack).toBe(`samples/pentatonic_jam/${CHIP.file}@130`);
    // The same notes, at the new tempo
    expect(made.lesson.steps).toEqual(jamLessonFromSong(CHIP, null, ['drums'])!.lesson.steps);
    expect(jamLessonFromSong(CHIP, null, ['drums'])!.lesson.bpm).toBe(CHIP.bpm);
  });
});
