import { Lesson, LessonStep } from '../types/lesson';

/**
 * Reads an Ableton Live project folder entirely in the browser: the .als is
 * gzip-compressed XML holding every track's notes. A picked track becomes a
 * normal lesson with its notes on the highway. Its sound is, in order of
 * preference:
 *  - its own export (File > Export Audio/Video > All Individual Tracks,
 *    rendered from 1.1.1 into the project folder): each note plays its slice
 *    of that render, so it sounds exactly like the song;
 *  - otherwise the sample its Simpler plays.
 * The backing track is every other exported track mixed together.
 */

const TICKS_PER_BEAT = 480; // an Ableton beat is a quarter note

export interface AbletonNote {
  beat: number; // arrangement position, beats (where it sits on the highway)
  key: number; // MIDI key
  duration: number; // beats
  velocity: number;
  audioBeat?: number; // where it sounds in the export, if not exactly on `beat`
}

export interface AbletonTrack {
  name: string;
  notes: AbletonNote[];
  sampleName: string | null; // the sample a Simpler on this track plays
  sampleRootKey: number;
  soundNames?: { [key: number]: string }; // lane names for keys that aren't pitches
}

/** A file of the project folder, with its path inside that folder. */
export interface ProjectFile {
  path: string; // e.g. "Project/Samples/Imported/Kick.wav"
  file: File;
}

/** A file of the project folder, with its path inside that folder. */
export interface ProjectFile {
  path: string; // e.g. "Project/Samples/Imported/Kick.wav"
  file: File;
}

export interface AbletonProject {
  name: string;
  tempo: number;
  tracks: AbletonTrack[]; // MIDI tracks that have notes in the arrangement
  files: ProjectFile[]; // every file in the project folder
  exports: Map<string, File>; // track name -> its exported WAV (MIDI and audio tracks)
  audioTracks: string[]; // audio tracks: no notes, hits can be detected in their export
}

const value = (el: Element | null | undefined, selector: string): string | null =>
  el?.querySelector(selector)?.getAttribute('Value') ?? null;

const num = (el: Element | null | undefined, selector: string, fallback = 0): number => {
  const v = value(el, selector);
  return v === null ? fallback : Number(v);
};

async function gunzipText(file: File): Promise<string> {
  const stream = file.stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/** Every note of one arrangement clip, placed on the arrangement timeline. */
function clipNotes(clip: Element): AbletonNote[] {
  if (value(clip, ':scope > Disabled') === 'true') return [];
  const clipStart = Number(clip.getAttribute('Time') ?? 0);
  const clipEnd = num(clip, ':scope > CurrentEnd');
  const loopOn = value(clip, ':scope > Loop > LoopOn') === 'true';
  const loopStart = num(clip, ':scope > Loop > LoopStart');
  const loopEnd = num(clip, ':scope > Loop > LoopEnd');
  const startRelative = num(clip, ':scope > Loop > StartRelative');
  const loopLength = loopEnd - loopStart;

  const notes: AbletonNote[] = [];
  for (const keyTrack of Array.from(clip.querySelectorAll('KeyTrack'))) {
    const key = num(keyTrack, ':scope > MidiKey');
    for (const event of Array.from(keyTrack.querySelectorAll('MidiNoteEvent'))) {
      if (event.getAttribute('IsEnabled') === 'false') continue;
      const time = Number(event.getAttribute('Time'));
      const note = {
        key,
        duration: Number(event.getAttribute('Duration')),
        velocity: Math.round(Number(event.getAttribute('Velocity'))),
      };
      if (time < loopStart || time >= loopEnd) continue;
      if (loopOn && loopLength > 0) {
        // the loop repeats until the clip ends in the arrangement
        let offset = time - loopStart - startRelative;
        if (offset < 0) offset += loopLength;
        for (let beat = clipStart + offset; beat < clipEnd - 1e-9; beat += loopLength) {
          notes.push({ ...note, beat });
        }
      } else {
        const beat = clipStart + (time - loopStart);
        if (beat < clipEnd - 1e-9) notes.push({ ...note, beat });
      }
    }
  }
  return notes;
}

export async function readAbletonProject(files: ProjectFile[]): Promise<AbletonProject> {
  const sets = files.filter((f) => f.file.name.endsWith('.als') && !/(^|\/)Backup\//.test(f.path));
  if (sets.length === 0) throw new Error('This folder has no Ableton Live Set (.als).');
  const setFile = sets[0].file;
  const doc = new DOMParser().parseFromString(await gunzipText(setFile), 'application/xml');
  const liveSet = doc.querySelector('Ableton > LiveSet');
  if (!liveSet) throw new Error(`${setFile.name} is not a readable Ableton Live Set.`);

  // Live 12 calls it MainTrack, earlier versions MasterTrack
  const main = liveSet.querySelector(':scope > MainTrack, :scope > MasterTrack');
  const tempo = num(main, 'Tempo > Manual', 120);

  const tracks: AbletonTrack[] = [];
  for (const track of Array.from(liveSet.querySelectorAll(':scope > Tracks > MidiTrack'))) {
    const notes = Array.from(track.querySelectorAll('ArrangerAutomation > Events > MidiClip'))
      .flatMap(clipNotes)
      .sort((a, b) => a.beat - b.beat || a.key - b.key);
    if (notes.length === 0) continue;
    const simpler = track.querySelector('OriginalSimpler');
    tracks.push({
      name: value(track, ':scope > Name > EffectiveName') ?? 'Track',
      notes,
      sampleName: value(simpler, 'SampleRef > FileRef > Name'),
      sampleRootKey: num(simpler, 'MultiSamplePart > RootKey', 60),
    });
  }

  // every MIDI and audio track can have an export; group tracks are left out
  // because their export repeats the tracks inside them
  const trackNames = Array.from(liveSet.querySelectorAll(':scope > Tracks > MidiTrack, :scope > Tracks > AudioTrack'))
    .map((track) => value(track, ':scope > Name > EffectiveName'))
    .filter((name): name is string => !!name);

  return {
    name: setFile.name.replace(/\.als$/, ''),
    tempo,
    tracks,
    files,
    exports: matchExports(files, trackNames),
    audioTracks: Array.from(liveSet.querySelectorAll(':scope > Tracks > AudioTrack'))
      .map((track) => value(track, ':scope > Name > EffectiveName'))
      .filter((name): name is string => !!name),
  };
}

const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Pairs exported WAVs with tracks. Ableton names each file after its track
 * (with a prefix), so a file belongs to the longest track name its name ends
 * with ("Atmos Chop" beats "Chop"). The project's own samples are not exports.
 * When a track was exported more than once, the newest export is used.
 */
function matchExports(files: ProjectFile[], trackNames: string[]): Map<string, File> {
  const exports = new Map<string, File>();
  const byLength = [...new Set(trackNames)].sort((a, b) => b.length - a.length);
  for (const { path, file } of files) {
    if (!/\.(wav|aiff?)$/i.test(file.name)) continue;
    if (/(^|\/)(Samples|Backup)\//.test(path)) continue;
    const base = normalize(file.name.replace(/\.[^.]+$/, ''));
    const track = byLength.find((name) => base === normalize(name) || base.endsWith(' ' + normalize(name)));
    if (!track) continue;
    const current = exports.get(track);
    if (!current || file.lastModified > current.lastModified) exports.set(track, file);
  }
  return exports;
}

/** The folder's copy of a track's sample, preferring the project's Samples folder. */
export function findSampleFile(project: AbletonProject, track: AbletonTrack): File | null {
  if (!track.sampleName) return null;
  const matches = project.files.filter((f) => f.file.name === track.sampleName);
  return (matches.find((f) => /(^|\/)Samples\//.test(f.path)) ?? matches[0])?.file ?? null;
}

/** A track can be practised if its export or its Simpler sample is in the folder. */
export const isPlayable = (project: AbletonProject, track: AbletonTrack) =>
  project.exports.has(track.name) || findSampleFile(project, track) !== null;

/** Where the lesson starts: the bar of the track's first note, so it doesn't open on silence. */
export const lessonStartBeat = (track: AbletonTrack) => Math.floor(track.notes[0].beat / 4) * 4;

const MAX_SLICE_SECONDS = 8;
const TAIL_SECONDS = 2;
// A chord, even strummed, is one group: notes on different keys each
// starting within this time of the previous one. Every note of a group plays
// the group's whole slice, once. Repeats on one key (a roll) never group.
const GROUP_SECONDS = 0.08;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (key: number) => `${NOTE_NAMES[key % 12]}${Math.floor(key / 12) - 2}`; // Ableton: C3 = 60

const CHORD_SHAPES: [string, number[]][] = [
  ['', [0, 4, 7]],
  ['m', [0, 3, 7]],
  ['7', [0, 4, 7, 10]],
  ['maj7', [0, 4, 7, 11]],
  ['m7', [0, 3, 7, 10]],
  ['sus2', [0, 2, 7]],
  ['sus4', [0, 5, 7]],
  ['dim', [0, 3, 6]],
  ['add9', [0, 2, 4, 7]],
  ['m(add9)', [0, 2, 3, 7]],
  ['5', [0, 7]],
];

/** "Fm", "C#maj7", or the note names when the notes aren't a common chord. */
function chordName(keys: number[]): string {
  const classes = [...new Set(keys.map((k) => k % 12))];
  // try the bass note as root first, so inversions read as slash chords
  const roots = [keys[0] % 12, ...classes.filter((c) => c !== keys[0] % 12)];
  for (const root of roots) {
    const shape = classes.map((c) => (c - root + 12) % 12).sort((a, b) => a - b);
    const match = CHORD_SHAPES.find(([, s]) => s.length === shape.length && s.every((v, i) => v === shape[i]));
    if (match) {
      const name = NOTE_NAMES[root] + match[0];
      return root === keys[0] % 12 ? name : `${name}/${NOTE_NAMES[keys[0] % 12]}`;
    }
  }
  return keys.map(noteName).join(' ');
}

interface NoteGroup {
  beat: number; // highway position (first note)
  audioBeat: number; // where it sounds in the export (first note)
  keys: number[]; // sorted, distinct
  duration: number; // beats
  velocity: number;
}

/**
 * Notes on different keys each starting within GROUP_SECONDS of the previous
 * one form a group: a chord, even strummed. Repeats on one key (a roll)
 * never group. A single note is a group of one.
 */
function groupNotes(notes: AbletonNote[], secondsPerBeat: number): NoteGroup[] {
  const groups: NoteGroup[] = [];
  let current: NoteGroup | null = null;
  let previous = -Infinity;
  for (const n of notes) {
    if (!current || (n.beat - previous) * secondsPerBeat > GROUP_SECONDS || current.keys.includes(n.key)) {
      current = { beat: n.beat, audioBeat: n.audioBeat ?? n.beat, keys: [], duration: 0, velocity: 0 };
      groups.push(current);
    }
    current.keys.push(n.key);
    current.duration = Math.max(current.duration, n.beat - current.beat + n.duration);
    current.velocity = Math.max(current.velocity, n.velocity);
    previous = n.beat;
  }
  for (const group of groups) group.keys.sort((a, b) => a - b);
  return groups;
}

const LANE_BASE_NOTE = 36; // lanes of export lessons are plain ids: 36, 37, ...

export function abletonTrackToLesson(
  project: AbletonProject,
  track: AbletonTrack,
  urls: { export?: string; sample?: string; backing?: string }
): Lesson {
  const firstBar = lessonStartBeat(track);
  const secondsPerBeat = 60 / project.tempo;
  const tick = (beat: number) => Math.round((beat - firstBar) * TICKS_PER_BEAT);
  const shared = {
    id: `ableton-${project.name}-${track.name}`,
    title: `${track.name} — ${project.name}`,
    instrument: 'pads' as const,
    bpm: project.tempo,
    timeSignature: { numerator: 4, denominator: 4 },
    ...(urls.backing ? { backingTrack: urls.backing } : {}),
  };
  const nameOf = (keys: number[]) => {
    const sounds = track.soundNames;
    if (sounds) return keys.map((key) => sounds[key] ?? `Sound ${key - LANE_BASE_NOTE + 1}`).join(' + ');
    return keys.length > 1 ? chordName(keys) : noteName(keys[0]);
  };

  if (urls.export) {
    // Each group is one note on the highway, on one key: the same set of
    // notes is always the same key, a different chord a different key. It
    // plays the export from its start to the next group's start, so the
    // slices rebuild the recording exactly.
    const groups = groupNotes(track.notes, secondsPerBeat);
    const shapes = [...new Set(groups.map((g) => g.keys.join(',')))]
      .map((id) => id.split(',').map(Number))
      .sort((a, b) => a[0] - b[0] || a.length - b.length || a.join(',').localeCompare(b.join(',')));
    const laneOf = new Map(shapes.map((keys, lane) => [keys.join(','), lane]));
    const steps: LessonStep[] = groups.map((g, i) => {
      const next = groups[i + 1];
      const seconds =
        next !== undefined ? (next.audioBeat - g.audioBeat) * secondsPerBeat : g.duration * secondsPerBeat + TAIL_SECONDS;
      const lane = laneOf.get(g.keys.join(','))!;
      return {
        tick: tick(g.beat),
        note: LANE_BASE_NOTE + lane,
        dur: Math.max(1, Math.round(g.duration * TICKS_PER_BEAT)),
        velocity: g.velocity,
        lane,
        slice: { offset: g.audioBeat * secondsPerBeat, duration: Math.min(seconds, MAX_SLICE_SECONDS) },
      };
    });
    const chords = shapes.filter((keys) => keys.length > 1).length;
    return {
      ...shared,
      steps,
      stemAudio: urls.export,
      laneLabels: Object.fromEntries(
        shapes.map((keys, lane) => [LANE_BASE_NOTE + lane, shapes.length === 1 && keys.length === 1 ? track.name : nameOf(keys)])
      ),
      metadata: {
        genre: 'Ableton project',
        tags: ['ableton'],
        description:
          `${steps.length} notes from the ${track.name} track of ${project.name}` +
          (chords > 0 ? `, ${chords} different chords` : ''),
      },
    };
  }

  // Without an export a Simpler plays its sample, transposed per note: every
  // note keeps its own key.
  const keys = Array.from(new Set(track.notes.map((n) => n.key))).sort((a, b) => a - b);
  const steps: LessonStep[] = track.notes.map((n) => {
    const semitones = n.key - track.sampleRootKey; // Simpler transposes from its root key
    return {
      tick: tick(n.beat),
      note: n.key,
      dur: Math.max(1, Math.round(n.duration * TICKS_PER_BEAT)),
      velocity: n.velocity,
      lane: keys.indexOf(n.key),
      ...(semitones !== 0 ? { semitones } : {}),
    };
  });
  return {
    ...shared,
    steps,
    ...(urls.sample ? { samples: Object.fromEntries(keys.map((key) => [key, urls.sample!])) } : {}),
    laneLabels: Object.fromEntries(keys.map((key) => [key, keys.length === 1 ? track.name : nameOf([key])])),
    metadata: {
      genre: 'Ableton project',
      tags: ['ableton'],
      description: `${track.notes.length} notes from the ${track.name} track of ${project.name}`,
    },
  };
}

/** Hits detected in an audio track's export, as a track: each sound a lane. */
export function audioTrackFromAnalysis(
  project: AbletonProject,
  name: string,
  analysis: { sounds: { id: number }[]; events: { time: number; audioTime: number; sound: number; velocity: number }[] }
): AbletonTrack {
  const secondsPerBeat = 60 / project.tempo;
  const events = [...analysis.events].sort((a, b) => a.audioTime - b.audioTime);
  return {
    name,
    notes: events.map((e, i) => ({
      beat: e.time / secondsPerBeat,
      audioBeat: e.audioTime / secondsPerBeat,
      key: LANE_BASE_NOTE + e.sound,
      // at most until the next hit; the sound's real length is measured later
      duration: Math.min((events[i + 1]?.audioTime ?? e.audioTime + MAX_SLICE_SECONDS) - e.audioTime, MAX_SLICE_SECONDS) / secondsPerBeat,
      velocity: e.velocity,
    })),
    sampleName: null,
    sampleRootKey: LANE_BASE_NOTE,
    soundNames: Object.fromEntries(analysis.sounds.map((sound, i) => [LANE_BASE_NOTE + sound.id, `Sound ${i + 1}`])),
  };
}

const BACKING_SAMPLE_RATE = 44100;

/**
 * Mixes every exported track except the practised one into a stereo WAV,
 * from `startSeconds` (the lesson start) to the end. Tracks are decoded one
 * at a time so memory stays at the size of the mix, not of every track.
 * Levels are kept as exported; the whole mix is only scaled down if the sum
 * would clip.
 */
export async function renderBacking(project: AbletonProject, practised: AbletonTrack, startSeconds: number): Promise<string | null> {
  const others = [...project.exports].filter(([name]) => name !== practised.name).map(([, file]) => file);
  if (others.length === 0) return null;

  const decoder = new OfflineAudioContext(2, 1, BACKING_SAMPLE_RATE);
  const start = Math.round(startSeconds * BACKING_SAMPLE_RATE);
  let left = new Float32Array(0);
  let right = new Float32Array(0);

  for (const file of others) {
    const audio = await decoder.decodeAudioData(await file.arrayBuffer());
    const length = Math.max(audio.length - start, 0);
    if (length > left.length) {
      const grow = (old: Float32Array) => {
        const next = new Float32Array(length);
        next.set(old);
        return next;
      };
      left = grow(left);
      right = grow(right);
    }
    const l = audio.getChannelData(0);
    const r = audio.numberOfChannels > 1 ? audio.getChannelData(1) : l;
    for (let i = 0; i < length; i++) {
      left[i] += l[start + i];
      right[i] += r[start + i];
    }
  }

  let peak = 0;
  for (let i = 0; i < left.length; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  const gain = peak > 0.99 ? 0.99 / peak : 1;
  return URL.createObjectURL(encodeWav(left, right, BACKING_SAMPLE_RATE, gain));
}

function encodeWav(left: Float32Array, right: Float32Array, sampleRate: number, gain: number): Blob {
  const frames = left.length;
  const view = new DataView(new ArrayBuffer(44 + frames * 4));
  const text = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + frames * 4, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 2, true); // stereo
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true); // byte rate
  view.setUint16(32, 4, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  text(36, 'data');
  view.setUint32(40, frames * 4, true);
  for (let i = 0, o = 44; i < frames; i++, o += 4) {
    view.setInt16(o, Math.max(-1, Math.min(1, left[i] * gain)) * 0x7fff, true);
    view.setInt16(o + 2, Math.max(-1, Math.min(1, right[i] * gain)) * 0x7fff, true);
  }
  return new Blob([view], { type: 'audio/wav' });
}

const LENGTH_FRAME_SECONDS = 0.01;
const LENGTH_THRESHOLD_DB = -24; // a sound lasts until it falls this far below its peak

/**
 * Sets each note's length to how long its sound actually lasts in the export
 * (never longer than written), and turns on hold notes for the lesson. Notes
 * whose sound is long are then drawn at their length and must be held.
 */
export async function withSoundLengths(lesson: Lesson, exportFile: File): Promise<Lesson> {
  const decoder = new OfflineAudioContext(1, 1, 44100);
  const audio = await decoder.decodeAudioData(await exportFile.arrayBuffer());
  const rate = audio.sampleRate;
  const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
  const frame = Math.round(LENGTH_FRAME_SECONDS * rate);
  const ratio = 10 ** (LENGTH_THRESHOLD_DB / 20);
  const secondsPerTick = 60 / (lesson.bpm * TICKS_PER_BEAT);

  const soundSeconds = (offset: number, duration: number): number => {
    const start = Math.round(offset * rate);
    const end = Math.min(Math.round((offset + duration) * rate), audio.length);
    const levels: number[] = [];
    for (let i = start; i < end; i += frame) {
      let sum = 0;
      const stop = Math.min(i + frame, end);
      for (let j = i; j < stop; j++) {
        let v = 0;
        for (const data of channels) v += data[j];
        v /= channels.length;
        sum += v * v;
      }
      levels.push(Math.sqrt(sum / Math.max(stop - i, 1)));
    }
    const peak = Math.max(0, ...levels);
    if (peak === 0) return 0;
    let last = 0;
    levels.forEach((level, k) => {
      if (level >= peak * ratio) last = k;
    });
    return (last + 1) * LENGTH_FRAME_SECONDS;
  };

  const steps = lesson.steps.map((step) => {
    if (!step.slice) return step;
    const seconds = Math.min(step.dur * secondsPerTick, soundSeconds(step.slice.offset, step.slice.duration));
    return { ...step, dur: Math.max(1, Math.round(seconds / secondsPerTick)) };
  });
  return { ...lesson, steps, holdNotes: true };
}
