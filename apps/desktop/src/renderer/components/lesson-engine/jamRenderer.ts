import type { JamSoundSource } from './jamSynth';
import type { JamTrackNote } from './jamTracks';

// Renders Jam sounds and backing tracks in a worker, so long renders never
// stall the highway
export interface JamBackingAudio {
  channels: Float32Array[];
  sampleRate: number;
  loopSeconds: number;
}

type Reply = {
  id: number;
  clips?: { [note: number]: ArrayBuffer };
  backing?: JamBackingAudio;
  error?: string;
};

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>();

function request(message: object): Promise<Reply> {
  if (!worker) {
    worker = new Worker(new URL('./jamRender.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<Reply>) => {
      const reply = event.data;
      const waiting = pending.get(reply.id);
      pending.delete(reply.id);
      if (!waiting) return;
      if (reply.error) waiting.reject(new Error(reply.error));
      else waiting.resolve(reply);
    };
  }
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ id, ...message });
  });
}

// One blob URL per note, keyed by MIDI note
export async function renderJamSound(source: JamSoundSource, notes: number[]): Promise<{ [note: number]: string }> {
  const { clips = {} } = await request({ source, notes });
  return Object.fromEntries(
    Object.entries(clips).map(([note, wav]) => [note, URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))])
  );
}

// A backing track's loop from its notes, one list per part
export async function renderJamBacking(trackFile: string, parts: JamTrackNote[][]): Promise<JamBackingAudio> {
  const { backing } = await request({ trackFile, parts });
  if (!backing) throw new Error(`No audio for ${trackFile}`);
  return backing;
}
