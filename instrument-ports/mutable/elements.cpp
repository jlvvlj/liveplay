// Elements (Mutable Instruments modal synthesis voice) as a monophonic
// instrument: elements::Part at the module's 32 kHz in its 16-frame blocks,
// with its 64 KB reverb buffer, converted to the audio context's rate.
//
// A note sets the pitch and holds the gate while its key is down; velocity is
// the module's STRENGTH (pressure) input. A new note while another is held
// drops the gate for one block and raises it again, so every key restarts the
// exciter as on a keyboard. Releasing the newest key returns to the one still
// held before it, without a new attack.
//
// The fourth resonator choice is the module's Ominous voice easter egg. Its
// strength input also opens its VCA (a pressure drone on the module); here
// that happens only while a key is held.

#include "port.h"

#include <cmath>
#include <cstring>

#include "elements/dsp/dsp.h"
#include "elements/dsp/part.h"
#include "elements/dsp/patch.h"
#include "shared/resampler.h"

namespace {

const int kBlock = elements::kMaxBlockSize;  // 16 frames, as the module's codec runs
const double kModuleRate = elements::kSampleRate;
const int kOminous = 3;
const int kStack = 16;

enum ParamId {
  P_MODEL,
  P_CONTOUR,
  P_BOW_LEVEL,
  P_BOW_TIMBRE,
  P_BLOW_LEVEL,
  P_FLOW,
  P_BLOW_TIMBRE,
  P_STRIKE_LEVEL,
  P_MALLET,
  P_STRIKE_TIMBRE,
  P_GEOMETRY,
  P_BRIGHTNESS,
  P_DAMPING,
  P_POSITION,
  P_SPACE,
  P_TRANSPOSE,
  P_FINE,
  P_VELOCITY,
  P_VOLUME,
  P_COUNT
};

struct PresetDef {
  const char* id;
  const char* name;
  const char* tag;
  int model;
  float contour, bow, bow_timbre, blow, flow, blow_timbre, strike, mallet, strike_timbre;
  float geometry, brightness, damping, position, space;
  int transpose;
};

const PresetDef kPresets[] = {
    // id, name, tag, model, contour, bow, bow timbre, blow, flow, blow timbre, strike, mallet, strike timbre,
    // geometry, brightness, damping, position, space, transpose
    {"struck-bell", "Struck bell", "Bell", 0, 1.0f, 0, 0.5f, 0, 0.5f, 0.5f, 0.8f, 0.5f, 0.5f,
     0.75f, 0.65f, 0.6f, 0.3f, 0.5f, 0},
    {"mallet", "Wooden mallet", "Mallet", 0, 1.0f, 0, 0.5f, 0, 0.5f, 0.5f, 0.8f, 0.25f, 0.35f,
     0.2f, 0.4f, 0.35f, 0.25f, 0.3f, 0},
    {"plucked-string", "Plucked string", "Pluck", 1, 1.0f, 0, 0.5f, 0, 0.5f, 0.5f, 0.8f, 0.75f, 0.6f,
     0.3f, 0.55f, 0.45f, 0.3f, 0.35f, 0},
    {"bowed-string", "Bowed string", "Strings", 1, 0.55f, 0.8f, 0.45f, 0, 0.5f, 0.5f, 0, 0.5f, 0.5f,
     0.25f, 0.5f, 0.6f, 0.3f, 0.45f, 0},
    {"bowed-glass", "Bowed glass", "Pad", 0, 0.5f, 0.75f, 0.6f, 0, 0.5f, 0.5f, 0, 0.5f, 0.5f,
     0.85f, 0.7f, 0.7f, 0.5f, 0.65f, 0},
    {"blown-pipe", "Blown pipe", "Wind", 0, 0.5f, 0, 0.5f, 0.8f, 0.5f, 0.4f, 0, 0.5f, 0.5f,
     0.15f, 0.45f, 0.55f, 0.2f, 0.4f, 0},
    {"breathy-flute", "Breathy flute", "Wind", 1, 0.45f, 0, 0.5f, 0.85f, 0.7f, 0.6f, 0, 0.5f, 0.5f,
     0.35f, 0.6f, 0.5f, 0.4f, 0.5f, 12},
    {"sympathetic-strings", "Sympathetic strings", "Strings", 2, 1.0f, 0, 0.5f, 0, 0.5f, 0.5f, 0.8f, 0.6f, 0.5f,
     0.5f, 0.55f, 0.65f, 0.3f, 0.55f, 0},
    {"gong", "Gong", "Bell", 0, 1.0f, 0, 0.5f, 0, 0.5f, 0.5f, 0.9f, 0.1f, 0.7f,
     0.95f, 0.5f, 0.75f, 0.6f, 0.7f, -12},
    {"drone-space", "Frozen space", "Pad", 0, 0.3f, 0.5f, 0.5f, 0.4f, 0.5f, 0.5f, 0.3f, 0.5f, 0.5f,
     0.6f, 0.55f, 0.8f, 0.5f, 1.2f, 0},
    {"ominous", "Ominous voice", "Pad", kOminous, 0.5f, 0, 0.5f, 0.6f, 0.5f, 0.5f, 0.5f, 0.5f, 0.5f,
     0.4f, 0.5f, 0.6f, 0.4f, 0.5f, -12},
};
const int kPresetCount = sizeof(kPresets) / sizeof(kPresets[0]);

uint16_t reverb_buffer[32768];
elements::Part part;
mi_port::Bridge<kBlock> bridge;
float values[P_COUNT];
std::vector<mp::Param>* params = nullptr;

float silence[kBlock];
float main_out[kBlock];
float aux_out[kBlock];

// Keys held, oldest first
int held[kStack];
int held_velocity[kStack];
int held_count = 0;
bool retrigger = false;  // drop the gate for one block
float note = 60.0f;
float strength = 0.8f;
float ominous_strength = 0.0f;  // the easter egg's strength, slewed to 0 when no key is held

void apply_patch() {
  elements::Patch* p = part.mutable_patch();
  auto unit = [](float v) { return v > 0.9995f ? 0.9995f : v; };
  p->exciter_envelope_shape = values[P_CONTOUR];
  p->exciter_bow_level = values[P_BOW_LEVEL];
  p->exciter_bow_timbre = unit(values[P_BOW_TIMBRE]);
  p->exciter_blow_level = values[P_BLOW_LEVEL];
  p->exciter_blow_meta = unit(values[P_FLOW]);
  p->exciter_blow_timbre = unit(values[P_BLOW_TIMBRE]);
  p->exciter_strike_level = values[P_STRIKE_LEVEL];
  p->exciter_strike_meta = unit(values[P_MALLET]);
  p->exciter_strike_timbre = values[P_STRIKE_TIMBRE] > 0.995f ? 0.995f : values[P_STRIKE_TIMBRE];
  p->resonator_geometry = unit(values[P_GEOMETRY]);
  p->resonator_brightness = unit(values[P_BRIGHTNESS]);
  p->resonator_damping = unit(values[P_DAMPING]);
  p->resonator_position = unit(values[P_POSITION]);
  p->space = values[P_SPACE];
  const int model = int(values[P_MODEL] + 0.5f);
  part.set_easter_egg(model == kOminous);
  if (model != kOminous) part.set_resonator_model(static_cast<elements::ResonatorModel>(model));
}

void render_block(float* out_l, float* out_r) {
  apply_patch();
  elements::PerformanceState state;
  state.gate = held_count > 0 && !retrigger;
  retrigger = false;
  state.note = note + values[P_TRANSPOSE] + values[P_FINE] / 100.0f;
  state.modulation = 0.0f;
  state.strength = strength;
  if (int(values[P_MODEL] + 0.5f) == kOminous) {
    // Its strength is also a level offset, a drone while pressure is applied:
    // here, only while a key is held
    const float target = held_count > 0 ? strength : 0.0f;
    ominous_strength += 0.03f * (target - ominous_strength);
    state.strength = ominous_strength;
  }
  part.Process(state, silence, silence, main_out, aux_out, kBlock);
  const float volume = values[P_VOLUME];
  for (int i = 0; i < kBlock; ++i) {
    // The module's main out is its right channel, aux its left
    out_l[i] = aux_out[i] * volume;
    out_r[i] = main_out[i] * volume;
  }
}

void set_defaults() {
  for (int i = 0; i < P_COUNT; ++i) values[i] = (*params)[i].def;
}

void play(int n, int velocity, bool attack) {
  note = float(n);
  const float v = velocity / 127.0f;
  strength = 1.0f - values[P_VELOCITY] * (1.0f - v) * 0.8f;
  if (attack && held_count > 0) retrigger = true;
}

}  // namespace

void port_init(float sample_rate, mp::Description& d) {
  using mp::choice;
  using mp::param;
  d.params = {
      choice("model", "Resonator", {"Modal", "String", "Strings", "Ominous voice"}, 0, "Resonator"),
      param("contour", "Contour", 0, 1, 0.001f, 1.0f, "Exciter"),
      param("bowLevel", "Bow", 0, 1, 0.001f, 0, "Exciter"),
      param("bowTimbre", "Bow timbre", 0, 1, 0.001f, 0.5f, "Exciter"),
      param("blowLevel", "Blow", 0, 1, 0.001f, 0, "Exciter"),
      param("flow", "Flow", 0, 1, 0.001f, 0.5f, "Exciter"),
      param("blowTimbre", "Blow timbre", 0, 1, 0.001f, 0.5f, "Exciter"),
      param("strikeLevel", "Strike", 0, 1, 0.001f, 0.8f, "Exciter"),
      param("mallet", "Mallet", 0, 1, 0.001f, 0.5f, "Exciter"),
      param("strikeTimbre", "Strike timbre", 0, 1, 0.001f, 0.5f, "Exciter"),
      param("geometry", "Geometry", 0, 1, 0.001f, 0.2f, "Resonator"),
      param("brightness", "Brightness", 0, 1, 0.001f, 0.5f, "Resonator"),
      param("damping", "Damping", 0, 1, 0.001f, 0.25f, "Resonator"),
      param("position", "Position", 0, 1, 0.001f, 0.3f, "Resonator"),
      param("space", "Space", 0, 2, 0.001f, 0.5f, "Space"),
      param("transpose", "Transpose", -24, 24, 1, 0, "Pitch"),
      param("fine", "Fine tune", -100, 100, 1, 0, "Pitch"),
      param("velocity", "Velocity to strength", 0, 1, 0.01f, 1, "Pitch"),
      param("volume", "Volume", 0, 1, 0.001f, 0.7f, "Space"),
  };
  params = &d.params;
  for (int i = 0; i < kPresetCount; ++i) d.presets.push_back({kPresets[i].id, kPresets[i].name, kPresets[i].tag});

  std::memset(silence, 0, sizeof silence);
  part.Init(reverb_buffer);
  // The module seeds its resonator modulation, reverb colour and exciter
  // signature from the chip's serial number; a fixed one here
  uint32_t seed[3] = {0x4d454c4f, 0x44494353, 0x31303030};
  part.Seed(seed, 3);
  set_defaults();
  apply_patch();
  bridge.Init(kModuleRate, sample_rate);
}

void port_render(const float*, const float*, float* out_l, float* out_r, int frames) {
  bridge.Render(out_l, out_r, frames, render_block);
}

void port_note_on(int n, int velocity) {
  // Taken out of the stack if it was there, then on top
  int w = 0;
  for (int i = 0; i < held_count; ++i) {
    if (held[i] != n) {
      held[w] = held[i];
      held_velocity[w] = held_velocity[i];
      ++w;
    }
  }
  held_count = w;
  play(n, velocity, true);
  if (held_count == kStack) {
    for (int i = 1; i < kStack; ++i) {
      held[i - 1] = held[i];
      held_velocity[i - 1] = held_velocity[i];
    }
    --held_count;
  }
  held[held_count] = n;
  held_velocity[held_count] = velocity;
  ++held_count;
}

void port_note_off(int n) {
  const bool top = held_count > 0 && held[held_count - 1] == n;
  int w = 0;
  for (int i = 0; i < held_count; ++i) {
    if (held[i] != n) {
      held[w] = held[i];
      held_velocity[w] = held_velocity[i];
      ++w;
    }
  }
  held_count = w;
  if (top && held_count > 0) play(held[held_count - 1], held_velocity[held_count - 1], false);
}

void port_all_off() {
  held_count = 0;
  retrigger = false;
}

void port_set_param(int index, float value) { values[index] = value; }
float port_get_param(int index) { return values[index]; }

void port_load_preset(int index) {
  const PresetDef& p = kPresets[index];
  set_defaults();
  values[P_MODEL] = float(p.model);
  values[P_CONTOUR] = p.contour;
  values[P_BOW_LEVEL] = p.bow;
  values[P_BOW_TIMBRE] = p.bow_timbre;
  values[P_BLOW_LEVEL] = p.blow;
  values[P_FLOW] = p.flow;
  values[P_BLOW_TIMBRE] = p.blow_timbre;
  values[P_STRIKE_LEVEL] = p.strike;
  values[P_MALLET] = p.mallet;
  values[P_STRIKE_TIMBRE] = p.strike_timbre;
  values[P_GEOMETRY] = p.geometry;
  values[P_BRIGHTNESS] = p.brightness;
  values[P_DAMPING] = p.damping;
  values[P_POSITION] = p.position;
  values[P_SPACE] = p.space;
  values[P_TRANSPOSE] = float(p.transpose);
}
