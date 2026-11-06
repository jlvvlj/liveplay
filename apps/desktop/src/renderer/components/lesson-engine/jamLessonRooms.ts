import type { Lesson, LessonStep } from '../../types/lesson';
import { JAM_TRACK_BARS, jamTrackByFile, jamTrackParts } from './jamTracks';
import { jamAddedPartName } from './jamAddedParts';
import { gridTracks, type GridTrack } from './jamGridTracks';
import type { JamTrackEdit } from './jamTrackEdits';
import type { JamRoomSong } from './jamRoomProtocol';
import { jamRoomSongLesson } from './jamSongs';

// Lesson rooms: a Jam room whose song also gives a lesson, one of its tracks.
// That track's notes come at the ship as a lesson's notes come at the timing
// line, a lane per drum (a kit) or per pitch (an instrument), and loop with
// the song. The lesson track is left out of the backing; each hit plays it.

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
  // The track's parts, left out of the backing
  parts: number[];
}

// The tracks of a song, as the grid shows them
export function jamSongTracks(file: string, edit: JamTrackEdit | null | undefined): GridTrack[] {
  const track = jamTrackByFile(file);
  return track ? gridTracks(jamTrackParts(track), edit?.added ?? []) : [];
}

// The lesson one of a song's tracks makes, with the song's notes as edited;
// null when the song has no such track
export function jamLessonFromSong(song: JamRoomSong, edit: JamTrackEdit | null | undefined, trackId: string): JamLesson | null {
  const track = jamTrackByFile(song.file);
  if (!track) return null;
  const own = jamTrackParts(track);
  const added = edit?.added ?? [];
  const notes = edit?.parts ?? own.map((part) => part.notes);
  const bars = edit?.bars ?? JAM_TRACK_BARS;
  const chosen = gridTracks(own, added).find((candidate) => candidate.id === trackId);
  if (!chosen) return null;
  const partName = (part: number) => own[part]?.name ?? jamAddedPartName(added[part - own.length]);

  const lanes: (JamLessonLane & { label: string })[] =
    chosen.kind === 'drum'
      ? chosen.parts
          .filter((part) => notes[part].length > 0)
          .map((part, lane) => ({ note: KIT_BASE_NOTE + lane, part, pitch: notes[part][0].pitch, label: partName(part) }))
      : [...new Set(notes[chosen.parts[0]].map((note) => note.pitch))]
          .sort((a, b) => a - b)
          .map((pitch) => ({ note: pitch, part: chosen.parts[0], pitch, label: noteName(pitch) }));

  const steps: LessonStep[] = lanes
    .flatMap((lane) =>
      notes[lane.part]
        .filter((note) => chosen.kind === 'drum' || note.pitch === lane.pitch)
        .map((note) => ({
          tick: Math.round(note.step * TICKS_PER_16TH),
          note: lane.note,
          dur: Math.max(1, Math.round(note.length * TICKS_PER_16TH)),
          velocity: note.velocity,
        }))
    )
    .sort((a, b) => a.tick - b.tick || a.note - b.note);

  const base = jamRoomSongLesson(song);
  return {
    lesson: {
      ...base,
      id: `lesson:${song.id}:${trackId}`,
      title: `${chosen.name} — ${song.title}`,
      instrument: chosen.kind === 'drum' ? 'drums' : 'keys',
      steps,
      loop: { startTick: 0, endTick: bars * 16 * TICKS_PER_16TH },
      laneLabels: Object.fromEntries(lanes.map((lane) => [lane.note, lane.label])),
      metadata: { ...base.metadata, description: `${chosen.name} of ${song.title}` },
    },
    lanes: lanes.map(({ note, part, pitch }) => ({ note, part, pitch })),
    parts: chosen.parts,
  };
}
