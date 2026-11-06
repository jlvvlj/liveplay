# OB-Xf

[OB-Xf](https://github.com/surge-synthesizer/OB-Xf) (GPL-3.0-or-later), the Surge Synth Team's continuation of OB-Xd, as a WebAssembly AudioWorklet instrument: upstream's `SynthEngine` (Motherboard, 32 voices, oscillators, filters, envelopes, LFOs, voice allocation and stealing) with no JUCE and no UI, its full parameter list and all 493 factory patches.

## Source

| Repository | Commit |
| --- | --- |
| surge-synthesizer/OB-Xf | `9c7599edc28022d83dca3af4af772f000c96bd42` |
| simd-everywhere/simde (pinned by OB-Xf, `libs/simde`) | `71fd833d9666141edcd1d3c109a80e228303d8d7` |
| surge-synthesizer/sst-basic-blocks (pinned by OB-Xf, `libs/sst/sst-basic-blocks`) | `5fb60983d57ccd0318865df8c004a1f9d8419b73` |

`fetch.sh` fetches them into `upstream/` (git-ignored).

## Build

```sh
./build.sh   # fetches the sources, installs emscripten with Homebrew if missing
./check.sh   # renders through the wasm: every factory patch, chords, parameter extremes
```

Output, git-ignored: `dist/obxf.wasm` and `dist/obxf.worklet.js`, which registers the processor `melodics-obxf`. `demo.html` plays it from the computer keyboard; serve `instrument-ports/` (for example `npx http-server instrument-ports`) and open `obxf/demo.html`.

| File | Size | Gzipped |
| --- | --- | --- |
| `obxf.wasm` | 415 KB | 164 KB |
| `obxf.worklet.js` | 9 KB | 3 KB |

## How it is built

- `port.cpp` drives upstream's `SynthEngine` through the shared exports in `../common/port.cpp`. Notes go to `processNoteOn` / `processNoteOff` (velocity 1-127 as 0-1), at their own sample in the block.
- `gen.mjs` reads the pinned sources at build time and writes `build/gen/`:
  - the parameter list from `src/parameter/ParameterList.h` (keys, names, groups, ranges, defaults and choices as upstream declares them),
  - the engine callback for each parameter, copied from `src/parameter/ParameterCoordinator.h`,
  - the parameter IDs and names from `src/parameter/SynthParam.h`, without the JUCE parameter classes,
  - every factory patch in `assets/installer/Surge Synth Team/OB-Xf/Patches/`, read from its `.fxp` chunk, with upstream's mapping for patches saved before 2025-12-13 (Unison Voices).
- `shim/` stands in for the JUCE utilities the engine headers use (`Random` and the fast sine as JUCE computes them, `jlimit`, `roundToInt`, `AbstractFifo`, byte order) and for the MTS-ESP client. A browser has no MTS-ESP tuning master, so tuning is twelve-tone equal temperament, as upstream plays without one.
- Upstream's `Program.h` (the plugin's patch store) is left out; the port holds the patch values itself.
- As in the plugin without a host transport, the engine gets a 120 BPM play position for tempo-synced LFOs.

## Behaviour

- Polyphony, unison and voice stealing are upstream's (Polyphony defaults to 8, up to 32). A stolen voice's envelopes continue from their current level, so stealing does not click.
- `allOff` releases every note (a MIDI all-notes-off): voices fade over their release.
- Parameter values are in the units shown below: a choice is the index of its option; every other value is in the range upstream displays. Upstream's normalized value is `(value - min) / (max - min)`.
- Presets are the factory patches, sorted by category (the preset's `tag`) and name; ids are `Category/File name`.

Measured by `check.sh` in Node: the default patch renders about 95x faster than realtime; the heaviest factory patches (unison and HQ patches) play a held six-note chord at about 4x realtime, the median patch at 18x. No allocation happens while playing, receiving notes, changing parameters or loading presets.

## Presets

493 factory patches: Atmospheres 5, Basses 45, Bells 5, Brass 31, Drums 35, FX 38, Guitars 20, Keys 87, Leads 43, Mallets 9, Organs 19, Pads 64, Percussion 10, Plucks 12, Soundscapes 19, Strings 23, Voices 11, Winds 17.

## Parameters

104 parameters, all of upstream's.

| Group | Key | Name | Range | Default |
| --- | --- | --- | --- | --- |
| Master | `Volume` | Volume | 0 to 1 | 0.5 |
| Master | `Transpose` | Transpose | -24 to 24 | 0 |
| Master | `Tune` | Tune | -100 to 100 | 0 |
| Global | `Polyphony` | Polyphony | 1 to 32 (whole) | 8 |
| Global | `HQMode` | High Quality Mode | Off / On | Off |
| Global | `UnisonVoices` | Unison Voices | 1 to 32 (whole) | 8 |
| Global | `Portamento` | Glide | 0 to 1 | 0 |
| Global | `Unison` | Unison | Off / On | Off |
| Global | `UnisonDetune` | Unison Detune | 0 to 1 | 0.25 |
| Global | `EnvLegatoMode` | Envelope Legato Mode | Both / Filter / Amp / Retrigger | Both |
| Global | `NotePriority` | Note Priority | Last / Low / High | Last |
| Global | `VoiceReassign` | Voice Reassign | Off / On | Off |
| Oscillators | `Osc1Pitch` | Osc 1 Pitch | -24 to 24 | 0 |
| Oscillators | `Osc2Detune` | Osc 2 Detune | 0 to 1 | 0 |
| Oscillators | `Osc2Pitch` | Osc 2 Pitch | -24 to 24 | 0 |
| Oscillators | `Osc2Keytrack` | Osc 2 Keytrack | Off / On | On |
| Oscillators | `Osc1SawWave` | Osc 1 Saw Wave | Off / On | On |
| Oscillators | `Osc1PulseWave` | Osc 1 Pulse Wave | Off / On | Off |
| Oscillators | `Osc2SawWave` | Osc 2 Saw Wave | Off / On | On |
| Oscillators | `Osc2PulseWave` | Osc 2 Pulse Wave | Off / On | Off |
| Oscillators | `OscPW` | Osc Pulsewidth | 0 to 1 | 0 |
| Oscillators | `Osc2PWOffset` | Osc 2 Pulsewidth Offset | 0 to 1 | 0 |
| Oscillators | `EnvToPitchAmount` | Filter Env to Pitch | 0 to 36 | 0 |
| Oscillators | `EnvToPitchBothOscs` | Filter Env to Both Osc Pitch | Off / On | On |
| Oscillators | `EnvToPitchInvert` | Invert Filter Env to Pitch | Off / On | Off |
| Oscillators | `EnvToPWAmount` | Filter Env to Pulsewidth | 0 to 1 | 0 |
| Oscillators | `EnvToPWBothOscs` | Filter Env to Both Osc Pulsewidth | Off / On | On |
| Oscillators | `EnvToPWInvert` | Invert Filter Env to Pulsewidth | Off / On | Off |
| Oscillators | `OscCrossmod` | Cross Modulation | 0 to 1 | 0 |
| Oscillators | `OscSync` | Osc Sync | Off / On | Off |
| Oscillators | `OscBrightness` | Osc Brightness | 0 to 1 | 1 |
| Mixer | `Osc1Mix` | Osc 1 Volume | 0 to 1 | 1 |
| Mixer | `Osc2Mix` | Osc 2 Volume | 0 to 1 | 0 |
| Mixer | `RingModMix` | Ring Mod Volume | 0 to 1 | 0 |
| Mixer | `NoiseMix` | Noise Volume | 0 to 1 | 0 |
| Mixer | `NoiseColor` | Noise Color | White / Pink / Red | White |
| Control | `PitchBendUp` | Pitch Bend Up | 0 to 48 (whole) | 2 |
| Control | `PitchBendDown` | Pitch Bend Down | 0 to 48 (whole) | 2 |
| Control | `BendOsc2Only` | Pitch Bend Osc 2 Only | Off / On | Off |
| Control | `VibratoWave` | Vibrato Wave | Sine / Square | Sine |
| Control | `VibratoRate` | Vibrato Rate | 0 to 1 | 0.30000001192092896 |
| Filter | `FilterCutoff` | Filter Cutoff | -45 to 75 | 75 |
| Filter | `FilterResonance` | Filter Resonance | 0 to 1 | 0 |
| Filter | `FilterEnvAmount` | Filter Env Amount | 0 to 1 | 0 |
| Filter | `FilterKeyFollow` | Filter Keytrack | 0 to 1 | 0 |
| Filter | `FilterMode` | Filter Mode | 0 to 1 | 0 |
| Filter | `Filter2PoleBPBlend` | Filter 2-Pole BP Blend | Off / On | Off |
| Filter | `Filter2PolePush` | Filter 2-Pole Push | Off / On | Off |
| Filter | `Filter4PoleMode` | Filter 4-Pole Mode | Off / On | Off |
| Filter | `Filter4PoleXpander` | Filter 4-Pole Xpander | Off / On | Off |
| Filter | `FilterXpanderMode` | Filter Xpander Mode | LP4 / LP3 / LP2 / LP1 / HP3 / HP2 / HP1 / BP4 / BP2 / N2 / PH3 / HP2+LP1 / HP3+LP1 / N2+LP1 / PH3+LP1 | LP4 |
| LFO 1 | `LFO1TempoSync` | LFO 1 Tempo Sync | Off / On | Off |
| LFO 1 | `LFO1Rate` | LFO 1 Rate | 0 to 1 | 0.5 |
| LFO 1 | `LFO1ModAmount1` | LFO 1 Mod 1 Amount | 0 to 1 | 0 |
| LFO 1 | `LFO1ModAmount2` | LFO 1 Mod 2 Amount | 0 to 1 | 0 |
| LFO 1 | `LFO1Wave1` | LFO 1 Wave 1 | -1 to 1 | -1 |
| LFO 1 | `LFO1Wave2` | LFO 1 Wave 2 | -1 to 1 | 0 |
| LFO 1 | `LFO1Wave3` | LFO 1 Wave 3 | -1 to 1 | 0 |
| LFO 1 | `LFO1PW` | LFO 1 Pulsewidth | 0 to 1 | 0 |
| LFO 1 | `LFO1ToOsc1Pitch` | LFO 1 to Osc 1 Pitch | Off / On / Inverted | Off |
| LFO 1 | `LFO1ToOsc2Pitch` | LFO 1 to Osc 2 Pitch | Off / On / Inverted | Off |
| LFO 1 | `LFO1ToFilterCutoff` | LFO 1 to Filter Cutoff | Off / On / Inverted | Off |
| LFO 1 | `LFO1ToOsc1PW` | LFO 1 to Osc 1 PW | Off / On / Inverted | Off |
| LFO 1 | `LFO1ToOsc2PW` | LFO 1 to Osc 2 PW | Off / On / Inverted | Off |
| LFO 1 | `LFO1ToVolume` | LFO 1 to Volume | Off / On / Inverted | Off |
| LFO 2 | `LFO2TempoSync` | LFO 2 Tempo Sync | Off / On | Off |
| LFO 2 | `LFO2Rate` | LFO 2 Rate | 0 to 1 | 0.5 |
| LFO 2 | `LFO2ModAmount1` | LFO 2 Mod 1 Amount | 0 to 1 | 0 |
| LFO 2 | `LFO2ModAmount2` | LFO 2 Mod 2 Amount | 0 to 1 | 0 |
| LFO 2 | `LFO2Wave1` | LFO 2 Wave 1 | -1 to 1 | -1 |
| LFO 2 | `LFO2Wave2` | LFO 2 Wave 2 | -1 to 1 | 0 |
| LFO 2 | `LFO2Wave3` | LFO 2 Wave 3 | -1 to 1 | 0 |
| LFO 2 | `LFO2PW` | LFO 2 Pulsewidth | 0 to 1 | 0 |
| LFO 2 | `LFO2ToOsc1Pitch` | LFO 2 to Osc 1 Pitch | Off / On / Inverted | Off |
| LFO 2 | `LFO2ToOsc2Pitch` | LFO 2 to Osc 2 Pitch | Off / On / Inverted | Off |
| LFO 2 | `LFO2ToFilterCutoff` | LFO 2 to Filter Cutoff | Off / On / Inverted | Off |
| LFO 2 | `LFO2ToOsc1PW` | LFO 2 to Osc 1 PW | Off / On / Inverted | Off |
| LFO 2 | `LFO2ToOsc2PW` | LFO 2 to Osc 2 PW | Off / On / Inverted | Off |
| LFO 2 | `LFO2ToVolume` | LFO 2 to Volume | Off / On / Inverted | Off |
| Filter Envelope | `FilterEnvAttack` | Filter Env Attack | 0 to 1 | 0 |
| Filter Envelope | `FilterEnvDecay` | Filter Env Decay | 0 to 1 | 0 |
| Filter Envelope | `FilterEnvSustain` | Filter Env Sustain | 0 to 1 | 1 |
| Filter Envelope | `FilterEnvRelease` | Filter Env Release | 0 to 1 | 0 |
| Filter Envelope | `FilterEnvAttackCurve` | Filter Env Attack Curve | 0 to 1 | 0 |
| Filter Envelope | `VelToFilterEnv` | Velocity to Filter Env | 0 to 1 | 0 |
| Filter Envelope | `FilterEnvInvert` | Filter Env Invert | Off / On | Off |
| Amplifier Envelope | `AmpEnvAttack` | Amp Env Attack | 0 to 1 | 0 |
| Amplifier Envelope | `AmpEnvDecay` | Amp Env Decay | 0 to 1 | 0 |
| Amplifier Envelope | `AmpEnvSustain` | Amp Env Sustain | 0 to 1 | 1 |
| Amplifier Envelope | `AmpEnvRelease` | Amp Env Release | 0 to 1 | 0 |
| Amplifier Envelope | `AmpEnvAttackCurve` | Amp Env Attack Curve | 0 to 1 | 0 |
| Amplifier Envelope | `VelToAmpEnv` | Velocity to Amp Env | 0 to 1 | 0 |
| Voice Variation | `PortamentoSlop` | Glide Slop | 0 to 1 | 0.25 |
| Voice Variation | `FilterSlop` | Filter Slop | 0 to 1 | 0.25 |
| Voice Variation | `EnvelopeSlop` | Envelope Slop | 0 to 1 | 0.25 |
| Voice Variation | `LevelSlop` | Level Slop | 0 to 1 | 0.25 |
| Voice Variation | `PanVoice1` | Pan Voice 1 | -1 to 1 | 0 |
| Voice Variation | `PanVoice2` | Pan Voice 2 | -1 to 1 | 0 |
| Voice Variation | `PanVoice3` | Pan Voice 3 | -1 to 1 | 0 |
| Voice Variation | `PanVoice4` | Pan Voice 4 | -1 to 1 | 0 |
| Voice Variation | `PanVoice5` | Pan Voice 5 | -1 to 1 | 0 |
| Voice Variation | `PanVoice6` | Pan Voice 6 | -1 to 1 | 0 |
| Voice Variation | `PanVoice7` | Pan Voice 7 | -1 to 1 | 0 |
| Voice Variation | `PanVoice8` | Pan Voice 8 | -1 to 1 | 0 |
