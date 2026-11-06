// Plaits (Mutable Instruments macro oscillator 2) as a polyphonic instrument:
// up to 8 copies of plaits::Voice, each with its own 16 KB engine RAM like
// the module, at the module's own sample rate (47872.34 Hz) converted to the
// audio context's rate.
//
// A note patches TRIGGER (held while the key is) and, in Gate mode, LEVEL
// (the key's velocity while held), so the low-pass gate opens with the key
// and closes with Decay after it. In Ping mode only TRIGGER is patched: the
// low-pass gate is pinged like the module's, velocity scales the voice.

#include "port.h"

#include <cmath>
#include <cstring>

#include "plaits/dsp/dsp.h"
#include "plaits/dsp/voice.h"
#include "shared/resampler.h"
#include "shared/voices.h"
#include "stmlib/utils/buffer_allocator.h"

namespace {

const int kMaxVoices = 8;
const int kBlock = plaits::kBlockSize;  // 12 frames
const double kModuleRate = plaits::kCorrectedSampleRate;

enum ParamId {
  P_ENGINE,
  P_HARMONICS,
  P_TIMBRE,
  P_MORPH,
  P_TRANSPOSE,
  P_FINE,
  P_DECAY,
  P_LPG_COLOUR,
  P_MODE,
  P_FM_AMOUNT,
  P_TIMBRE_AMOUNT,
  P_MORPH_AMOUNT,
  P_AUX,
  P_SPREAD,
  P_VOICES,
  P_VOLUME,
  P_COUNT
};

const char* kEngines[24] = {
    "Virtual analog VCF", "Phase distortion", "Six-op FM 1",   "Six-op FM 2",   "Six-op FM 3",
    "Wave terrain",       "String machine",   "Chiptune",      "Virtual analog", "Waveshaping",
    "Two-op FM",          "Granular formant", "Harmonic",      "Wavetable",     "Chords",
    "Speech",             "Granular cloud",   "Filtered noise", "Particle noise", "Inharmonic string",
    "Modal resonator",    "Analog bass drum", "Analog snare",  "Analog hi-hat"};

struct PresetDef {
  const char* id;
  const char* name;
  const char* tag;
  int engine;
  float harmonics, timbre, morph, decay, colour, mode, fm, timbre_amount, morph_amount, transpose;
};

// One sound for each of the 24 models, as a starting point
const PresetDef kPresets[] = {
    {"va-vcf", "Filtered analog", "Lead", 0, 0.45f, 0.55f, 0.3f, 0.5f, 0.5f, 0, 0, 0.35f, 0, 0},
    {"phase-distortion", "Phase distortion", "Keys", 1, 0.5f, 0.4f, 0.35f, 0.55f, 0.5f, 0, 0, 0.3f, 0, 0},
    {"six-op-1", "Six-op FM bank 1", "Keys", 2, 0.0f, 0.5f, 0.5f, 0.5f, 0.5f, 0, 0, 0, 0, 0},
    {"six-op-2", "Six-op FM bank 2", "Keys", 3, 0.25f, 0.5f, 0.5f, 0.5f, 0.5f, 0, 0, 0, 0, 0},
    {"six-op-3", "Six-op FM bank 3", "Keys", 4, 0.5f, 0.5f, 0.5f, 0.5f, 0.5f, 0, 0, 0, 0, 0},
    {"wave-terrain", "Wave terrain", "Lead", 5, 0.4f, 0.5f, 0.5f, 0.5f, 0.5f, 0, 0, 0.2f, 0, 0},
    {"string-machine", "String machine", "Pad", 6, 0.3f, 0.5f, 0.6f, 0.7f, 0.5f, 0, 0, 0, 0, 0},
    {"chiptune", "Chiptune", "Lead", 7, 0.0f, 0.5f, 0.5f, 0.45f, 0.5f, 0, 0, 0, 0, 0},
    {"virtual-analog", "Virtual analog", "Lead", 8, 0.25f, 0.5f, 0.5f, 0.5f, 0.5f, 0, 0, 0.3f, 0, 0},
    {"waveshaping", "Waveshaper", "Lead", 9, 0.4f, 0.35f, 0.4f, 0.5f, 0.5f, 0, 0, 0.35f, 0, 0},
    {"two-op-fm", "Two-op FM", "Keys", 10, 0.35f, 0.4f, 0.3f, 0.5f, 0.5f, 0, 0, 0.4f, 0, 0},
    {"granular-formant", "Granular formant", "Lead", 11, 0.5f, 0.5f, 0.5f, 0.5f, 0.5f, 0, 0, 0.2f, 0, 0},
    {"harmonic", "Harmonic organ", "Keys", 12, 0.45f, 0.5f, 0.5f, 0.5f, 0.5f, 0, 0, 0.2f, 0, 0},
    {"wavetable", "Wavetable", "Pad", 13, 0.3f, 0.5f, 0.5f, 0.6f, 0.5f, 0, 0, 0.2f, 0, 0},
    {"chords", "Chords", "Pad", 14, 0.3f, 0.5f, 0.5f, 0.6f, 0.5f, 0, 0, 0, 0, -12},
    {"speech", "Speech", "Voice", 15, 0.6f, 0.5f, 0.5f, 0.5f, 0.5f, 0, 0, 0, 0, 0},
    {"granular-cloud", "Granular cloud", "Pad", 16, 0.4f, 0.5f, 0.6f, 0.7f, 0.5f, 0, 0, 0, 0, 0},
    {"filtered-noise", "Filtered noise", "FX", 17, 0.5f, 0.5f, 0.75f, 0.5f, 0.5f, 0, 0, 0, 0, 0},
    {"particle-noise", "Particles", "FX", 18, 0.5f, 0.5f, 0.6f, 0.6f, 0.5f, 0, 0, 0, 0, 0},
    {"inharmonic-string", "Inharmonic string", "Pluck", 19, 0.3f, 0.5f, 0.6f, 0.5f, 0.5f, 0, 0, 0, 0, 0},
    {"modal", "Modal resonator", "Pluck", 20, 0.4f, 0.55f, 0.6f, 0.5f, 0.5f, 0, 0, 0, 0, 0},
    {"bass-drum", "Bass drum", "Drum", 21, 0.5f, 0.5f, 0.5f, 0.5f, 0.5f, 0, 0, 0, 0, -24},
    {"snare", "Snare drum", "Drum", 22, 0.5f, 0.5f, 0.5f, 0.5f, 0.5f, 0, 0, 0, 0, -12},
    {"hi-hat", "Hi-hat", "Drum", 23, 0.5f, 0.5f, 0.5f, 0.5f, 0.5f, 0, 0, 0, 0, 0},
};
const int kPresetCount = sizeof(kPresets) / sizeof(kPresets[0]);

plaits::Voice voices[kMaxVoices];
char ram[kMaxVoices][16384];
float last_trigger[kMaxVoices];
bool retrigger[kMaxVoices];
plaits::Voice::Frame frames[kMaxVoices][kBlock];
mi_port::VoiceAllocator<kMaxVoices> allocator;
mi_port::Bridge<kBlock> bridge;
float values[P_COUNT];
std::vector<mp::Param>* params = nullptr;

void render_block(float* out_l, float* out_r) {
  for (int k = 0; k < kBlock; ++k) out_l[k] = out_r[k] = 0.0f;
  allocator.set_voices(int(values[P_VOICES]));
  allocator.BeginBlock();

  plaits::Patch patch;
  patch.harmonics = values[P_HARMONICS];
  patch.timbre = values[P_TIMBRE];
  patch.morph = values[P_MORPH];
  patch.frequency_modulation_amount = values[P_FM_AMOUNT];
  patch.timbre_modulation_amount = values[P_TIMBRE_AMOUNT];
  patch.morph_modulation_amount = values[P_MORPH_AMOUNT];
  patch.engine = int(values[P_ENGINE]);
  patch.decay = values[P_DECAY];
  patch.lpg_colour = values[P_LPG_COLOUR];
  const bool gate_mode = values[P_MODE] < 0.5f;
  const float aux = values[P_AUX];
  const float spread = values[P_SPREAD];
  const float volume = values[P_VOLUME] / 32768.0f;
  const int count = allocator.voices();

  for (int v = 0; v < kMaxVoices; ++v) {
    if (!allocator.active(v)) {
      allocator.EndBlock(v, 0.0f);
      last_trigger[v] = 0.0f;
      continue;
    }
    const auto& s = allocator.slot(v);
    plaits::Modulations m;
    std::memset(&m, 0, sizeof m);
    float trigger = (s.gate || s.start) ? 1.0f : 0.0f;
    // The same voice played again: its trigger drops for a block first
    if (s.start && last_trigger[v] > 0.5f) {
      trigger = 0.0f;
      retrigger[v] = true;
    } else if (retrigger[v]) {
      trigger = 1.0f;
      retrigger[v] = false;
    }
    last_trigger[v] = trigger;
    m.trigger = trigger;
    m.trigger_patched = true;
    const float velocity = s.velocity / 127.0f;
    if (gate_mode) {
      m.level_patched = true;
      m.level = trigger > 0.5f || s.gate ? velocity : 0.0f;
    }
    patch.note = s.note + values[P_TRANSPOSE] + values[P_FINE] / 100.0f;
    if (s.note < 0) patch.note = 60.0f;  // fading out after its note was taken
    voices[v].Render(patch, m, frames[v], kBlock);

    float gain = s.gain * volume * (gate_mode ? 1.0f : 0.25f + 0.75f * velocity);
    // Voices spread across the stereo field by slot
    float pan = count > 1 ? (float(v % count) / float(count - 1)) * 2.0f - 1.0f : 0.0f;
    pan *= spread;
    const float gl = gain * std::sqrt(0.5f * (1.0f - pan));
    const float gr = gain * std::sqrt(0.5f * (1.0f + pan));
    float peak = 0.0f;
    for (int k = 0; k < kBlock; ++k) {
      // The module's outputs are inverted
      const float o = -float(frames[v][k].out);
      const float a = -float(frames[v][k].aux);
      const float x = o + aux * (a - o);
      out_l[k] += x * gl;
      out_r[k] += x * gr;
      const float ax = std::fabs(x) / 32768.0f;
      if (ax > peak) peak = ax;
    }
    allocator.EndBlock(v, peak);
  }
}

void set_defaults() {
  for (int i = 0; i < P_COUNT; ++i) values[i] = (*params)[i].def;
}

}  // namespace

void port_init(float sample_rate, mp::Description& d) {
  using mp::choice;
  using mp::param;
  d.params = {
      choice("engine", "Model", std::vector<std::string>(kEngines, kEngines + 24), 8, "Oscillator"),
      param("harmonics", "Harmonics", 0, 1, 0.001f, 0.25f, "Oscillator"),
      param("timbre", "Timbre", 0, 1, 0.001f, 0.5f, "Oscillator"),
      param("morph", "Morph", 0, 1, 0.001f, 0.5f, "Oscillator"),
      param("transpose", "Transpose", -24, 24, 1, 0, "Oscillator"),
      param("fine", "Fine tune", -100, 100, 1, 0, "Oscillator"),
      param("decay", "Decay", 0, 1, 0.001f, 0.5f, "Low-pass gate"),
      param("lpgColour", "Colour", 0, 1, 0.001f, 0.5f, "Low-pass gate"),
      choice("mode", "Envelope", {"Gate", "Ping"}, 0, "Low-pass gate"),
      param("fmAmount", "Envelope to pitch", -1, 1, 0.001f, 0, "Envelope"),
      param("timbreAmount", "Envelope to timbre", -1, 1, 0.001f, 0.3f, "Envelope"),
      param("morphAmount", "Envelope to morph", -1, 1, 0.001f, 0, "Envelope"),
      param("aux", "Aux output", 0, 1, 0.001f, 0, "Output"),
      param("spread", "Stereo spread", 0, 1, 0.001f, 0.4f, "Output"),
      param("voices", "Voices", 1, kMaxVoices, 1, 6, "Output"),
      param("volume", "Volume", 0, 1, 0.001f, 0.5f, "Output"),
  };
  params = &d.params;
  for (int i = 0; i < kPresetCount; ++i) d.presets.push_back({kPresets[i].id, kPresets[i].name, kPresets[i].tag});

  for (int v = 0; v < kMaxVoices; ++v) {
    stmlib::BufferAllocator buffer(ram[v], sizeof ram[v]);
    voices[v].Init(&buffer);
    last_trigger[v] = 0.0f;
    retrigger[v] = false;
  }
  set_defaults();
  allocator.Init(int(values[P_VOICES]), 8);  // 8 blocks: a 2 ms fade
  bridge.Init(kModuleRate, sample_rate);
}

void port_render(const float*, const float*, float* out_l, float* out_r, int frames_count) {
  bridge.Render(out_l, out_r, frames_count, render_block);
}

void port_note_on(int note, int velocity) { allocator.NoteOn(note, velocity); }
void port_note_off(int note) { allocator.NoteOff(note); }
void port_all_off() { allocator.AllOff(); }
void port_set_param(int index, float value) { values[index] = value; }
float port_get_param(int index) { return values[index]; }

void port_load_preset(int index) {
  const PresetDef& p = kPresets[index];
  set_defaults();
  values[P_ENGINE] = float(p.engine);
  values[P_HARMONICS] = p.harmonics;
  values[P_TIMBRE] = p.timbre;
  values[P_MORPH] = p.morph;
  values[P_DECAY] = p.decay;
  values[P_LPG_COLOUR] = p.colour;
  values[P_MODE] = p.mode;
  values[P_FM_AMOUNT] = p.fm;
  values[P_TIMBRE_AMOUNT] = p.timbre_amount;
  values[P_MORPH_AMOUNT] = p.morph_amount;
  values[P_TRANSPOSE] = p.transpose;
}
