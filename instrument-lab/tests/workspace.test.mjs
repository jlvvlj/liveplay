import test from "node:test";
import assert from "node:assert/strict";
import {
  workspaceRoot,
  workspaceMembers,
  composeWorkspace,
} from "../server/workspace.mjs";
import { renderArrangement } from "../engine/arrangement.mjs";
import { renderPractice } from "../engine/practice.mjs";
import { renderDrums, drumPatch } from "../engine/drums.mjs";
import { patchData } from "../engine/synth.mjs";

const melody = {
  id: "melody",
  revision: 7,
  status: "ready",
  sourceSongIds: ["song"],
  result: {
    sourceFile: "original.wav",
    duration: 2,
    parts: [
      { id: "instrument-1", name: "Synth", patch: patchData(), notes: [] },
    ],
    analysis: { notes: 0, warnings: [] },
  },
};
const drum = {
  id: "drum",
  revision: 3,
  status: "ready",
  engine: "drum",
  sourceSongIds: ["song"],
  result: {
    duration: 2,
    parts: [
      {
        id: "instrument-1",
        name: "Kick",
        patch: drumPatch(),
        sampleFile: "hit.wav",
        notes: [],
      },
    ],
    analysis: { notes: 0, warnings: ["Check layers"] },
  },
};
test("existing drum and synth analyses form one workspace with distinct editable identities", () => {
  const before = JSON.stringify([melody, drum]);
  const root = workspaceRoot(drum, [drum, melody]);
  assert.equal(root.id, "melody");
  const combined = composeWorkspace(
    root,
    workspaceMembers(root, [drum, melody]),
  );
  assert.equal(combined.id, "melody");
  assert.equal(combined.result.engine, "mixed");
  assert.equal(combined.result.workspaceMix, true);
  assert.equal(combined.result.sourceFile, "original.wav");
  assert.deepEqual(
    combined.result.parts.map((p) => p.id),
    ["instrument-1", "drum:instrument-1"],
  );
  assert.deepEqual(
    combined.result.parts.map((p) => [
      p.ownerProjectId,
      p.ownerPartId,
      p.ownerRevision,
    ]),
    [
      ["melody", "instrument-1", 7],
      ["drum", "instrument-1", 3],
    ],
  );
  assert.equal(
    JSON.stringify([melody, drum]),
    before,
    "composition never changes saved edits",
  );
});
test("pending attached drum analysis keeps the existing synth workspace usable", () => {
  const child = {
    id: "attached",
    parentProjectId: "melody",
    engine: "drum",
    status: "analyzing",
    progress: 0.5,
  };
  const members = workspaceMembers(melody, [
    melody,
    child,
    { ...drum, sourceSongIds: ["another-song"] },
  ]);
  const combined = composeWorkspace(melody, members);
  assert.equal(combined.result.parts.length, 1);
  assert.equal(combined.status, "ready");
  assert.equal(combined.analyses[1].status, "analyzing");
  assert.equal(workspaceRoot(child, [child, melody]).id, "melody");
});
test("full mix sums both engines; practice mutes only the selected part at either tempo", () => {
  const sr = 8000,
    asset = {
      sampleRate: sr,
      channels: [
        Float32Array.from(
          { length: 1000 },
          (_, i) => 0.3 * Math.sin(i * 0.2) * Math.exp(-i / 200),
        ),
        new Float32Array(1000),
      ],
    };
  const synth = {
    id: "synth",
    patch: patchData({ family: "sine", gain: 0.25 }),
    notes: [{ start: 0.15, end: 0.5, pitch: 60, velocity: 100 }],
  };
  const hit = {
    id: "drum",
    patch: drumPatch(),
    asset,
    notes: [{ start: 0.3, end: 0.36, pitch: 36, velocity: 127 }],
  };
  for (const speed of [1, 0.5]) {
    const duration = 0.8 / speed;
    const a = renderPractice([synth], null, 0.1, 0.9, speed, sr),
      b = renderDrums([hit], duration, sr, { start: 0.1, end: 0.9, speed });
    const mixed = renderArrangement([hit, synth], null, 0.1, 0.9, speed, sr);
    const muteSynth = renderArrangement(
        [synth, hit],
        "synth",
        0.1,
        0.9,
        speed,
        sr,
      ),
      muteDrum = renderArrangement([hit, synth], "drum", 0.1, 0.9, speed, sr);
    for (let c = 0; c < 2; c++)
      for (let i = 0; i < a.length; i++) {
        assert.ok(Math.abs(mixed[c][i] - a[i] - b[c][i]) < 1e-6);
        assert.equal(muteSynth[c][i], b[c][i]);
        assert.equal(muteDrum[c][i], a[i]);
      }
  }
});
