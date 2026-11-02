import fs from "node:fs/promises";
import path from "node:path";
import { decodeDrumWav, encodeStereoWav } from "../engine/drums.mjs";

// Combine the isolated originals, retaining the destination's playable patch/sample.
// Assets are generation-named, so a failed render never changes published audio.
export async function mergeDrumReferences(folder, source, target, filename) {
  const assets = await Promise.all(
    [source, target].map(async (part) => {
      const bytes = await fs.readFile(path.join(folder, part.referenceFile));
      return decodeDrumWav(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      );
    }),
  );
  const sampleRate = assets[0].sampleRate;
  if (assets.some((a) => a.sampleRate !== sampleRate))
    throw new Error("Drum reference sample rates do not match.");
  const count = Math.max(...assets.map((a) => a.channels.length));
  const length = Math.max(...assets.map((a) => a.channels[0].length));
  const channels = Array.from({ length: count }, (_, c) => {
    const mix = new Float32Array(length);
    for (const asset of assets) {
      const samples = asset.channels[c] || asset.channels[0];
      for (let i = 0; i < samples.length; i++) mix[i] += samples[i];
    }
    return mix;
  });
  await fs.writeFile(
    path.join(folder, filename),
    new Uint8Array(encodeStereoWav(channels, sampleRate)),
  );
  target.referenceFile = filename;
}
