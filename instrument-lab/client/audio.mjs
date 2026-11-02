import { enginePath } from "./paths.mjs";
export class AudioEngine {
  constructor() {
    this.context = null;
    this.sources = [];
    this.mixGains = new Map();
    this.mixBuffers = new Map();
    this.buffers = new Map();
    this.node = null;
    this.startAt = 0;
    this.pending = new Map();
    this.initializing = null;
    this.playGeneration = 0;
    this.renderJob = null;
  }
  async init() {
    if (!this.initializing) {
      this.initializing = (async () => {
        this.context = new AudioContext({ latencyHint: "interactive" });
        await this.context.audioWorklet.addModule(enginePath("worklet.mjs"));
        this.node = new AudioWorkletNode(this.context, "melodics-instrument", {
          outputChannelCount: [2],
        });
        this.node.connect(this.context.destination);
      })();
    }
    await this.initializing;
    await this.context.resume();
  }
  patch(patch) {
    this.isDrum = patch.engine === "drum";
    const token = (this.token = (this.token || 0) + 1);
    this.patchReady = (async () => {
      await this.init();
      if (token !== this.token) return;
      if (!this.worker) {
        this.worker = new Worker(enginePath("prepare-worker.mjs"), {
          type: "module",
        });
        this.waiters = new Map();
        this.worker.onmessage = ({ data }) => {
          if (data.error)
            this.waiters.get(data.token)?.reject(new Error(data.error));
          else {
            if (data.token === this.token)
              this.node.port.postMessage({ type: "patch", ...data });
            this.waiters.get(data.token)?.resolve();
          }
          this.waiters.delete(data.token);
          this.patchBusy = false;
          this.dispatchPatch();
        };
        this.worker.onerror = () => {
          for (const waiter of this.waiters.values())
            waiter.reject(
              new Error(
                "The instrument engine could not start. Reload and try again.",
              ),
            );
          this.waiters.clear();
          this.pendingPatch = null;
          this.patchBusy = false;
          this.worker.terminate();
          this.worker = null;
        };
      }
      const ready = new Promise((resolve, reject) =>
        this.waiters.set(token, { resolve, reject }),
      );
      // A dragged slider may generate many updates while tables are building.
      // Keep the latest pending shape rather than making the player wait for
      // every intermediate slider position to render.
      if (this.pendingPatch) {
        this.waiters.get(this.pendingPatch.token)?.resolve();
        this.waiters.delete(this.pendingPatch.token);
      }
      this.pendingPatch = {
        token,
        patch,
        sampleRate: this.context.sampleRate,
      };
      this.dispatchPatch();
      await ready;
    })();
    return this.patchReady;
  }
  dispatchPatch() {
    if (this.patchBusy || !this.pendingPatch) return;
    const next = this.pendingPatch;
    this.pendingPatch = null;
    this.patchBusy = true;
    this.worker.postMessage(next);
  }
  async on(pitch, velocity = 100, id = String(pitch)) {
    const token = {};
    this.pending.set(id, token);
    await this.init();
    await this.patchReady;
    if (this.pending.get(id) === token)
      this.node.port.postMessage({ type: "on", pitch, velocity, id });
  }
  off(pitch, id = String(pitch)) {
    if (!this.isDrum) this.pending.delete(id);
    this.node?.port.postMessage({ type: "off", id });
  }
  async buffer(url) {
    await this.init();
    if (!this.buffers.has(url)) {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Could not load audio");
      const buffer = await this.context.decodeAudioData(
        await response.arrayBuffer(),
      );
      if (this.buffers.size >= 8)
        this.buffers.delete(this.buffers.keys().next().value);
      this.buffers.set(url, buffer);
    }
    return this.buffers.get(url);
  }
  stop() {
    this.playGeneration++;
    this.renderJob?.cancel();
    for (const source of this.sources)
      try {
        source.stop();
      } catch {}
    this.sources = [];
    this.mixGains.clear();
    this.panic();
  }
  panic() {
    this.pending.clear();
    this.node?.port.postMessage({ type: "panic" });
  }
  schedule(buffer, offset, duration, delay) {
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    this.startAt = this.context.currentTime + delay;
    source.start(this.startAt, offset, duration);
    this.sources = [source];
    return this.startAt;
  }
  async playUrl(url, offset = 0, end = Infinity) {
    this.stop();
    const generation = this.playGeneration,
      buffer = await this.buffer(url);
    if (generation !== this.playGeneration) return null;
    const duration = Math.min(buffer.duration, end) - offset;
    if (duration <= 0) throw new Error("Choose a range within the recording.");
    return this.schedule(buffer, offset, duration, 0.05);
  }
  setMixAudible(ids) {
    this.mixAudible = new Set(ids);
    for (const [id, gain] of this.mixGains) {
      gain.gain.setTargetAtTime(
        ids.has(id) ? 1 : 0,
        this.context.currentTime,
        0.008,
      );
    }
  }
  async playMix(parts, offset, end, audible) {
    this.stop();
    this.mixAudible = new Set(audible);
    const generation = this.playGeneration;
    // Decode first, then schedule every source on exactly the same audio clock.
    const previous = this.mixBuffers;
    const loaded = await Promise.all(
      parts.map(async (part) => ({
        ...part,
        buffer: previous.get(part.url) || (await this.buffer(part.url)),
      })),
    );
    const buffers = loaded.map((part) => [part.id, part.buffer]);
    if (generation !== this.playGeneration) return null;
    this.mixBuffers = new Map(loaded.map((part) => [part.url, part.buffer]));
    this.startAt = this.context.currentTime + 0.05;
    for (const [id, buffer] of buffers) {
      const duration = Math.min(buffer.duration, end) - offset;
      if (duration <= 0) continue;
      const source = this.context.createBufferSource(),
        gain = this.context.createGain();
      source.buffer = buffer;
      gain.gain.value = this.mixAudible.has(id) ? 1 : 0;
      source.connect(gain);
      gain.connect(this.context.destination);
      source.start(this.startAt, offset, duration);
      this.sources.push(source);
      this.mixGains.set(id, gain);
    }
    return this.startAt;
  }
  renderPractice(data) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(enginePath("render-worker.mjs"), {
        type: "module",
      });
      const job = { cancel: () => finish(null) };
      const finish = (audio, error) => {
        worker.terminate();
        if (this.renderJob === job) this.renderJob = null;
        error ? reject(new Error(error)) : resolve(audio);
      };
      this.renderJob = job;
      worker.onmessage = ({ data }) => finish(data.audio, data.error);
      worker.onerror = () =>
        finish(null, "Could not prepare practice audio. Try a shorter range.");
      worker.postMessage(data);
    });
  }
  async practice(parts, selectedId, start, end, speed, delay = 2) {
    this.stop();
    const generation = this.playGeneration;
    await this.init();
    if (generation !== this.playGeneration) return null;
    const mix = await this.renderPractice({
      parts,
      selectedId,
      start,
      end,
      speed,
    });
    if (!mix || generation !== this.playGeneration) return null;
    const channels = mix.channels || [mix];
    const buffer = this.context.createBuffer(
      channels.length,
      channels[0].length,
      mix.sampleRate || 22050,
    );
    channels.forEach((channel, i) => buffer.copyToChannel(channel, i));
    return this.schedule(buffer, 0, buffer.duration, delay);
  }
}
export const audio = new AudioEngine();
