import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { chartAnalysis } from './charting';

const execFileAsync = promisify(execFile);
const UV_BIN = '/opt/homebrew/bin/uv';

export interface AudioAnalysis {
  duration: number;
  sounds: { id: number; centroidHz: number }[];
  events: { time: number; audioTime: number; sound: number; velocity: number }[];
}

/**
 * Detects the hits in one audio track (e.g. an Ableton audio track's
 * export) the same way stem lessons do: onsets grouped into similar sounds,
 * then charted on the song's beat grid. The grid comes from the known tempo,
 * starting at 0 s (exports are rendered from 1.1.1).
 */
export async function analyzeAudio(repoRoot: string, wav: Buffer, bpm: number): Promise<AudioAnalysis> {
  if (!(bpm > 0)) throw new Error('A tempo (bpm) is required.');
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'melodics-analysis-'));
  try {
    const input = path.join(dir, 'track.wav');
    await fs.promises.writeFile(input, wav);
    const env = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ''}` };
    const { stdout } = await execFileAsync(
      UV_BIN,
      ['run', '--script', path.join(repoRoot, 'scripts', 'analyze_stem_sounds.py'), '--input', input, '--output', path.join(dir, 'clips')],
      { env, maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60 * 1000 }
    );
    const analysis = JSON.parse(stdout.trim().split('\n').pop()!);
    if (analysis.error) throw new Error(analysis.error);

    const beatSeconds = 60 / bpm;
    const beats = Array.from({ length: Math.ceil(analysis.duration / beatSeconds) + 2 }, (_, i) => i * beatSeconds);
    const chart = chartAnalysis<{ id: number; centroidHz: number }, AudioAnalysis['events'][number]>(
      analysis.sounds,
      analysis.events,
      { beats },
      analysis.duration
    );
    return {
      duration: analysis.duration,
      sounds: chart.sounds.map(({ id, centroidHz }) => ({ id, centroidHz })),
      events: chart.events.map(({ time, audioTime, sound, velocity }) => ({
        time,
        audioTime: audioTime ?? time,
        sound,
        velocity,
      })),
    };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}
