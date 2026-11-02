import test from "node:test";
import assert from "node:assert/strict";
import { renderPractice } from "../engine/practice.mjs";
import { renderNotes, patchData } from "../engine/synth.mjs";
import { AudioEngine } from "../client/audio.mjs";

test("rapid patch edits prepare only the latest pending shape", async (t) => {
  const OriginalWorker = globalThis.Worker;
  const sent = [],
    applied = [];
  globalThis.Worker = class {
    postMessage(data) {
      sent.push(data);
    }
    terminate() {}
  };
  t.after(() => {
    if (OriginalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = OriginalWorker;
  });
  const engine = new AudioEngine();
  engine.init = async () => {};
  engine.context = { sampleRate: 44100 };
  engine.node = { port: { postMessage: (data) => applied.push(data) } };
  const edits = [engine.patch({ brightness: 0.1 })];
  await Promise.resolve();
  for (let i = 2; i <= 20; i++)
    edits.push(engine.patch({ brightness: i / 20 }));
  await Promise.resolve();
  assert.equal(sent.length, 1);
  engine.worker.onmessage({ data: sent[0] });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].patch.brightness, 1);
  assert.equal(applied.length, 0);
  engine.worker.onmessage({ data: sent[1] });
  await Promise.all(edits);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].patch.brightness, 1);
});

const patch = patchData({ family: "fm", release: 0.3, detune: 7 });
const backing = {
  id: "backing",
  patch,
  notes: [{ pitch: 60, start: 0, end: 1, velocity: 90 }],
};
const target = {
  id: "target",
  patch,
  notes: [{ pitch: 72, start: 0, end: 1, velocity: 90 }],
};

test("practice mutes the selected instrument and preserves held notes at loop boundaries", () => {
  const full = renderNotes(patch, backing.notes, 2);
  const slice = renderPractice([backing, target], "target", 0.5, 1.5, 1);
  for (let i = 0; i < slice.length; i++)
    assert.ok(Math.abs(slice[i] - full[i + 11025]) < 1e-6);
  const muted = renderPractice([target], "target", 0, 1, 1);
  assert.ok(muted.every((x) => x === 0));
});

test("slower practice changes note spacing and length without transposing the oscillator", () => {
  const part = {
    ...backing,
    notes: [{ pitch: 60, start: 0.2, end: 0.6, velocity: 90 }],
  };
  const actual = renderPractice([part], "target", 0, 1, 0.5);
  const expected = renderNotes(
    patch,
    [{ pitch: 60, start: 0.4, end: 1.2, velocity: 90 }],
    2,
  );
  assert.deepEqual(actual, expected);
});

test("stopping while audio loads prevents delayed playback from starting", async () => {
  const engine = new AudioEngine();
  let deliver;
  engine.buffer = () =>
    new Promise((resolve) => {
      deliver = resolve;
    });
  engine.schedule = () => assert.fail("Cancelled playback started");
  const pending = engine.playUrl("/recording.wav");
  engine.stop();
  deliver({ duration: 4 });
  assert.equal(await pending, null);
});

test("starting another recording invalidates the earlier pending load", async () => {
  const engine = new AudioEngine(),
    deliver = [];
  engine.buffer = () => new Promise((resolve) => deliver.push(resolve));
  engine.schedule = (buffer) => buffer.name;
  const first = engine.playUrl("/first.wav"),
    second = engine.playUrl("/second.wav");
  deliver[1]({ name: "second", duration: 4 });
  assert.equal(await second, "second");
  deliver[0]({ name: "first", duration: 4 });
  assert.equal(await first, null);
});

test("stopping pending practice rendering prevents scheduling its completed buffer", async () => {
  const engine = new AudioEngine();
  let deliver;
  engine.init = async () => {};
  engine.renderPractice = () =>
    new Promise((resolve) => {
      deliver = resolve;
    });
  engine.schedule = () => assert.fail("Cancelled practice started");
  const pending = engine.practice([backing], "target", 0, 1, 1);
  await Promise.resolve();
  engine.stop();
  deliver(new Float32Array(22050));
  assert.equal(await pending, null);
});
