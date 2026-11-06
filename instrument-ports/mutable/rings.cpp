// Rings (Mutable Instruments resonator) as an instrument: rings::Part with its
// internal exciter, at the module's 48 kHz in its 24-frame blocks, converted
// to the audio context's rate.
//
// A note strums the resonator at its pitch, as a trigger with the V/OCT input
// patched does on the module. The module's polyphony (1, 2 or 4) decides how
// many strummed notes ring together; the oldest voice is reused. A note-off
// does nothing: the resonator rings out with Damping, as on the module.
//
// Rings' note filter hands a voice its pitch a few milliseconds after the
// strum, so notes played together (a chord) are strummed 8 ms apart.
//
// Stereo: the module's odd and even outputs, blended by Stereo width (at 1,
// alternate notes sit hard left and right as on the module).
//
// Velocity: the internal exciter has no level, so a softer note is a darker
// one: Brightness is lowered by up to 0.3 at the lowest velocity, from that
// note on.
//
// The seventh model is the module's Disastrous Peace easter egg
// (rings::StringSynthPart): a string machine whose chord follows Structure,
// with its effect chosen by "Easter egg effect".

#include "port.h"

#include <cmath>
#include <cstring>

#include "rings/dsp/dsp.h"
#include "rings/dsp/part.h"
#include "rings/dsp/patch.h"
#include "rings/dsp/performance_state.h"
#include "rings/dsp/string_synth_part.h"
#include "shared/resampler.h"

namespace {

const int kBlock = rings::kMaxBlockSize;  // 24 frames
const double kModuleRate = rings::kSampleRate;
const int kStrumSpacing = 16;  // blocks between strums: 8 ms
const int kQueueSize = 32;
const int kEasterEgg = 6;

enum ParamId {
  P_MODEL,
  P_POLYPHONY,
  P_STRUCTURE,
  P_BRIGHTNESS,
  P_DAMPING,
  P_POSITION,
  P_TRANSPOSE,
  P_FINE,
  P_VELOCITY,
  P_FX,
  P_WIDTH,
  P_VOLUME,
  P_COUNT
};

struct PresetDef {
  const char* id;
  const char* name;
  const char* tag;
  int model;
  int polyphony;  // option index: 0 = 1, 1 = 2, 2 = 4
  float structure, brightness, damping, position;
  int transpose;
  int fx;
};

const PresetDef kPresets[] = {
    {"modal-bell", "Modal bell", "Bell", 0, 2, 0.75f, 0.7f, 0.6f, 0.3f, 0, 0},
    {"modal-marimba", "Modal marimba", "Mallet", 0, 2, 0.25f, 0.35f, 0.45f, 0.25f, 0, 0},
    {"modal-glass", "Glass plate", "Bell", 0, 2, 0.9f, 0.85f, 0.7f, 0.6f, 12, 0},
    {"sympathetic", "Sympathetic strings", "Pluck", 1, 1, 0.45f, 0.55f, 0.7f, 0.4f, 0, 0},
    {"string", "Plucked string", "Pluck", 2, 2, 0.35f, 0.5f, 0.55f, 0.3f, 0, 0},
    {"string-bass", "String bass", "Bass", 2, 1, 0.2f, 0.3f, 0.5f, 0.2f, -24, 0},
    {"string-sitar", "Sitar", "Pluck", 2, 2, 0.9f, 0.65f, 0.65f, 0.35f, 0, 0},
    {"fm-voice", "FM voice", "Keys", 3, 2, 0.4f, 0.5f, 0.55f, 0.4f, 0, 0},
    {"fm-bell", "FM bell", "Bell", 3, 2, 0.8f, 0.7f, 0.65f, 0.6f, 0, 0},
    {"sympathetic-chords", "Quantized chords", "Pad", 4, 1, 0.5f, 0.55f, 0.75f, 0.4f, -12, 0},
    {"string-reverb", "String and reverb", "Pad", 5, 2, 0.3f, 0.5f, 0.75f, 0.5f, 0, 0},
    {"disastrous-formant", "Disastrous Peace formant", "Pad", kEasterEgg, 1, 0.3f, 0.5f, 0.6f, 0.5f, -12, 0},
    {"disastrous-ensemble", "Disastrous Peace ensemble", "Pad", kEasterEgg, 1, 0.5f, 0.6f, 0.75f, 0.5f, -12, 4},
    {"disastrous-reverb", "Disastrous Peace reverb", "Pad", kEasterEgg, 1, 0.2f, 0.4f, 0.8f, 0.5f, -12, 2},
};
const int kPresetCount = sizeof(kPresets) / sizeof(kPresets[0]);

uint16_t reverb_buffer[32768];
rings::Part part;
rings::StringSynthPart string_synth;
mi_port::Bridge<kBlock> bridge;
float values[P_COUNT];
std::vector<mp::Param>* params = nullptr;

float silence[kBlock];
float out[kBlock];
float aux[kBlock];

// Notes waiting for their strum
int queue_note[kQueueSize];
int queue_velocity[kQueueSize];
int queue_head = 0;
int queue_count = 0;
int since_strum = kStrumSpacing;

float note = 60.0f;          // the last strummed note
float velocity_dark = 0.0f;  // brightness taken off by the last note's velocity
int applied_model = -1;
int applied_polyphony = -1;
int applied_fx = -1;
// allOff: the output fades over these blocks, then the resonators are cleared
const int kStopBlocks = 10;
int stopping = 0;

int polyphony_of(float option) {
  const int i = int(option + 0.5f);
  return i <= 0 ? 1 : (i == 1 ? 2 : 4);
}

void configure() {
  const int model = int(values[P_MODEL] + 0.5f);
  const int polyphony = polyphony_of(values[P_POLYPHONY]);
  const int fx = int(values[P_FX] + 0.5f);
  if (model != applied_model) {
    if (model < kEasterEgg) part.set_model(static_cast<rings::ResonatorModel>(model));
    applied_model = model;
  }
  if (polyphony != applied_polyphony) {
    part.set_polyphony(polyphony);
    string_synth.set_polyphony(polyphony);
    applied_polyphony = polyphony;
  }
  if (fx != applied_fx) {
    string_synth.set_fx(static_cast<rings::FxType>(fx));
    applied_fx = fx;
  }
}

void reset_parts() {
  part.Init(reverb_buffer);
  string_synth.Init(reverb_buffer);
  applied_model = applied_polyphony = applied_fx = -1;
}

void render_block(float* out_l, float* out_r) {
  configure();
  rings::PerformanceState state;
  state.internal_exciter = true;
  state.internal_strum = false;
  state.internal_note = false;
  state.tonic = 0.0f;
  state.fm = 0.0f;
  state.strum = false;

  if (since_strum < kStrumSpacing) ++since_strum;
  if (queue_count && since_strum >= kStrumSpacing && !stopping) {
    note = float(queue_note[queue_head]);
    const float v = queue_velocity[queue_head] / 127.0f;
    velocity_dark = values[P_VELOCITY] * 0.3f * (1.0f - v);
    queue_head = (queue_head + 1) % kQueueSize;
    --queue_count;
    state.strum = true;
    since_strum = 0;
  }
  state.note = note + values[P_TRANSPOSE] + values[P_FINE] / 100.0f;

  rings::Patch patch;
  patch.structure = values[P_STRUCTURE] > 0.9995f ? 0.9995f : values[P_STRUCTURE];
  float brightness = values[P_BRIGHTNESS] - velocity_dark;
  patch.brightness = brightness < 0.0f ? 0.0f : brightness;
  patch.damping = values[P_DAMPING];
  patch.position = values[P_POSITION];
  // The chord, from Structure, as the module reads it
  int chord = int(patch.structure * float(rings::kNumChords - 1) + 0.5f);
  if (chord > rings::kNumChords - 1) chord = rings::kNumChords - 1;
  state.chord = chord;

  if (applied_model == kEasterEgg) {
    string_synth.Process(state, patch, silence, out, aux, kBlock);
  } else {
    part.Process(state, patch, silence, out, aux, kBlock);
  }
  float volume = values[P_VOLUME];
  // The module sends odd and even voices to its two outputs; Width blends
  // them, so notes are not thrown hard left and right in turn
  const float wide = 0.5f + 0.5f * values[P_WIDTH];
  const float narrow = 1.0f - wide;
  if (stopping) {
    volume *= float(stopping - 1) / float(kStopBlocks);
    if (--stopping == 0) reset_parts();
  }
  for (int i = 0; i < kBlock; ++i) {
    out_l[i] = (out[i] * wide + aux[i] * narrow) * volume;
    out_r[i] = (aux[i] * wide + out[i] * narrow) * volume;
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
      choice("model", "Resonator",
             {"Modal", "Sympathetic strings", "String", "FM voice", "Quantized chords", "String and reverb",
              "Disastrous Peace"},
             0, "Resonator"),
      choice("polyphony", "Polyphony", {"1", "2", "4"}, 2, "Resonator"),
      param("structure", "Structure", 0, 1, 0.001f, 0.45f, "Resonator"),
      param("brightness", "Brightness", 0, 1, 0.001f, 0.6f, "Resonator"),
      param("damping", "Damping", 0, 1, 0.001f, 0.6f, "Resonator"),
      param("position", "Position", 0, 1, 0.001f, 0.3f, "Resonator"),
      param("transpose", "Transpose", -24, 24, 1, 0, "Pitch"),
      param("fine", "Fine tune", -100, 100, 1, 0, "Pitch"),
      param("velocity", "Velocity to brightness", 0, 1, 0.01f, 1, "Pitch"),
      choice("fx", "Easter egg effect", {"Formant", "Chorus", "Reverb", "Formant 2", "Ensemble", "Reverb 2"}, 0,
             "Output"),
      param("width", "Stereo width", 0, 1, 0.001f, 0.5f, "Output"),
      param("volume", "Volume", 0, 1, 0.001f, 0.7f, "Output"),
  };
  params = &d.params;
  for (int i = 0; i < kPresetCount; ++i) d.presets.push_back({kPresets[i].id, kPresets[i].name, kPresets[i].tag});

  std::memset(silence, 0, sizeof silence);
  reset_parts();
  set_defaults();
  configure();
  bridge.Init(kModuleRate, sample_rate);
}

void port_render(const float*, const float*, float* out_l, float* out_r, int frames) {
  bridge.Render(out_l, out_r, frames, render_block);
}

void port_note_on(int n, int velocity) {
  if (queue_count >= kQueueSize) return;
  const int at = (queue_head + queue_count) % kQueueSize;
  queue_note[at] = n;
  queue_velocity[at] = velocity;
  ++queue_count;
}

void port_note_off(int) {}

// The module has no way to stop ringing but Damping: all-off fades the
// output out over 5 ms and clears the resonators
void port_all_off() {
  queue_count = 0;
  if (!stopping) stopping = kStopBlocks;
}

void port_set_param(int index, float value) { values[index] = value; }
float port_get_param(int index) { return values[index]; }

void port_load_preset(int index) {
  const PresetDef& p = kPresets[index];
  set_defaults();
  values[P_MODEL] = float(p.model);
  values[P_POLYPHONY] = float(p.polyphony);
  values[P_STRUCTURE] = p.structure;
  values[P_BRIGHTNESS] = p.brightness;
  values[P_DAMPING] = p.damping;
  values[P_POSITION] = p.position;
  values[P_TRANSPOSE] = float(p.transpose);
  values[P_FX] = float(p.fx);
}
