import test from "node:test";
import assert from "node:assert/strict";
import {
  drumPatch,
  prepareDrum,
  DrumVoice,
  renderDrums,
  encodeStereoWav,
  decodeDrumWav,
} from "../engine/drums.mjs";
const sr = 44100;
const sound = {
  sampleRate: sr,
  channels: [
    Float32Array.from(
      { length: sr / 4 },
      (_, i) =>
        Math.sin((2 * Math.PI * 200 * i) / sr) * 0.3 * Math.exp(-i / sr / 0.06),
    ),
    Float32Array.from(
      { length: sr / 4 },
      (_, i) =>
        Math.sin((2 * Math.PI * 200 * i) / sr) * 0.1 * Math.exp(-i / sr / 0.06),
    ),
  ],
};
const patch = drumPatch({
  model: { frequency: 200, toneDecay: 0.06, noiseDecay: 0.02 },
});
const energy = (x) => x.reduce((a, b) => a + b * b, 0);
test("recovered detail preserves full-rate stereo; synthesized controls are audible", () => {
  const prepared = prepareDrum(patch, sound, sr);
  for (let c = 0; c < 2; c++)
    for (let i = 0; i < sound.channels[c].length; i++)
      assert.ok(Math.abs(prepared[c][i] - sound.channels[c][i]) < 1e-6);
  assert.ok(energy(prepared[0]) > 8.9 * energy(prepared[1]));
  const pure = prepareDrum({ ...patch, detail: 0 }, sound, sr),
    shaped = prepareDrum({ ...patch, tone: 0 }, sound, sr);
  assert.notDeepEqual(pure[0], prepared[0]);
  assert.notDeepEqual(shaped[0], prepared[0]);
  const roundTrip = decodeDrumWav(encodeStereoWav(sound.channels, sr));
  assert.equal(roundTrip.sampleRate, sr);
  assert.deepEqual(roundTrip.channels, sound.channels);
});
test("drum note release preserves tails; velocity, retrigger and choke remain independent", () => {
  const prepared = prepareDrum(patch, sound, sr),
    voice = new DrumVoice(prepared, 127),
    quiet = new DrumVoice(prepared, 32);
  voice.off();
  voice.sample();
  quiet.sample();
  assert.equal(voice.done, false);
  const loud = voice.sample(),
    soft = quiet.sample();
  assert.ok(Math.abs(soft[0] / loud[0] - 32 / 127) < 1e-6);
  voice.choke(16);
  for (let i = 0; i < 16; i++) voice.sample();
  assert.equal(voice.done, true);
  assert.equal(quiet.done, false);
  const retrigger = new DrumVoice(prepared);
  assert.equal(retrigger.position, 0);
});
test("practice mutes the selected sound, changes timing without tuning, and chokes across parts", () => {
  const one = {
    id: "one",
    patch,
    asset: sound,
    notes: [{ start: 0.2, end: 0.26, velocity: 127 }],
  };
  const empty = renderDrums([one], 1, sr, { selectedId: "one" });
  assert.equal(energy(empty[0]), 0);
  const slow = renderDrums([one], 1, sr, { speed: 0.5 });
  const first = slow[0].findIndex((x) => Math.abs(x) > 1e-5);
  assert.ok(Math.abs(first / sr - 0.4) < 0.001);
  for (let i = 1; i < 2000; i++)
    assert.ok(
      Math.abs(slow[0][Math.round(0.4 * sr) + i] - sound.channels[0][i]) < 1e-6,
    );
  const second = {
    ...one,
    id: "two",
    patch: { ...patch, chokeGroup: "hats" },
    notes: [{ start: 0.23, end: 0.3, velocity: 1 }],
  };
  const choked = renderDrums(
    [{ ...one, patch: { ...patch, chokeGroup: "hats" } }, second],
    1,
    sr,
  );
  const free = renderDrums([one], 1, sr);
  assert.ok(
    energy(choked[0].slice(sr * 0.25)) <
      energy(free[0].slice(sr * 0.25)) * 0.01,
  );
});
