import type { LessonStep } from '../../types/lesson';
import { abletonNoteKey } from '../../utils/abletonImport';
import type { JamAbletonTrack, JamDawSong } from './jamRoomProtocol';

// The sounds of a song imported from an Ableton project, as a sound pack under
// the song's title, each sound a lane of a track. As for Softer
// (scripts/make-softer-jam.mjs): a track playing more than one pitch is an
// instrument, each pitch recorded at its real key; every other sound (a track
// of one key, a chord, a detected hit) is one pad of the song's kit.

export interface JamPackSound {
  name: string;
  // The track's export (GET /jam-audio/<audio>) and where the lane's notes are
  // in it, in seconds: the sampler plays the best of them, heard once decoded
  audio: string;
  slices: { offset: number; duration: number }[];
}
export interface JamPackInstrument {
  // The track's place in the song, which names the instrument for good
  track: number;
  name: string;
  notes: (JamPackSound & { root: number })[];
}
export interface JamSongPack {
  song: string;
  title: string;
  kit: JamPackSound[];
  instruments: JamPackInstrument[];
}

// Every instrument of a song pack has an id starting with this
export const JAM_SONG_PACK_ID = 'song:';

export const jamPackAudioUrl = (server: string, audio: string) => `${server}/jam-audio/${audio}`;

type Sliced = LessonStep & { slice: NonNullable<LessonStep['slice']> };

function trackLanes(track: JamAbletonTrack): { label: string; sound: JamPackSound }[] {
  const steps = track.lesson.steps.filter((step): step is Sliced => !!step.slice);
  const notes = [...new Set(steps.map((step) => step.note))].sort((a, b) => a - b);
  return notes.map((note) => {
    const label = track.lesson.laneLabels?.[note] ?? track.name;
    const slices = steps.filter((step) => step.note === note).map(({ slice: { offset, duration } }) => ({ offset, duration }));
    return { label, sound: { name: label, audio: track.audio, slices } };
  });
}

export function jamSongPack(song: Pick<JamDawSong, 'id' | 'title' | 'ableton'>): JamSongPack {
  const pack: JamSongPack = { song: song.id, title: song.title, kit: [], instruments: [] };
  song.ableton?.tracks.forEach((track, index) => {
    const lanes = trackLanes(track);
    const roots = lanes.map(({ label }) => abletonNoteKey(label));
    if (lanes.length > 1 && roots.every((root) => root !== null)) {
      pack.instruments.push({
        track: index,
        name: track.name,
        notes: lanes.map(({ sound }, lane) => ({ ...sound, root: roots[lane]! })),
      });
    } else {
      for (const { label, sound } of lanes) pack.kit.push({ ...sound, name: lanes.length === 1 ? track.name : `${track.name} ${label}` });
    }
  });
  return pack;
}
