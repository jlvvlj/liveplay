# Surge XT as an AudioWorklet instrument

Surge XT's synth engine (`surge-common`, no JUCE and no UI) compiled to WebAssembly
and run in an `AudioWorkletProcessor` named `melodics-surge-xt`. Stereo,
polyphonic, single-threaded, with wasm SIMD.

- Source: https://github.com/surge-synthesizer/surge at
  `d152d7930b0b3a28ca9cbb61fc6851017d3ac8b6` (5 Nov 2026), GPL-3.0-or-later.
  This folder's code is under the same licence.
- Built with emscripten 6.0.13 (Homebrew), block size 32 (Surge's own default).

## Build

```sh
./build.sh
```

One command from a clean checkout. It installs emscripten with Homebrew when
`emcc` is missing, fetches the pinned Surge commit and only the submodules
`surge-common` needs into `build/surge`, applies the two patches in `patches/`,
builds with CMake and Ninja into `build/wasm`, and writes `dist/` (git-ignored):

| File | Size | gzip |
| --- | --- | --- |
| `dist/surge-xt.wasm` | 5.7 MB | 1.6 MB |
| `dist/surge-xt.worklet.js` | 75 KB | 21 KB |
| `dist/surge-xt-data.bin` | 29.4 MB | 11.6 MB |
| `dist/surge-xt.js` | 2 KB | 1 KB |

A first build takes about 4 minutes; later ones rebuild only what changed.
`SURGE_BLOCK_SIZE=8 ./build.sh` builds with Surge's smaller block (notes land
within 4 samples instead of 16, for about twice the CPU).

## Check

```sh
node check.mjs
node check.mjs --all    # also plays a chord on every preset
```

`check.mjs` runs `dist/surge-xt.worklet.js` in Node the way an AudioWorklet runs
it (a scope with no `fetch`, `TextDecoder`, `performance` or `crypto`) and fails
on silence or NaN in one second of a note. It also checks that a note lands on
the engine block nearest its time, that parameters take effect, that a chosen
wavetable changes the sound and "Patch's own" gives it back (type and modulation
included), that each preset's listed values are what loading it gives, and that
`process()` never
allocates: the engine's `operator new` counts calls made while it renders, and
the heap must not grow.

## Demo

```sh
node tools/serve.mjs    # http://localhost:5178/demo.html
```

Plays from the on-screen keys or the computer keyboard (A W S E D F T G Y H U J K
O L P ;, with Z and X for octaves), with the preset menu, a slider for every
parameter and a list for each oscillator's wavetable.

## Using it

```js
import { loadSurgeXt, createSurgeXtNode } from './dist/surge-xt.js';

const assets = await loadSurgeXt(context);         // once per AudioContext
const node = createSurgeXtNode(context, assets);   // one per instrument
node.port.onmessage = ({ data }) => { if (data.type === 'ready') { /* data.params, data.presets */ } };
node.connect(context.destination);
node.port.postMessage({ type: 'noteOn', note: 60, velocity: 100, time: context.currentTime });
```

An `AudioWorkletGlobalScope` has no `fetch`, so `loadSurgeXt` adds the worklet
module, fetches the wasm (compiled once, as a `WebAssembly.Module`) and the data
bundle, and `createSurgeXtNode` hands both to the processor in
`processorOptions: { wasm, data }`. Each node is its own engine: about 55 MB of
wasm memory once started, plus a copy of each oscillator's own setup once a
wavetable replaces it.

In an `OfflineAudioContext`, port messages are not delivered while it renders:
suspend it at its first quantum, post the notes with their times, then resume.

## Protocol

In:

- `{type:'noteOn', note, velocity, time}`: velocity 1-127, `time` in AudioContext
  seconds. A note starts on the edge of the 32-sample engine block nearest its
  time (within 16 samples, 0.33 ms at 48 kHz); times already past play at once.
- `{type:'noteOff', note, time}`
- `{type:'allOff'}`: releases every note and drops pending ones.
- `{type:'param', key, value}`
- `{type:'preset', id}`

Out:

- `{type:'ready', params, presets}` once the engine is up. Parameter and preset
  messages sent before it are applied then; notes sent before it are dropped.
  - `params: [{key, label, min, max, step, default, group, options?}]`; `default`
    is the value in the init patch (Templates/Init Saw), which is loaded at
    start. A param with `options` is a choice: its value is the option's index.
  - `presets: [{id, name, tag, params}]`; `id` is `Category/Name`, `tag` the
    category, `params` the preset's parameter values where they differ from the
    defaults, so sliders can follow a preset change.
- `{type:'error', message}` if the engine cannot start.

## Parameters (55)

Continuous parameters are Surge's own 0-1 range; the octaves are -3 to 3; the
wavetables are choices. They act on scene A, which is the only scene in most
factory patches.

| Group | Keys |
| --- | --- |
| Macros | `macro1` ... `macro8` |
| Oscillators | `osc1_octave` `osc1_pitch` `osc2_octave` `osc2_pitch` `osc3_octave` `osc3_pitch` `osc1_wavetable` `osc2_wavetable` `osc3_wavetable` `osc1_level` `osc2_level` `osc3_level` `noise_level` `fm_depth` `drift` |
| Filters | `filter1_cutoff` `filter1_resonance` `filter1_envmod` `filter1_keytrack` `filter2_cutoff` `filter2_resonance` `filter2_envmod` `filter2_keytrack` `filter_balance` `waveshaper_drive` `highpass` |
| Envelopes | `amp_attack` `amp_decay` `amp_sustain` `amp_release` `filter_attack` `filter_decay` `filter_sustain` `filter_release` |
| Effects | `fx_a1_mix` `fx_a2_mix` `fx_send1_mix` `fx_send2_mix` `fx_global1_mix` `fx_global2_mix` `send1_level` `send2_level` `send1_return` `send2_return` |
| Output | `scene_volume` `scene_width` `volume` |

- `oscN_wavetable` has 189 options: 0 is "Patch's own", the oscillator exactly as
  the preset loaded it, and 1-188 are the factory wavetables, labelled
  `Folder/Name` (`Basic/Sine`). Every preset lists 0.
  - Choosing a wavetable on an oscillator that is not a Wavetable or Window
    oscillator makes it a Wavetable oscillator. Surge clears the modulation on an
    oscillator's settings when its type changes; it is put back, at the same share
    of each setting's range, on the settings that can still be modulated.
  - Before an oscillator first leaves its own setup, its type, settings,
    wavetable and modulation are copied aside; choosing 0 puts all of them back.
  - The table is loaded and the type changed on the message, before the next
    block, never inside `process()`.
- A muted oscillator or noise source reads as level 0; raising its level unmutes it.
- `fx_*_mix` sets the Mix of whatever effect is in that slot; an empty slot has none.
- A preset load resets the global `volume` first, since patches saved before
  Surge's streaming revision 17 do not carry one.

## Presets (618)

All 641 factory patches except those that cannot sound right here: the 3
Vocoder patches and 4 "Audio In" templates (they need audio input), and the 16
that route a Formula modulator (the 14 Formula Modulator tutorials, Init
Arpeggiator and Init Duophonic). Formula modulators and scripted wavetables run
Lua through LuaJIT, which has no WebAssembly build, and this port leaves Lua out
entirely (no substitute Lua). `check.mjs --all` fails if a listed preset still
routes a formula.

Per category: Basses 59, Brass 11, Chords 8, FX 27, Keys 16, Leads 131, MPE 9,
Pads 65, Percussion 9, Plucks 111, Polysynths 104, Sequences 45, Splits 5,
Templates 10, Winds 8.

The data bundle also carries the 188 factory wavetables (`.wt`, `.wav`) the
`oscN_wavetable` choices load. The 13 scripted wavetables (`.wtscript`, Lua) are
left out.

## How it is put together

- `build.sh` configures Surge's own CMake with `SURGE_SKIP_JUCE_FOR_RACK`,
  `SURGE_SKIP_LUA`, `SURGE_SKIP_ODDSOUND_MTS` and the 32-bit Linux switch (wasm32),
  and adds the `surge-xt-engine` target through `CMAKE_PROJECT_Surge_INCLUDE`
  (`cmake/`). SSE code compiles through emscripten's SSE-to-wasm-SIMD headers
  (`-msse4.1 -msimd128`); exceptions are native wasm exceptions.
- `src/surge_wasm.cpp`: the C interface (init, render one block, notes, presets,
  parameters, wavetable choices). Patch loads, effect changes, wavetable loads,
  oscillator type changes and parameter sets run in the message calls, where
  Surge would otherwise spawn a loading thread from its audio loop.
- `src/worklet.js`: the processor. Timed notes wait in preallocated typed arrays
  and go to the engine block by block; the output is copied out of the wasm heap.
- `src/worklet-scope.js`: the engine's clock and random seeds from `Date.now()`
  and `Math.random()`, since a worklet scope has no `performance` or `crypto`.
- `patches/surge.patch`: seeds each voice's MSEG random generator from one
  generator, since `std::random_device` allocates on wasm32 at every note.
- `patches/sst-plugininfra.patch`: no x86 CPU feature probing, stack traces or
  shared-object path under emscripten.
- `tools/pack-data.mjs` packs the patches, wavetables and `preset-values.json`
  (written by `tools/preset-values.mjs` from the built engine) into
  `surge-xt-data.bin`, which the worklet unpacks into its in-memory filesystem.
