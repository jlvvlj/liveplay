import { Lesson, LessonStep } from '../types/lesson';
import { getStemLabel, Song, StemId } from '../types/song';

export interface StemSound {
  id: number;
  clip: string; // relative to /audio/
  centroidHz: number;
  start: number; // clip region within the stem, seconds
  end: number;
  label?: string; // e.g. "Kick" or "E1" when a transcription model names the lane
  pitch?: number; // MIDI pitch of a pitched lane (its clip plays this note)
}

export interface StemEvent {
  time: number; // seconds
  sound: number;
  velocity: number;
  duration?: number; // this event's own slice length within the stem
  pitch?: number; // MIDI pitch of a pitched note; differs from its lane's when folded
}

export interface StemLessonData {
  stem: StemId;
  bpm: number;
  duration: number;
  sounds: StemSound[];
  events: StemEvent[];
  backing: string; // relative to /audio/
  rev: number; // bumped on edits; busts the browser's audio cache
  grid?: { beats: number[]; downbeats: number[]; beatsPerBar: number }; // song-wide beat grid
}

const TICKS_PER_QUARTER = 480;
// Arbitrary contiguous note ids: sound N -> note BASE_NOTE+N. Pure lookup
// keys connecting pad -> highway lane; no MIDI drum semantics.
const BASE_NOTE = 36;

/**
 * Wraps category-free stem analysis in the existing Lesson format: each
 * distinct sound is a lane whose events trigger the selected sound clip,
 * and events land at their original timestamps (ticks are derived from the
 * BPM and convert back to the same seconds during the lesson).
 */
export function stemLessonFromSong(song: Song, data: StemLessonData): Lesson {
  const secondsPerTick = 60 / (data.bpm * TICKS_PER_QUARTER);
  const label = getStemLabel(data.stem);

  const lanePitch = new Map(data.sounds.map((sound) => [sound.id, sound.pitch]));
  const steps: LessonStep[] = data.events.map((event) => {
    const lane = lanePitch.get(event.sound);
    const semitones = event.pitch !== undefined && lane !== undefined ? event.pitch - lane : 0;
    return {
      tick: Math.round(event.time / secondsPerTick),
      note: BASE_NOTE + event.sound,
      dur: 120,
      velocity: event.velocity,
      lane: event.sound,
      ...(semitones !== 0 ? { semitones } : {}),
    };
  });

  const samples: { [note: number]: string } = {};
  const laneLabels: { [note: number]: string } = {};
  for (const sound of data.sounds) {
    samples[BASE_NOTE + sound.id] = `${sound.clip}?rev=${data.rev ?? 1}`;
    laneLabels[BASE_NOTE + sound.id] = sound.label ?? `Sound ${sound.id + 1}`;
  }

  return {
    id: `song-${data.stem}-${song.id}`,
    title: `${song.title} — ${label}`,
    instrument: 'pads',
    bpm: data.bpm,
    timeSignature: { numerator: data.grid?.beatsPerBar ?? 4, denominator: 4 },
    steps,
    samples,
    laneLabels,
    backingTrack: data.backing,
    ...(data.grid ? { beatGrid: { beats: data.grid.beats, downbeats: data.grid.downbeats } } : {}),
    metadata: {
      genre: 'Song practice',
      tags: ['song', data.stem, 'auto-analyzed'],
      description: `${data.sounds.length} distinct sounds found in the ${label.toLowerCase()} of ${song.title}`,
    },
  };
}
