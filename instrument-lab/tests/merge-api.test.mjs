import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drumPatch, encodeStereoWav, decodeDrumWav } from "../engine/drums.mjs";

test(
  "drum track merge publishes rebuilt audio, persists edits, rejects stale changes and preserves originals on failure",
  { timeout: 15000 },
  async (t) => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "lab-merge-"));
    const id = randomUUID(),
      dir = path.join(folder, id);
    await fs.mkdir(dir);
    const parts = [1, 2, 3].map((i) => ({
      id: `instrument-${i}`,
      engine: "drum",
      name: `Drum ${i}`,
      patch: drumPatch({ tune: i }),
      sampleFile: `sample-${i}.wav`,
      referenceFile: `reference-${i}.wav`,
      notes: [
        {
          pitch: 35 + i,
          start: i * 0.1,
          end: i * 0.1 + 0.06,
          velocity: 70 + i,
        },
      ],
    }));
    const result = {
      engine: "drum",
      duration: 1,
      sourceFile: "source.wav",
      parts,
      analysis: { notes: 3, warnings: [] },
    };
    const original = JSON.stringify(result);
    await fs.writeFile(path.join(dir, "edited.json"), original);
    await fs.writeFile(
      path.join(dir, "project.json"),
      JSON.stringify({
        id,
        engine: "drum",
        status: "ready",
        revision: 1,
        documentFile: "edited.json",
      }),
    );
    for (const [i, p] of parts.entries()) {
      const wav = new Uint8Array(
        encodeStereoWav([
          new Float32Array(4410).fill(0.01 * (i + 1)),
          new Float32Array(4410).fill(0.02 * (i + 1)),
        ]),
      );
      await fs.writeFile(path.join(dir, p.sampleFile), wav);
      await fs.writeFile(path.join(dir, p.referenceFile), wav);
    }
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    );
    const child = spawn(
      process.execPath,
      [path.join(root, "server/index.mjs")],
      {
        env: {
          ...process.env,
          NODE_ENV: "production",
          INSTRUMENT_LAB_DATA: folder,
          INSTRUMENT_LAB_PORT: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    t.after(async () => {
      if (child.exitCode === null) {
        const done = once(child, "exit");
        child.kill("SIGTERM");
        await done;
      }
      await fs.rm(folder, { recursive: true, force: true });
    });
    const base = await new Promise((resolve, reject) => {
      child.stdout.on("data", (d) => {
        const u = String(d).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (u) resolve(u);
      });
      child.on("error", reject);
      child.stderr.on("data", () => {});
    });
    const merge = (revision) =>
      fetch(`${base}/api/projects/${id}/edit`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revision,
          partId: "instrument-1",
          notes: [
            ...parts[0].notes,
            { pitch: 36, start: 0.7, end: 0.76, velocity: 88 },
          ],
          assignment: { action: "merge", targetId: "instrument-2" },
        }),
      });
    const response = await merge(1);
    assert.equal(response.status, 200);
    const saved = await response.json(),
      target = saved.result.parts.find((p) => p.id === "instrument-2");
    assert.equal(saved.result.parts.length, 2);
    assert.equal(saved.selectedPartId, target.id);
    assert.deepEqual(target.patch, parts[1].patch);
    assert.equal(target.sampleFile, parts[1].sampleFile);
    assert.deepEqual(
      target.notes.map((n) => n.start),
      [0.1, 0.2, 0.7],
    );
    assert.ok(target.notes.every((n) => n.pitch === 37));
    assert.equal(saved.result.analysis.notes, 4);
    for (const file of [
      target.referenceFile,
      target.synthFile,
      saved.result.reconstructionFile,
    ])
      assert.equal(
        (await fetch(`${base}/api/projects/${id}/audio/${file}`)).status,
        200,
      );
    const bytes = await fs.readFile(path.join(dir, target.referenceFile));
    const audio = decodeDrumWav(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    assert.ok(Math.abs(audio.channels[0][0] - 0.03) < 1e-6);
    assert.ok(Math.abs(audio.channels[1][0] - 0.06) < 1e-6);
    assert.equal(
      await fs.readFile(path.join(dir, "edited.json"), "utf8"),
      original,
    );
    assert.equal((await merge(1)).status, 409);
    const reload = await (await fetch(`${base}/api/projects/${id}`)).json();
    assert.equal(reload.result.parts.length, 2);
    const metadata = await fs.readFile(path.join(dir, "project.json"), "utf8");
    await fs.unlink(path.join(dir, parts[2].referenceFile));
    const failed = await fetch(`${base}/api/projects/${id}/edit`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        revision: 2,
        partId: "instrument-3",
        assignment: { action: "merge", targetId: "instrument-2" },
      }),
    });
    assert.equal(failed.status, 404);
    assert.equal(
      await fs.readFile(path.join(dir, "project.json"), "utf8"),
      metadata,
    );
  },
);
