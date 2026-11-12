import type { Lesson, LessonStep } from '../../types/lesson';
import { JAM_TRACK_BARS, jamTrackByFile, jamTrackParts } from './jamTracks';
import { jamAddedPartName } from './jamAddedParts';
import { gridTracks } from './jamGridTracks';
import type { JamTrackEdit } from './jamTrackEdits';
import type { JamRoomSong } from './jamRoomProtocol';
import { jamRoomSongLesson } from './jamSongs';

// Lesson rooms: a Jam room whose song also gives a lesson, from one or more
// of its tracks (a kit's drums each count as one: kick and snare, say). Their
// notes come at the ship as a lesson's notes come at the timing line, a lane
// per drum or per pitch, and loop with the song. The lesson's tracks are left
// out of the backing; each hit plays its own track's sound.

const TICKS_PER_16TH = 120; // lessons count 480 ticks a beat
const KIT_BASE_NOTE = 36; // a kit's lanes are plain ids, one per drum from 36 up

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (pitch: number) => `${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;

// A lane of the lesson: its note in the lesson, and the part and pitch it plays
export interface JamLessonLane {
  note: number;
  part: number;
  pitch: number;
}

export interface JamLesson {
  lesson: Lesson;
  lanes: JamLessonLane[];
  // The tracks' parts, left out of the backing
  parts: number[];
}

// What a lesson room can learn, in the song's order: each drum of a kit on
// its own (`kit` names its kit), each other track whole
export interface JamLessonChoice {
  id: string;
  name: string;
  kit?: string;
}

const drumId = (part: number) => `drum-${part}`;

// A song's lesson choices: a kit's drums that play, each other track
export function jamLessonChoices(file: string, edit: JamTrackEdit | null | undefined): JamLessonChoice[] {
  const track = jamTrackByFile(file);
  if (!track) return [];
  const own = jamTrackParts(track);
  const added = edit?.added ?? [];
  const notes = edit?.parts ?? own.map((part) => part.notes);
  const partName = (part: number) => own[part]?.name ?? jamAddedPartName(added[part - own.length]);
  return gridTracks(own, added).flatMap((grid) =>
    grid.kind === 'drum'
      ? grid.parts.filter((part) => notes[part]?.length).map((part) => ({ id: drumId(part), name: partName(part), kit: grid.name }))
      : [{ id: grid.id, name: grid.name }]
  );
}

// A lesson's name from its choices: theirs in the song's order, joined, a kit
// whose every drum is chosen by the kit's name
export function jamLessonName(choices: JamLessonChoice[], ids: string[]): string {
  const chosen = new Set(ids);
  const names: string[] = [];
  const kitsNamed = new Set<string>();
  for (const choice of choices) {
    if (!chosen.has(choice.id)) continue;
    const kit = choice.kit;
    if (kit !== undefined && choices.filter((other) => other.kit === kit).every((other) => chosen.has(other.id))) {
      if (!kitsNamed.has(kit)) names.push(kit);
      kitsNamed.add(kit);
    } else {
      names.push(choice.name);
    }
  }
  return names.join(' + ');
}

// Lanes of several tracks in one lesson: each track keeps its own notes,
// unless they meet an earlier track's, when they move up past them. Returns
// each group's shift.
export function jamStackLanes(groups: number[][]): number[] {
  let top = -Infinity;
  return groups.map((notes) => {
    if (notes.length === 0) return 0;
    const low = Math.min(...notes);
    const shift = low <= top ? top + 1 - low : 0;
    top = Math.max(...notes) + shift;
    return shift;
  });
}

// The lesson some of a song's tracks make (grid track ids, or a kit's drums
// by drum-<part>), with the song's notes as edited; null when the song has
// none of them
export function jamLessonFromSong(song: JamRoomSong, edit: JamTrackEdit | null | undefined, ids: string[]): JamLesson | null {
  const track = jamTrackByFile(song.file);
  if (!track) return null;
  const own = jamTrackParts(track);
  const added = edit?.added ?? [];
  const notes = edit?.parts ?? own.map((part) => part.notes);
  const bars = edit?.bars ?? JAM_TRACK_BARS;
  const grids = gridTracks(own, added);
  const partName = (part: number) => own[part]?.name ?? jamAddedPartName(added[part - own.length]);
  const chosen = new Set(ids);
  const known = (id: string) => grids.some((grid) => grid.id === id || (grid.kind === 'drum' && grid.parts.some((part) => drumId(part) === id)));
  if (ids.length === 0 || !ids.every(known)) return null;

  // The chosen drums, every kit's together; then each chosen notes track
  const drums = grids
    .filter((grid) => grid.kind === 'drum')
    .flatMap((grid) => grid.parts.filter((part) => chosen.has(grid.id) || chosen.has(drumId(part))));
  const tracks = grids.filter((grid) => grid.kind === 'notes' && chosen.has(grid.id));

  type Lane = JamLessonLane & { label: string };
  const kit: Lane[] = drums
    .filter((part) => notes[part].length > 0)
    .map((part, lane) => ({ note: KIT_BASE_NOTE + lane, part, pitch: notes[part][0].pitch, label: partName(part) }));
  const pitched: Lane[][] = tracks.map((grid) =>
    [...new Set(notes[grid.parts[0]].map((note) => note.pitch))]
      .sort((a, b) => a - b)
      .map((pitch) => ({ note: pitch, part: grid.parts[0], pitch, label: noteName(pitch) }))
  );
  const groups = [kit, ...pitched];
  const shifts = jamStackLanes(groups.map((group) => group.map((lane) => lane.note)));
  const lanes: Lane[] = groups.flatMap((group, at) => group.map((lane) => ({ ...lane, note: lane.note + shifts[at] })));

  const drumParts = new Set(drums);
  const steps: LessonStep[] = lanes
    .flatMap((lane) =>
      notes[lane.part]
        .filter((note) => drumParts.has(lane.part) || note.pitch === lane.pitch)
        .map((note) => ({
          tick: Math.round(note.step * TICKS_PER_16TH),
          note: lane.note,
          dur: Math.max(1, Math.round(note.length * TICKS_PER_16TH)),
          velocity: note.velocity,
        }))
    )
    .sort((a, b) => a.tick - b.tick || a.note - b.note);

  const name = jamLessonName(jamLessonChoices(song.file, edit), [
    ...ids.filter((id) => !grids.some((grid) => grid.kind === 'drum' && grid.id === id)),
    ...grids.filter((grid) => grid.kind === 'drum' && chosen.has(grid.id)).flatMap((grid) => grid.parts.map(drumId)),
  ]);
  const base = jamRoomSongLesson(song);
  return {
    lesson: {
      ...base,
      id: `lesson:${song.id}:${[...ids].sort().join('+')}`,
      title: `${name} — ${song.title}`,
      instrument: tracks.length === 0 ? 'drums' : 'keys',
      steps,
      loop: { startTick: 0, endTick: bars * 16 * TICKS_PER_16TH },
      laneLabels: Object.fromEntries(lanes.map((lane) => [lane.note, lane.label])),
      metadata: { ...base.metadata, description: `${name} of ${song.title}` },
    },
    lanes: lanes.map(({ note, part, pitch }) => ({ note, part, pitch })),
    parts: [...drums, ...tracks.flatMap((grid) => grid.parts)],
  };
}
