# Helm

Matt Tytel's [Helm](https://github.com/mtytel/helm) as a WebAssembly AudioWorklet: its `HelmEngine` and the `mopo` synthesis library it runs on, without JUCE, and its 274 factory patches.

| | |
| --- | --- |
| Source | `mtytel/helm` at `abdedd527e6e1cf86636f0f1e8a3e75b06ed166a` (fetched by `fetch.sh`) |
| Build | `./build.sh` (Homebrew emscripten, installed when missing) |
| Check | `./check.sh` |
| Output | `dist/helm.wasm` (576,600 bytes, 187 KB gzipped), `dist/helm.worklet.js` (9.4 KB) |
| Processor | `melodics-helm`, no inputs, stereo out |
| Parameters | 139 |
| Presets | 274 (Helm's factory patches) |
| CPU | about 130x realtime for one held note on the default patch (Node, Apple silicon) |
| Memory | 24.5 MB at start; each voice's stutter takes 1 MB once the stutter is on (33 MB in all), and preset loads clone their modulation routings into the voices (about 61 MB after loading every factory patch) |

## What is built

- `mopo/src/*.cpp`, `src/synthesis/*.cpp` and `src/common/helm_common.cpp`: the engine, unchanged apart from the three edits below. None of them include JUCE.
- `port.cpp`: the port interface (`../common/port.h`).
- `convert-presets.mjs`: reads the factory `.helm` files at build time into `build/presets.inc`, applying the same upgrades Helm's `LoadSave::varToState` applies to patches saved by older versions (9 of them).

`build.sh` copies `mopo/src` into `build/mopo` and makes three edits there, each checked so a changed upstream stops the build:

1. `arpeggiator.h`: its `std::map` of held notes and its three `std::vector`s become containers with fixed room for every note (`shims/arp_containers.h`), so the arpeggiator does not allocate when notes are played.
2. `ProcessorRouter::visitAll` and `VoiceHandler::visitAll` (`shims/*.inc`): mopo clones a newly connected modulation into each voice the first time that voice plays, and each voice's stutter allocates its memory the first time it runs. The port calls `visitAll` when a preset loads or the stutter is switched on, so both happen then and never while playing.
3. `Stutter::allocateMemory`, used by the above.

## Behaviour

- Notes: `HelmEngine::noteOn` and `noteOff`, velocity 1-127 as 0-1. Helm's envelopes run once per processing block, starting with the block after the note; the port renders a one-sample block right after a note on, so a note sounds from the sample it is scheduled at.
- Polyphony as Helm: up to 32 voices, limited by the Polyphony parameter. A note over the limit takes a free voice and mopo fades the voice it replaces over 20 ms (`VOICE_KILL_TIME`); legato and portamento as Helm.
- `allOff` releases every voice (`HelmEngine::allNotesOff`).
- A preset sets every control to the patch's value or its default and replaces all modulation routings with the patch's, as Helm does when it opens a patch. Values are set as stored, so the few patches that store a value past a control's range (for example a distortion drive of 63 dB) keep it, and `presetLoaded` reports it.
- Not reachable through the message protocol: pitch bend, mod wheel, aftertouch and sustain pedal (the Pitch Bend Range parameter is listed but has no effect without pitch bend), and the host tempo: the Tempo parameter (beats per minute; Helm stores beats per second) drives the synced LFOs, delay, stutter and arpeggiator.

## Parameters

All of Helm's controls, with the ranges, steps and defaults of its parameter list (`helm_common.cpp`), in Helm's units (envelope times and volumes are the raw control values Helm stores, as in its patch files). Controls with named values are choices.

| Group | Count | Parameters |
| --- | --- | --- |
| Oscillator 1 | 7 | Transpose, Tune, Unison Detune, Unison Voices, Volume, Waveform (11), Harmonize |
| Oscillator 2 | 7 | as Oscillator 1 |
| Oscillators | 4 | Cross Mod, Feedback Amount, Feedback Transpose, Feedback Tune |
| Sub & noise | 5 | Noise Volume, Shuffle, Sub Octave Down, Volume, Waveform (11) |
| Filter | 9 | Cutoff, Env Depth, Drive, Blend, Style (12 dB, 24 dB, Shelf), Shelf (3), On, Key Track, Resonance |
| Filter envelope | 4 | Attack, Decay, Release, Sustain |
| Amp envelope | 4 | Attack, Decay, Release, Sustain |
| Mod envelope | 4 | Attack, Decay, Release, Sustain |
| Formant | 3 | On, X, Y |
| Mono LFO 1, Mono LFO 2 | 6 each | Amp, Frequency, Retrigger (3), Sync (4), Tempo (12), Waveform (13) |
| Poly LFO | 5 | Amp, Frequency, Sync (4), Tempo (12), Waveform (13) |
| Step sequencer | 38 | Num Steps, Step Frequency, Step 1-32, Retrigger (3), Sync (4), Tempo (12), Smoothing |
| Arpeggiator | 7 | Frequency, Gate, Octaves, On, Pattern (5), Sync (4), Tempo (12) |
| Distortion | 4 | On, Type (4), Drive, Mix |
| Delay | 6 | Mix, Feedback, Frequency, On, Sync (4), Tempo (12) |
| Reverb | 4 | Damping, Mix, Feedback, On |
| Stutter | 8 | Frequency, Sync (4), Tempo, On, Resample Frequency, Resample Sync (4), Resample Tempo (12), Softness |
| Voice | 8 | Tempo, Legato, Pitch Bend Range, Polyphony, Portamento, Portamento Type (3), Velocity Track, Volume |

## Presets

274 factory patches, each with the id `<folder>/<name>`, the patch's file name as its name and its folder as its tag: Arp 7, Bass 51, Chip 8, Harsh 3, Keys 43, Lead 37, Pad 40, Percussion 58, SFX 27. Their 482 modulation routings all resolve to the engine's sources and destinations (checked by `check.sh`).

## Licences

- Code: Helm and mopo are GPL-3.0 (Matt Tytel); this port is GPL-3.0 as well.
- Factory patches: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) unless noted, by the authors named in each patch file: Cris Owl Alvarez (130), SF (56), Matt Tytel (39), Mikolis (24), Ones & Zeros (24). Five of the Cris Owl Alvarez patches (`Bass/COA Sub-Layer for Trap Kick 5`, `COA Trap Bass 7`, `COA Trap Bass 8`, `COA Trap Bass 9`, `COA Hard Bass 10`) are GPL-3.0 instead, as their files state. `Percussion/SF Kick 2` names no author in its file.

## Checks

`check.sh` runs `../common/check.mjs` with every preset, then `check-presets.mjs`, which checks on the wasm directly that:

- every factory modulation routing resolves;
- a note scheduled 37 frames into a block sounds from that frame;
- after each of the 274 presets loads, and with every on/off switch turned on (arpeggiator, stutter, effects), playing notes and chords allocates nothing.

Last run: default patch -16.9 dBFS RMS at C4 (262 Hz measured), 274 of 274 presets sounding, no NaN, no allocation while playing. `demo.html` plays it in the browser (serve the `instrument-ports` folder, e.g. `python3 -m http.server -d instrument-ports`, and open `/helm/demo.html`); an offline render in Chrome at 44.1 kHz started the note on its scheduled sample.
