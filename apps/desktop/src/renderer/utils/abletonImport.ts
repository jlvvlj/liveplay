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
  beat: number; // arrangement position, beats
  key: number; // MIDI key
  duration: number; // beats
  velocity: number;
}

export interface AbletonTrack {
  name: string;
  notes: AbletonNote[];
  sampleName: string | null; // the sample a Simpler on this track plays
  sampleRootKey: number;
}

export interface AbletonProject {
  name: string;
  tempo: number;
  tracks: AbletonTrack[]; // MIDI tracks that have notes in the arrangement
  files: File[]; // every file in the picked folder
  exports: Map<string, File>; // track name -> its exported WAV (MIDI and audio tracks)
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

export async function readAbletonProject(files: File[]): Promise<AbletonProject> {
  const sets = files.filter((f) => f.name.endsWith('.als') && !/(^|\/)Backup\//.test(f.webkitRelativePath));
  if (sets.length === 0) throw new Error('This folder has no Ableton Live Set (.als).');
  const setFile = sets[0];
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
  };
}

const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Pairs exported WAVs with tracks. Ableton names each file after its track
 * (with a prefix), so a file belongs to the longest track name its name ends
 * with ("Atmos Chop" beats "Chop"). The project's own samples are not exports.
 */
function matchExports(files: File[], trackNames: string[]): Map<string, File> {
  const exports = new Map<string, File>();
  const byLength = [...new Set(trackNames)].sort((a, b) => b.length - a.length);
  for (const file of files) {
    if (!/\.(wav|aiff?)$/i.test(file.name)) continue;
    if (/(^|\/)(Samples|Backup)\//.test(file.webkitRelativePath)) continue;
    const base = normalize(file.name.replace(/\.[^.]+$/, ''));
    const track = byLength.find((name) => base === normalize(name) || base.endsWith(' ' + normalize(name)));
    if (track && !exports.has(track)) exports.set(track, file);
  }
  return exports;
}

/** The picked folder's copy of a track's sample, preferring the project's Samples folder. */
export function findSampleFile(project: AbletonProject, track: AbletonTrack): File | null {
  if (!track.sampleName) return null;
  const matches = project.files.filter((f) => f.name === track.sampleName);
  return matches.find((f) => /(^|\/)Samples\//.test(f.webkitRelativePath)) ?? matches[0] ?? null;
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

export function abletonTrackToLesson(
  project: AbletonProject,
  track: AbletonTrack,
  urls: { export?: string; sample?: string; backing?: string }
): Lesson {
  const firstBar = lessonStartBeat(track);
  const secondsPerBeat = 60 / project.tempo;
  const keys = Array.from(new Set(track.notes.map((n) => n.key))).sort((a, b) => a - b);
  // With an export, each note plays the render from the start of its group
  // up to the next group: consecutive slices then rebuild the export exactly.
  const groupStarts: number[] = [];
  const noteGroup: number[] = []; // track.notes index -> its group's start beat
  let previous = -Infinity;
  let groupKeys = new Set<number>();
  for (const n of track.notes) {
    if ((n.beat - previous) * secondsPerBeat > GROUP_SECONDS || groupKeys.has(n.key)) {
      groupStarts.push(n.beat);
      groupKeys = new Set();
    }
    groupKeys.add(n.key);
    previous = n.beat;
    noteGroup.push(groupStarts[groupStarts.length - 1]);
  }

  const steps: LessonStep[] = track.notes.map((n, index) => {
    const step: LessonStep = {
      tick: Math.round((n.beat - firstBar) * TICKS_PER_BEAT),
      note: n.key,
      dur: Math.max(1, Math.round(n.duration * TICKS_PER_BEAT)),
      velocity: n.velocity,
      lane: keys.indexOf(n.key),
    };
    if (urls.export) {
      const start = noteGroup[index];
      const next = groupStarts.find((beat) => beat > start);
      const seconds =
        next !== undefined ? (next - start) * secondsPerBeat : n.duration * secondsPerBeat + TAIL_SECONDS;
      step.slice = { offset: start * secondsPerBeat, duration: Math.min(seconds, MAX_SLICE_SECONDS) };
    } else {
      const semitones = n.key - track.sampleRootKey; // Simpler transposes from its root key
      if (semitones !== 0) step.semitones = semitones;
    }
    return step;
  });

  return {
    id: `ableton-${project.name}-${track.name}`,
    title: `${track.name} — ${project.name}`,
    instrument: 'pads',
    bpm: project.tempo,
    timeSignature: { numerator: 4, denominator: 4 },
    steps,
    ...(urls.export ? { stemAudio: urls.export } : {}),
    ...(urls.sample ? { samples: Object.fromEntries(keys.map((key) => [key, urls.sample!])) } : {}),
    ...(urls.backing ? { backingTrack: urls.backing } : {}),
    laneLabels: Object.fromEntries(keys.map((key) => [key, keys.length === 1 ? track.name : `${track.name} ${key}`])),
    metadata: {
      genre: 'Ableton project',
      tags: ['ableton'],
      description: `${track.notes.length} notes from the ${track.name} track of ${project.name}`,
    },
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
