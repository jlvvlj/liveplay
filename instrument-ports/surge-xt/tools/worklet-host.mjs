// Runs dist/surge-xt.worklet.js in Node the way an AudioWorklet runs it: in a
// scope with only the language built-ins, registerProcessor,
// AudioWorkletProcessor (with a port), sampleRate and currentTime. No fetch,
// TextDecoder, performance or window.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

export const SAMPLE_RATE = 48000;
const QUANTUM = 128;

export async function startProcessor(dist, data = readFileSync(join(dist, 'surge-xt-data.bin'))) {
  const processors = new Map();
  const scope = {
    sampleRate: SAMPLE_RATE,
    currentTime: 0,
    currentFrame: 0,
    console,
    WebAssembly,
    registerProcessor: (name, ctor) => processors.set(name, ctor),
    AudioWorkletProcessor: class {
      constructor() {
        this.port = {
          onmessage: null,
          sent: [],
          postMessage: (message) => this.port.sent.push(message),
          deliver: (data) => this.port.onmessage?.({ data }),
        };
      }
    },
  };
  vm.createContext(scope);
  vm.runInContext(readFileSync(join(dist, 'surge-xt.worklet.js'), 'utf8'), scope, {
    filename: 'surge-xt.worklet.js',
  });
  const Processor = processors.get('melodics-surge-xt');
  if (!Processor) throw new Error('melodics-surge-xt was not registered');

  const wasm = await WebAssembly.compile(readFileSync(join(dist, 'surge-xt.wasm')));
  const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const started = performance.now();
  const processor = new Processor({ processorOptions: { wasm, data: bytes } });
  const ready = await waitFor(processor, (m) => m.type === 'ready' || m.type === 'error');
  if (ready.type === 'error') throw new Error(`worklet error: ${ready.message}`);
  return { scope, processor, ready, startMs: performance.now() - started };
}

async function waitFor(processor, test) {
  for (let i = 0; i < 4000; i++) {
    const found = processor.port.sent.find(test);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for the worklet');
}

// Renders `seconds` of audio, quantum by quantum. `events` are [frame, message]
// pairs, sent before the quantum that holds the frame, with its exact time.
// Reports whether the engine heap grew during any process() call.
export function render(scope, processor, seconds, events = []) {
  const frames = Math.round(seconds * SAMPLE_RATE);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const outL = new Float32Array(QUANTUM);
  const outR = new Float32Array(QUANTUM);
  const pending = [...events];
  const start = scope.currentFrame;
  let cpuMs = 0;
  let grew = false;
  for (let f = 0; f < frames; f += QUANTUM) {
    scope.currentFrame = start + f;
    scope.currentTime = scope.currentFrame / SAMPLE_RATE;
    while (pending.length && pending[0][0] < f + QUANTUM) {
      const [frame, message] = pending.shift();
      processor.port.deliver({ ...message, time: (start + frame) / SAMPLE_RATE });
    }
    outL.fill(0);
    outR.fill(0);
    const heap = processor.engine.HEAPU8.length;
    const t0 = performance.now();
    processor.process([], [[outL, outR]], {});
    cpuMs += performance.now() - t0;
    if (processor.engine.HEAPU8.length !== heap) grew = true;
    const n = Math.min(QUANTUM, frames - f);
    left.set(outL.subarray(0, n), f);
    right.set(outR.subarray(0, n), f);
  }
  scope.currentFrame = start + frames;
  return { left, right, cpuMs, grew };
}

export function measure({ left, right }) {
  let peak = 0;
  let sum = 0;
  let nan = false;
  for (const ch of [left, right]) {
    for (const x of ch) {
      if (!Number.isFinite(x)) nan = true;
      else {
        peak = Math.max(peak, Math.abs(x));
        sum += x * x;
      }
    }
  }
  return { peak, rms: Math.sqrt(sum / (left.length * 2)), nan };
}
