# Dexed

Dexed's DX7 engine as an AudioWorklet instrument: processor `melodics-dexed`.

- Source: [asb2m10/dexed](https://github.com/asb2m10/dexed) at `fea2f0f0f2c397799f59b27eb11c038cd34b22c5` (pinned in `fetch.sh`)
- Build: `./build.sh` (fetches the source, installs emscripten with Homebrew when missing, writes `dist/dexed.wasm` and `dist/dexed.worklet.js`)
- Check: `./check.sh` (plays every bundled voice through the wasm in Node; fails on silence, NaN or allocation while playing)
- Demo: serve `instrument-ports/` (for example `python3 -m http.server -d instrument-ports`) and open `dexed/demo.html`

## What is built

- The MSFA engine (`source/msfa`: dx7note, env, exp2, fm_core, fm_op_kernel, freqlut, lfo, pitchenv, porta, sin) with Dexed's three cores: Modern (MSFA), Mark I and OPL (`source/engine`).
- Dexed's output filter, gain and DC filter (`source/PluginFx.cpp`) and its standard tuning with master tune.
- Dexed's voice handling from `PluginProcessor.cpp`: 16 voices, its stealing preference (free voice, then released, then same pitch, then oldest), oscillator key sync, phase transfer between equal pitches, and mono mode with its legato state transfer.
- Every voice of the 33 bundled cartridges in `assets/builtin_pgm.zip` (Dexed_01 and SynprezFM_01 to 32), unpacked at build time the way Dexed's `Cartridge::unpackProgram` reads them.

No JUCE code is built. Small headers in `shim/` stand in for the three things the engine files include: JUCE's `pi` (PluginFx), its memory logger (no logging), and the MTS-ESP client (never a master in a browser). `PLUGINPROCESSOR_H_INCLUDED` keeps `PluginFx.cpp` from reading the plugin header.

### Differences from the plugin

- Notes start on their exact sample: each voice runs its 64-sample blocks from its own note-on. The LFO still ticks every 64 samples for all voices, as in Dexed.
- A voice taken from a sounding note hands its sound to a 3 ms fade-out instead of restarting from silence; `allOff` fades too.
- Note-offs find the voice by the key that started it, so a transpose change during a held note cannot leave it stuck.
- Only standard tuning: loading `.scl`/`.kbm` scales is not built (it needs files and the tuning library's exceptions). MTS-ESP retuning does not exist in a browser.
- Not built: sysex I/O, MIDI CC mapping, mod wheel / breath / foot / aftertouch routing, pitch bend, portamento and sustain pedal, since the worklet protocol carries notes only.

## Parameters (157)

| Group | Parameters |
| --- | --- |
| Dexed | Engine (Modern, Mark I, OPL), Voices (Poly, Mono), Cutoff, Resonance, Output, Master tune (±1 semitone) |
| Voice | Algorithm 1-32, Feedback 0-7, Oscillator key sync, Transpose ±24, Pitch mod sensitivity 0-7 |
| LFO | Wave, Rate, Delay, Pitch depth, Amp depth, Key sync |
| Pitch EG | Rate 1-4, Level 1-4 |
| Operator 1-6 | On, Output level, Frequency mode, Coarse, Fine, Detune ±7, EG rate 1-4, EG level 1-4, Velocity sensitivity, Amp mod sensitivity, Rate scaling, Breakpoint, Left/Right depth, Left/Right curve |

Voice parameters are the DX7's own values. Loading a preset sets all voice parameters (the Dexed group keeps its settings) and the worklet answers with `presetLoaded` carrying every value. The defaults in `ready` are the voice Dexed starts with (Dexed_01, voice 1).

## Presets (1056)

Ids are `<cartridge>/<voice>` (`Dexed_01/1` … `SynprezFM_32/32`); names are the voice name with its cartridge, for example `E.-PIANO (SynprezFM 02)`. At note 60 every voice sounds except `AT&T- RING (SynprezFM 17)`.

## Sizes and speed

- `dexed.wasm`: 306,058 bytes (146,826 gzipped), of which the cartridges are about 165 KB
- `dexed.worklet.js`: 9,452 bytes
- One held note renders about 200 times faster than real time in Node on an Apple Silicon Mac.

## Licences

Dexed is GPL-3.0; the MSFA engine (`source/msfa`) is Apache-2.0. The bundled cartridges come with Dexed: Dexed_01 and the SynprezFM collection compiled by Jean-Marc Desprez (credited in Dexed's README).
