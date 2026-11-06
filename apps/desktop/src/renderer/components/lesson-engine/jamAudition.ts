import * as Tone from 'tone';
import { renderJamBackingPart } from './jamRenderer';
import type { JamAddedInstrument } from './jamAddedParts';

// A backing-track part's sound on one pitch, played once: what a drum row's
// name or a piano key sounds like in the Jam tab's grid. Each sound is
// rendered the first time it is asked for, then kept. Lesson rooms play their
// lesson track's hits with the same sounds (jamLessonVoices.ts).

const AUDITION_SECONDS = 1.5;
const FADE_SECONDS = 0.03;

const sounds = new Map<string, Promise<Tone.ToneAudioBuffer>>();
let output: Tone.Volume | null = null;

// Parts render unscaled: held under 0 dBFS, like the mixer's parts
const auditionOutput = () => (output ??= new Tone.Volume(-6).connect(new Tone.Limiter(-1).toDestination()));

export function renderJamPartSound(trackFile: string, part: number, pitch: number, added?: JamAddedInstrument): Promise<Tone.ToneAudioBuffer> {
  return renderJamBackingPart(trackFile, part, [{ pitch, step: 0, length: 2, velocity: 100 }], added).then((audio) => {
    const length = Math.min(audio.channels[0].length, Math.round(AUDITION_SECONDS * audio.sampleRate));
    const fade = Math.round(FADE_SECONDS * audio.sampleRate);
    const buffer = Tone.getContext().createBuffer(audio.channels.length, length, audio.sampleRate);
    audio.channels.forEach((channel, c) => {
      const data = buffer.getChannelData(c);
      data.set(channel.subarray(0, length));
      for (let i = Math.max(0, length - fade); i < length; i++) data[i] *= (length - i) / fade;
    });
    return new Tone.ToneAudioBuffer(buffer);
  });
}

// `added` plays an added part, kept by its sound (`id`: an instrument's, or a kit's drum's)
export function auditionJamPart(trackFile: string, part: number, pitch: number, added?: { id: string; instrument: JamAddedInstrument }) {
  const key = added ? `${added.id}|${pitch}` : `${trackFile}|${part}|${pitch}`;
  let sound = sounds.get(key);
  if (!sound) {
    sound = renderJamPartSound(trackFile, part, pitch, added?.instrument);
    sounds.set(key, sound);
  }
  sound
    .then((buffer) => {
      const player = new Tone.Player(buffer).connect(auditionOutput());
      player.onstop = () => player.dispose();
      player.start();
    })
    .catch((err) => {
      sounds.delete(key);
      console.error('[jamAudition] Could not play the sound:', err);
    });
}
