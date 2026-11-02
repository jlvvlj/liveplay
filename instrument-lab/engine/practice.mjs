import { renderNotes } from "./synth.mjs";

// Tempo changes note positions and gates; pitch and synth envelope stay intact.
// Negative onsets retain the existing voice's age when a loop starts mid-note.
export function renderPractice(
  parts,
  selectedId,
  start,
  end,
  speed,
  sampleRate = 22050,
) {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start ||
    !Number.isFinite(speed) ||
    speed < 0.25 ||
    speed > 2
  )
    throw new Error("Invalid practice range");
  const duration = (end - start) / speed;
  const mix = new Float32Array(Math.ceil(duration * sampleRate));
  for (const part of parts.filter((p) => p.id !== selectedId)) {
    const notes = part.notes
      .filter(
        (n) =>
          n.start < end && n.end + part.patch.release * 1.5 * speed > start,
      )
      .map((n) => ({
        ...n,
        start: (n.start - start) / speed,
        end: (n.end - start) / speed,
      }));
    const samples = renderNotes(part.patch, notes, duration, sampleRate);
    for (let i = 0; i < mix.length; i++) mix[i] += samples[i];
  }
  return mix;
}
