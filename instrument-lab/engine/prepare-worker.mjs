import { drumPatch, decodeDrumWav, prepareDrum } from "./drums.mjs";
const assets = new Map();
import { makeTable, patchData } from "./synth.mjs";
self.onmessage = async ({ data }) => {
  if (data.patch.engine === "drum") {
    try {
      if (!assets.has(data.patch.assetUrl)) {
        const response = await fetch(data.patch.assetUrl);
        if (!response.ok)
          throw new Error("Could not load recovered drum sound");
        if (assets.size > 16) assets.clear();
        assets.set(
          data.patch.assetUrl,
          decodeDrumWav(await response.arrayBuffer()),
        );
      }
      const patch = drumPatch(data.patch),
        drum = prepareDrum(
          patch,
          assets.get(data.patch.assetUrl),
          data.sampleRate,
        );
      self.postMessage(
        { token: data.token, patch, drum },
        drum.map((c) => c.buffer),
      );
    } catch (error) {
      self.postMessage({ token: data.token, error: error.message });
    }
    return;
  }
  const patch = patchData(data.patch),
    tables = [];
  for (let pitch = 0; pitch <= 127; pitch++)
    tables.push(makeTable(patch, pitch, data.sampleRate));
  self.postMessage({ token: data.token, patch, tables });
};
