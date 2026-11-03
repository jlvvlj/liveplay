import type { JamSoundSource } from './jamSynth';
import type { JamTrackNote } from './jamTracks';

// Renders Jam sounds and backing-track parts in workers, so long renders never
// stall the highway. A part's notes are split over several workers and the
// pieces added up, so a part renders about as fast as the device has cores.
export interface JamPartAudio {
  channels: Float32Array[];
  sampleRate: number;
}

type Reply = {
  id: number;
  clips?: { [note: number]: ArrayBuffer };
  part?: JamPartAudio;
  error?: string;
};

const POOL_SIZE = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
const workers: { worker: Worker; busy: number }[] = [];
let nextId = 0;
const pending = new Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>();

const onReply = (event: MessageEvent<Reply>) => {
  const reply = event.data;
  const waiting = pending.get(reply.id);
  pending.delete(reply.id);
  if (!waiting) return;
  if (reply.error) waiting.reject(new Error(reply.error));
  else waiting.resolve(reply);
};

// Sends to the least busy worker, starting the pool on first use
function request(message: object): Promise<Reply> {
  if (workers.length === 0) {
    for (let i = 0; i < POOL_SIZE; i++) {
      const worker = new Worker(new URL('./jamRender.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = onReply;
      workers.push({ worker, busy: 0 });
    }
  }
  const slot = workers.reduce((least, candidate) => (candidate.busy < least.busy ? candidate : least));
  slot.busy++;
  const id = ++nextId;
  return new Promise<Reply>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    slot.worker.postMessage({ id, ...message });
  }).finally(() => {
    slot.busy--;
  });
}

// One blob URL per note, keyed by MIDI note
export async function renderJamSound(source: JamSoundSource, notes: number[]): Promise<{ [note: number]: string }> {
  const { clips = {} } = await request({ source, notes });
  return Object.fromEntries(
    Object.entries(clips).map(([note, wav]) => [note, URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))])
  );
}

// One part of a backing track's loop, unscaled (as jamTrackParts orders the
// parts). Its distinct notes are dealt out to the workers, longest first.
export async function renderJamBackingPart(trackFile: string, part: number, notes: JamTrackNote[]): Promise<JamPartAudio> {
  const groups = new Map<string, JamTrackNote[]>();
  for (const note of notes) {
    const key = `${note.pitch}|${note.length}|${note.velocity}`;
    groups.set(key, [...(groups.get(key) ?? []), note]);
  }
  const pieces: { notes: JamTrackNote[]; cost: number }[] = Array.from({ length: POOL_SIZE }, () => ({ notes: [], cost: 0 }));
  for (const group of [...groups.values()].sort((a, b) => b[0].length - a[0].length)) {
    const piece = pieces.reduce((least, candidate) => (candidate.cost < least.cost ? candidate : least));
    piece.notes.push(...group);
    piece.cost += group[0].length + 1;
  }
  const used = pieces.filter((piece) => piece.notes.length);
  const replies = await Promise.all((used.length ? used : [pieces[0]]).map((piece) => request({ trackFile, part, notes: piece.notes })));
  const [first, ...rest] = replies.map((reply) => {
    if (!reply.part) throw new Error(`No audio for ${trackFile} part ${part}`);
    return reply.part;
  });
  for (const piece of rest)
    for (let c = 0; c < first.channels.length; c++) {
      const target = first.channels[c];
      const source = piece.channels[c];
      for (let i = 0; i < target.length; i++) target[i] += source[i];
    }
  return first;
}
