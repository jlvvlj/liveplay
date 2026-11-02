import test from "node:test";
import assert from "node:assert/strict";
import { AudioEngine } from "../client/audio.mjs";
import { audibleIds, zoomWindow } from "../client/timeline.mjs";

test("timeline zoom anchors the focus and clamps song boundaries", () => {
  assert.deepEqual(zoomWindow(0, 200, 200, 100, 0.5), [50, 100]);
  assert.deepEqual(zoomWindow(50, 100, 200, 75, 0.5), [62.5, 50]);
  assert.deepEqual(zoomWindow(150, 50, 200, 200, 0.5), [175, 25]);
  assert.deepEqual(zoomWindow(175, 25, 200, 200, 20), [0, 200]);
  assert.deepEqual(zoomWindow(0, 0.1, 0.1, 0, 0.5), [0, 0.1]);
});

test("multiple solos form a group, mute takes priority, clearing solo restores others", () => {
  const parts = ["synth", "drum", "bass"].map((id) => ({ id }));
  assert.deepEqual(
    [...audibleIds(parts, [], ["synth", "drum"])],
    ["synth", "drum"],
  );
  assert.deepEqual(
    [...audibleIds(parts, ["drum"], ["synth", "drum"])],
    ["synth"],
  );
  assert.deepEqual([...audibleIds(parts, ["drum"], [])], ["synth", "bass"]);
});

function engine() {
  const audio = new AudioEngine(),
    starts = [],
    gains = [];
  audio.context = {
    currentTime: 10,
    destination: {},
    createBufferSource() {
      return {
        connect() {},
        start(...args) {
          starts.push(args);
        },
        stop() {
          this.stopped = true;
        },
      };
    },
    createGain() {
      const node = {
        connect() {},
        gain: {
          value: 0,
          setTargetAtTime(value) {
            this.value = value;
          },
        },
      };
      gains.push(node);
      return node;
    },
  };
  audio.buffer = async () => ({ duration: 60 });
  return { audio, starts, gains };
}

test("mix sources seek and start in sync; solo/mute updates live without restarting", async () => {
  const { audio, starts, gains } = engine();
  await audio.playMix(
    [
      { id: "synth", url: "s" },
      { id: "drum", url: "d" },
    ],
    25,
    40,
    new Set(["synth", "drum"]),
  );
  assert.deepEqual(starts, [
    [10.05, 25, 15],
    [10.05, 25, 15],
  ]);
  audio.setMixAudible(new Set(["drum"]));
  assert.deepEqual(
    gains.map((g) => g.gain.value),
    [0, 1],
  );
  assert.equal(starts.length, 2);
  audio.setMixAudible(new Set());
  assert.deepEqual(
    gains.map((g) => g.gain.value),
    [0, 0],
  );
  const sources = [...audio.sources];
  audio.stop();
  assert.ok(sources.every((s) => s.stopped));
  assert.equal(audio.mixGains.size, 0);
});

test("cancelled loading cannot start a stale mix; pending mute applies on first sample", async () => {
  const { audio, starts, gains } = engine();
  let finish;
  audio.buffer = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const cancelled = audio.playMix(
    [{ id: "drum", url: "d" }],
    0,
    50,
    new Set(["drum"]),
  );
  audio.stop();
  finish({ duration: 60 });
  assert.equal(await cancelled, null);
  assert.equal(starts.length, 0);
  const pending = audio.playMix(
    [{ id: "drum", url: "d" }],
    10,
    50,
    new Set(["drum"]),
  );
  audio.setMixAudible(new Set());
  finish({ duration: 60 });
  await pending;
  assert.equal(gains[0].gain.value, 0);
});

test("seeking reuses decoded mix stems and changed revisions reload only that stem", async () => {
  const { audio, starts } = engine();
  const requests = [];
  audio.buffer = async (url) => {
    requests.push(url);
    return { duration: 60 };
  };
  const parts = [
    { id: "synth", url: "s?v=1" },
    { id: "drum", url: "d?v=1" },
  ];
  await audio.playMix(parts, 0, 60, new Set(["synth", "drum"]));
  await audio.playMix(parts, 30, 60, new Set(["synth", "drum"]));
  assert.deepEqual(requests, ["s?v=1", "d?v=1"]);
  assert.deepEqual(starts.slice(-2), [
    [10.05, 30, 30],
    [10.05, 30, 30],
  ]);
  await audio.playMix(
    [parts[0], { ...parts[1], url: "d?v=2" }],
    30,
    60,
    new Set(["drum"]),
  );
  assert.deepEqual(requests, ["s?v=1", "d?v=1", "d?v=2"]);
  assert.equal(audio.mixBuffers.has("d?v=1"), false);
});
