import type { JamSoundSource } from './jamSynth';

// Renders a Jam sound in a worker, so long clips never stall the highway, and
// returns one blob URL per note, keyed by MIDI note
type Reply = { id: number; clips?: { [note: number]: ArrayBuffer }; error?: string };

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (urls: { [note: number]: string }) => void; reject: (error: Error) => void }>();

export function renderJamSound(source: JamSoundSource, notes: number[]): Promise<{ [note: number]: string }> {
  if (!worker) {
    worker = new Worker(new URL('./jamRender.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<Reply>) => {
      const { id, clips, error } = event.data;
      const request = pending.get(id);
      pending.delete(id);
      if (!request) return;
      if (!clips) return request.reject(new Error(error));
      request.resolve(
        Object.fromEntries(
          Object.entries(clips).map(([note, wav]) => [note, URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))])
        )
      );
    };
  }
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ id, source, notes });
  });
}
