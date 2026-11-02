import { renderNotes, encodeWav, patchData } from "../engine/synth.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
export function fixture(kind = "duet") {
  const bass = {
    name: "Round bass",
    patch: patchData({
      family: "square",
      brightness: 0.21,
      body: 0.43,
      attack: 0.008,
      decay: 0.18,
      sustain: 0.5,
      release: 0.09,
      gain: 0.65,
    }),
    notes: [],
  };
  const lead = {
    name: "Glass sequence",
    patch: patchData({
      family: "fm",
      ratio: 2,
      fm: 1.8,
      brightness: 0.74,
      body: 0.08,
      attack: 0.009,
      decay: 0.32,
      sustain: 0.24,
      release: 0.18,
      gain: 0.6,
    }),
    notes: [],
  };
  const pad = {
    name: "Soft chords",
    patch: patchData({
      family: "saw",
      brightness: 0.32,
      body: 0.17,
      attack: 0.12,
      decay: 0.4,
      sustain: 0.7,
      release: 0.25,
      gain: 0.26,
    }),
    notes: [],
  };
  for (let i = 0; i < 16; i++)
    bass.notes.push({
      pitch: [36, 36, 39, 43, 36, 46, 43, 39][i % 8],
      start: 0.3 + i * 0.5,
      end: 0.3 + i * 0.5 + 0.34,
      velocity: 95,
    });
  for (let i = 0; i < 24; i++)
    lead.notes.push({
      pitch: [60, 67, 63, 70, 67, 63][i % 6],
      start: 0.42 + i * 0.333333,
      end: 0.42 + i * 0.333333 + 0.19,
      velocity: 85 + (i % 3) * 5,
    });
  for (let i = 0; i < 4; i++)
    for (const p of [48, 51, 55])
      pad.notes.push({
        pitch: p + (i % 2) * 5,
        start: 0.55 + i * 2,
        end: 1.85 + i * 2,
        velocity: 85,
      });
  const parts =
    kind === "solo"
      ? [lead]
      : kind === "trio"
        ? [bass, lead, pad]
        : [bass, lead];
  const duration = 9,
    sr = 22050,
    audio = new Float32Array(duration * sr);
  for (const part of parts) {
    part.audio = renderNotes(part.patch, part.notes, duration, sr);
    for (let i = 0; i < audio.length; i++) audio[i] += part.audio[i];
  }
  return { parts, audio, duration, sr };
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const dir = process.argv[2];
  mkdirSync(dir, { recursive: true });
  for (const kind of ["solo", "duet", "trio"]) {
    const f = fixture(kind);
    f.parts.forEach((part, index) => {
      writeFileSync(
        path.join(dir, `${kind}-source-${index}.wav`),
        new Uint8Array(encodeWav(part.audio, f.sr)),
      );
    });
    writeFileSync(
      path.join(dir, kind + ".wav"),
      new Uint8Array(encodeWav(f.audio, f.sr)),
    );
    writeFileSync(
      path.join(dir, kind + "-truth.json"),
      JSON.stringify(
        { ...f, audio: undefined, parts: f.parts.map(({ audio, ...p }) => p) },
        null,
        2,
      ),
    );
  }
}
