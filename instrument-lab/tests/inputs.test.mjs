import test from "node:test";
import assert from "node:assert/strict";
import { routeMidiInputs } from "../client/midi.mjs";
import { matchPracticeNote } from "../engine/scoring.mjs";
import { AudioEngine } from "../client/audio.mjs";

test("MIDI attaches later devices, releases disconnected inputs and reconnects once", () => {
  const access = { inputs: new Map() },
    events = [],
    listed = [];
  let selection = "";
  const router = routeMidiInputs(access, {
    getDeviceId: () => selection,
    onNoteOn: (...args) => events.push(["on", ...args]),
    onNoteOff: (...args) => events.push(["off", ...args]),
    onDevices: (inputs) => listed.push(inputs.map((p) => p.id)),
  });
  const a = { id: "a", state: "connected" },
    b = { id: "b", state: "connected" };
  access.inputs.set(a.id, a);
  access.onstatechange();
  a.onmidimessage({ data: [0x90, 60, 99] });
  assert.deepEqual(events.at(-1), ["on", 60, 99, "midi:a:0:60"]);
  access.inputs.set(b.id, b);
  access.onstatechange();
  b.onmidimessage({ data: [0x91, 60, 90] });
  assert.equal(events.at(-1)[3], "midi:b:1:60");
  selection = "b";
  router.refresh();
  assert.deepEqual(events.at(-1), ["off", 60, "midi:a:0:60"]);
  const count = events.length;
  a.onmidimessage({ data: [0x90, 64, 100] });
  assert.equal(events.length, count, "unselected device is ignored");
  b.state = "disconnected";
  access.onstatechange();
  assert.deepEqual(events.at(-1), ["off", 60, "midi:b:1:60"]);
  assert.equal(b.onmidimessage, null);
  b.state = "connected";
  access.onstatechange();
  access.onstatechange();
  b.onmidimessage({ data: [0x91, 62, 88] });
  b.onmidimessage({ data: [0x91, 62, 0] });
  assert.deepEqual(events.slice(-2), [
    ["on", 62, 88, "midi:b:1:62"],
    ["off", 62, "midi:b:1:62"],
  ]);
  b.onmidimessage({ data: [0x91, 65, 88] });
  b.onmidimessage({ data: [0xb1, 123, 0] });
  assert.deepEqual(events.at(-1), ["off", 65, "midi:b:1:65"]);
  router.dispose();
  assert.equal(access.onstatechange, null);
  assert.equal(a.onmidimessage, null);
  assert.equal(b.onmidimessage, null);
  assert.deepEqual(listed.at(-1), ["a", "b"]);
});

test("practice scoring respects pitch, closest onset, loop bounds and single credit", () => {
  const notes = [
    { pitch: 60, start: 0.9 },
    { pitch: 60, start: 1.2 },
    { pitch: 64, start: 1.2 },
    { pitch: 60, start: 2 },
  ];
  const matched = new Set(),
    range = [1, 2];
  const hit = matchPracticeNote(notes, 60, 1.23, matched, range, 1);
  assert.equal(hit.kind, "hit");
  assert.equal(hit.index, 1);
  assert.equal(hit.feedback, "On time");
  matched.add(hit.index);
  assert.equal(
    matchPracticeNote(notes, 60, 1.23, matched, range, 1).kind,
    "extra",
  );
  assert.equal(
    matchPracticeNote(notes, 61, 1.2, matched, range, 1).kind,
    "extra",
  );
  assert.equal(
    matchPracticeNote(notes, 64, 1.2, matched, range, 1).kind,
    "hit",
    "simultaneous chord notes each count",
  );
  assert.equal(
    matchPracticeNote(notes, 60, 0.9, new Set(), range, 1).kind,
    "ignored",
    "warm-up is not penalized",
  );
  assert.equal(
    matchPracticeNote(notes, 60, 2, new Set(), range, 1).kind,
    "ignored",
    "loop end is exclusive",
  );
});

test("practice timing tolerance stays 150 real milliseconds at every tempo", () => {
  for (const speed of [0.25, 0.5, 1, 2]) {
    const notes = [{ pitch: 72, start: 3 }],
      range = [1, 5],
      matched = new Set();
    const early = matchPracticeNote(
      notes,
      72,
      3 - 0.14 * speed,
      matched,
      range,
      speed,
    );
    assert.equal(early.kind, "hit");
    assert.equal(early.feedback, "A little early");
    assert.ok(Math.abs(early.offsetMs + 140) < 1e-7);
    const late = matchPracticeNote(
      notes,
      72,
      3 + 0.14 * speed,
      matched,
      range,
      speed,
    );
    assert.equal(late.kind, "hit");
    assert.equal(late.feedback, "A little late");
    assert.equal(
      matchPracticeNote(notes, 72, 3 + 0.16 * speed, matched, range, speed)
        .kind,
      "extra",
    );
  }
});

test("panic cancels a pending live note without stopping accompaniment", async () => {
  const engine = new AudioEngine(),
    messages = [];
  let resume;
  engine.init = () =>
    new Promise((resolve) => {
      resume = resolve;
    });
  engine.node = { port: { postMessage: (message) => messages.push(message) } };
  const accompaniment = {
    stop() {
      throw new Error("panic must keep the backing track");
    },
  };
  engine.sources = [accompaniment];
  const pending = engine.on(60);
  engine.panic();
  resume();
  await pending;
  assert.deepEqual(messages, [{ type: "panic" }]);
  assert.equal(engine.sources[0], accompaniment);
});

test("a retrigger while audio initializes cannot revive the previous pending note", async () => {
  const engine = new AudioEngine(),
    messages = [];
  let resume;
  const ready = new Promise((resolve) => {
    resume = resolve;
  });
  engine.init = () => ready;
  engine.node = { port: { postMessage: (message) => messages.push(message) } };
  const first = engine.on(60, 90);
  engine.off(60);
  const second = engine.on(60, 110);
  resume();
  await Promise.all([first, second]);
  assert.deepEqual(
    messages.filter((message) => message.type === "on"),
    [{ type: "on", pitch: 60, velocity: 110, id: "60" }],
  );
});
