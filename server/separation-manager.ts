import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import { updateSong, StemName } from './songs';

export type SeparationStage = 'queued' | 'provisioning' | 'loading-model' | 'separating' | 'exporting';

export interface SeparationProgress {
  stage: SeparationStage;
  progress: number; // 0..1, meaningful during 'separating'
}

interface DoneMessage {
  duration: number;
  stems: Record<StemName, string>; // filenames relative to the song's output dir
}

const UV_BIN = '/opt/homebrew/bin/uv';
const STDERR_RING_SIZE = 4096;

export class SeparationManager {
  private queue: string[] = [];
  private current: { songId: string; child: ChildProcess } | null = null;
  private progress = new Map<string, SeparationProgress>();

  constructor(
    private repoRoot: string,
    // MPS (Apple GPU) validated on this machine: ~3x faster than CPU, identical output
    private device: string = process.env.MELODICS_DEMUCS_DEVICE || 'mps'
  ) {}

  getProgress(songId: string): SeparationProgress | null {
    return this.progress.get(songId) ?? null;
  }

  async enqueue(songId: string): Promise<void> {
    if (this.queue.includes(songId) || this.current?.songId === songId) {
      return;
    }
    this.queue.push(songId);
    this.progress.set(songId, { stage: 'queued', progress: 0 });
    await updateSong(songId, { status: 'queued', error: null });
    void this.runNext();
  }

  cancel(songId: string): void {
    const queued = this.queue.indexOf(songId);
    if (queued !== -1) {
      this.queue.splice(queued, 1);
      this.progress.delete(songId);
      return;
    }
    if (this.current?.songId === songId) {
      this.current.child.kill('SIGTERM');
    }
  }

  private async runNext(): Promise<void> {
    if (this.current || this.queue.length === 0) {
      return;
    }
    const songId = this.queue.shift()!;
    const songDir = path.join(this.repoRoot, 'audio', 'stems', songId);
    const scriptPath = path.join(this.repoRoot, 'scripts', 'separate_stems.py');

    // Until the script's first stdout line, time is spent installing the uv env
    // and downloading model weights (one-time, can be many minutes).
    this.progress.set(songId, { stage: 'provisioning', progress: 0 });
    await updateSong(songId, { status: 'separating' });

    const child = spawn(
      UV_BIN,
      [
        'run',
        '--script',
        scriptPath,
        '--input',
        path.join(songDir, 'source.mp3'),
        '--output',
        songDir,
        '--model',
        'htdemucs_ft',
        '--device',
        this.device,
      ],
      {
        env: {
          ...process.env,
          PATH: `/opt/homebrew/bin:${process.env.PATH ?? ''}`,
          ...(this.device === 'mps' ? { PYTORCH_ENABLE_MPS_FALLBACK: '1' } : {}),
        },
      }
    );
    this.current = { songId, child };

    let done: DoneMessage | null = null;
    let scriptError: string | null = null;
    let stderrTail = '';

    child.stderr!.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_RING_SIZE);
    });

    const rl = readline.createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      let msg: { type: string; value?: unknown; message?: string; duration?: number; stems?: DoneMessage['stems'] };
      try {
        msg = JSON.parse(line);
      } catch {
        return; // ignore non-JSON noise
      }
      const prev = this.progress.get(songId) ?? { stage: 'provisioning' as SeparationStage, progress: 0 };
      if (msg.type === 'stage') {
        this.progress.set(songId, { stage: msg.value as SeparationStage, progress: prev.progress });
      } else if (msg.type === 'progress') {
        this.progress.set(songId, { stage: 'separating', progress: Number(msg.value) });
      } else if (msg.type === 'done') {
        done = { duration: msg.duration!, stems: msg.stems! };
      } else if (msg.type === 'error') {
        scriptError = msg.message ?? 'Unknown separation error';
      }
    });

    child.on('close', (code) => {
      void (async () => {
        this.current = null;
        this.progress.delete(songId);
        try {
          if (code === 0 && done) {
            await updateSong(songId, {
              status: 'ready',
              error: null,
              duration: done.duration,
              drumsPath: `stems/${songId}/${done.stems.drums}`,
              bassPath: `stems/${songId}/${done.stems.bass}`,
              vocalsPath: `stems/${songId}/${done.stems.vocals}`,
              otherPath: `stems/${songId}/${done.stems.other}`,
            });
          } else {
            const message = scriptError ?? `Separation process exited with code ${code}.\n${stderrTail.trim()}`;
            await updateSong(songId, { status: 'error', error: message });
          }
        } catch (err) {
          console.error(`Failed to persist separation result for ${songId}:`, err);
        }
        void this.runNext();
      })();
    });
  }
}
