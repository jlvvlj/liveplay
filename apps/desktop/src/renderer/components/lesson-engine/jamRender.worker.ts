import { prepareJamSynth, renderJamWavs, type JamSoundSource, type JamSynthPatch } from './jamSynth';
import { jamTrackByFile, type JamTrackNote } from './jamTracks';
import {
  decodeWav16,
  renderJamAddedLoop,
  renderJamPartLoop,
  renderJamSampleWavs,
  renderJamSampledLoop,
  withJamTrackEffects,
} from './jamTrackRender';
import type { JamAddedInstrument } from './jamAddedParts';

// Renders Jam sounds and pieces of backing-track parts off the main thread (see
// jamRenderer.ts). Recorded sounds come with their URLs (`urls`, by file), so
// the worker never loads the list of every sound file.
type Request =
  | { id: number; source: JamSoundSource; notes: number[]; urls: { [file: string]: string } }
  | { id: number; synth: JamSynthPatch; sampleRate: number; tables: boolean }
  | { id: number; trackFile: string; effects: [Float32Array, Float32Array] }
  | {
      id: number;
      trackFile: string;
      part: number;
      notes: JamTrackNote[];
      added?: JamAddedInstrument;
      bars?: number;
      dry?: boolean;
      urls?: { [file: string]: string };
    };

const SAMPLE_RATE = 44100;

// Recorded sounds, loaded once per worker
const sounds = new Map<string, Promise<Float32Array[]>>();
const loadSound = (file: string, urls: { [file: string]: string } = {}) => {
  if (!sounds.has(file)) {
    const load = async () => {
      if (!urls[file]) throw new Error(`No URL for ${file}`);
      const response = await fetch(urls[file]);
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
    if ('synth' in request) {
      const synth = prepareJamSynth(request.synth, request.sampleRate, request.tables);
      post({ id: request.id, synth }, (synth.tables ?? []).map((table) => table.buffer));
      return;
    }
    if ('source' in request) {
      const { source } = request;
      const clips =
        'sample' in source
          ? renderJamSampleWavs(
              await Promise.all(source.sample.map((note) => loadSound(note.file, request.urls))),
              source.sample.map((note) => note.root),
              request.notes,
              SAMPLE_RATE
            )
          : renderJamWavs(source, request.notes);
      post({ id: request.id, clips }, Object.values(clips));
      return;
    }
    const track = jamTrackByFile(request.trackFile);
    if (!track) throw new Error(`No backing track ${request.trackFile}`);
    if ('effects' in request) {
      const channels = withJamTrackEffects(track, request.effects, SAMPLE_RATE);
      post({ id: request.id, part: { channels, sampleRate: SAMPLE_RATE } }, channels.map((c) => c.buffer));
      return;
    }
    const recorded = request.added ? undefined : track.sampled?.[request.part - track.drums.length - track.layers.length];
    const channels = request.added
      ? renderJamAddedLoop(track, request.added, request.notes, SAMPLE_RATE, request.bars)
      : recorded
      ? renderJamSampledLoop(
          track,
          request.part,
          request.notes,
          await Promise.all(recorded.sounds.map((sound) => loadSound(sound.file, request.urls))),
          SAMPLE_RATE,
          request.bars
        )
      : renderJamPartLoop(track, request.part, request.notes, SAMPLE_RATE, request.bars, !request.dry);
    post({ id: request.id, part: { channels, sampleRate: SAMPLE_RATE } }, channels.map((c) => c.buffer));
  } catch (error) {
    post({ id: request.id, error: String(error) });
  }
};
