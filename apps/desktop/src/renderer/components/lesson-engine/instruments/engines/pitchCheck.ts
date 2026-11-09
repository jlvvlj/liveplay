// Whether audio sounds at a given note, as the YIN pitch detector hears it: the
// shortest period the audio repeats at must be that note's. A low note still
// ringing under a high one, or a note an octave away, does not pass.

const WINDOW = 2048;
// How little a period may differ from itself, and the highest pitch looked for
const THRESHOLD = 0.2;
const HIGHEST_HZ = 1600;
const TOLERANCE_SEMITONES = 0.5;

// Audio this long is enough to tell at `note`
export const pitchCheckFrames = (note: number, sampleRate: number): number => WINDOW + Math.ceil(sampleRate / noteHz(note)) + 2;

const noteHz = (note: number) => 440 * 2 ** ((note - 69) / 12);

export function soundsAtNote(audio: Float32Array, sampleRate: number, note: number): boolean {
  const period = Math.ceil(sampleRate / noteHz(note)) + 2;
  if (audio.length < WINDOW + period) return false;
  const least = Math.floor(sampleRate / HIGHEST_HZ);
  let sum = 0;
  let previous = Infinity;
  for (let lag = 1; lag <= period; lag++) {
    let difference = 0;
    for (let i = 0; i < WINDOW; i++) {
      const delta = audio[i] - audio[i + lag];
      difference += delta * delta;
    }
    sum += difference;
    const normal = sum > 0 ? (difference * lag) / sum : 1;
    // The first dip under the threshold, at its lowest
    if (previous < THRESHOLD && normal > previous && lag - 1 >= least) {
      return Math.abs(12 * Math.log2(sampleRate / (lag - 1) / noteHz(note))) < TOLERANCE_SEMITONES;
    }
    previous = normal;
  }
  return false;
}
