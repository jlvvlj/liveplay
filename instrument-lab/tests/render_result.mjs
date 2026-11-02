import fs from "node:fs/promises";
import path from "node:path";
import { renderNotes, encodeWav } from "../engine/synth.mjs";

const result = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
const output = process.argv[3];
await fs.mkdir(output, { recursive: true });
for (const part of result.parts) {
  const audio = renderNotes(part.patch, part.notes, result.duration);
  await fs.writeFile(
    path.join(output, part.id + "-synth.wav"),
    new Uint8Array(encodeWav(audio)),
  );
}
