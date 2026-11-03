import { renderJamWavs, type JamSoundSource } from './jamSynth';
import { JAM_TRACKS, type JamTrackNote } from './jamTracks';
import { decodeWav16, renderJamPartLoop, renderJamSampledLoop } from './jamTrackRender';
import { jamSoundUrl } from './jamSoundFiles';

// Renders Jam sounds and pieces of backing-track parts off the main thread (see jamRenderer.ts)
type Request =
  | { id: number; source: JamSoundSource; notes: number[] }
  | { id: number; trackFile: string; part: number; notes: JamTrackNote[] };

const SAMPLE_RATE = 44100;

// Recorded sounds, loaded once per worker
const sounds = new Map<string, Promise<Float32Array[]>>();
const loadSound = (file: string) => {
  if (!sounds.has(file)) {
    const load = async () => {
      const response = await fetch(jamSoundUrl(file));
      if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
      const wav = decodeWav16(await response.arrayBuffer());
      if (wav.sampleRate !== SAMPLE_RATE) throw new Error(`${file} is ${wav.sampleRate} Hz, not ${SAMPLE_RATE}`);
      return wav.channels;
    };
    sounds.set(file, load());
  }
  return sounds.get(file)!;
};

const post = (message: unknown, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer);

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data;
  try {
    if ('source' in request) {
      const clips = renderJamWavs(request.source, request.notes);
      post({ id: request.id, clips }, Object.values(clips));
      return;
    }
    const track = JAM_TRACKS.find((candidate) => candidate.file === request.trackFile);
    if (!track) throw new Error(`No backing track ${request.trackFile}`);
    const recorded = track.sampled?.[request.part - track.drums.length - track.layers.length];
    const channels = recorded
      ? renderJamSampledLoop(track, request.part, request.notes, await Promise.all(recorded.sounds.map((sound) => loadSound(sound.file))), SAMPLE_RATE)
      : renderJamPartLoop(track, request.part, request.notes, SAMPLE_RATE);
    post({ id: request.id, part: { channels, sampleRate: SAMPLE_RATE } }, channels.map((c) => c.buffer));
  } catch (error) {
    post({ id: request.id, error: String(error) });
  }
};
