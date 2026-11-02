import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { patchData } from "../engine/synth.mjs";
import { drumPatch, encodeStereoWav } from "../engine/drums.mjs";

test(
  "workspace API keeps edits in their owning analysis and preserves both engines",
  { timeout: 15000 },
  async (t) => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "lab-workspace-"));
    const melodic = randomUUID(),
      drum = randomUUID();
    const notes = [{ start: 0.1, end: 0.2, pitch: 60, velocity: 100 }];
    for (const [id, engine, revision] of [
      [melodic, "melodic", 7],
      [drum, "drum", 3],
    ]) {
      const dir = path.join(folder, id);
      await fs.mkdir(dir);
      const patch = engine === "drum" ? drumPatch() : patchData({ gain: 0.2 });
      const result = {
        engine,
        duration: 0.4,
        sourceFile: "source.wav",
        parts: [
          {
            id: "instrument-1",
            engine,
            name: engine,
            patch,
            automaticPatch: patch,
            sampleFile: "instrument-1-sample.wav",
            referenceFile: "instrument-1-reference.wav",
            notes,
          },
        ],
        analysis: { notes: 1, warnings: [] },
      };
      await fs.writeFile(
        path.join(dir, "project.json"),
        JSON.stringify({
          id,
          engine,
          revision,
          status: "ready",
          sourceSongIds: ["same-song"],
          documentFile: "result.json",
          createdAt: 1,
        }),
      );
      await fs.writeFile(path.join(dir, "result.json"), JSON.stringify(result));
      const wav = new Uint8Array(
        encodeStereoWav(
          [new Float32Array(3000).fill(0.01), new Float32Array(3000)],
          44100,
        ),
      );
      await fs.writeFile(path.join(dir, "instrument-1-sample.wav"), wav);
    }
    const oldMelody = await fs.readFile(
      path.join(folder, melodic, "result.json"),
      "utf8",
    );
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
        const ended = once(child, "exit");
        child.kill("SIGTERM");
        await ended;
      }
      await fs.rm(folder, { recursive: true, force: true });
    });
    const base = await new Promise((resolve, reject) => {
      let logs = "";
      child.stdout.on("data", (d) => {
        logs += d;
        const url = logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (url) resolve(url);
      });
      child.on("error", reject);
      child.stderr.on("data", () => {});
    });
    const get = async (url) => (await fetch(base + url)).json();
    const edit = async (id, revision, patch) =>
      fetch(base + `/api/projects/${id}/edit`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision, partId: "instrument-1", patch }),
      });
    assert.deepEqual(
      (await get("/api/projects")).map((p) => p.id),
      [melodic],
    );
    assert.equal((await get(`/api/projects/${drum}`)).id, melodic);
    assert.equal(
      (await edit(drum, 3, { ...drumPatch(), gain: 0.7 })).status,
      200,
    );
    let combined = await get(`/api/projects/${melodic}`);
    assert.equal(combined.result.parts.length, 2);
    assert.equal(
      combined.result.parts.find((p) => p.engine === "drum").patch.gain,
      0.7,
    );
    assert.equal(
      combined.result.parts.find((p) => p.engine === "drum").ownerRevision,
      4,
    );
    assert.equal(
      await fs.readFile(path.join(folder, melodic, "result.json"), "utf8"),
      oldMelody,
    );
    assert.equal(
      (await edit(melodic, 7, patchData({ gain: 0.5 }))).status,
      200,
    );
    combined = await get(`/api/projects/${melodic}`);
    assert.equal(
      combined.result.parts.find((p) => p.engine === "melodic").patch.gain,
      0.5,
    );
    assert.equal(
      combined.result.parts.find((p) => p.engine === "drum").patch.gain,
      0.7,
    );
    assert.equal((await edit(drum, 3, drumPatch())).status, 409);
    const part = combined.result.parts.find((p) => p.engine === "drum");
    assert.equal(
      (
        await fetch(
          base + `/api/projects/${part.ownerProjectId}/audio/${part.synthFile}`,
        )
      ).status,
      200,
    );
  },
);
