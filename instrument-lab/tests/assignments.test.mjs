import test from "node:test";
import assert from "node:assert/strict";
import { applyAssignment } from "../server/assignments.mjs";
import { patchData } from "../engine/synth.mjs";
const note = (pitch, start) => ({
  pitch,
  start,
  end: start + 0.2,
  velocity: 90,
});
const fixture = () => ({
  parts: [
    {
      id: "instrument-1",
      name: "Lead",
      patch: patchData({ family: "fm" }),
      notes: [note(60, 0.1), note(64, 0.5), note(67, 0.9)],
    },
    {
      id: "instrument-2",
      name: "Bass",
      patch: patchData({ family: "square" }),
      notes: [note(36, 0.1)],
    },
  ],
});

test("split, move and merge preserve note ownership and independent patches", () => {
  const result = fixture();
  const originalCount = result.parts.flatMap((p) => p.notes).length;
  const split = applyAssignment(result, "instrument-1", {
    action: "split",
    indexes: [1, 1],
    name: "Separate voice",
  });
  assert.equal(result.parts.length, 3);
  const created = result.parts.find((p) => p.id === split);
  assert.equal(created.notes.length, 1);
  assert.equal(created.name, "Separate voice");
  created.patch.gain = 0.2;
  assert.notEqual(created.patch.gain, result.parts[0].patch.gain);
  applyAssignment(result, split, {
    action: "move",
    targetId: "instrument-2",
    indexes: [0],
  });
  assert.equal(
    result.parts.length,
    2,
    "moving all notes removes the emptied row",
  );
  assert.equal(
    result.parts[1].patch.family,
    "square",
    "destination sound is kept",
  );
  applyAssignment(result, "instrument-1", {
    action: "merge",
    targetId: "instrument-2",
  });
  assert.equal(result.parts.length, 1);
  assert.equal(result.parts[0].notes.length, originalCount);
  assert.equal(result.analysis.notes, originalCount);
});

test("invalid assignments leave the document unchanged and merge removes exact duplicates", () => {
  for (const assignment of [
    { action: "split", indexes: [99] },
    { action: "split", indexes: [0, 1, 2] },
    { action: "move", indexes: [0], targetId: "instrument-1" },
    { action: "merge", targetId: "missing" },
    { action: "move", indexes: [], targetId: "instrument-2" },
  ]) {
    const result = fixture(),
      before = structuredClone(result);
    assert.throws(() => applyAssignment(result, "instrument-1", assignment), {
      status: 400,
    });
    assert.deepEqual(result, before);
  }
  const result = fixture();
  result.parts[1].notes.push({ ...result.parts[0].notes[0] });
  applyAssignment(result, "instrument-1", {
    action: "merge",
    targetId: "instrument-2",
  });
  assert.equal(result.parts[0].notes.length, 4);
});

test("drum merge keeps the destination patch, unifies pad pitch and removes duplicate hits", () => {
  const result = fixture();
  result.engine = "drum";
  result.parts[0].patch = { engine: "drum", tune: 7 };
  result.parts[1].patch = { engine: "drum", tune: -2 };
  const patch = structuredClone(result.parts[1].patch);
  applyAssignment(result, "instrument-1", {
    action: "merge",
    targetId: "instrument-2",
  });
  assert.equal(result.parts.length, 1);
  assert.deepEqual(result.parts[0].patch, patch);
  assert.deepEqual(
    result.parts[0].notes.map((n) => n.start),
    [0.1, 0.5, 0.9],
  );
  assert.ok(result.parts[0].notes.every((n) => n.pitch === 36));
  assert.equal(result.analysis.notes, 3);
});

test("an empty track can be merged and unsupported drum assignments are rejected", () => {
  const result = fixture();
  result.parts[0].notes = [];
  applyAssignment(result, "instrument-1", {
    action: "merge",
    targetId: "instrument-2",
  });
  assert.equal(result.parts.length, 1);
  const drum = fixture();
  drum.engine = "drum";
  const before = structuredClone(drum);
  assert.throws(
    () =>
      applyAssignment(drum, "instrument-1", { action: "split", indexes: [0] }),
    { status: 400 },
  );
  assert.deepEqual(drum, before);
});
