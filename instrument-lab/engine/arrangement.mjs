import { renderPractice } from "./practice.mjs";
import { renderDrums } from "./drums.mjs";

// Both engines share the same clock, range and output rate. Only the selected
// instrument is muted during practice, regardless of which engine plays it.
export function renderArrangement(
  parts,
  selectedId,
  start,
  end,
  speed = 1,
  sampleRate = 44100,
) {
  const drums = parts.filter((p) => p.patch.engine === "drum");
  const melodic = parts.filter((p) => p.patch.engine !== "drum");
  const synth = renderPractice(
    melodic,
    selectedId,
    start,
    end,
    speed,
    sampleRate,
  );
  const channels = drums.length
    ? renderDrums(drums, (end - start) / speed, sampleRate, {
        selectedId,
        start,
        end,
        speed,
      })
    : [new Float32Array(synth.length), new Float32Array(synth.length)];
  for (const channel of channels)
    for (let i = 0; i < synth.length; i++) channel[i] += synth[i];
  return channels;
}
