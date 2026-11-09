import type { Lesson } from '../../types/lesson';
import {
  abletonTrackToLesson,
  lessonStartBeat,
  readAbletonProject,
  withSoundLengths,
  type AbletonTrack,
  type ProjectFile,
} from '../../utils/abletonImport';
import { detectAudioTrack } from '../../utils/abletonLibrary';
import { encodeOpusWebm } from './jamOpus';
import { encodeWav16 } from './jamTrackRender';
import { JAM_ABLETON_FILE, type JamAbletonSong, type JamAbletonTrack, type JamDawSong } from './jamRoomProtocol';
import { jamRecordedBars, type JamTrack } from './jamTracks';

// Daw songs from Ableton projects, read by the full app's Ableton import
// (utils/abletonImport.ts, utils/abletonLibrary.ts) exactly as the Lessons
// tab reads them: every exported track's lesson, each note a slice of its
// export, audio tracks' hits detected by the server. Each export is sent as
// Opus (jamOpus.ts) and the lessons are kept on the song's own time.

const TICKS_PER_BEAT = 480;

export type JamImportStep =
  | { stage: 'reading' }
  | { stage: 'analyzing' | 'encoding'; track: string; done: number; total: number };

export interface JamImportedSong {
  title: string;
  bpm: number;
  ableton: JamAbletonSong;
}

// `server` is the jam server's address (http(s)://host)
export async function importAbletonProject(
  files: ProjectFile[],
  server: string,
  onStep: (step: JamImportStep) => void
): Promise<JamImportedSong> {
  onStep({ stage: 'reading' });
  const project = await readAbletonProject(files);
  const audioNames = project.audioTracks.filter((name) => project.exports.has(name));
  const tracks: AbletonTrack[] = project.tracks.filter((track) => project.exports.has(track.name));
  for (const [index, name] of audioNames.entries()) {
    onStep({ stage: 'analyzing', track: name, done: index, total: audioNames.length });
    tracks.push(await detectAudioTrack(project, name));
  }
  if (tracks.length === 0) throw new Error(`${project.name} has no exported tracks.`);

  // The song lasts to the bar after its last written note: its MIDI tracks'
  // (an audio track's detected hits run on into its sound's tail)
  const midi = tracks.slice(0, tracks.length - audioNames.length);
  const lastBeat = Math.max(...(midi.length ? midi : tracks).flatMap((track) => track.notes.map((note) => note.beat + note.duration)));
  const beats = Math.ceil(lastBeat / 4) * 4;
  const loop = { startTick: 0, endTick: beats * TICKS_PER_BEAT };

  const imported: JamAbletonTrack[] = [];
  for (const [index, track] of tracks.entries()) {
    onStep({ stage: 'encoding', track: track.name, done: index, total: tracks.length });
    const exportFile = project.exports.get(track.name)!;
    // The export's URL is the room server's, known once it is sent
    const made = await withSoundLengths(abletonTrackToLesson(project, track, { export: 'pending' }), exportFile);
    const shift = lessonStartBeat(track) * TICKS_PER_BEAT;
    const lesson: Lesson = { ...made, stemAudio: undefined };
    const response = await fetch(`${server}/jam-audio`, { method: 'POST', body: await encodeOpusWebm(exportFile) });
    const body = await response.json();
    if (!response.ok || !body.id) throw new Error(body.error ?? `Could not send ${track.name} (${response.status})`);
    imported.push({
      name: track.name,
      audio: body.id,
      lesson: { ...lesson, steps: lesson.steps.map((step) => ({ ...step, tick: step.tick + shift })), loop },
    });
  }
  return { title: project.name, bpm: project.tempo, ableton: { seconds: (beats * 60) / project.tempo, tracks: imported } };
}

// An imported track's export on the room server
export const jamAbletonAudioUrl = (server: string, track: JamAbletonTrack) => `${server}/jam-audio/${track.audio}`;

// An imported song as a track of the Daw and the Jam: its recordings, played as they are
export const jamRecordedTrackOf = (server: string, song: JamDawSong & { ableton: JamAbletonSong }): JamTrack => ({
  file: JAM_ABLETON_FILE,
  bpm: song.bpm,
  chords: [],
  layers: [],
  drums: [],
  bars: jamRecordedBars(song.ableton.seconds, song.bpm),
  recorded: song.ableton.tracks.map((track) => ({ name: track.name, url: jamAbletonAudioUrl(server, track) })),
});

// One of an imported song's tracks as a lesson: its notes, each a slice of its export
export const jamAbletonLesson = (server: string, songId: string, title: string, track: JamAbletonTrack): Lesson => ({
  ...track.lesson,
  id: `ableton:${songId}:${track.name}`,
  title: `${track.name} — ${title}`,
  stemAudio: jamAbletonAudioUrl(server, track),
});

const MIX_SAMPLE_RATE = 44100;

// Tracks' audio mixed into one loop of `seconds` (a WAV's blob URL), decoded one
// at a time so memory stays at the size of the mix; scaled down only if it would clip
export async function mixJamAbletonAudio(
  urls: string[],
  seconds: number,
  onTrack?: (done: number, total: number) => void
): Promise<string> {
  const length = Math.round(seconds * MIX_SAMPLE_RATE);
  const mix = [new Float32Array(length), new Float32Array(length)];
  const decoder = new OfflineAudioContext(2, 1, MIX_SAMPLE_RATE);
  for (const [index, url] of urls.entries()) {
    onTrack?.(index, urls.length);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
    const audio = await decoder.decodeAudioData(await response.arrayBuffer());
    const left = audio.getChannelData(0);
    const right = audio.numberOfChannels > 1 ? audio.getChannelData(1) : left;
    const frames = Math.min(length, audio.length);
    for (let i = 0; i < frames; i++) {
      mix[0][i] += left[i];
      mix[1][i] += right[i];
    }
  }
  let peak = 0;
  for (const channel of mix) for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(channel[i]));
  if (peak > 0.99) for (const channel of mix) for (let i = 0; i < length; i++) channel[i] *= 0.99 / peak;
  return URL.createObjectURL(new Blob([encodeWav16(mix, MIX_SAMPLE_RATE)], { type: 'audio/wav' }));
}
