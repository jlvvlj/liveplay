import test from "node:test";
import assert from "node:assert/strict";
import {
  Voice,
  renderNotes,
  patchData,
  encodeWav,
  FAMILIES,
  hz,
  harmonicAmplitudes,
  makeTable,
} from "../engine/synth.mjs";
test("high live notes retain the spectral bandwidth used for fitting", () => {
  const patch = patchData({ family: "square", brightness: 1, body: 0 });
  for (const pitch of [60, 84, 96, 108]) {
    assert.deepEqual(
      makeTable(patch, pitch, 48000),
      makeTable(patch, pitch, 22050),
    );
  }
});
test("offline and realtime voices produce the same samples", () => {
  const patch = patchData({
    family: "fm",
    fm: 1.7,
    ratio: 2,
    attack: 0.02,
    release: 0.1,
  });
  const notes = [{ pitch: 60, start: 0, end: 0.2, velocity: 91 }],
    offline = renderNotes(patch, notes, 0.5, 22050);
  const voice = new Voice(patch, 60, 91, 22050, 0.2);
  for (let i = 0; i < offline.length; i++)
    assert.ok(Math.abs(offline[i] - (voice.done ? 0 : voice.sample())) < 1e-7);
});
test("every family is finite, audible and releases to silence", () => {
  for (const family of FAMILIES) {
    const audio = renderNotes(
      { family, release: 0.08 },
      [{ pitch: 69, start: 0, end: 0.15, velocity: 100 }],
      0.5,
      22050,
    );
    assert.ok(audio.every(Number.isFinite));
    assert.ok(audio.some((x) => Math.abs(x) > 0.01));
    assert.ok(audio.slice(-1000).every((x) => x === 0));
  }
});
test("held notes keep sounding until note-off", () => {
  const voice = new Voice(
    { family: "sine", sustain: 0.8, release: 0.03 },
    69,
    100,
    22050,
  );
  let energy = 0;
  for (let i = 0; i < 22050; i++) energy += voice.sample() ** 2;
  assert.ok(energy > 1);
  assert.equal(voice.done, false);
  voice.off();
  for (let i = 0; i < 2205; i++) voice.sample();
  assert.equal(voice.done, true);
});
test("patch controls and output encoding reject unsafe numeric state", () => {
  const p = patchData({
    family: "unknown",
    gain: Infinity,
    attack: -2,
    brightness: 99,
  });
  assert.equal(p.family, "saw");
  assert.equal(p.attack, 0.002);
  assert.equal(p.brightness, 1);
  assert.ok(Number.isFinite(p.gain));
  const wav = new DataView(encodeWav(new Float32Array([2, -2, 0]), 22050));
  assert.equal(wav.getInt16(44, true), 32767);
  assert.equal(wav.getInt16(46, true), -32767);
  assert.equal(wav.getUint32(24, true), 22050);
});
test("octaves double frequency and a sine patch has one harmonic", () => {
  assert.equal(hz(81), 2 * hz(69));
  const a = harmonicAmplitudes({ family: "sine", body: 0 });
  assert.equal(a[0], 1);
  assert.ok(a.slice(1).every((x) => x === 0));
});
