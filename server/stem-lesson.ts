import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { Song, StemName } from './songs';
import { chartAnalysis } from './charting';

const execFileAsync = promisify(execFile);

const UV_BIN = '/opt/homebrew/bin/uv';
const FFMPEG_BIN = '/opt/homebrew/bin/ffmpeg';
const STEM_NAMES: StemName[] = ['drums', 'bass', 'vocals', 'other'];
type StemId = string;

export interface MergedStem {
  id: string;
  stems: StemName[];
  label: string;
  path: string; // relative to audio/
}

export interface StemSound {
  id: number;
  label?: string; // e.g. "Kick" or "E1" when a transcription model names the lane
  pitch?: number; // MIDI pitch of a pitched lane (its clip plays this note)
  clip: string; // path relative to audio/
  centroidHz: number;
  start: number; // clip region within the stem, seconds
  end: number;
  sourceStem?: StemName;
  sourceSound?: number;
}

export interface StemEvent {
  time: number; // chart time, seconds (snapped to the beat grid when charted)
  sound: number; // StemSound id
  velocity: number; // 0-127
  duration?: number; // slice length within the stem, seconds
  audioTime?: number; // detected onset in the stem = slice offset (defaults to time)
  pitch?: number; // MIDI pitch of a pitched note; differs from its lane's when folded
  noteEnd?: number; // pitched notes: transcribed end, seconds
}

const MIN_SLICE = 0.12;

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** Ensure every event plays for the duration of its assigned editable sound. */
function withSoundDurations(events: StemEvent[], sounds: StemSound[], total: number): StemEvent[] {
  const durations = new Map(sounds.map((sound) => [sound.id, Math.max(sound.end - sound.start, MIN_SLICE)]));
  const sorted = [...events].sort((a, b) => a.time - b.time);
  return sorted.map((event) => {
    const requested = durations.get(event.sound) ?? MIN_SLICE;
    const remaining = Math.max(total - event.time, MIN_SLICE);
    return { ...event, duration: round4(Math.min(requested, remaining)) };
  });
}

async function matchSelectedSoundEvents(
  repoRoot: string,
  songDir: string,
  stemWav: string,
  stem: StemId,
  sounds: StemSound[],
  total: number
): Promise<StemEvent[]> {
  if (sounds.length === 0) return [];

  const env = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ''}` };
  const matchInputPath = path.join(songDir, `.stem-match-${stem}-${Date.now()}.json`);
  await fs.promises.writeFile(
    matchInputPath,
    JSON.stringify(sounds.map(({ id, start, end }) => ({ id, start, end })))
  );

  try {
    const { stdout } = await execFileAsync(
      UV_BIN,
      [
        'run',
        '--script',
        path.join(repoRoot, 'scripts', 'match_selected_stem_sounds.py'),
        '--input', stemWav,
        '--sounds', matchInputPath,
        '--sensitivity', '1.65',
      ],
      { env, maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60 * 1000 }
    );
    const match = JSON.parse(stdout.trim().split('\n').pop()!);
    if (match.error) {
      throw new Error(`Stem sound matching failed: ${match.error}`);
    }
    const soundIds = new Set(sounds.map((sound) => sound.id));
    const matchedEvents: StemEvent[] = (match.events ?? [])
      .filter((event: StemEvent) => soundIds.has(event.sound))
      .map((event: StemEvent) => ({
        time: round4(event.time),
        sound: event.sound,
        velocity: Math.max(1, Math.min(127, Math.round(event.velocity))),
      }));
    return withSoundDurations(matchedEvents, sounds, total);
  } finally {
    await fs.promises.rm(matchInputPath, { force: true });
  }
}

export interface StemLessonData {
  stem: StemId;
  bpm: number;
  duration: number;
  sounds: StemSound[];
  events: StemEvent[];
  backing: string; // mixed audio of the other three stems, relative to audio/
  rev: number; // bumped on every edit; used to cache-bust clip URLs
  sourceRevs?: Record<string, number>;
  grid?: { beats: number[]; downbeats: number[]; beatsPerBar: number }; // response only
}

function isStemName(value: string): value is StemName {
  return STEM_NAMES.includes(value as StemName);
}

function assertSafeStemId(stem: string): void {
  if (!/^[a-z0-9-]+$/.test(stem)) {
    throw new Error(`Invalid stem "${stem}".`);
  }
}

function mergedStemMetadataPath(songDir: string): string {
  return path.join(songDir, 'merged-stems.json');
}

function mergedStemId(stems: StemName[]): string {
  return `merged-${[...stems].sort().join('-')}`;
}

function stemLabel(stem: StemName): string {
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

function mergedStemLabel(stems: StemName[]): string {
  return stems.map(stemLabel).join(' + ');
}

async function readMergedStems(songDir: string): Promise<MergedStem[]> {
  try {
    const raw = await fs.promises.readFile(mergedStemMetadataPath(songDir), 'utf-8');
    const parsed = JSON.parse(raw) as MergedStem[];
    return parsed.filter(
      (stem) =>
        typeof stem.id === 'string' &&
        Array.isArray(stem.stems) &&
        stem.stems.every(isStemName) &&
        typeof stem.label === 'string' &&
        typeof stem.path === 'string'
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function writeMergedStems(songDir: string, stems: MergedStem[]): Promise<void> {
  await fs.promises.writeFile(mergedStemMetadataPath(songDir), JSON.stringify(stems, null, 2));
}

async function findMergedStem(songDir: string, stem: string): Promise<MergedStem | null> {
  return (await readMergedStems(songDir)).find((candidate) => candidate.id === stem) ?? null;
}

async function resolveStemAudio(
  song: Song,
  stem: StemId,
  repoRoot: string
): Promise<{ audioPath: string; sources: StemName[]; label: string; merged?: MergedStem }> {
  assertSafeStemId(stem);
  if (song.status !== 'ready' || !song.stems) {
    throw new Error('Song stems are not ready.');
  }

  if (isStemName(stem)) {
    return {
      audioPath: path.join(repoRoot, 'audio', song.stems[stem]),
      sources: [stem],
      label: stemLabel(stem),
    };
  }

  const songDir = path.join(repoRoot, 'audio', 'stems', song.id);
  const merged = await findMergedStem(songDir, stem);
  if (!merged) {
    throw new Error(`Unknown stem "${stem}".`);
  }
  return {
    audioPath: path.join(repoRoot, 'audio', merged.path),
    sources: merged.stems,
    label: merged.label,
    merged,
  };
}

function sourceRevSignature(sourceLessons: Array<{ stem: StemName; lesson: StemLessonData }>): Record<string, number> {
  return Object.fromEntries(sourceLessons.map(({ stem, lesson }) => [stem, lesson.rev ?? 1]));
}

function sameSourceRevs(a: Record<string, number> | undefined, b: Record<string, number>): boolean {
  if (!a) return false;
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return aKeys.length === bKeys.length && aKeys.every((key, index) => key === bKeys[index] && a[key] === b[key]);
}

async function ensureBackingTrack(
  song: Song,
  stem: StemId,
  resolved: { sources: StemName[]; label: string },
  songDir: string,
  repoRoot: string
): Promise<string> {
  if (!song.stems) {
    throw new Error('Song stems are not ready.');
  }

  const env = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ''}` };
  const backingPath = path.join(songDir, `backing-${stem}.wav`);
  if (!fs.existsSync(backingPath)) {
    const sourceSet = new Set(resolved.sources);
    const others = STEM_NAMES.filter((s) => !sourceSet.has(s));
    if (others.length === 0) {
      throw new Error(`Cannot build a backing track for ${resolved.label}; no stems remain outside the lesson stem.`);
    }
    await execFileAsync(
      FFMPEG_BIN,
      [
        '-y',
        ...others.flatMap((s) => ['-i', path.join(repoRoot, 'audio', song.stems![s])]),
        '-filter_complex',
        `amix=inputs=${others.length}:duration=longest:normalize=0`,
        '-c:a',
        'pcm_s16le',
        backingPath,
      ],
      { env, timeout: 5 * 60 * 1000 }
    );
  }
  return `stems/${song.id}/backing-${stem}.wav`;
}

async function buildMergedLessonFromSourceLessons(
  song: Song,
  stem: StemId,
  resolved: { sources: StemName[]; label: string },
  sourceLessons: Array<{ stem: StemName; lesson: StemLessonData }>,
  songDir: string,
  repoRoot: string,
  previousRev = 0
): Promise<StemLessonData> {
  const soundsDir = path.join(songDir, `sounds-${stem}`);
  await fs.promises.rm(soundsDir, { recursive: true, force: true });
  await fs.promises.mkdir(soundsDir, { recursive: true });

  const idMap = new Map<string, number>();
  const sounds: StemSound[] = [];
  for (const { stem: sourceStem, lesson } of sourceLessons) {
    for (const sound of lesson.sounds) {
      const id = sounds.length;
      const clipFile = `sound-${id}.wav`;
      const sourceClipPath = path.join(repoRoot, 'audio', sound.clip.split('?')[0]);
      const outputClipPath = path.join(soundsDir, clipFile);
      if (!fs.existsSync(sourceClipPath)) {
        throw new Error(`Cannot build merged stem: saved clip missing for ${sourceStem} sound ${sound.id}.`);
      }
      await fs.promises.copyFile(sourceClipPath, outputClipPath);
      idMap.set(`${sourceStem}:${sound.id}`, id);
      sounds.push({
        ...sound,
        id,
        clip: `stems/${song.id}/sounds-${stem}/${clipFile}`,
        sourceStem,
        sourceSound: sound.id,
      });
    }
  }

  const events: StemEvent[] = [];
  for (const { stem: sourceStem, lesson } of sourceLessons) {
    for (const event of lesson.events) {
      const sound = idMap.get(`${sourceStem}:${event.sound}`);
      if (sound === undefined) continue;
      events.push({
        time: round4(event.time),
        sound,
        velocity: event.velocity,
        ...(event.audioTime !== undefined ? { audioTime: event.audioTime } : {}),
      });
    }
  }

  const duration = Math.max(...sourceLessons.map(({ lesson }) => lesson.duration), 0);
  const lesson: StemLessonData = {
    stem,
    bpm: sourceLessons[0]?.lesson.bpm ?? 120,
    duration,
    sounds,
    events: withSoundDurations(events, sounds, duration),
    backing: await ensureBackingTrack(song, stem, resolved, songDir, repoRoot),
    rev: previousRev + 1,
    sourceRevs: sourceRevSignature(sourceLessons),
  };

  await fs.promises.writeFile(path.join(songDir, `stem-lesson-${stem}.json`), JSON.stringify(lesson));
  return lesson;
}

async function buildMergedLessonFromSources(
  song: Song,
  stem: StemId,
  resolved: { sources: StemName[]; label: string },
  songDir: string,
  repoRoot: string,
  previousRev = 0
): Promise<StemLessonData> {
  const sourceLessons = await Promise.all(
    resolved.sources.map(async (sourceStem) => ({
      stem: sourceStem,
      lesson: await getOrCreateStemLesson(song, sourceStem, repoRoot),
    }))
  );
  return buildMergedLessonFromSourceLessons(song, stem, resolved, sourceLessons, songDir, repoRoot, previousRev);
}

export async function listMergedStems(song: Song, repoRoot: string): Promise<MergedStem[]> {
  const songDir = path.join(repoRoot, 'audio', 'stems', song.id);
  return readMergedStems(songDir);
}

export async function createMergedStem(song: Song, stems: StemName[], repoRoot: string): Promise<MergedStem> {
  if (song.status !== 'ready' || !song.stems) {
    throw new Error('Song stems are not ready.');
  }
  const unique = [...new Set(stems)];
  if (unique.length !== 2 || !unique.every(isStemName)) {
    throw new Error('Choose two different source stems to merge.');
  }

  const sources = unique.sort() as StemName[];
  const id = mergedStemId(sources);
  const songDir = path.join(repoRoot, 'audio', 'stems', song.id);
  const outputPath = path.join(songDir, `${id}.wav`);
  const meta: MergedStem = {
    id,
    stems: sources,
    label: mergedStemLabel(sources),
    path: `stems/${song.id}/${id}.wav`,
  };

  await fs.promises.mkdir(songDir, { recursive: true });
  const env = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ''}` };
  if (!fs.existsSync(outputPath)) {
    await execFileAsync(
      FFMPEG_BIN,
      [
        '-y',
        ...sources.flatMap((source) => ['-i', path.join(repoRoot, 'audio', song.stems![source])]),
        '-filter_complex',
        'amix=inputs=2:duration=longest:normalize=0',
        '-c:a',
        'pcm_s16le',
        outputPath,
      ],
      { env, timeout: 5 * 60 * 1000 }
    );
  }

  const existing = await readMergedStems(songDir);
  const next = [...existing.filter((candidate) => candidate.id !== id), meta].sort((a, b) =>
    a.label.localeCompare(b.label)
  );
  await writeMergedStems(songDir, next);
  return meta;
}

/**
 * Category-free lesson data for any stem: the stem's distinct repeated
 * sounds (clustered, with exemplar clips sliced from the stem itself) and
 * the precise times at which each occurs. Cached per stem.
 */
export async function getOrCreateStemLesson(
  song: Song,
  stem: StemId,
  repoRoot: string
): Promise<StemLessonData> {
  const grid = await ensureBeatGrid(song, repoRoot);
  const lesson = await loadOrCreateStemLesson(song, stem, repoRoot, grid);
  // every stem lesson of a song shares the song-wide tempo; event times are
  // in seconds, so changing bpm never moves an event
  if (lesson.bpm !== grid.bpm) {
    lesson.bpm = grid.bpm;
    const cachePath = path.join(repoRoot, 'audio', 'stems', song.id, `stem-lesson-${stem}.json`);
    await fs.promises.writeFile(cachePath, JSON.stringify(lesson));
  }
  // the grid travels with the response (for the metronome), not the cache
  return {
    ...lesson,
    grid: { beats: grid.beats, downbeats: grid.downbeats, beatsPerBar: grid.beatsPerBar },
  };
}

export interface BeatGrid {
  bpm: number;
  beatsPerBar: number;
  firstDownbeat: number;
  beats: number[]; // seconds
  downbeats: number[]; // seconds
}

const beatGridsInFlight = new Map<string, Promise<BeatGrid>>();

/**
 * The song-wide beat grid, detected once on the full mix (Beat This!) and
 * cached as beats.json next to the stems. Failures surface as errors.
 */
export function ensureBeatGrid(song: Song, repoRoot: string): Promise<BeatGrid> {
  const inFlight = beatGridsInFlight.get(song.id);
  if (inFlight) return inFlight;

  const promise = (async () => {
    const songDir = path.join(repoRoot, 'audio', 'stems', song.id);
    const gridPath = path.join(songDir, 'beats.json');
    if (fs.existsSync(gridPath)) {
      return JSON.parse(await fs.promises.readFile(gridPath, 'utf-8')) as BeatGrid;
    }
    const env = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ''}` };
    const { stdout } = await execFileAsync(
      UV_BIN,
      ['run', '--script', path.join(repoRoot, 'scripts', 'detect_beats.py'), '--input', path.join(songDir, 'source.mp3')],
      { env, maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60 * 1000 }
    );
    const grid = JSON.parse(stdout.trim().split('\n').pop()!);
    if (grid.error) {
      throw new Error(`Beat detection failed: ${grid.error}`);
    }
    await fs.promises.writeFile(gridPath, JSON.stringify(grid));
    return grid as BeatGrid;
  })();

  beatGridsInFlight.set(song.id, promise);
  promise.finally(() => beatGridsInFlight.delete(song.id)).catch(() => {});
  return promise;
}

async function loadOrCreateStemLesson(
  song: Song,
  stem: StemId,
  repoRoot: string,
  grid: BeatGrid
): Promise<StemLessonData> {
  const songDir = path.join(repoRoot, 'audio', 'stems', song.id);
  const resolved = await resolveStemAudio(song, stem, repoRoot);
  const cachePath = path.join(songDir, `stem-lesson-${stem}.json`);
  if (fs.existsSync(cachePath)) {
    const cached: StemLessonData = JSON.parse(await fs.promises.readFile(cachePath, 'utf-8'));
    if (resolved.merged) {
      const sourceLessons = await Promise.all(
        resolved.sources.map(async (sourceStem) => ({
          stem: sourceStem,
          lesson: await getOrCreateStemLesson(song, sourceStem, repoRoot),
        }))
      );
      const currentSourceRevs = sourceRevSignature(sourceLessons);
      if (!sameSourceRevs(cached.sourceRevs, currentSourceRevs)) {
        return buildMergedLessonFromSourceLessons(
          song,
          stem,
          resolved,
          sourceLessons,
          songDir,
          repoRoot,
          cached.rev ?? 1
        );
      }
    }
    const events = withSoundDurations(cached.events, cached.sounds, cached.duration);
    if (JSON.stringify(events) !== JSON.stringify(cached.events)) {
      cached.events = events;
      await fs.promises.writeFile(cachePath, JSON.stringify(cached));
    }
    return cached;
  }

  if (resolved.merged) {
    return buildMergedLessonFromSources(song, stem, resolved, songDir, repoRoot);
  }

  const env = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ''}` };

  // Analyze the stem's sounds with the transcriber suited to it. All emit the
  // same sounds + events contract:
  //  - drums: ADTOF drum transcription, one lane per drum class
  //  - bass / other: Basic Pitch note transcription, one lane per pitch
  //  - vocals: still the generic onset-clustering analyzer
  const soundsDir = path.join(songDir, `sounds-${stem}`);
  const analyzerArgs: Record<string, string[]> = {
    drums: ['transcribe_drums_adtof.py'],
    bass: ['transcribe_notes.py', '--profile', 'bass'],
    other: ['transcribe_notes.py', '--profile', 'melodic'],
  };
  const [analyzer, ...extraArgs] = analyzerArgs[stem] ?? ['analyze_stem_sounds.py'];
  const { stdout } = await execFileAsync(
    UV_BIN,
    [
      'run',
      '--script',
      path.join(repoRoot, 'scripts', analyzer),
      '--input', resolved.audioPath,
      '--output', soundsDir,
      ...extraArgs,
    ],
    { env, maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60 * 1000 }
  );
  const analysis = JSON.parse(stdout.trim().split('\n').pop()!);
  if (analysis.error) {
    throw new Error(`Stem analysis failed: ${analysis.error}`);
  }

  // Turn the raw transcription into a playable chart (grid snap, lane folding,
  // double-trigger merge), then keep clip files named after their sound id.
  const chart = chartAnalysis<StemSound, StemEvent>(analysis.sounds, analysis.events, grid, analysis.duration);
  await applyClipRemap(soundsDir, chart.idRemap, chart.removedSoundIds);
  console.log(`[chart] ${song.id} ${stem}:`, chart.stats);

  const lesson: StemLessonData = {
    stem,
    bpm: grid.bpm,
    duration: analysis.duration,
    sounds: chart.sounds.map((s) => ({
      ...s,
      clip: `stems/${song.id}/sounds-${stem}/sound-${s.id}.wav`,
    })),
    events: [],
    backing: await ensureBackingTrack(song, stem, resolved, songDir, repoRoot),
    rev: 1,
  };
  lesson.events = withSoundDurations(chart.events, lesson.sounds, lesson.duration);
  await fs.promises.writeFile(cachePath, JSON.stringify(lesson));
  return lesson;
}

/** Delete clips of folded lanes and rename the rest to sound-<newId>.wav. */
async function applyClipRemap(soundsDir: string, idRemap: Map<number, number>, removed: number[]): Promise<void> {
  for (const id of removed) {
    await fs.promises.rm(path.join(soundsDir, `sound-${id}.wav`), { force: true });
  }
  const moves = [...idRemap].filter(([from, to]) => from !== to);
  // two phases so a rename never overwrites a clip that still has to move
  for (const [from] of moves) {
    await fs.promises.rename(path.join(soundsDir, `sound-${from}.wav`), path.join(soundsDir, `.remap-${from}.wav`));
  }
  for (const [from, to] of moves) {
    await fs.promises.rename(path.join(soundsDir, `.remap-${from}.wav`), path.join(soundsDir, `sound-${to}.wav`));
  }
}

/** Re-slice one sound's clip from the stem (fade tail + loudness normalize). */
async function sliceClip(
  stemWav: string,
  clipPath: string,
  start: number,
  end: number
): Promise<void> {
  const duration = Math.max(end - start, 0.03);
  const fadeStart = duration * 0.75;
  await execFileAsync(
    FFMPEG_BIN,
    [
      '-y',
      '-ss', String(start),
      '-t', String(duration),
      '-i', stemWav,
      '-af', `afade=t=out:st=${fadeStart.toFixed(4)}:d=${(duration - fadeStart).toFixed(4)},loudnorm=I=-16:TP=-1.5`,
      '-c:a', 'pcm_s16le',
      clipPath,
    ],
    { env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ''}` }, timeout: 60 * 1000 }
  );
}

/**
 * Applies user corrections from the sound editor: changed clip regions are
 * re-sliced from the stem, removed sounds' clips are deleted, new sounds get
 * clips, matching occurrences are searched in the full stem from those saved
 * regions, and the cache JSON (the single source of truth for lessons) is
 * rewritten with a bumped rev.
 */
export async function updateStemLesson(
  song: Song,
  stem: StemId,
  update: { sounds: Omit<StemSound, 'clip'>[]; events: StemEvent[] }
): Promise<StemLessonData> {
  const repoRoot = path.resolve(__dirname, '..');
  const songDir = path.join(repoRoot, 'audio', 'stems', song.id);
  const resolved = await resolveStemAudio(song, stem, repoRoot);
  const cachePath = path.join(songDir, `stem-lesson-${stem}.json`);
  if (!fs.existsSync(cachePath)) {
    throw new Error('No analysis to update — analyze the stem first.');
  }
  const existing: StemLessonData = JSON.parse(await fs.promises.readFile(cachePath, 'utf-8'));
  const stemWav = resolved.audioPath;
  const soundsDir = path.join(songDir, `sounds-${stem}`);

  const previous = new Map(existing.sounds.map((s) => [s.id, s]));
  const sounds: StemSound[] = [];
  for (const sound of update.sounds) {
    if (sound.end <= sound.start) {
      throw new Error(`Sound ${sound.id}: end must be after start.`);
    }
    const clipFile = `sound-${sound.id}.wav`;
    const old = previous.get(sound.id);
    if (!old || old.start !== sound.start || old.end !== sound.end) {
      await sliceClip(stemWav, path.join(soundsDir, clipFile), sound.start, sound.end);
    }
    sounds.push({ ...sound, clip: `stems/${song.id}/sounds-${stem}/${clipFile}` });
  }

  // remove clips of deleted sounds
  const keptIds = new Set(update.sounds.map((s) => s.id));
  for (const old of existing.sounds) {
    if (!keptIds.has(old.id)) {
      await fs.promises.rm(path.join(soundsDir, `sound-${old.id}.wav`), { force: true });
    }
  }

  const lesson: StemLessonData = {
    ...existing,
    sounds,
    events: await matchSelectedSoundEvents(repoRoot, songDir, stemWav, stem, sounds, existing.duration),
    rev: (existing.rev ?? 1) + 1,
  };
  await fs.promises.writeFile(cachePath, JSON.stringify(lesson));
  return lesson;
}

/** Discard the analysis and its clips so the next request re-runs the pipeline. */
export async function resetStemLesson(songId: string, stem: StemId, repoRoot: string): Promise<void> {
  assertSafeStemId(stem);
  const songDir = path.join(repoRoot, 'audio', 'stems', songId);
  await fs.promises.rm(path.join(songDir, `stem-lesson-${stem}.json`), { force: true });
  await fs.promises.rm(path.join(songDir, `sounds-${stem}`), { recursive: true, force: true });
}
