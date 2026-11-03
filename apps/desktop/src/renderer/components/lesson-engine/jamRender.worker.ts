import { renderJamWavs, type JamSoundSource } from './jamSynth';
import { JAM_TRACKS, type JamTrackNote } from './jamTracks';
import { renderJamPartLoop } from './jamTrackRender';

// Renders Jam sounds and pieces of backing-track parts off the main thread (see jamRenderer.ts)
type Request =
  | { id: number; source: JamSoundSource; notes: number[] }
  | { id: number; trackFile: string; part: number; notes: JamTrackNote[] };

const SAMPLE_RATE = 44100;

const post = (message: unknown, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer);

self.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  try {
    if ('source' in request) {
      const clips = renderJamWavs(request.source, request.notes);
      post({ id: request.id, clips }, Object.values(clips));
      return;
    }
    const track = JAM_TRACKS.find((candidate) => candidate.file === request.trackFile);
    if (!track) throw new Error(`No backing track ${request.trackFile}`);
    const channels = renderJamPartLoop(track, request.part, request.notes, SAMPLE_RATE);
    post({ id: request.id, part: { channels, sampleRate: SAMPLE_RATE } }, channels.map((c) => c.buffer));
  } catch (error) {
    post({ id: request.id, error: String(error) });
  }
};
