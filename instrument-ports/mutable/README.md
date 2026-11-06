# Mutable Instruments

Five Mutable Instruments modules as AudioWorklets, built from the modules' own DSP code:

| Module | Processor | Kind | Runs at | Voices |
| --- | --- | --- | --- | --- |
| Plaits | `melodics-plaits` | instrument | 47,872.34 Hz (the module's real rate), 12-frame blocks | up to 8 copies of the voice |
| Rings | `melodics-rings` | instrument | 48 kHz, 24-frame blocks | the module's own 1, 2 or 4 |
| Elements | `melodics-elements` | instrument | 32 kHz, 16-frame blocks | 1, as the module |
| Braids | `melodics-braids` | instrument | 96 kHz, 24-frame blocks | up to 8 copies of the oscillator |
| Clouds | `melodics-clouds` | effect (stereo in, stereo out) | 32 kHz, 32-frame blocks | none |

- Source: [pichenettes/eurorack](https://github.com/pichenettes/eurorack) at `f4cfa7697095a28d292bff758beb51deb49b5a86`, with [pichenettes/stmlib](https://github.com/pichenettes/stmlib) at `e3bd7c9cc00e4364166f9905c0509b6ffd0535ec`, the commit eurorack pins (`fetch.sh`)
- Build: `./build.sh` (all five) or `./build.sh plaits rings`; it fetches the source, installs emscripten with Homebrew when missing, and writes `dist/<module>.wasm` and `dist/<module>.worklet.js`
- Check: `./check.sh` plays every preset of every module through the wasm in Node (Clouds with a plucked input); it fails on silence, NaN or allocation while playing
- Demo: serve `instrument-ports/` (`python3 -m http.server -d instrument-ports`) and open `mutable/demo.html`; the Clouds tab plays Plaits through Clouds

Only the DSP is built: the files each module's desktop test build (`<module>/test/makefile`) compiles, without the test programs, UI, drivers or bootloaders, with `-DTEST` as those builds use. Each module renders its fixed blocks at its own sample rate; `shared/resampler.h` converts to the audio context's rate (32-tap windowed sinc). `shared/voices.h` allocates voices for Plaits and Braids: a free voice first, then the quietest released one, then the oldest held one; a voice still sounding fades out over 2 ms before it takes the new note.

Notes are applied at the start of the module's next block (0.25 to 0.5 ms), the resolution its envelopes and triggers run at. Plaits keeps the module's 1.25 ms trigger delay.

## Plaits

`plaits::Voice`, each copy with its own 16 KB engine RAM. A note patches TRIGGER, held while the key is down. In Gate mode it also patches LEVEL with the key's velocity, so the low-pass gate opens with the key and closes with Decay after it. In Ping mode only TRIGGER is patched: the low-pass gate is pinged as on the module, and velocity scales the voice. The six-op FM models play the module's built-in DX7 banks, chosen with Harmonics.

| Group | Parameters |
| --- | --- |
| Oscillator | Model (all 24: Virtual analog VCF, Phase distortion, Six-op FM 1-3, Wave terrain, String machine, Chiptune, Virtual analog, Waveshaping, Two-op FM, Granular formant, Harmonic, Wavetable, Chords, Speech, Granular cloud, Filtered noise, Particle noise, Inharmonic string, Modal resonator, Analog bass drum, Analog snare, Analog hi-hat), Harmonics, Timbre, Morph (0-1), Transpose (±24), Fine tune (±100 cents) |
| Low-pass gate | Decay, Colour (0-1), Envelope (Gate, Ping) |
| Envelope | Envelope to pitch, to timbre, to morph (the module's attenuverters, -1 to 1) |
| Output | Aux output (blend from OUT to AUX), Stereo spread, Voices (1-8), Volume |

Presets (24): one starting sound for each model.

## Rings

`rings::Part` with its internal exciter, and `rings::StringSynthPart` for the Disastrous Peace easter egg. A note strums the resonator at its pitch; the module's polyphony decides how many strummed notes ring together. A note-off does nothing, as on the module: the resonator rings out with Damping. Rings' note filter gives a voice its pitch a few milliseconds after the strum, so notes played together are strummed 8 ms apart. Velocity darkens a soft note (Brightness lowered by up to 0.3). `allOff` fades the output over 5 ms and clears the resonators. The odd and even voices go to the two outputs as on the module; Stereo width blends them.

| Group | Parameters |
| --- | --- |
| Resonator | Resonator (Modal, Sympathetic strings, String, FM voice, Quantized chords, String and reverb, Disastrous Peace), Polyphony (1, 2, 4), Structure, Brightness, Damping, Position (0-1) |
| Pitch | Transpose (±24), Fine tune (±100 cents), Velocity to brightness |
| Output | Easter egg effect (Formant, Chorus, Reverb, Formant 2, Ensemble, Reverb 2), Stereo width, Volume |

Presets (14): Modal bell, Modal marimba, Glass plate, Sympathetic strings, Plucked string, String bass, Sitar, FM voice, FM bell, Quantized chords, String and reverb, Disastrous Peace formant, ensemble and reverb.

## Elements

`elements::Part` with its 64 KB reverb buffer, monophonic. A note sets the pitch and holds the gate while the key is down; velocity is the STRENGTH input. A new note while another is held drops the gate for one block, so each key attacks again; releasing the newest key returns to the one still held, legato. The outputs are the module's two (aux left, main right). The Ominous voice easter egg sounds only while a key is held (on the module its pressure input drones).

| Group | Parameters |
| --- | --- |
| Exciter | Contour, Bow, Bow timbre, Blow, Flow, Blow timbre, Strike, Mallet, Strike timbre (0-1) |
| Resonator | Resonator (Modal, String, Strings, Ominous voice), Geometry, Brightness, Damping, Position (0-1) |
| Space | Space (0-2; from 1.75 the reverb freezes, as on the module), Volume |
| Pitch | Transpose (±24), Fine tune (±100 cents), Velocity to strength |

Presets (11): Struck bell, Wooden mallet, Plucked string, Bowed string, Bowed glass, Blown pipe, Breathy flute, Sympathetic strings, Gong, Frozen space, Ominous voice.

## Braids

`braids::MacroOscillator` with the firmware's block processing from `braids.cc`: the AD envelope to timbre, colour, pitch and VCA, VCO drift, bit depth and sample rate reduction, and the signature waveshaper. A key going down calls `Strike()` and starts the envelope, like a trigger on the module. The VCA has two modes: Gate (opens at the attack time, holds while the key is down, closes at the decay time) and AD (the firmware's, the key's length does not matter). Velocity scales the level.

| Group | Parameters |
| --- | --- |
| Oscillator | Shape (all 47 firmware shapes), Timbre, Colour (0-1), Transpose (±24), Fine tune (±100 cents) |
| Envelope | VCA (Gate, AD), Attack, Decay, Envelope to timbre, to colour, to pitch (0-15, the firmware's settings) |
| Character | Bit depth (2-16 bits), Sample rate (4-96 kHz), Signature (0-4), VCO drift (0-4) |
| Output | Velocity, Stereo spread, Voices (1-8), Volume |

Presets (40), across the shapes: CSaw lead, Morph bass, Sync lead, Triple saw chord, FM bell, Plucked string, Bowed string, Kick, Snare, Wavetables, Paraphonic chords, Granular cloud, Digital modulation and more. The signature waveshaper is seeded with a fixed value (the module uses its chip id). The quantizer, META mode and trigger delay are not built.

## Clouds

`clouds::GranularProcessor` with the module's two buffers (118,784 and 65,408 bytes). The input is converted to 32 kHz and the output back; the output side starts with 64 frames of latency so it never runs dry. Clouds plays no notes: a note-on fires TRIG for one block (a new grain in Granular mode, a resync in Looping delay), and a held key is the GATE input. Parameter changes are smoothed over about 20 ms.

Two upstream lines are patched by `patch-clouds.sh` into copies under `build/`, leaving the pinned checkout untouched; the build stops if upstream changes:

- `clouds/dsp/window.h`: two cleanup commits (`fbb53ba`, `0e3756f`) each removed one of the two `done_ = false;` lines in `Window::Start`, which silences the Stretch mode. The line is put back.
- `clouds/dsp/correlator.cc`: a shift by `32 - offset_bits` becomes a shift by 32 when `offset_bits` is 0; the module's ARM core gives 0 there, WebAssembly does not. The patched line gives 0.

| Group | Parameters |
| --- | --- |
| Mode | Mode (Granular, Stretch, Looping delay, Spectral), Quality (Stereo hi-fi, Mono hi-fi, Stereo lo-fi, Mono lo-fi) |
| Grains | Position, Size (0-1), Pitch (±24), Density, Texture (0-1) |
| Blend | Dry/wet, Stereo spread, Feedback, Reverb (0-1), Freeze (Off, On), Input gain (0-2) |

Presets (11): Granular, Pitch shifter and time stretcher, Looping delay, Spectral, Frozen pad, Shimmer reverb, Sparse grains, Octave down cloud, Lo-fi tape echo, Spectral freeze, Diffuse wash.

After a start or a quality change, the wet sound stays silent until the recording buffer has filled up to Position; in lo-fi that takes several seconds, as on the module.

## Sizes and speed

| File | Bytes | Gzipped | Speed in Node (one note) |
| --- | --- | --- | --- |
| `plaits.wasm` | 241,727 | 135,121 | 145x real time |
| `rings.wasm` | 94,587 | 48,090 | 55x |
| `elements.wasm` | 431,150 | 351,701 | 66x |
| `braids.wasm` | 143,819 | 88,998 | 182x |
| `clouds.wasm` | 125,230 | 66,863 | 86x |
| each `*.worklet.js` | about 9,450 | about 3,000 | |

Elements is mostly its exciter samples. Speeds are on an Apple Silicon Mac.

## Licence

The modules' DSP code and stmlib are MIT (Emilie Gillet).
