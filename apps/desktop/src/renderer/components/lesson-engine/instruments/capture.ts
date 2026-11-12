import * as Tone from 'tone';
import workletUrl from './worklets/recorder.worklet.ts?worker&url';
import { InstrumentChannel } from './channel';
import type { InstrumentChoice, InstrumentDef } from './types';

// Records notes of a live instrument as the Daw plays them (its effects
// included), one after the other, through a channel nobody hears: each note
// held for its time, then recorded until it has rung out.

export interface CapturedNote {
  note: number;
  velocity: number;
  // How long the note is held (s)
  hold: number;
}

// A note has rung out once it stays this quiet this long (s), and is cut this long after it is let go at most (s)
const SILENT = 1e-4;
const QUIET_S = 0.25;
const MAX_TAIL_S = 4;
// Notes start this far ahead (s), so their start is never missed
const LEAD_S = 0.1;
const FADE_S = 0.005;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const added = new WeakMap<object, Promise<void>>();
function addWorklet(): Promise<void> {
  const raw = Tone.getContext().rawContext as unknown as BaseAudioContext;
  let adding = added.get(raw);
  if (!adding) {
    adding = raw.audioWorklet.addModule(workletUrl);
    added.set(raw, adding);
  }
  return adding;
}

// What the recorder has sent, block by block, from the frame each starts at
class Recording {
  private blocks: { start: number; channels: Float32Array[] }[] = [];
  end = 0;

  add(start: number, channels: Float32Array[]) {
    this.blocks.push({ start, channels });
    this.end = start + channels[0].length;
  }

  // Frames [from, to), silence where nothing was recorded
  between(from: number, to: number): Float32Array[] {
    const out = [new Float32Array(Math.max(0, to - from)), new Float32Array(Math.max(0, to - from))];
    for (const { start, channels } of this.blocks) {
      const first = Math.max(from, start);
      const last = Math.min(to, start + channels[0].length);
      for (let c = 0; c < 2; c++) for (let i = first; i < last; i++) out[c][i - from] = channels[c][i - start];
    }
    return out;
  }

  peak(from: number, to: number): number {
    let top = 0;
    for (const channel of this.between(from, to)) for (const x of channel) top = Math.max(top, Math.abs(x));
    return top;
  }

  // Blocks that end before `frame` are no longer needed
  forget(frame: number) {
    this.blocks = this.blocks.filter(({ start, channels }) => start + channels[0].length > frame);
  }
}

// Each note's sound, both channels, from its start to where it has rung out
export async function captureNotes(
  instrument: InstrumentDef,
  choice: InstrumentChoice,
  notes: CapturedNote[],
  bpm: number,
  onNote: (done: number) => void = () => {}
): Promise<Float32Array[][]> {
  await addWorklet();
  const context = Tone.getContext();
  const rate = context.sampleRate;
  const tap = new Tone.Gain();
  const recorder = context.createAudioWorkletNode('jam-recorder', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
  }) as unknown as AudioWorkletNode;
  // The recorder runs only while it leads to the speakers: through silence
  const silent = new Tone.Gain(0).connect(context.destination);
  Tone.connect(tap, recorder as unknown as Tone.InputNode);
  Tone.connect(recorder as unknown as Tone.OutputNode, silent);
  const recording = new Recording();
  recorder.port.onmessage = (event: MessageEvent<{ start: number; channels: Float32Array[] }>) =>
    recording.add(event.data.start, event.data.channels);
  const channel = new InstrumentChannel(tap);
  try {
    await channel.set(instrument, choice, bpm);
    const sounds: Float32Array[][] = [];
    for (const { note, velocity, hold } of notes) {
      const on = context.currentTime + LEAD_S;
      channel.noteOn(note, velocity, on);
      channel.noteOff(note, on + hold);
      const from = Math.round(on * rate);
      const released = Math.round((on + hold) * rate);
      const quiet = Math.round(QUIET_S * rate);
      const latest = Math.round((on + hold + MAX_TAIL_S) * rate);
      for (;;) {
        await sleep(50);
        const end = recording.end;
        if (end >= latest || (end >= released + quiet && recording.peak(end - quiet, end) < SILENT)) break;
      }
      const sound = recording.between(from, Math.min(recording.end, latest));
      sounds.push(trimmed(sound, rate));
      channel.allOff();
      recording.forget(recording.end);
      onNote(sounds.length);
    }
    return sounds;
  } finally {
    channel.dispose();
    recorder.port.onmessage = null;
    recorder.disconnect();
    tap.dispose();
    silent.dispose();
  }
}

// Without its silent end, and fading out over its last moments
function trimmed(channels: Float32Array[], rate: number): Float32Array[] {
  let length = channels[0].length;
  while (length > 1 && channels.every((channel) => Math.abs(channel[length - 1]) < SILENT)) length--;
  const fade = Math.min(length, Math.round(FADE_S * rate));
  return channels.map((channel) => {
    const out = channel.slice(0, length);
    for (let i = 0; i < fade; i++) out[length - 1 - i] *= i / fade;
    return out;
  });
}
