import { renderJamWavs, type JamSoundSource } from './jamSynth';
import { JAM_TRACKS, jamTrackParts, type JamTrackNote } from './jamTracks';
import { jamLoopScale, renderJamTrackLoop } from './jamTrackRender';

// Renders Jam sounds and backing tracks off the main thread (see jamRenderer.ts)
type Request =
  | { id: number; source: JamSoundSource; notes: number[] }
  | { id: number; trackFile: string; parts: JamTrackNote[][] };

const SAMPLE_RATE = 44100;
// Each track keeps its original loudness scale, so edits never change the level
// of the parts left untouched
const scales = new Map<string, number>();

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
    if (!scales.has(track.file)) {
      const original = renderJamTrackLoop(track, jamTrackParts(track).map((part) => part.notes), SAMPLE_RATE);
      scales.set(track.file, jamLoopScale(original.loop));
    }
    const { loop, loopSeconds } = renderJamTrackLoop(track, request.parts, SAMPLE_RATE);
    const scale = scales.get(track.file)!;
    for (const channel of loop) for (let i = 0; i < channel.length; i++) channel[i] *= scale;
    post({ id: request.id, backing: { channels: loop, sampleRate: SAMPLE_RATE, loopSeconds } }, loop.map((c) => c.buffer));
  } catch (error) {
    post({ id: request.id, error: String(error) });
  }
};
