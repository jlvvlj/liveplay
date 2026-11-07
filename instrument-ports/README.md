# Instrument ports

Synths with no web build, compiled from their own C++ to WebAssembly and run as AudioWorklets, for the live instrument engine.

| Folder | What | Processors | Licence |
| --- | --- | --- | --- |
| `mutable/` | Mutable Instruments Plaits, Rings, Elements, Braids (instruments) and Clouds (effect) | `melodics-plaits`, `melodics-rings`, `melodics-elements`, `melodics-braids`, `melodics-clouds` | MIT |
| `obxf/` | OB-Xf | `melodics-obxf` | GPL-3.0 |
| `dexed/` | Dexed (MSFA engine, Dexed's filter and tuning, its bundled cartridges) | `melodics-dexed` | GPL-3.0, MSFA Apache-2.0 |
| `helm/` | Helm (`mopo` engine, factory patches) | `melodics-helm` | GPL-3.0, patches CC BY 4.0 |
| `surge-xt/` | Surge XT (`surge-common`, factory patches and wavetables) | `melodics-surge-xt` | GPL-3.0 |
| `vital/` | Vital (its `SoundEngine`; 536 presets from free banks, fetched when played) | `melodics-vital` | GPL-3.0; banks GPL-3.0, CC0, Unlicense, one unstated |

Each folder has:

- `fetch.sh`: the upstream source at a pinned commit, into `upstream/` (git-ignored)
- `build.sh`: one command from a clean checkout; installs emscripten with Homebrew when it is missing, fetches, compiles, and writes `dist/<name>.wasm` and `dist/<name>.worklet.js` (git-ignored)
- `check.sh`: renders notes through the built wasm in Node and fails when the sound is silent, has NaN, or allocates while playing
- `demo.html`: plays the port from the computer keyboard (A W S E D F T G Y H U J K O L P ; ', Z and X for octaves) or the on-screen keys, its parameters as sliders and its presets as a menu. Serve this folder and open it: `python3 -m http.server -d instrument-ports 8731`, then `http://127.0.0.1:8731/dexed/demo.html`
- `README.md`: source commit, what is built, parameters, presets, sizes

```sh
instrument-ports/mutable/build.sh && instrument-ports/mutable/check.sh
instrument-ports/obxf/build.sh && instrument-ports/obxf/check.sh
instrument-ports/dexed/build.sh && instrument-ports/dexed/check.sh
instrument-ports/helm/build.sh && instrument-ports/helm/check.sh
instrument-ports/surge-xt/build.sh && node instrument-ports/surge-xt/check.mjs
instrument-ports/vital/build.sh && node instrument-ports/vital/check.mjs
```

## Using a worklet

```js
await context.audioWorklet.addModule('dexed.worklet.js');
const wasm = await (await fetch('dexed.wasm')).arrayBuffer();
const node = new AudioWorkletNode(context, 'melodics-dexed', {
  numberOfInputs: 0, // 1 for an effect (Clouds)
  outputChannelCount: [2],
  processorOptions: { wasm }, // the bytes, or a compiled WebAssembly.Module
});
node.port.onmessage = ({ data }) => {
  if (data.type === 'ready') console.log(data.params, data.presets);
};
node.port.postMessage({ type: 'noteOn', note: 60, velocity: 100, time: context.currentTime });
```

Messages in:

- `{type:'noteOn', note, velocity, time}`: velocity 1-127, `time` in the AudioContext's seconds; applied at its own sample inside the block (a past time plays at once)
- `{type:'noteOff', note, time}`
- `{type:'allOff'}`: releases every voice and drops notes not yet played
- `{type:'param', key, value}`: a value between the parameter's `min` and `max` (a choice's option index)
- `{type:'preset', id, data?}`: `data` is the preset's file, for a port whose presets are files (Vital: see `vital/README.md`)

Messages out:

- `{type:'ready', params:[{key,label,min,max,step,default}], presets:[{id,name}]}` once the module has started. Parameters may also carry `group` (a heading) and `options` (a choice's names), presets a `tag` (Lead, Pad, Bass...), as the app's `ParamSpec` and `Preset` do.
- `{type:'presetLoaded', id, values:{key: value}}` after each `preset`, with every parameter's new value, so sliders can follow
- `{type:'error', message}` when the module cannot start, or a preset cannot be loaded

Nothing is allocated in `process()`: notes wait in fixed typed arrays, and the C++ side allocates only while starting (and, for Helm, while loading a preset). Every C++ allocation is counted (`mp_allocations`), and the checks fail if one happens while playing.

## Shared files

- `common/port.h`, `common/port.cpp`: the C exports every port links (`mp_init`, `mp_render`, `mp_note_on`...), the description sent with `ready`, the allocation counter
- `common/worklet.template.js`: the AudioWorkletProcessor; `build-lib.sh` writes it per port with the processor's name
- `common/build-lib.sh`: emscripten flags (standalone wasm, no file system, no exceptions, SIMD) and build steps
- `common/check.mjs`: the Node check (`node common/check.mjs <dist> <name> [--effect] [--presets all] [--preset id] [--param key=value] [--wav out.wav]`)
- `common/demo.js`, `common/demo.css`: the demo page
- `common/fetch.sh`, `common/fetch-submodule.sh`: pinned fetches
