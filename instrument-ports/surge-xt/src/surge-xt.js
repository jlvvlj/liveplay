// Main-thread loader for the Surge XT worklet instrument.
//
// An AudioWorkletGlobalScope has no fetch, so the files are fetched here and
// handed to each node in processorOptions.
//
//   import { loadSurgeXt, createSurgeXtNode } from './surge-xt.js';
//   const assets = await loadSurgeXt(context);            // once per AudioContext
//   const node = createSurgeXtNode(context, assets);      // one per instrument
//   node.port.onmessage = (e) => { if (e.data.type === 'ready') ... };
//   node.connect(context.destination);

const loads = new WeakMap();

export function loadSurgeXt(context, baseUrl = new URL('.', import.meta.url)) {
  if (!loads.has(context)) {
    const url = (name) => new URL(name, baseUrl).href;
    loads.set(
      context,
      (async () => {
        const [, wasm, data] = await Promise.all([
          context.audioWorklet.addModule(url('surge-xt.worklet.js')),
          fetchOk(url('surge-xt.wasm'))
            .then((response) => response.arrayBuffer())
            .then((bytes) => WebAssembly.compile(bytes)),
          fetchOk(url('surge-xt-data.bin')).then((response) => response.arrayBuffer()),
        ]);
        return { wasm, data };
      })()
    );
  }
  return loads.get(context);
}

export function createSurgeXtNode(context, assets) {
  return new AudioWorkletNode(context, 'melodics-surge-xt', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { wasm: assets.wasm, data: assets.data },
  });
}

async function fetchOk(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`surge-xt: ${url} answered ${response.status}`);
  return response;
}
