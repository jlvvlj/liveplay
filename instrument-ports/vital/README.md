# Vital as an AudioWorklet instrument

Vital's synth engine (its `SoundEngine`, no JUCE and no interface) compiled to
WebAssembly and run in an `AudioWorkletProcessor` named `melodics-vital`.
Stereo, polyphonic, single-threaded, Vital's SSE2 code on wasm SIMD.

- Source: https://github.com/mtytel/vital at
  `636ca0ef517a4db087a6a08a6a8a5e704e21f836` (20 Apr 2022), GPL-3.0-or-later.
  This folder's code is under the same licence. The open-source Vital is
  version 1.0.6.
- Built with emscripten 6.0.13 (Homebrew), with wasm exceptions (nlohmann::json
  reports a preset it cannot read by throwing).

## What is built

- `src/engine.cpp`: the engine as one translation unit, as Vital's own build
  compiles it (`src/unity_build/synthesis.cpp`), then the wavetable and LFO
  shape code that presets carry.
- `shims/`: the few JUCE pieces that code uses (a `String` over `std::string`,
  `Base64`, a memory stream), a `SynthBase` holding the engine, the oscillators'
  wavetable creators and modulation connections, and standard tuning (Vital's
  default; scale files are not built).
- `tools/extract-load-save.mjs`: upstream's preset loading functions
  (`loadControls`, `loadModulations`, `loadWavetables`, `loadSample`,
  `loadLfos`, `updateFromOldVersion` and the version comparisons), taken from
  `src/common/load_save.cpp` unchanged at build time.
- `src/vital_port.cpp`: the port (`common/port.h`). Two source changes, made
  by `build.sh` on a copy:
  - `Sample` gets `getData()` and `adoptData()`, so a prepared sample can move
    between instances.
  - Routers get `prepareAll()`. A router (each voice is one) copies a processor
    added to the graph, such as a preset's feedback loop, the first time it
    runs after the change. The port has every router and voice do that when a
    preset loads, so playing never allocates.

## Presets

528 presets from six free banks, each a `.vital` file the browser fetches when
the preset is played (`dist/presets/<id>.vital`):

| Bank | Commit | Presets | Licence |
| --- | --- | --- | --- |
| [jpriebe/qub1t-vital-presets](https://github.com/jpriebe/qub1t-vital-presets) vol 1 and 2 | `a45e933` | 174 | none stated |
| [nahush2321/Vitalium-presets](https://github.com/nahush2321/Vitalium-presets) | `025728f` | 219 | GPL-3.0 |
| [Mxm40b/vital-presets](https://github.com/Mxm40b/vital-presets) | `c6e8bc1` | 124 | Unlicense |
| [abstractionmage/Vital-Presets](https://github.com/abstractionmage/Vital-Presets) | `023763a` | 8 | CC0 |
| [christ-offer/vitalium-presets](https://github.com/christ-offer/vitalium-presets) | `8c6c93c` | 3 | CC0 |

Each keeps its own name, and its style (Keys, Bass, Lead, Pad, SFX,
Percussion, Sequence, Experiment) as its tag. Left out, as the build prints:

- 21 qub1t vol 2 presets saved by Vital 1.5.1, a newer feature version than
  this engine; upstream's loader refuses them too.
- Mxm40b's `light pluck.vital`, which is not valid JSON (a number in it is
  broken: `0.46231.5.58760071`).
- Two nahush presets that play nothing: `rewrite` has its only oscillator at
  level 0, and `check23` turns its oscillators down with velocity, to nothing.

### Loading off the audio thread

Reading a preset's file takes up to 400 ms, most of it rendering its three
wavetables and preparing its sample, and the audio thread every instrument
shares cannot stop that long. So the app has a second instance of the module
in a Worker, `dist/vital.loader.js`, read each file and pack the result:

1. The app fetches `presets/<id>.vital` and sends it to the loader.
2. The loader loads it as upstream does and returns a pack: the preset's
   settings (its JSON without wavetables and sample, upgraded as upstream
   upgrades older presets), then each oscillator's rendered wavetable data and
   the sample's band-limited buffers.
3. The app sends the pack with the preset message. The worklet reads the
   settings and copies the wavetables and sample in, in 2 to 19 ms.

A pack is 1 to 45 MB, transferred rather than copied. The worklet also reads a
plain `.vital` file, as `catalog.mjs` does when it measures each preset.

## Parameters

33 of Vital's controls. A continuous one is its knob position, 0 to 1, as
Vital's own interface shows it (Vital's curve from knob to sound applies);
voice counts and switches are whole numbers:

- Macros: Macro 1 to 4, which most presets map to their main changes.
- Oscillators: oscillator 1 level, wavetable position, unison voices and
  detune; oscillator 2 level and position; oscillator 3 level.
- Filters: filter 1 cutoff, resonance, drive and mix; filter 2 cutoff and
  resonance.
- Envelope: envelope 1 attack, decay, sustain and release.
- Effects: chorus, delay, distortion and reverb, each on or off with its mix
  (distortion: its drive).
- Voice: polyphony, glide time, velocity tracking and volume.

The tempo for synced LFOs and delays is 120 BPM.

## Build

```sh
./build.sh
```

One command from a clean checkout. It installs emscripten with Homebrew when
it is missing, fetches the pinned Vital commit (only `src/`, its JSON and FFT
libraries: not JUCE, the VST SDK or Firebase) and the banks (only their
presets), and writes `dist/` (git-ignored):

| File | Size | gzip |
| --- | --- | --- |
| `dist/vital.wasm` | 1.4 MB | 345 KB |
| `dist/vital.worklet.js` | 10 KB | 3 KB |
| `dist/vital.loader.js` | 3 KB | 1 KB |
| `dist/presets/*.vital` (528) | 333 MB, median 250 KB, largest 5.2 MB | 209 MB |

A build takes about 35 seconds.

## Check

```sh
node check.mjs          # every 53rd preset
node check.mjs --all
```

`check.mjs` runs `dist/vital.worklet.js` in Node the way an AudioWorklet runs
it. One instance reads each preset's file and packs it, as the loader does;
another loads the pack, as the app's worklet does. Both play the same chord.
The check fails when a preset does not load, its sound is silent (a chord
held for 8 seconds, for the slow risers) or not finite, playing allocates, or
the pack does not sound exactly like the file.

## Demo

```sh
python3 -m http.server -d instrument-ports 8731   # http://127.0.0.1:8731/vital/demo.html
```

## Limits

- Each instance holds its three wavetables, up to 25 MB, and takes about as
  much again while a pack is copied in.
- A 4-note chord renders at 3 to 21% of real time in Node on an M-series Mac,
  depending on the preset (unison and oversampling cost the most).
