import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, accept, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (accept(result)) return result;
    await delay(20);
  }
  throw new Error("Timed out waiting for server state");
}

test(
  "analysis attempts, document commits, validation and concurrent edits",
  { timeout: 30000 },
  async (t) => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "instrument-api-"));
    const ffmpeg = path.join(folder, "ffmpeg.mjs"),
      python = path.join(folder, "python.mjs");
    await fs.writeFile(
      ffmpeg,
      `#!${process.execPath}
import fs from 'node:fs/promises';
const args=process.argv.slice(2);
if(args.includes('-t') || args.includes('-to')) throw new Error('Audio must not be truncated');
await fs.copyFile(args[args.indexOf('-i')+1],args.at(-1));
`,
      { mode: 0o755 },
    );
    // A cooperative fake analyzer lets the API tests force a late completion from
    // a cancelled child. No real project, audio model or network is involved.
    await fs.writeFile(
      python,
      `#!${process.execPath}
import fs from 'node:fs/promises';
import path from 'node:path';
const args=process.argv.slice(2), folder=args[args.indexOf('--output')+1];
if(args.includes('--document')) {
 const document=JSON.parse(await fs.readFile(args[args.indexOf('--document')+1], 'utf8'));
 if(document.parts.some(p=>p.name==='Force reference failure')) process.exit(3);
 for(const part of document.parts) {
  part.referenceFile=part.id+'-reference.wav';
  await fs.writeFile(path.join(folder,part.referenceFile),Buffer.alloc(44));
 }
 document.referenceRevision={method:'test-mask-rebuild'};
 await fs.writeFile(path.join(folder,'result.json'),JSON.stringify(document));
 process.exit(0);
}

const input=await fs.readFile(args[args.indexOf('--input')+1], 'utf8');
if(input==='expected-error' || input==='unexpected-error') {
 if(input==='expected-error') process.stdout.write(JSON.stringify({stage:'Failed',progress:0,error:'No reliable pitched notes found.'}));
 console.error('Traceback (most recent call last): private/path/analyze.py: sensitive diagnostic');
 process.exitCode=1;
 await new Promise(r=>setTimeout(r,20));
 process.exit(1);
}
let interrupted=false;
process.on('SIGTERM',()=>{interrupted=true});
console.log(JSON.stringify({stage:'Fake model running',progress:.4}));
await new Promise(r=>setTimeout(r,600));
const lengthy=(await fs.readFile(args[args.indexOf('--input')+1], 'utf8'))==='lengthy';
const result={duration:1,sampleRate:22050,parts:[{id:'instrument-1',name:'Test instrument',referenceFile:'instrument-1-reference.wav',patch:{family:'sine'},notes:[{pitch:60,start:.1,end:.4,velocity:100},{pitch:64,start:.6,end:.8,velocity:90}]}],analysis:{attempt:path.basename(folder),interrupted},waveform:[]};
if(lengthy){
 result.duration=30;
 result.parts=Array.from({length:24},(_,i)=>({...result.parts[0],id:'instrument-'+(i+1),referenceFile:'instrument-'+(i+1)+'-reference.wav'}));
}
for(const part of result.parts) await fs.writeFile(path.join(folder,part.referenceFile),Buffer.alloc(44));
await fs.writeFile(path.join(folder,'result.json'),JSON.stringify(result));
console.log(JSON.stringify({stage:interrupted?'Late cancelled result':'Finished',progress:1}));
`,
      { mode: 0o755 },
    );
    const child = spawn(
      process.execPath,
      [path.join(root, "server/index.mjs")],
      {
        env: {
          ...process.env,
          NODE_ENV: "production",
          INSTRUMENT_LAB_PORT: "0",
          INSTRUMENT_LAB_DATA: path.join(folder, "data"),
          FFMPEG_PATH: ffmpeg,
          INSTRUMENT_LAB_PYTHON: python,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let logs = "";
    child.stdout.on("data", (chunk) => {
      logs += chunk;
    });
    child.stderr.on("data", (chunk) => {
      logs += chunk;
    });
    t.after(async () => {
      if (child.exitCode === null) {
        const ended = once(child, "exit");
        child.kill("SIGTERM");
        await ended;
      }
      await fs.rm(folder, { recursive: true, force: true });
    });
    const base = await until(() => {
      if (child.exitCode !== null) throw new Error("Server exited: " + logs);
      return logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    }, Boolean);
    const request = async (url, options) => {
      const res = await fetch(base + url, options);
      return { status: res.status, body: await res.json() };
    };
    for (const kind of ["expected-error", "unexpected-error"]) {
      const failed = await request("/api/projects?filename=failure.wav", {
        method: "POST",
        body: kind,
      });
      const state = await until(
        async () => (await request("/api/projects/" + failed.body.id)).body,
        (p) => p.status === "error",
      );
      assert.doesNotMatch(
        state.message,
        /Traceback|private\/path|sensitive diagnostic/,
      );
      assert.match(
        state.message,
        kind === "expected-error"
          ? /No reliable pitched notes/
          : /Audio processing failed/,
      );
    }
    assert.match(
      logs,
      /sensitive diagnostic/,
      "diagnostics remain available on the server",
    );
    const created = await request("/api/projects?filename=test.wav", {
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
    });
    assert.equal(created.status, 202);
    const endpoint = "/api/projects/" + created.body.id;
    const get = async () => (await request(endpoint)).body;
    await until(get, (p) => p.message === "Fake model running");
    assert.equal(
      (await request(endpoint + "/cancel", { method: "POST" })).status,
      200,
    );
    const retried = await request(endpoint + "/retry", { method: "POST" });
    assert.equal(retried.status, 200);
    assert.notEqual(retried.body.attemptId, created.body.attemptId);
    assert.equal(
      (await request(endpoint + "/retry", { method: "POST" })).status,
      409,
    );
    const ready = await until(get, (p) => p.status === "ready");
    assert.equal(ready.attemptId, retried.body.attemptId);
    assert.equal(ready.result.analysis.attempt, retried.body.attemptId);
    assert.equal(ready.result.analysis.interrupted, false);
    assert.equal(
      (await request(endpoint + "/cancel", { method: "POST" })).status,
      409,
    );

    // A track imported through Melodics must reuse an existing matching project.
    const linkSong = () =>
      request("/api/song-projects/existing-song?filename=linked.wav", {
        method: "POST",
        body: new Uint8Array([1, 2, 3]),
      });
    const links = await Promise.all([linkSong(), linkSong()]);
    assert.ok(links.every((r) => r.status === 200 && r.body.id === ready.id));
    assert.equal(
      (await request("/api/song-projects/existing-song")).body.id,
      ready.id,
    );
    assert.equal(
      (await request("/api/instruments/projects/" + ready.id)).body.id,
      ready.id,
    );
    assert.equal(
      (await request("/api/projects")).body.filter((p) =>
        p.sourceSongIds?.includes("existing-song"),
      ).length,
      1,
    );

    const oldFile = ready.result.parts[0].synthFile;
    const oldAudio = new Uint8Array(
      await (await fetch(base + endpoint + "/audio/" + oldFile)).arrayBuffer(),
    );
    const edit = (body) =>
      request(endpoint + "/edit", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 0, partId: "instrument-1", ...body }),
      });
    assert.equal((await edit({ notes: [null] })).status, 400);
    assert.equal((await edit({ notes: "invalid" })).status, 400);
    assert.equal((await get()).revision, 0);
    const saves = await Promise.all([
      edit({ patch: { family: "square" }, name: "First" }),
      edit({ patch: { family: "saw" }, name: "Second" }),
    ]);
    assert.deepEqual(saves.map((r) => r.status).sort(), [200, 409]);
    const saved = await get();
    assert.equal(saved.revision, 1);
    assert.notEqual(saved.documentFile, ready.documentFile);
    assert.notEqual(saved.result.parts[0].synthFile, oldFile);
    assert.equal(
      saved.result.parts[0].referenceFile,
      ready.result.parts[0].referenceFile,
    );
    const oldAgain = new Uint8Array(
      await (await fetch(base + endpoint + "/audio/" + oldFile)).arrayBuffer(),
    );
    assert.deepEqual(
      oldAgain,
      oldAudio,
      "a save must not overwrite assets of the previous revision",
    );
    const committed = JSON.parse(
      await fs.readFile(
        path.join(folder, "data", ready.id, saved.documentFile),
        "utf8",
      ),
    );
    assert.equal(
      committed.parts[0].name,
      saves.find((r) => r.status === 200).body.result.parts[0].name,
    );
    const failed = await edit({
      revision: 1,
      name: "Force reference failure",
      notes: [{ pitch: 60, start: 0.1, end: 0.3, velocity: 100 }],
    });
    assert.equal(failed.status, 500);
    assert.equal(
      (await get()).documentFile,
      saved.documentFile,
      "a failed extraction must not publish a partial document",
    );
    const reopened = await linkSong();
    assert.equal(reopened.body.documentFile, saved.documentFile);
    assert.equal(
      reopened.body.revision,
      1,
      "linking must retain edits and audio revisions",
    );
    const newTrack = await request(
      "/api/song-projects/new-song?filename=new.wav",
      { method: "POST", body: "new song bytes" },
    );
    assert.equal(newTrack.status, 200);
    assert.notEqual(newTrack.body.id, ready.id);
    await until(
      async () => (await request("/api/projects/" + newTrack.body.id)).body,
      (p) => p.status === "ready",
    );

    const split = await edit({
      revision: 1,
      assignment: { action: "split", indexes: [1], name: "Second voice" },
    });
    assert.equal(split.status, 200);
    assert.equal(split.body.result.parts.length, 2);
    assert.equal(
      split.body.result.referenceRevision.method,
      "test-mask-rebuild",
    );
    assert.notEqual(
      split.body.result.parts[0].referenceFile,
      saved.result.parts[0].referenceFile,
    );
    assert.notEqual(
      split.body.result.parts[0].referenceFile,
      split.body.result.parts[1].referenceFile,
    );
    const splitId = split.body.selectedPartId;
    const merged = await edit({
      revision: 2,
      partId: splitId,
      assignment: { action: "merge", targetId: "instrument-1" },
    });
    assert.equal(merged.status, 200);
    assert.equal(merged.body.result.parts.length, 1);
    assert.equal(merged.body.result.parts[0].notes.length, 2);

    // Cancel after the first generated synth file proves final rendering started.
    const large = await request("/api/projects?filename=render.wav", {
      method: "POST",
      body: "lengthy",
    });
    const largePath = path.join(folder, "data", large.body.id);
    await until(
      () => fs.readdir(largePath),
      (files) => files.some((f) => f.endsWith("-synth.wav")),
    );
    const stopped = await request(
      "/api/projects/" + large.body.id + "/cancel",
      { method: "POST" },
    );
    assert.equal(stopped.status, 200);
    // Starting and completing another queued job drains the cancelled attempt.
    const following = await request("/api/projects?filename=after.wav", {
      method: "POST",
      body: "short",
    });
    await until(
      async () => (await request("/api/projects/" + following.body.id)).body,
      (p) => p.status === "ready",
    );
    const cancelled = (await request("/api/projects/" + large.body.id)).body;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.documentFile, undefined);
  },
);
