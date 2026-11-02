import { registerSoundEditor } from "./sound-editor.mjs";
import {
  workspaceRoot,
  workspaceMembers,
  composeWorkspace,
} from "./workspace.mjs";
import express from "express";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { catalog } from "../engine/catalog.mjs";
import { renderNotes, encodeWav, patchData } from "../engine/synth.mjs";
import {
  drumPatch,
  decodeDrumWav,
  renderDrums,
  encodeStereoWav,
} from "../engine/drums.mjs";
import { fixture } from "../tests/fixtures.mjs";
import { applyAssignment } from "./assignments.mjs";
import { applyPartEdit, noteIdentity } from "./part-edit.mjs";
import { validateSamRequest, renderSamProject, referencePeaks } from "./sam.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mergeDrumReferences } from "./merge-audio.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.INSTRUMENT_LAB_DATA || path.join(root, "data");
const python =
  process.env.INSTRUMENT_LAB_PYTHON || path.join(root, ".venv/bin/python");
const hfPython = process.env.INSTRUMENT_LAB_HF_PYTHON || path.join(root, ".venv-hf/bin/python");
const execFileAsync = promisify(execFile);
const hfClient = path.join(root, "hf/client.py");
const port = Number(process.env.INSTRUMENT_LAB_PORT || 5186);
await fs.mkdir(dataRoot, { recursive: true });
await fs.writeFile(
  path.join(dataRoot, "catalog.json"),
  JSON.stringify(catalog()),
);
const app = express(),
  queue = [],
  children = new Map(),
  locks = new Map();
app.use((req, res, next) => {
  if (req.url.startsWith("/api/instruments/"))
    req.url = req.url.replace("/api/instruments/", "/api/");
  next();
});
let running = null,
  shuttingDown = false;
async function exclusive(key, action) {
  const prior = locks.get(key) || Promise.resolve();
  const current = prior.catch(() => {}).then(action);
  locks.set(key, current);
  try {
    return await current;
  } finally {
    if (locks.get(key) === current) locks.delete(key);
  }
}
const idOK = (id) => /^[a-f0-9-]{36}$/.test(id);
const dir = (id) => {
  if (!idOK(id))
    throw Object.assign(new Error("Project not found"), { status: 404 });
  return path.join(dataRoot, id);
};
const read = async (id, file = "project.json") =>
  JSON.parse(await fs.readFile(path.join(dir(id), file), "utf8"));
const write = async (id, file, data) => {
  const filePath = path.join(dir(id), file),
    temp = filePath + "." + randomUUID() + ".tmp";
  await fs.writeFile(temp, JSON.stringify(data, null, 2));
  await fs.rename(temp, filePath);
};
async function update(id, patch, attemptId, statuses) {
  return exclusive(id, async () => {
    const project = await read(id);
    if (attemptId && project.attemptId !== attemptId) return null;
    if (statuses && !statuses.includes(project.status)) return null;
    Object.assign(project, patch, { updatedAt: Date.now() });
    await write(id, "project.json", project);
    return project;
  });
}
for (const id of await fs.readdir(dataRoot)) {
  if (idOK(id)) {
    try {
      const p = await read(id);
      if (["queued", "analyzing"].includes(p.status))
        await update(id, {
          status: "interrupted",
          message: "Analysis was interrupted. You can retry it.",
        });
    } catch {}
  }
}
function stopChild(child, signal) {
  if (!child) return;
  try { if(child.labProcessGroup) process.kill(-child.pid,signal); else child.kill(signal); }
  catch(error) { if(error.code!=="ESRCH") throw error; }
}
async function run(id, attemptId, command, args, onLine, forEdit = false) {
  const job = await exclusive(id, async () => {
    const project = await read(id);
    if (
      forEdit
        ? project.status !== "ready"
        : project.attemptId !== attemptId || project.status !== "analyzing"
    )
      throw new Error("Analysis stopped.");
    // Spawn under the same lock as cancellation, but release it immediately.
    // Cancellation must never miss a child between checking state and spawning.
    return {
      completion: new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          env: {
            ...process.env,
            OPENBLAS_NUM_THREADS: "2",
            VECLIB_MAXIMUM_THREADS: "2",
            PYTORCH_ENABLE_MPS_FALLBACK: "1",
          },
          detached: !!project.demucsRequest && process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.labProcessGroup = !!project.demucsRequest && process.platform !== "win32";
        children.set(attemptId, child);
        let errors = "",
          pending = "",
          analysisError = "";
        const consumeLine = (line) => {
          try {
            const event = JSON.parse(line);
            if (event.stage === "Failed" && typeof event.error === "string")
              analysisError = event.error;
            if (event.type === "error" && typeof event.message === "string") analysisError = event.message;
          } catch {}
          onLine?.(line);
        };
        child.stdout.on("data", (chunk) => {
          pending += chunk;
          const lines = pending.split("\n");
          pending = lines.pop();
          for (const line of lines) consumeLine(line);
        });
        child.stderr.on("data", (chunk) => {
          errors = (errors + chunk).slice(-4000);
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (children.get(attemptId) === child) children.delete(attemptId);
          if (pending) consumeLine(pending);
          if (code === 0) return resolve();
          if (errors) console.error(`Analysis ${attemptId} failed:\n${errors}`);
          reject(
            new Error(
              analysisError ||
                "Audio processing failed. Please retry; diagnostic details are in the server log.",
            ),
          );
        });
      }),
    };
  });
  return job.completion;
}
async function renderProject(id, result, generation = randomUUID(), attemptId) {
  if (["sam-audio", "demucs-lab"].includes(result.separation?.provider)) return renderSamProject(dir(id), result, generation);
  if (result.engine === "drum") {
    const parts = await Promise.all(
      result.parts.map(async (part) => {
        const bytes = await fs.readFile(path.join(dir(id), part.sampleFile));
        return {
          ...part,
          asset: decodeDrumWav(
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ),
          ),
        };
      }),
    );
    for (const part of parts) {
      const samples = renderDrums([part], result.duration, 44100);
      const filename = generation + "-" + part.id + "-synth.wav";
      await fs.writeFile(
        path.join(dir(id), filename),
        new Uint8Array(encodeStereoWav(samples)),
      );
      result.parts.find((p) => p.id === part.id).synthFile = filename;
    }
    result.reconstructionFile = generation + "-reconstruction.wav";
    await fs.writeFile(
      path.join(dir(id), result.reconstructionFile),
      new Uint8Array(
        encodeStereoWav(renderDrums(parts, result.duration, 44100)),
      ),
    );
    return result;
  }
  const mix = new Float32Array(Math.ceil(result.duration * 22050));
  for (const part of result.parts) {
    if (attemptId) {
      const project = await read(id);
      if (project.attemptId !== attemptId || project.status !== "analyzing")
        throw new Error("Analysis stopped.");
    }
    const audio = renderNotes(part.patch, part.notes, result.duration, 22050);
    const filename = generation + "-" + part.id + "-synth.wav";
    await fs.writeFile(
      path.join(dir(id), filename),
      new Uint8Array(encodeWav(audio)),
    );
    part.synthFile = filename;
    for (let i = 0; i < mix.length; i++) mix[i] += audio[i];
  }
  await fs.writeFile(
    path.join(dir(id), generation + "-reconstruction.wav"),
    new Uint8Array(encodeWav(mix)),
  );
  result.reconstructionFile = generation + "-reconstruction.wav";
  return result;
}
async function rebuildReferences(id, result, generation) {
  const folder = path.join(dir(id), "edits", generation);
  await fs.mkdir(folder, { recursive: true });
  const document = path.join(folder, "input.json");
  await fs.writeFile(document, JSON.stringify(result));
  await run(
    id,
    generation,
    python,
    [
      path.join(root, "analysis/reextract.py"),
      "--input",
      path.join(dir(id), result.sourceFile || "source.wav"),
      "--document",
      document,
      "--output",
      folder,
    ],
    undefined,
    true,
  );
  const extracted = JSON.parse(
    await fs.readFile(path.join(folder, "result.json"), "utf8"),
  );
  for (const part of extracted.parts) {
    const filename = generation + "-" + part.id + "-reference.wav";
    await fs.copyFile(
      path.join(folder, part.referenceFile),
      path.join(dir(id), filename),
    );
    part.referenceFile = filename;
  }
  return extracted;
}
async function next() {
  if (shuttingDown || running || !queue.length) return;
  const { id, attemptId } = queue.shift();
  running = attemptId;
  try {
    const project = await update(
      id,
      {
        status: "analyzing",
        progress: 0.01,
        message: "Preparing audio",
      },
      attemptId,
      ["queued"],
    );
    if (!project) return;
    const folder = path.join(dir(id), "runs", attemptId);
    await fs.mkdir(folder, { recursive: true });
    const sam = project.samRequest;
    const demucs = project.demucsRequest;
    const range = sam?.range || demucs?.range;
    await run(id, attemptId, process.env.FFMPEG_PATH || "ffmpeg", [
      "-v",
      "error",
      "-y",
      "-i",
      path.join(dir(id), project.uploadFile),
      ...(range ? ["-ss", String(range[0]), "-t", String(range[1]-range[0])] : []),
      "-ar",
      sam ? "48000" : demucs || project.engine === "drum" ? "44100" : "22050",
      "-ac",
      sam || demucs || project.engine === "drum" ? "2" : "1",
      path.join(folder, "source.wav"),
    ]);
    let progressWrites = Promise.resolve();
    const onProgress = (line) => {
      try {
        const event = JSON.parse(line);
        progressWrites = progressWrites.then(() => update(id,
          {progress:event.progress, message:event.stage, ...(event.remoteJob ? {remoteJob:event.remoteJob} : {})},
          attemptId,["analyzing"]));
        progressWrites.catch(()=>{});
      } catch {}
    };
    if (demucs) {
      // Use the exact Sound editor separator without writing to its song folders.
      let separationProgress = .04;
      await run(id, attemptId, process.env.UV_PATH || "/opt/homebrew/bin/uv", [
        "run", "--script", path.resolve(root, "../scripts/separate_stems.py"),
        "--input", path.join(folder,"source.wav"), "--output", path.join(folder,"demucs"),
        "--model", "htdemucs_ft", "--device", process.env.MELODICS_DEMUCS_DEVICE || "mps",
      ], line => {
        try {
          const event=JSON.parse(line);
          if(event.type === "progress") separationProgress=.04+.36*event.value;
          onProgress(JSON.stringify({stage:event.type === "stage" && event.value === "loading-model" ? "Loading Sound editor separation model" : "Separating bass, drums, vocals and other", progress:separationProgress}));
        } catch {}
      });
      await run(id, attemptId, python, [path.join(root,"analysis/demucs_stems.py"),
        "--input", path.join(folder,"source.wav"), "--output", folder,
        "--catalog", path.join(dataRoot,"catalog.json")], onProgress);
    } else if (sam) {
      const requestFile = path.join(folder, "sam-request.json");
      await fs.writeFile(requestFile, JSON.stringify(sam));
      await run(id, attemptId, hfPython, [hfClient, "--input", path.join(folder,"source.wav"), "--request", requestFile, "--output", folder], onProgress);
      await run(id, attemptId, python, [path.join(root,"analysis/sam_stems.py"), "--input", path.join(folder,"source.wav"), "--request", requestFile, "--output", folder, "--catalog", path.join(dataRoot,"catalog.json")], onProgress);
    } else {
    await run(
      id,
      attemptId,
      python,
      [
        path.join(
          root,
          project.engine === "drum"
            ? "analysis/drums.py"
            : "analysis/analyze.py",
        ),
        "--input",
        path.join(folder, "source.wav"),
        "--output",
        folder,
        "--catalog",
        path.join(dataRoot, "catalog.json"),
        ...(project.inputKind === "mix"
          ? ["--mixed"]
          : project.autoDrums
            ? ["--allow-empty"]
            : []),
      ],
      onProgress,
    );
    }
    await progressWrites;
    const current = await read(id);
    if (current.attemptId !== attemptId || current.status !== "analyzing")
      return;
    const result = JSON.parse(
      await fs.readFile(path.join(folder, "result.json"), "utf8"),
    );
    for (const part of result.parts) {
      const filename = attemptId + "-" + part.id + "-reference.wav";
      await fs.copyFile(
        path.join(folder, part.referenceFile),
        path.join(dir(id), filename),
      );
      part.referenceFile = filename;
      if (part.engine === "drum" || result.engine === "drum") {
        const sampleFile = attemptId + "-" + part.id + "-sample.wav";
        await fs.copyFile(
          path.join(folder, part.sampleFile),
          path.join(dir(id), sampleFile),
        );
        part.sampleFile = sampleFile;
      }
    }
    result.sourceFile = attemptId + "-source.wav";
    await fs.copyFile(
      path.join(folder, "source.wav"),
      path.join(dir(id), result.sourceFile),
    );
    await renderProject(id, result, attemptId, attemptId);
    const documentFile = attemptId + "-result.json";
    await write(id, documentFile, result);
    // This pointer is the single commit: readers see either the old complete
    // document/assets or the new complete set. Cancelled attempts cannot publish.
    await update(
      id,
      {
        status: "ready",
        progress: 1,
        message: "Ready to explore",
        revision: 0,
        documentFile,
        analysisFile: documentFile,
      },
      attemptId,
      ["analyzing"],
    );
  } catch (error) {
    await update(id, { status: "error", message: error.message }, attemptId, [
      "analyzing",
    ]);
  } finally {
    running = null;
    void next();
  }
}
async function allProjects() {
  const projects = [];
  for (const id of await fs.readdir(dataRoot))
    if (idOK(id)) {
      try {
        projects.push(await read(id));
      } catch {}
    }
  return projects;
}
async function workspace(id) {
  const projects = await allProjects();
  const requested = projects.find((p) => p.id === id);
  if (!requested)
    throw Object.assign(new Error("Project not found"), { status: 404 });
  const root = workspaceRoot(requested, projects);
  const members = await Promise.all(
    workspaceMembers(root, projects).map(async (p) =>
      p.status === "ready"
        ? { ...p, result: await read(p.id, p.documentFile || "edited.json") }
        : p,
    ),
  );
  return composeWorkspace(members[0], members);
}
const route = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);
app.get(
  "/api/projects",
  route(async (req, res) => {
    const projects = [];
    for (const id of await fs.readdir(dataRoot))
      if (idOK(id))
        try {
          projects.push(await read(id));
        } catch {}
    res.json(
      projects
        .filter((p) => workspaceRoot(p, projects).id === p.id)
        .sort((a, b) => b.createdAt - a.createdAt),
    );
  }),
);
async function createProject(title, bytes, ext, metadata = {}) {
  const id = randomUUID(),
    attemptId = randomUUID();
  await fs.mkdir(dir(id));
  await fs.writeFile(path.join(dir(id), "upload" + ext), bytes);
  await write(id, "project.json", {
    id,
    title: title.slice(0, 120),
    uploadFile: "upload" + ext,
    sourceHash: createHash("sha256").update(bytes).digest("hex"),
    ...metadata,
    createdAt: Date.now(),
    status: "queued",
    progress: 0,
    message: "Waiting for analysis",
    revision: 0,
    attemptId,
  });
  queue.push({ id, attemptId });
  void next();
  return read(id);
}
async function ensureDrums(project) {
  const projects = await allProjects();
  const parent = workspaceRoot(project, projects);
  if (parent.engine === "drum" || parent.samRequest || parent.demucsRequest) return;
  await exclusive(parent.id + "-automatic-instruments", async () => {
    if (
      workspaceMembers(parent, await allProjects()).some(
        (p) => p.engine === "drum",
      )
    )
      return;
    const bytes = await fs.readFile(
      path.join(dir(parent.id), parent.uploadFile),
    );
    await createProject(
      parent.title + " · percussion",
      bytes,
      path.extname(parent.uploadFile),
      {
        engine: "drum",
        inputKind: "mix",
        parentProjectId: parent.id,
        sourceSongIds: parent.sourceSongIds || [],
      },
    );
  });
}
app.get("/api/sam/status", route(async (req,res) => {
  try {
    const {stdout} = await execFileAsync(hfPython,[hfClient,"--check"],{timeout:20000});
    const event = JSON.parse(stdout.trim().split("\n").at(-1));
    res.json({available:true,account:event.account});
  } catch { res.json({available:false,message:"Hugging Face connection unavailable. Check the server login and connection."}); }
}));
app.post("/api/projects/:id/demucs", express.json({limit:"8kb"}), route(async(req,res)=>{
  const range=req.body?.range ?? null;
  if(range !== null && (!Array.isArray(range) || range.length!==2 || !range.every(Number.isFinite) || range[0]<0 || range[1]-range[0]<.3))
    return res.status(400).json({error:"Choose a passage of at least 0.3 seconds."});
  const source=await read(req.params.id);
  const originId=source.analysisSourceProjectId || source.samSourceProjectId;
  const origin=originId ? await read(originId) : source;
  const duration=origin.documentFile ? (await read(origin.id,origin.documentFile)).duration : null;
  if(range && duration && range[1]>duration+.05)
    return res.status(400).json({error:"The passage extends beyond the recording."});
  const project=await exclusive(origin.id+"-demucs-submit",async()=>{
    const pending=(await allProjects()).find(p=>p.analysisSourceProjectId===origin.id && p.demucsRequest && ["queued","analyzing"].includes(p.status));
    if(pending) throw Object.assign(new Error("Instrument separation is already running. Open it from the analysis selector."),{status:409});
    const bytes=await fs.readFile(path.join(dir(origin.id),origin.uploadFile));
    return createProject(origin.title+" · Demucs instruments",bytes,path.extname(origin.uploadFile),{
      engine:"melodic",demucsRequest:{range,model:"htdemucs_ft"},analysisSourceProjectId:origin.id,
    });
  });
  res.status(202).json(await workspace(project.id));
}));
app.post("/api/projects/:id/sam", express.json({limit:"64kb"}), route(async(req,res)=>{
  const samRequest = validateSamRequest(req.body);
  const source = await read(req.params.id);
  const originId = source.analysisSourceProjectId || source.samSourceProjectId;
  const origin = originId ? await read(originId) : source;
  const duration = origin.documentFile ? (await read(origin.id,origin.documentFile)).duration : null;
  if(samRequest.range && duration && samRequest.range[1] > duration+.05)
    return res.status(400).json({error:"The passage extends beyond the recording."});
  const project = await exclusive(origin.id+"-sam-submit",async()=>{
    const pending = (await allProjects()).find(p=>p.samSourceProjectId===origin.id && ["queued","analyzing"].includes(p.status));
    if(pending) throw Object.assign(new Error("A SAM analysis for this recording is already running. Open it from the analysis selector."),{status:409});
    const bytes = await fs.readFile(path.join(dir(origin.id),origin.uploadFile));
    return createProject(origin.title+" · SAM Audio",bytes,path.extname(origin.uploadFile),{
      engine:"melodic", samRequest, samSourceProjectId:origin.id,
    });
  });
  res.status(202).json(await workspace(project.id));
}));
app.post(
  "/api/projects/:id/analyze-instruments",
  route(async (req, res) => {
    const project = await read(req.params.id);
    await ensureDrums(project);
    res.json(await workspace(project.id));
  }),
);
// Link an existing Melodics track without touching its legacy stems or lessons.
// Content matching also recovers projects created in the standalone preview,
// retaining their patches, notes and practice settings.
function importAnalysis(engine, pipeline) {
  if(engine === "drum") return {};
  // Legacy remains available for old analysis workflows; new imports separate first.
  return pipeline === "legacy" ? {autoDrums:true} : {demucsRequest:{range:null,model:"htdemucs_ft"}};
}
const songIdOK = (id) => /^[a-zA-Z0-9_-]{1,100}$/.test(id);
async function linkedSongProject(songId, engine = "melodic") {
  for (const id of await fs.readdir(dataRoot)) {
    if (!idOK(id)) continue;
    const project = await read(id);
    if (
      (project.engine || "melodic") === engine &&
      project.sourceSongIds?.includes(songId)
    )
      return project;
  }
  return null;
}
app.get(
  "/api/song-projects/:songId",
  route(async (req, res) => {
    if (!songIdOK(req.params.songId))
      return res.status(400).json({ error: "Invalid song ID." });
    const project = await linkedSongProject(
      req.params.songId,
      req.query.engine === "drum" ? "drum" : "melodic",
    );
    res
      .status(project ? 200 : 404)
      .json(
        project || { error: "No Instrument Lab project for this song yet." },
      );
  }),
);
app.post(
  "/api/song-projects/:songId",
  express.raw({ type: () => true, limit: "300mb" }),
  route(async (req, res) => {
    const songId = req.params.songId;
    const engine = req.query.engine === "drum" ? "drum" : "melodic";
    if (!songIdOK(songId) || !Buffer.isBuffer(req.body) || !req.body.length)
      return res.status(400).json({ error: "Choose an imported recording." });
    const filename = String(req.query.filename || "song.mp3");
    const ext = path.extname(filename).toLowerCase();
    if (![".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"].includes(ext))
      return res.status(400).json({ error: "Unsupported recording format." });
    const project = await exclusive("song-imports", async () => {
      const linked = await linkedSongProject(songId, engine);
      if (linked) return linked;
      const hash = createHash("sha256").update(req.body).digest("hex");
      for (const id of await fs.readdir(dataRoot)) {
        if (!idOK(id)) continue;
        const existing = await read(id);
        const existingHash =
          existing.sourceHash ||
          createHash("sha256")
            .update(await fs.readFile(path.join(dir(id), existing.uploadFile)))
            .digest("hex");
        if (!existing.samSourceProjectId && !existing.analysisSourceProjectId && (existing.engine || "melodic") === engine && existingHash === hash)
          return update(id, {
            sourceHash: hash,
            sourceSongIds: [...(existing.sourceSongIds || []), songId],
          });
      }
      return createProject(path.basename(filename, ext), req.body, ext, {
        sourceSongIds: [songId],
        ...importAnalysis(engine, req.query.pipeline),
        engine,
      });
    });
    if (engine !== "drum") await ensureDrums(project);
    res.json(project);
  }),
);
app.post(
  "/api/projects",
  express.raw({ type: () => true, limit: "60mb" }),
  route(async (req, res) => {
    const filename = String(req.query.filename || "song.wav"),
      ext = path.extname(filename).toLowerCase();
    if (
      ![".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"].includes(ext) ||
      !Buffer.isBuffer(req.body) ||
      !req.body.length
    )
      return res.status(400).json({
        error: "Choose a WAV, MP3, FLAC, OGG, M4A, or AAC recording.",
      });
    const engine = req.query.engine === "drum" ? "drum" : "melodic";
    const project = await createProject(
      path.basename(filename, ext),
      req.body,
      ext,
      { engine, ...importAnalysis(engine, req.query.pipeline) },
    );
    if (engine !== "drum") await ensureDrums(project);
    res.status(202).json(await workspace(project.id));
  }),
);
app.post(
  "/api/projects/:id/drums",
  express.raw({ type: () => true, limit: "300mb" }),
  route(async (req, res) => {
    const parent = await workspace(req.params.id);
    const ext = path
      .extname(String(req.query.filename || "drums.wav"))
      .toLowerCase();
    if (
      ![".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"].includes(ext) ||
      !Buffer.isBuffer(req.body) ||
      !req.body.length
    )
      return res.status(400).json({ error: "Choose a drum stem recording." });
    await exclusive(parent.id + "-drum-import", async () => {
      const hash = createHash("sha256").update(req.body).digest("hex");
      const existing = workspaceMembers(parent, await allProjects()).find(
        (p) => p.engine === "drum" && p.sourceHash === hash,
      );
      if (!existing)
        await createProject(parent.title + " · drum analysis", req.body, ext, {
          engine: "drum",
          parentProjectId: parent.id,
        });
    });
    res.status(202).json(await workspace(parent.id));
  }),
);
app.post(
  "/api/demo",
  route(async (req, res) => {
    const f = fixture("duet");
    const project = await createProject(
      "Neon duet · analysis demo",
      Buffer.from(encodeWav(f.audio, f.sr)),
      ".wav",
      { engine: "melodic", autoDrums: true },
    );
    await ensureDrums(project);
    res.status(202).json(await workspace(project.id));
  }),
);
app.get(
  "/api/projects/:id",
  route(async (req, res) => {
    res.json(await workspace(req.params.id));
  }),
);
app.post(
  "/api/projects/:id/cancel",
  route(async (req, res) => {
    const id = req.params.id;
    const project = await read(id);
    const members =
      project.engine === "drum"
        ? [project]
        : workspaceMembers(project, await allProjects());
    const pending = members.filter((p) =>
      ["queued", "analyzing"].includes(p.status),
    );
    if (!pending.length)
      return res
        .status(409)
        .json({ error: "This analysis is no longer running." });
    for (const member of pending)
      await exclusive(member.id, async () => {
        const current = await read(member.id);
        if (!["queued", "analyzing"].includes(current.status)) return;
        Object.assign(current, {
          status: "cancelled",
          message: "Analysis cancelled",
          updatedAt: Date.now(),
        });
        await write(current.id, "project.json", current);
        const index = queue.findIndex(
          (job) => job.attemptId === current.attemptId,
        );
        if (index >= 0) queue.splice(index, 1);
        stopChild(children.get(current.attemptId), "SIGTERM");
      });
    for (const member of pending.filter(p=>p.samRequest)) {
      try { await execFileAsync(hfPython,[hfClient,"--cancel","--output",path.join(dir(member.id),"runs",member.attemptId)],{timeout:30000}); }
      catch { await update(member.id,{message:"Analysis cancelled locally. Could not confirm remote cancellation; open the Hugging Face job to stop it. It has a 30-minute timeout."}); }
    }
    res.json(await workspace(id));
  }),
);
app.post(
  "/api/projects/:id/retry",
  route(async (req, res) => {
    await exclusive(req.params.id, async () => {
      const p = await read(req.params.id);
      if (!["error", "interrupted", "cancelled"].includes(p.status))
        return res
          .status(409)
          .json({ error: "Only unfinished analyses can be retried." });
      Object.assign(p, {
        status: "queued",
        progress: 0,
        message: "Waiting for analysis",
        attemptId: p.samRequest && p.status !== "cancelled" && !["ERROR","CANCELED","CANCELLED","DELETED"].includes(p.remoteJob?.status) ? p.attemptId : randomUUID(),
        updatedAt: Date.now(),
      });
      await write(p.id, "project.json", p);
      queue.push({ id: p.id, attemptId: p.attemptId });
      if (p.engine !== "drum") {
        for (const member of workspaceMembers(p, await allProjects()).filter(
          (m) =>
            m.id !== p.id &&
            m.inputKind === "mix" &&
            ["cancelled", "interrupted"].includes(m.status),
        )) {
          const attemptId = randomUUID();
          await update(member.id, {
            status: "queued",
            progress: 0,
            message: "Waiting for analysis",
            attemptId,
          });
          queue.push({ id: member.id, attemptId });
        }
      }
      res.json(p);
    });
    void next();
  }),
);
app.get(
  "/api/projects/:id/audio/:file",
  route(async (req, res) => {
    const folder = dir(req.params.id),
      file = req.params.file;
    if (
      !/^(?:[a-f0-9-]{36}-)?(source|reconstruction|instrument-\d+-(reference|synth|sample))\.wav$/.test(
        file,
      )
    )
      return res.sendStatus(404);
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(folder, file));
  }),
);
app.put(
  "/api/projects/:id/edit",
  express.json({ limit: "4mb" }),
  route(async (req, res) =>
    exclusive(req.params.id + "-edit", async () => {
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
        return res.status(400).json({ error: "Supply an instrument edit." });
      if (req.body.notes !== undefined && !Array.isArray(req.body.notes))
        return res.status(400).json({ error: "Notes must be a list." });
      const id = req.params.id,
        project = await read(id);
      if (project.status !== "ready")
        return res.status(409).json({ error: "Wait for analysis to finish." });
      if (req.body.revision !== project.revision)
        return res
          .status(409)
          .json({ error: "This project changed. Reload it before saving." });
      let result = await read(id, project.documentFile || "edited.json");
      const part = result.parts.find((p) => p.id === req.body.partId);
      if (!part) return res.status(404).json({ error: "Instrument not found" });
      for (const p of result.parts)
        p.referencePatch ??= (p.engine === "drum" || result.engine === "drum" ? drumPatch : patchData)(
          p.automaticPatch || p.patch,
        );
      const beforeNotes = noteIdentity(part.notes);
      applyPartEdit(result, part, req.body);
      if (req.body.targetEdit !== undefined) {
        if (req.body.assignment?.action !== "merge")
          return res
            .status(400)
            .json({ error: "Destination edits require a track merge." });
        const target = result.parts.find(
          (p) => p.id === req.body.assignment.targetId && p !== part,
        );
        if (!target)
          return res
            .status(400)
            .json({ error: "Choose a different destination instrument." });
        applyPartEdit(result, target, req.body.targetEdit);
      }
      const generation = randomUUID(),
        documentFile = generation + "-edited.json";
      let selectedPartId = part.id;
      if (result.separation && req.body.assignment && req.body.assignment.action !== "merge")
        return res.status(400).json({error:"SAM original stems support whole-track merging. Edit notes directly; split/move remains available in earlier analyses."});
      if (req.body.assignment !== undefined) {
        selectedPartId = applyAssignment(result, part.id, req.body.assignment);
        if (result.engine === "drum" || result.separation) {
          const target = result.parts.find((p) => p.id === selectedPartId);
          await mergeDrumReferences(
            dir(id),
            part,
            target,
            generation + "-" + target.id + "-reference.wav",
          );
          if(result.separation) {
            target.separation = {...target.separation, mergedSources:[...(target.separation?.mergedSources || [target.separation?.sourceId]), ...(part.separation?.mergedSources || [part.separation?.sourceId])]};
            await referencePeaks(dir(id),target);
          }
        }
      }
      if (
        !result.separation && result.engine !== "drum" &&
        (req.body.assignment !== undefined ||
          noteIdentity(part.notes) !== beforeNotes)
      )
        result = await rebuildReferences(id, result, generation);
      result.analysis = {
        ...result.analysis,
        notes: result.parts.reduce((sum, p) => sum + p.notes.length, 0),
      };
      await renderProject(id, result, generation);
      await write(id, documentFile, result);
      await update(id, { revision: project.revision + 1, documentFile });
      res.json({ ...(await read(id)), result, selectedPartId });
    }),
  ),
);
app.get("/api/health", (req, res) =>
  res.json({ ok: true, engine: "melodics-harmonic-v1" }),
);
registerSoundEditor(app, {dir,read,write,exclusive,root,python});
app.use("/engine", express.static(path.join(root, "engine")));
app.use("/instrument-lab/engine", express.static(path.join(root, "engine")));
app.use((error, req, res, next) => {
  console.error(error);
  res
    .status(error.status || (error.code === "ENOENT" ? 404 : 500))
    .json({ error: error.message });
});
if (process.env.NODE_ENV === "production") {
  app.use("/instrument-lab", express.static(path.join(root, "dist")));
  app.use(express.static(path.join(root, "dist")));
  app.get("/", (req, res) => res.sendFile(path.join(root, "dist/index.html")));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    root: path.join(root, "client"),
    configFile: false,
    server: {
      middlewareMode: true,
      hmr: { host: "127.0.0.1" },
      fs: { allow: [root] },
    },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
const server = app.listen(port, "127.0.0.1", (error) => {
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  console.log(`Instrument Lab http://127.0.0.1:${server.address().port}`);
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    shuttingDown = true;
    const exited = [...children.values()].map((child) =>
      once(child, "close").catch(() => {}),
    );
    for (const child of children.values()) stopChild(child, child.spawnargs.includes(hfClient) ? "SIGINT" : "SIGTERM");
    exited.push(new Promise((resolve) => server.close(resolve)));
    Promise.all(exited).then(() => process.exit(0));
    setTimeout(() => {
      for (const child of children.values()) stopChild(child, "SIGKILL");
      process.exit(0);
    }, 2000).unref();
  });
