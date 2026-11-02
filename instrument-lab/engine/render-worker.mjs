import { decodeDrumWav } from "./drums.mjs";
import { renderArrangement } from "./arrangement.mjs";
import { renderPractice } from "./practice.mjs";

self.onmessage = async ({ data }) => {
  try {
    if (data.parts.some((p) => p.patch.engine === "drum")) {
      const parts = await Promise.all(
        data.parts.map(async (p) => {
          if (p.patch.engine !== "drum") return p;
          const response = await fetch(p.assetUrl);
          if (!response.ok) throw new Error("Could not load drum sound");
          return { ...p, asset: decodeDrumWav(await response.arrayBuffer()) };
        }),
      );
      const channels = renderArrangement(
        parts,
        data.selectedId,
        data.start,
        data.end,
        data.speed,
        44100,
      );
      self.postMessage(
        { audio: { channels, sampleRate: 44100 } },
        channels.map((c) => c.buffer),
      );
      return;
    }
    const audio = renderPractice(
      data.parts,
      data.selectedId,
      data.start,
      data.end,
      data.speed,
    );
    self.postMessage({ audio }, [audio.buffer]);
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
