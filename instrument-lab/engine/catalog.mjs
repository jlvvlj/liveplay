import { patchData, harmonicAmplitudes } from "./synth.mjs";
export function candidates() {
  const patches = [];
  for (const family of ["sine", "triangle", "saw", "square", "pulse"])
    for (const brightness of family === "sine"
      ? [0.5]
      : [0.14, 0.35, 0.65, 0.95])
      for (const body of family === "sine" ? [0] : [0, 0.6])
        patches.push(patchData({ family, brightness, body }));
  for (const ratio of [1, 2, 3, 4])
    for (const fm of [0.4, 0.8, 1.2, 1.6, 2, 2.5, 3.2, 4, 5])
      patches.push(
        patchData({ family: "fm", ratio, fm, brightness: 0.8, body: 0 }),
      );
  return patches;
}
export function catalog() {
  return candidates().map((patch, id) => ({
    id,
    patch,
    harmonics: harmonicAmplitudes(patch),
  }));
}
