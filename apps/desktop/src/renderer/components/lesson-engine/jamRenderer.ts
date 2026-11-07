import type { JamSoundSource, JamSynthPatch } from './jamSynth';
import { jamTrackByFile, type JamTrackNote } from './jamTracks';
import type { JamAddedInstrument } from './jamAddedParts';
import { jamSoundUrl } from './jamSoundFiles';
import { jamTrackHasEffects } from './jamTrackRender';
import { startJamRenderWorker } from './jamRenderWorker';

// Renders Jam sounds and backing-track parts in workers, so long renders never
// stall the highway. A part's notes are split over several workers and the
// pieces added up, so a part renders about as fast as the device has cores;
// the track's echo and room are then added to the sum, once, by one worker.
export interface JamPartAudio {
  channels: Float32Array[];
  sampleRate: number;
}

type Reply = {
  id: number;
  clips?: { [note: number]: ArrayBuffer };
  part?: JamPartAudio;
  synth?: { gain: number; tables?: Float32Array[] };
  error?: string;
};

const POOL_SIZE = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
type Slot = { worker: Worker; busy: number };
const workers: Slot[] = [];
let nextId = 0;
const pending = new Map<number, { slot: Slot; resolve: (reply: Reply) => void; reject: (error: Error) => void }>();

const onReply = (event: MessageEvent<Reply>) => {
  const reply = event.data;
  const waiting = pending.get(reply.id);
  pending.delete(reply.id);
  if (!waiting) return;
  if (reply.error) waiting.reject(new Error(reply.error));
  else waiting.resolve(reply);
};

// A worker that failed (to load, or later) is dropped, and everything sent to
// it fails with its error; the next request starts a new one in its place
const onFailure = (slot: Slot, reason: string) => {
  slot.worker.terminate();
  workers.splice(workers.indexOf(slot), 1);
  for (const [id, waiting] of pending)
    if (waiting.slot === slot) {
      pending.delete(id);
      waiting.reject(new Error(`The Jam render worker failed: ${reason}`));
    }
};

function startWorker(): Slot {
  const slot: Slot = { worker: startJamRenderWorker(), busy: 0 };
  slot.worker.onmessage = onReply;
  slot.worker.onerror = (event) => {
    event.preventDefault();
    onFailure(slot, event.message || 'it could not be loaded');
  };
  slot.worker.onmessageerror = () => onFailure(slot, 'its reply could not be read');
  return slot;
}

// Sends to the least busy worker, starting the pool on first use
function request(message: object, transfer: Transferable[] = []): Promise<Reply> {
  while (workers.length < POOL_SIZE) workers.push(startWorker());
  const slot = workers.reduce((least, candidate) => (candidate.busy < least.busy ? candidate : least));
  slot.busy++;
  const id = ++nextId;
  return new Promise<Reply>((resolve, reject) => {
    pending.set(id, { slot, resolve, reject });
    slot.worker.postMessage({ id, ...message }, transfer);
  }).finally(() => {
    slot.busy--;
  });
}

// Where recorded sounds are fetched from, by file
const soundUrls = (files: string[]) => Object.fromEntries(files.map((file) => [file, jamSoundUrl(file)]));

// One blob URL per note, keyed by MIDI note
export async function renderJamSound(source: JamSoundSource, notes: number[]): Promise<{ [note: number]: string }> {
  const urls = 'sample' in source ? soundUrls(source.sample.map((note) => note.file)) : {};
  const { clips = {} } = await request({ source, notes, urls });
  return Object.fromEntries(
    Object.entries(clips).map(([note, wav]) => [note, URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))])
  );
}

// A Melodics Synth patch made ready to play live (see prepareJamSynth)
export async function prepareJamSynthPatch(
  patch: JamSynthPatch,
  sampleRate: number,
  tables: boolean
): Promise<{ gain: number; tables?: Float32Array[] }> {
  const { synth } = await request({ synth: patch, sampleRate, tables });
  if (!synth) throw new Error('The synth patch could not be prepared');
  return synth;
}

// One part of a backing track's loop, unscaled (as jamTrackParts orders the
// parts, then the parts added in the grid, played by `added`). Its distinct
// notes are dealt out to the workers, longest first. A recorded or added part
// is done by one worker. The loop is `bars` long (the track's own 8 if unset).
export async function renderJamBackingPart(
  trackFile: string,
  part: number,
  notes: JamTrackNote[],
  added?: JamAddedInstrument,
  bars?: number
): Promise<JamPartAudio> {
  const track = jamTrackByFile(trackFile);
  if (added || (track?.sampled && part >= track.drums.length + track.layers.length)) {
    const recorded = added ? undefined : track?.sampled?.[part - track.drums.length - track.layers.length];
    const urls = recorded ? soundUrls(recorded.sounds.map((sound) => sound.file)) : undefined;
    const reply = await request({ trackFile, part, notes, ...(added ? { added } : {}), ...(bars ? { bars } : {}), ...(urls ? { urls } : {}) });
    if (!reply.part) throw new Error(`No audio for ${trackFile} part ${part}`);
    return reply.part;
  }
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
  // Pieces are rendered dry when there are several, the effects added to their sum
  const dry = used.length > 1 && !!track && jamTrackHasEffects(track);
  const replies = await Promise.all(
    (used.length ? used : [pieces[0]]).map((piece) =>
      request({ trackFile, part, notes: piece.notes, ...(bars ? { bars } : {}), ...(dry ? { dry } : {}) })
    )
  );
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
  if (!dry) return first;
  const { part: wet } = await request({ trackFile, effects: first.channels }, first.channels.map((channel) => channel.buffer));
  if (!wet) throw new Error(`No audio for ${trackFile} part ${part}`);
  return wet;
}
