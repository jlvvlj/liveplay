import { renderJamWavs, type JamSoundSource } from './jamSynth';

// Renders Jam sounds off the main thread (see jamRenderer.ts)
self.onmessage = (event: MessageEvent<{ id: number; source: JamSoundSource; notes: number[] }>) => {
  const { id, source, notes } = event.data;
  try {
    const clips = renderJamWavs(source, notes);
    (self as unknown as Worker).postMessage({ id, clips }, Object.values(clips));
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, error: String(error) });
  }
};
