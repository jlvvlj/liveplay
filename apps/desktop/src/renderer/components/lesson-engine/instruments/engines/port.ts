import * as Tone from 'tone';
import { JAM_SOUND_LOUDNESS } from '../../jamLoudness';
import type { LiveInstrument, ParamSpec, ParamValues } from '../types';

// Synths compiled from their own C++ to WebAssembly (instrument-ports/):
// Surge XT, OB-Xf, Dexed, Helm, Vital and Mutable Instruments' modules, each
// an AudioWorklet that takes notes, parameters and presets as messages. Their
// files and catalog (instrument-ports/catalog.mjs) are served under
// /instrument-ports/.

export const PORTS_URL = '/instrument-ports/';

// One port as the catalog lists it
export interface PortEntry {
  name: string;
  label: string;
  effect: boolean;
  // `presets`: where each preset's file is (its id in place of {id}), for a
  // port whose presets are fetched when played; `loader`: the Worker that
  // reads such a file for the worklet
  files: { worklet: string; wasm: string; data?: string; presets?: string; loader?: string };
  params: ParamSpec[];
  // `raw`: the id the port knows the preset by; `loudness`: dB RMS of a note
  // of the preset (instruments only)
  presets: { id: string; raw: string | number; name: string; tag?: string; params: ParamValues; loudness?: number }[];
  // dB RMS of a note as the port starts (instruments only)
  loudness?: number;
}

// The catalog, or none where the ports were not built (a development
// checkout without them: npm run ports:catalog)
export async function loadPortCatalog(): Promise<PortEntry[]> {
  const response = await fetch(`${PORTS_URL}catalog.json`);
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Instrument ports catalog: HTTP ${response.status}`);
  return ((await response.json()) as { ports: PortEntry[] }).ports;
}

// A port's files fetched and its wasm compiled, once per port; its worklet
// module added once per audio context
const files = new Map<string, Promise<{ wasm: WebAssembly.Module; data?: ArrayBuffer }>>();
const modules = new WeakMap<object, Map<string, Promise<void>>>();
function loadPort(entry: PortEntry) {
  const url = (file: string) => `${PORTS_URL}${entry.name}/${file}`;
  if (!files.has(entry.name)) {
    const fetchOk = async (file: string) => {
      const response = await fetch(url(file));
      if (!response.ok) throw new Error(`${entry.label}: ${file} answered HTTP ${response.status}`);
      return response.arrayBuffer();
    };
    files.set(
      entry.name,
      Promise.all([
        fetchOk(entry.files.wasm).then((bytes) => WebAssembly.compile(bytes)),
        entry.files.data ? fetchOk(entry.files.data) : Promise.resolve(undefined),
      ]).then(([wasm, data]) => ({ wasm, data }))
    );
  }
  const raw = Tone.getContext().rawContext as unknown as BaseAudioContext;
  const added = modules.get(raw) ?? new Map<string, Promise<void>>();
  modules.set(raw, added);
  if (!added.has(entry.name)) added.set(entry.name, raw.audioWorklet.addModule(url(entry.files.worklet)));
  return Promise.all([files.get(entry.name)!, added.get(entry.name)!]).then(([loaded]) => loaded);
}

// A port's node, its messages answered: resolves once it has started
async function portNode(entry: PortEntry, inputs: number): Promise<AudioWorkletNode> {
  const { wasm, data } = await loadPort(entry);
  const node = Tone.getContext().createAudioWorkletNode(`melodics-${entry.name}`, {
    numberOfInputs: inputs,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { wasm, ...(data ? { data } : {}) },
  }) as unknown as AudioWorkletNode;
  await new Promise<void>((resolve, reject) => {
    let started = false;
    node.port.onmessage = ({ data: message }) => {
      if (message.type === 'ready') {
        started = true;
        resolve();
      } else if (message.type === 'error') {
        // After it has started, a preset that could not be loaded
        if (started) console.error(`[PortInstrument] ${entry.label}: ${message.message}`);
        else reject(new Error(`${entry.label}: ${message.message}`));
      }
    };
  });
  return node;
}

// For a port whose presets are files (Vital): its loader Worker, one per port,
// with its own instance of the port's module. It reads a preset's file and
// packs it, so the worklet only copies the result in: reading takes up to
// half a second, which the audio thread every instrument shares cannot spare.
const loaders = new Map<string, { worker: Worker; waiting: Map<number, (answer: { type: string; data?: ArrayBuffer; message?: string }) => void> }>();
let loaderRequests = 0;
async function presetLoader(entry: PortEntry) {
  const existing = loaders.get(entry.name);
  if (existing) return existing;
  const { wasm } = await loadPort(entry);
  if (loaders.has(entry.name)) return loaders.get(entry.name)!;
  const worker = new Worker(`${PORTS_URL}${entry.name}/${entry.files.loader}`);
  const loader = { worker, waiting: new Map() };
  worker.onmessage = ({ data: answer }) => {
    loader.waiting.get(answer.id)?.(answer);
    loader.waiting.delete(answer.id);
  };
  worker.postMessage({ type: 'start', wasm, sampleRate: Tone.getContext().sampleRate });
  loaders.set(entry.name, loader);
  return loader;
}

// A preset's file, fetched and packed by the port's loader
async function presetData(entry: PortEntry, raw: string | number): Promise<ArrayBuffer> {
  const file = entry.files.presets!.replace('{id}', String(raw));
  const [response, loader] = await Promise.all([fetch(`${PORTS_URL}${entry.name}/${file}`), presetLoader(entry)]);
  if (!response.ok) throw new Error(`${entry.label}: ${file} answered HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  const id = ++loaderRequests;
  const answer = await new Promise<{ type: string; data?: ArrayBuffer; message?: string }>((resolve) => {
    loader.waiting.set(id, resolve);
    loader.worker.postMessage({ type: 'pack', id, data: bytes }, [bytes]);
  });
  if (answer.type !== 'packed' || !answer.data) throw new Error(`${entry.label}: ${file}: ${answer.message}`);
  return answer.data;
}

// What a port's node is sent, in order: a preset whose file is fetched first
// holds back the messages after it. A preset chosen while an earlier one is
// still being fetched replaces it.
export class PortSender {
  private queue = Promise.resolve();
  private presets = 0;

  constructor(
    private readonly entry: PortEntry,
    private readonly node: () => Pick<AudioWorkletNode, 'port'> | null,
    private readonly fetchPreset: (entry: PortEntry, raw: string | number) => Promise<ArrayBuffer> = presetData
  ) {}

  // Resolves once every message sent so far has been delivered or dropped
  settled() {
    return this.queue;
  }

  send(message: { type: string; id?: string | number }) {
    if (message.type !== 'preset' || !this.entry.files.presets) {
      this.queue = this.queue.then(() => this.node()?.port.postMessage(message));
      return;
    }
    const number = ++this.presets;
    const data = this.fetchPreset(this.entry, message.id!);
    this.queue = this.queue
      .then(() => data)
      .then((packed) => {
        if (number === this.presets) this.node()?.port.postMessage({ ...message, data: packed }, [packed]);
      })
      .catch((err) => console.error(`[PortInstrument] ${this.entry.label} preset ${message.id}:`, err));
  }
}

// What a port's node is sent: a preset, then each parameter that differs from
// what the port holds (after a preset, that preset's values)
export class PortControl {
  private preset: string | null = null;
  private held: ParamValues;

  constructor(
    private readonly entry: PortEntry,
    private readonly send: (message: object) => void
  ) {
    this.held = Object.fromEntries(entry.params.map((spec) => [spec.key, spec.default]));
  }

  set(preset: string | null, params: ParamValues) {
    if (preset !== null && preset !== this.preset) {
      const chosen = this.entry.presets.find((candidate) => candidate.id === preset);
      if (chosen) {
        this.send({ type: 'preset', id: chosen.raw });
        this.held = { ...Object.fromEntries(this.entry.params.map((spec) => [spec.key, spec.default])), ...chosen.params };
      }
      this.preset = preset;
    }
    for (const spec of this.entry.params) {
      const value = params[spec.key] ?? spec.default;
      if (this.held[spec.key] === value) continue;
      this.send({ type: 'param', key: spec.key, value });
      this.held[spec.key] = value;
    }
  }
}

// The gain that brings a note of the port's preset (or of the port as it
// starts) to the Jam's other instruments' level; a quiet preset is raised by
// 12 dB at most, its note perhaps only slow to rise
const MAX_BOOST_DB = 12;
export function portGain(entry: PortEntry, preset: string | null): number {
  const loudness = entry.presets.find((candidate) => candidate.id === preset)?.loudness ?? entry.loudness;
  if (loudness === undefined) return 1;
  return 10 ** (Math.min(MAX_BOOST_DB, JAM_SOUND_LOUDNESS - loudness) / 20);
}

export class PortInstrument implements LiveInstrument {
  readonly output = new Tone.Gain();
  readonly ready: Promise<void>;
  private node: AudioWorkletNode | null = null;
  private readonly control: PortControl;
  private preset: string | null;
  private params: ParamValues;
  private disposed = false;

  constructor(private readonly entry: PortEntry, params: ParamValues, preset: string | null) {
    this.preset = preset;
    this.params = params;
    this.output.gain.value = portGain(entry, preset);
    const sender = new PortSender(entry, () => this.node);
    this.control = new PortControl(entry, (message) => sender.send(message as { type: string }));
    this.ready = this.start();
  }

  private async start() {
    const node = await portNode(this.entry, 0);
    if (this.disposed) {
      node.port.postMessage({ type: 'allOff' });
      return;
    }
    this.node = node;
    Tone.connect(node as unknown as Tone.OutputNode, this.output);
    this.control.set(this.preset, this.params);
  }

  setPreset(preset: string) {
    this.preset = preset;
    this.output.gain.value = portGain(this.entry, preset);
  }

  setParams(params: ParamValues) {
    this.params = params;
    if (this.node) this.control.set(this.preset, params);
  }

  noteOn(note: number, velocity: number, time: number) {
    this.node?.port.postMessage({ type: 'noteOn', note, velocity, time });
  }

  noteOff(note: number, time: number) {
    this.node?.port.postMessage({ type: 'noteOff', note, time });
  }

  allOff() {
    this.node?.port.postMessage({ type: 'allOff' });
  }

  dispose() {
    this.disposed = true;
    this.allOff();
    this.node?.disconnect();
    this.output.dispose();
  }
}

// A port that is an effect (Clouds): audio through it, its parameters and
// presets set as an instrument's are. It passes the sound through unchanged
// until it has loaded.
export class PortEffect {
  readonly input = new Tone.Gain();
  readonly output = new Tone.Gain();
  private node: AudioWorkletNode | null = null;
  private readonly control: PortControl;
  private params: ParamValues = {};
  private disposed = false;

  constructor(private readonly entry: PortEntry) {
    this.input.connect(this.output);
    this.control = new PortControl(entry, (message) => this.node?.port.postMessage(message));
    void this.start();
  }

  private async start() {
    try {
      const node = await portNode(this.entry, 1);
      if (this.disposed) return;
      this.node = node;
      this.input.disconnect();
      Tone.connect(this.input, node as unknown as Tone.InputNode);
      Tone.connect(node as unknown as Tone.OutputNode, this.output);
      this.control.set(null, this.params);
    } catch (err) {
      console.error(`[PortEffect] ${this.entry.label} could not start:`, err);
    }
  }

  set(params: ParamValues) {
    this.params = params;
    if (this.node) this.control.set(null, params);
  }

  dispose() {
    this.disposed = true;
    this.node?.disconnect();
    this.input.dispose();
    this.output.dispose();
  }
}
