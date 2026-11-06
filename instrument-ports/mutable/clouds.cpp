// Clouds (Mutable Instruments texture synthesizer) as an audio effect:
// clouds::GranularProcessor at the module's 32 kHz in 32-frame blocks, with
// the module's two buffers (block_mem and block_ccm in clouds.cc). The input
// is converted from the audio context's rate to 32 kHz and the output back;
// the output side starts with a block of latency so it never runs dry.
//
// Notes are not played: a note-on fires the TRIG input for one block (a new
// grain in Granular mode, a resync in Looping delay mode), and any key held
// is the GATE input. FREEZE is a parameter.

#include "port.h"

#include <cmath>
#include <cstring>

#include "clouds/dsp/frame.h"
#include "clouds/dsp/granular_processor.h"
#include "shared/resampler.h"

namespace {

using namespace clouds;

const int kBlock = 32;  // clouds.cc codec.Start(32, ...)
const double kModuleRate = 32000.0;

enum ParamId {
  P_MODE,
  P_QUALITY,
  P_POSITION,
  P_SIZE,
  P_PITCH,
  P_DENSITY,
  P_TEXTURE,
  P_BLEND,
  P_SPREAD,
  P_FEEDBACK,
  P_REVERB,
  P_FREEZE,
  P_INPUT,
  P_COUNT
};

struct PresetDef {
  const char* id;
  const char* name;
  const char* tag;
  int mode, quality;
  float position, size, pitch, density, texture, blend, spread, feedback, reverb;
  int freeze;
};

const PresetDef kPresets[] = {
    {"granular", "Granular", "Granular", 0, 0, 0.3f, 0.5f, 0, 0.75f, 0.5f, 0.6f, 0.5f, 0.1f, 0.3f, 0},
    {"stretch", "Pitch shifter and time stretcher", "Stretch", 1, 0, 0.2f, 0.5f, 0, 0.5f, 0.5f, 0.6f, 0.3f, 0.1f, 0.25f, 0},
    {"looping-delay", "Looping delay", "Delay", 2, 0, 0.4f, 0.5f, 0, 0.2f, 0.5f, 0.5f, 0.4f, 0.45f, 0.2f, 0},
    {"spectral", "Spectral", "Spectral", 3, 0, 0.3f, 0.5f, 0, 0.5f, 0.4f, 0.65f, 0.5f, 0.1f, 0.3f, 0},
    {"frozen-pad", "Frozen pad", "Granular", 0, 0, 0.5f, 0.7f, 0, 0.8f, 0.6f, 0.85f, 0.8f, 0.0f, 0.6f, 1},
    {"shimmer", "Shimmer reverb", "Delay", 2, 0, 0.6f, 0.8f, 12, 0.3f, 0.55f, 0.5f, 0.7f, 0.5f, 0.85f, 0},
    {"sparse-grains", "Sparse grains", "Granular", 0, 0, 0.6f, 0.3f, 0, 0.25f, 0.4f, 0.7f, 0.9f, 0.0f, 0.4f, 0},
    {"octave-down", "Octave down cloud", "Granular", 0, 0, 0.2f, 0.6f, -12, 0.7f, 0.6f, 0.6f, 0.6f, 0.2f, 0.4f, 0},
    {"tape-echo", "Lo-fi tape echo", "Delay", 2, 3, 0.55f, 0.6f, 0, 0.0f, 0.35f, 0.45f, 0.2f, 0.55f, 0.15f, 0},
    {"spectral-freeze", "Spectral freeze", "Spectral", 3, 0, 0.5f, 0.5f, 0, 0.3f, 0.2f, 0.9f, 0.6f, 0.0f, 0.5f, 1},
    {"diffuse-wash", "Diffuse wash", "Stretch", 1, 0, 0.5f, 0.8f, 0, 0.9f, 0.6f, 0.75f, 0.8f, 0.3f, 0.7f, 0},
};
const int kPresetCount = sizeof(kPresets) / sizeof(kPresets[0]);

uint8_t block_mem[118784];
uint8_t block_ccm[65536 - 128];
GranularProcessor processor;
mi_port::Resampler input_resampler;   // context rate -> 32 kHz
mi_port::Resampler output_resampler;  // 32 kHz -> context rate
ShortFrame input_block[kBlock];
ShortFrame output_block[kBlock];
int input_fill = 0;
float values[P_COUNT];
float smoothed[P_COUNT];
std::vector<mp::Param>* params = nullptr;
bool trigger_pending = false;
int keys_held = 0;

inline int16_t to_short(float x) {
  x *= 32768.0f;
  if (x > 32767.0f) x = 32767.0f;
  if (x < -32768.0f) x = -32768.0f;
  return int16_t(x);
}

void process_block() {
  // The knobs, smoothed like the module's CV scaler
  const int continuous[] = {P_POSITION, P_SIZE, P_PITCH, P_DENSITY, P_TEXTURE,
                            P_BLEND,    P_SPREAD, P_FEEDBACK, P_REVERB};
  for (int p : continuous) smoothed[p] += 0.05f * (values[p] - smoothed[p]);

  processor.set_playback_mode(static_cast<PlaybackMode>(int(values[P_MODE] + 0.5f)));
  processor.set_quality(int(values[P_QUALITY] + 0.5f));
  Parameters* p = processor.mutable_parameters();
  p->position = smoothed[P_POSITION];
  p->size = smoothed[P_SIZE];
  p->pitch = smoothed[P_PITCH];
  p->density = smoothed[P_DENSITY];
  p->texture = smoothed[P_TEXTURE];
  p->dry_wet = smoothed[P_BLEND];
  p->stereo_spread = smoothed[P_SPREAD];
  p->feedback = smoothed[P_FEEDBACK];
  p->reverb = smoothed[P_REVERB];
  p->freeze = values[P_FREEZE] > 0.5f;
  p->trigger = trigger_pending;
  p->gate = keys_held > 0;
  trigger_pending = false;

  processor.Process(input_block, output_block, kBlock);
  processor.Prepare();
  for (int i = 0; i < kBlock; ++i) {
    output_resampler.Push(output_block[i].l / 32768.0f, output_block[i].r / 32768.0f);
  }
}

void prime() {
  input_resampler.Reset();
  output_resampler.Reset();
  input_fill = 0;
  // A block and a kernel of silence ahead: the output never waits for a block
  for (int i = 0; i < kBlock + mi_port::Resampler::kTaps; ++i) output_resampler.Push(0.0f, 0.0f);
}

void set_defaults() {
  for (int i = 0; i < P_COUNT; ++i) values[i] = (*params)[i].def;
}

}  // namespace

void port_init(float sample_rate, mp::Description& d) {
  using mp::choice;
  using mp::param;
  d.params = {
      choice("mode", "Mode", {"Granular", "Stretch", "Looping delay", "Spectral"}, 0, "Mode"),
      choice("quality", "Quality", {"Stereo hi-fi", "Mono hi-fi", "Stereo lo-fi", "Mono lo-fi"}, 0, "Mode"),
      param("position", "Position", 0, 1, 0.001f, 0.3f, "Grains"),
      param("size", "Size", 0, 1, 0.001f, 0.5f, "Grains"),
      param("pitch", "Pitch", -24, 24, 0.01f, 0, "Grains"),
      param("density", "Density", 0, 1, 0.001f, 0.75f, "Grains"),
      param("texture", "Texture", 0, 1, 0.001f, 0.5f, "Grains"),
      param("blend", "Dry/wet", 0, 1, 0.001f, 0.6f, "Blend"),
      param("spread", "Stereo spread", 0, 1, 0.001f, 0.5f, "Blend"),
      param("feedback", "Feedback", 0, 1, 0.001f, 0.1f, "Blend"),
      param("reverb", "Reverb", 0, 1, 0.001f, 0.3f, "Blend"),
      choice("freeze", "Freeze", {"Off", "On"}, 0, "Blend"),
      param("input", "Input gain", 0, 2, 0.01f, 1, "Blend"),
  };
  params = &d.params;
  for (int i = 0; i < kPresetCount; ++i) d.presets.push_back({kPresets[i].id, kPresets[i].name, kPresets[i].tag});

  std::memset(block_mem, 0, sizeof block_mem);
  std::memset(block_ccm, 0, sizeof block_ccm);
  processor.Init(block_mem, sizeof block_mem, block_ccm, sizeof block_ccm);
  set_defaults();
  for (int i = 0; i < P_COUNT; ++i) smoothed[i] = values[i];
  processor.set_playback_mode(PLAYBACK_MODE_GRANULAR);
  processor.set_quality(0);
  processor.Prepare();
  input_resampler.Init(sample_rate, kModuleRate);
  output_resampler.Init(kModuleRate, sample_rate);
  prime();
}

void port_render(const float* in_l, const float* in_r, float* out_l, float* out_r, int frames) {
  const float gain = values[P_INPUT];
  for (int i = 0; i < frames; ++i) {
    input_resampler.Push(in_l[i] * gain, in_r[i] * gain);
    while (input_resampler.Available()) {
      float l, r;
      input_resampler.Pull(&l, &r);
      input_block[input_fill].l = to_short(l);
      input_block[input_fill].r = to_short(r);
      if (++input_fill == kBlock) {
        input_fill = 0;
        process_block();
      }
    }
    if (output_resampler.Available()) {
      output_resampler.Pull(&out_l[i], &out_r[i]);
    } else {
      out_l[i] = out_r[i] = 0.0f;
    }
  }
}

void port_note_on(int, int) {
  trigger_pending = true;
  ++keys_held;
}
void port_note_off(int) {
  if (keys_held > 0) --keys_held;
}
void port_all_off() { keys_held = 0; }
void port_set_param(int index, float value) { values[index] = value; }
float port_get_param(int index) { return values[index]; }

void port_load_preset(int index) {
  const PresetDef& p = kPresets[index];
  const float input = values[P_INPUT];
  set_defaults();
  values[P_INPUT] = input;
  values[P_MODE] = float(p.mode);
  values[P_QUALITY] = float(p.quality);
  values[P_POSITION] = p.position;
  values[P_SIZE] = p.size;
  values[P_PITCH] = p.pitch;
  values[P_DENSITY] = p.density;
  values[P_TEXTURE] = p.texture;
  values[P_BLEND] = p.blend;
  values[P_SPREAD] = p.spread;
  values[P_FEEDBACK] = p.feedback;
  values[P_REVERB] = p.reverb;
  values[P_FREEZE] = float(p.freeze);
}
