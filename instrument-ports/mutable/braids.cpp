// Braids (Mutable Instruments macro oscillator) as a polyphonic instrument:
// up to 8 copies of braids::MacroOscillator, each rendered at the module's
// 96 kHz in 24-frame blocks with the firmware's block processing (braids.cc
// RenderBlock): AD envelope to timbre, colour, pitch and VCA, VCO drift, bit
// and sample rate reduction, signature waveshaper. The mix is converted to
// the audio context's rate.
//
// Strike() and the AD envelope's attack happen when a key goes down, like a
// trigger on the module. The VCA has two modes:
// - Gate: opens with the key at the AD attack time, stays open while the key
//   is held, closes at the AD decay time when it is released;
// - AD: the firmware's AD VCA, the key's length does not matter.
// Velocity scales the voice's level.

#include "port.h"

#include <cmath>
#include <cstring>

#include "braids/envelope.h"
#include "braids/macro_oscillator.h"
#include "braids/resources.h"
#include "braids/signature_waveshaper.h"
#include "braids/vco_jitter_source.h"
#include "shared/resampler.h"
#include "shared/voices.h"
#include "stmlib/utils/dsp.h"

namespace {

using namespace braids;

const int kMaxVoices = 8;
const int kBlock = 24;  // braids.cc kBlockSize
const double kModuleRate = 96000.0;

enum ParamId {
  P_SHAPE,
  P_TIMBRE,
  P_COLOR,
  P_TRANSPOSE,
  P_FINE,
  P_VCA,
  P_ATTACK,
  P_DECAY,
  P_AD_TIMBRE,
  P_AD_COLOR,
  P_AD_FM,
  P_BITS,
  P_RATE,
  P_SIGNATURE,
  P_DRIFT,
  P_VELOCITY,
  P_SPREAD,
  P_VOICES,
  P_VOLUME,
  P_COUNT
};

// The firmware's shapes, in its order (settings.cc algo_values)
const char* kShapes[] = {
    "CSaw",              "Triangle-saw-square morph", "Saw-square",         "Sine-triangle fold",
    "Buzz",              "Square sub",                "Saw sub",            "Square sync",
    "Saw sync",          "Triple saw",                "Triple square",      "Triple triangle",
    "Triple sine",       "Triple ring mod",           "Saw swarm",          "Saw comb",
    "Toy",               "Digital low-pass",          "Digital peak",       "Digital band-pass",
    "Digital high-pass", "VOSIM",                     "Vowel",              "Vowel FOF",
    "Harmonics",         "FM",                        "Feedback FM",        "Chaotic feedback FM",
    "Plucked",           "Bowed",                     "Blown",              "Fluted",
    "Struck bell",       "Struck drum",               "Kick",               "Cymbal",
    "Snare",             "Wavetables",                "Wave map",           "Wave line",
    "Paraphonic wavetable", "Filtered noise",         "Twin peaks noise",   "Clocked noise",
    "Granular cloud",    "Particle noise",            "Digital modulation"};
const int kShapeCount = sizeof(kShapes) / sizeof(kShapes[0]);
static_assert(kShapeCount == MACRO_OSC_SHAPE_LAST - 1, "one name per shape");

const uint16_t kBitMasks[] = {0xc000, 0xe000, 0xf000, 0xf800, 0xff00, 0xfff0, 0xffff};
const uint16_t kDecimation[] = {24, 12, 6, 4, 3, 2, 1};

struct PresetDef {
  const char* id;
  const char* name;
  const char* tag;
  int shape;
  float timbre, color;
  int vca, attack, decay, ad_timbre, ad_color, ad_fm;
  int transpose;
};

const PresetDef kPresets[] = {
    {"csaw-lead", "CSaw lead", "Lead", 0, 0.3f, 0.5f, 0, 0, 6, 0, 0, 0, 0},
    {"morph-bass", "Morph bass", "Bass", 1, 0.6f, 0.3f, 0, 0, 5, 6, 0, 0, -12},
    {"saw-square", "Saw to square", "Lead", 2, 0.5f, 0.4f, 0, 0, 6, 0, 0, 0, 0},
    {"fold", "Wavefolder", "Lead", 3, 0.45f, 0.6f, 0, 1, 7, 5, 0, 0, 0},
    {"buzz", "Buzz", "Lead", 4, 0.4f, 0.5f, 0, 0, 6, 0, 0, 0, 0},
    {"square-sub", "Square with sub", "Bass", 5, 0.5f, 0.6f, 0, 0, 5, 0, 0, 0, -12},
    {"saw-sync", "Sync lead", "Lead", 8, 0.4f, 0.5f, 0, 0, 7, 0, 6, 0, 0},
    {"triple-saw", "Triple saw chord", "Pad", 9, 0.6f, 0.7f, 0, 4, 9, 0, 0, 0, -12},
    {"triple-sine", "Triple sine organ", "Keys", 12, 0.5f, 0.6f, 0, 0, 6, 0, 0, 0, 0},
    {"ring-mod", "Ring modulator", "FX", 13, 0.5f, 0.45f, 0, 0, 6, 0, 0, 0, 0},
    {"swarm", "Saw swarm", "Pad", 14, 0.5f, 0.5f, 0, 5, 10, 0, 0, 0, -12},
    {"comb", "Saw comb", "Lead", 15, 0.5f, 0.6f, 0, 0, 6, 0, 0, 0, 0},
    {"toy", "Toy", "FX", 16, 0.5f, 0.5f, 0, 0, 5, 0, 0, 0, 0},
    {"lpf", "Digital filter bass", "Bass", 17, 0.35f, 0.6f, 0, 0, 5, 7, 0, 0, -12},
    {"vosim", "VOSIM voice", "Voice", 21, 0.5f, 0.5f, 0, 0, 6, 0, 0, 0, 0},
    {"vowel", "Vowels", "Voice", 22, 0.4f, 0.5f, 0, 0, 6, 0, 0, 0, 0},
    {"fof", "Vowel FOF", "Voice", 23, 0.5f, 0.5f, 0, 0, 6, 0, 0, 0, 0},
    {"harmonics", "Harmonic organ", "Keys", 24, 0.4f, 0.5f, 0, 0, 6, 0, 0, 0, 0},
    {"fm", "FM bell", "Keys", 25, 0.4f, 0.55f, 1, 0, 9, 6, 0, 0, 0},
    {"feedback-fm", "Feedback FM", "Lead", 26, 0.45f, 0.5f, 0, 0, 6, 4, 0, 0, 0},
    {"chaotic-fm", "Chaotic FM", "FX", 27, 0.5f, 0.5f, 0, 0, 6, 0, 0, 0, 0},
    {"plucked", "Plucked string", "Pluck", 28, 0.5f, 0.5f, 1, 0, 10, 0, 0, 0, 0},
    {"bowed", "Bowed string", "Strings", 29, 0.5f, 0.5f, 0, 3, 8, 0, 0, 0, 0},
    {"blown", "Blown reed", "Wind", 30, 0.5f, 0.5f, 0, 2, 7, 0, 0, 0, 0},
    {"fluted", "Flute", "Wind", 31, 0.5f, 0.5f, 0, 2, 7, 0, 0, 0, 0},
    {"bell", "Struck bell", "Keys", 32, 0.5f, 0.5f, 1, 0, 12, 0, 0, 0, 0},
    {"drum", "Struck drum", "Drum", 33, 0.5f, 0.5f, 1, 0, 9, 0, 0, 0, -12},
    {"kick", "Kick", "Drum", 34, 0.5f, 0.5f, 1, 0, 10, 0, 0, 0, -24},
    {"cymbal", "Cymbal", "Drum", 35, 0.5f, 0.5f, 1, 0, 10, 0, 0, 0, 0},
    {"snare", "Snare", "Drum", 36, 0.5f, 0.5f, 1, 0, 9, 0, 0, 0, -12},
    {"wavetables", "Wavetables", "Pad", 37, 0.3f, 0.5f, 0, 2, 8, 5, 0, 0, 0},
    {"wave-map", "Wave map", "Pad", 38, 0.4f, 0.4f, 0, 2, 8, 0, 4, 0, 0},
    {"wave-line", "Wave line", "Lead", 39, 0.5f, 0.5f, 0, 0, 6, 0, 0, 0, 0},
    {"paraphonic", "Paraphonic chords", "Pad", 40, 0.5f, 0.3f, 0, 3, 9, 0, 0, 0, -12},
    {"filtered-noise", "Filtered noise", "FX", 41, 0.5f, 0.6f, 0, 0, 6, 0, 0, 0, 0},
    {"twin-peaks", "Twin peaks noise", "FX", 42, 0.5f, 0.5f, 0, 0, 6, 0, 0, 0, 0},
    {"clocked-noise", "Clocked noise", "FX", 43, 0.5f, 0.5f, 0, 0, 6, 0, 0, 0, 0},
    {"granular", "Granular cloud", "Pad", 44, 0.5f, 0.5f, 0, 3, 9, 0, 0, 0, 0},
    {"particles", "Particle noise", "FX", 45, 0.5f, 0.5f, 0, 0, 7, 0, 0, 0, 0},
    {"qpsk", "Digital modulation", "FX", 46, 0.5f, 0.5f, 0, 0, 6, 0, 0, 0, 0},
};
const int kPresetCount = sizeof(kPresets) / sizeof(kPresets[0]);

// The Gate VCA: the firmware envelope's curve and times, holding while the key is
class GateEnvelope {
 public:
  void Init() {
    value_ = 0;
    a_ = b_ = 0;
    phase_ = 0;
    segment_ = 3;
  }
  void Update(int attack, int release) {
    increment_[0] = lut_env_portamento_increments[attack];
    increment_[2] = lut_env_portamento_increments[release];
  }
  void Open() { Start(0, 65535); }
  void Close() {
    if (segment_ < 2) Start(2, 0);
  }
  uint16_t Render() {
    if (segment_ == 0 || segment_ == 2) {
      const uint32_t increment = increment_[segment_];
      phase_ += increment;
      if (phase_ < increment) {
        value_ = b_;
        segment_ = segment_ == 0 ? 1 : 3;
      } else {
        value_ = stmlib::Mix(a_, b_, stmlib::Interpolate824(lut_env_expo, phase_));
      }
    }
    return value_;
  }

 private:
  void Start(int segment, uint16_t target) {
    a_ = value_;
    b_ = target;
    segment_ = segment;
    phase_ = 0;
  }
  uint32_t increment_[3];
  uint32_t phase_;
  uint16_t a_, b_, value_;
  int segment_;
};

struct BraidsVoice {
  MacroOscillator osc;
  Envelope envelope;
  GateEnvelope gate;
  VcoJitterSource jitter;
  uint16_t gain_lp;
  float fade_gain;
  int16_t render_buffer[kBlock];
  uint8_t sync_buffer[kBlock];
};

BraidsVoice voices[kMaxVoices];
SignatureWaveshaper ws;
mi_port::VoiceAllocator<kMaxVoices> allocator;
mi_port::Bridge<kBlock> bridge;
float values[P_COUNT];
std::vector<mp::Param>* params = nullptr;

inline int iv(int p) { return int(values[p] + 0.5f); }

void render_block(float* out_l, float* out_r) {
  for (int k = 0; k < kBlock; ++k) out_l[k] = out_r[k] = 0.0f;
  allocator.set_voices(iv(P_VOICES));
  allocator.BeginBlock();

  const MacroOscillatorShape shape = static_cast<MacroOscillatorShape>(iv(P_SHAPE));
  const int attack = iv(P_ATTACK) * 8;
  const int decay = iv(P_DECAY) * 8;
  const bool ad_vca = iv(P_VCA) == 1;
  const int ad_timbre = iv(P_AD_TIMBRE);
  const int ad_color = iv(P_AD_COLOR);
  const int ad_fm = iv(P_AD_FM);
  const int base_parameters[2] = {int(values[P_TIMBRE] * 32767.0f), int(values[P_COLOR] * 32767.0f)};
  const size_t decimation = kDecimation[iv(P_RATE)];
  const uint16_t bit_mask = kBitMasks[iv(P_BITS)];
  const uint16_t signature = uint16_t(iv(P_SIGNATURE) * iv(P_SIGNATURE) * 4095);
  const int drift = iv(P_DRIFT);
  const int32_t transposition = int32_t(std::lround((values[P_TRANSPOSE] + values[P_FINE] / 100.0f) * 128.0f));
  const float spread = values[P_SPREAD];
  const float volume = values[P_VOLUME] / 32768.0f;
  const float sensitivity = values[P_VELOCITY];
  const int count = allocator.voices();

  for (int v = 0; v < kMaxVoices; ++v) {
    BraidsVoice& voice = voices[v];
    if (!allocator.active(v)) {
      allocator.EndBlock(v, 0.0f);
      continue;
    }
    const auto& s = allocator.slot(v);
    if (s.start) {
      voice.osc.Strike();
      voice.envelope.Trigger(ENV_SEGMENT_ATTACK);
      voice.gate.Open();
    }
    if (!s.gate && !s.start) voice.gate.Close();

    voice.envelope.Update(attack, decay);
    voice.gate.Update(attack, decay);
    const uint32_t ad_value = voice.envelope.Render();
    const uint32_t gate_value = voice.gate.Render();

    voice.osc.set_shape(shape);
    int16_t parameters[2];
    const int amounts[2] = {ad_timbre, ad_color};
    for (int i = 0; i < 2; ++i) {
      int32_t value = base_parameters[i];
      value += ad_value * amounts[i] >> 5;
      CONSTRAIN(value, 0, 32767);
      parameters[i] = int16_t(value);
    }
    voice.osc.set_parameters(parameters[0], parameters[1]);

    int32_t pitch = (s.note >= 0 ? s.note : 60) << 7;
    pitch += transposition;
    pitch += voice.jitter.Render(drift);
    pitch += ad_value * ad_fm >> 7;
    CONSTRAIN(pitch, 0, 16383);
    voice.osc.set_pitch(int16_t(pitch));

    voice.osc.Render(voice.sync_buffer, voice.render_buffer, kBlock);

    // The firmware's sample rate and bit reduction, VCA and signature
    int16_t held_sample = 0;
    const int32_t gain = ad_vca ? int32_t(ad_value) : int32_t(gate_value);
    const float velocity = 1.0f - sensitivity + sensitivity * (s.velocity / 127.0f);
    // The steal fade ramps through the block
    const float fade_from = voice.fade_gain;
    const float fade_to = s.gain;
    voice.fade_gain = fade_to;
    float pan = count > 1 ? (float(v % count) / float(count - 1)) * 2.0f - 1.0f : 0.0f;
    pan *= spread;
    const float gl = volume * velocity * std::sqrt(0.5f * (1.0f - pan));
    const float gr = volume * velocity * std::sqrt(0.5f * (1.0f + pan));
    float peak = 0.0f;
    for (int i = 0; i < kBlock; ++i) {
      if ((i % decimation) == 0) held_sample = voice.render_buffer[i] & bit_mask;
      const int16_t sample = int16_t(held_sample * voice.gain_lp >> 16);
      voice.gain_lp += (gain - voice.gain_lp) >> 4;
      const int16_t warped = int16_t(ws.Transform(sample));
      const float x = float(stmlib::Mix(sample, warped, signature)) *
                      (fade_from + (fade_to - fade_from) * (i + 1) / float(kBlock));
      out_l[i] += x * gl;
      out_r[i] += x * gr;
      const float ax = std::fabs(x) / 32768.0f;
      if (ax > peak) peak = ax;
    }
    // A closed VCA leaves nothing to hear
    if (gain == 0 && voice.gain_lp < 16) peak = 0.0f;
    allocator.EndBlock(v, peak);
  }
}

void set_defaults() {
  for (int i = 0; i < P_COUNT; ++i) values[i] = (*params)[i].def;
}

std::vector<std::string> names(const char* const* list, int n) { return std::vector<std::string>(list, list + n); }

}  // namespace

void port_init(float sample_rate, mp::Description& d) {
  using mp::choice;
  using mp::param;
  const char* bits[] = {"2 bits", "3 bits", "4 bits", "6 bits", "8 bits", "12 bits", "16 bits"};
  const char* rates[] = {"4 kHz", "8 kHz", "16 kHz", "24 kHz", "32 kHz", "48 kHz", "96 kHz"};
  d.params = {
      choice("shape", "Shape", names(kShapes, kShapeCount), 0, "Oscillator"),
      param("timbre", "Timbre", 0, 1, 0.001f, 0.5f, "Oscillator"),
      param("color", "Colour", 0, 1, 0.001f, 0.5f, "Oscillator"),
      param("transpose", "Transpose", -24, 24, 1, 0, "Oscillator"),
      param("fine", "Fine tune", -100, 100, 1, 0, "Oscillator"),
      choice("vca", "VCA", {"Gate", "AD"}, 0, "Envelope"),
      param("attack", "Attack", 0, 15, 1, 0, "Envelope"),
      param("decay", "Decay", 0, 15, 1, 6, "Envelope"),
      param("adTimbre", "Envelope to timbre", 0, 15, 1, 0, "Envelope"),
      param("adColor", "Envelope to colour", 0, 15, 1, 0, "Envelope"),
      param("adFm", "Envelope to pitch", 0, 15, 1, 0, "Envelope"),
      choice("bits", "Bit depth", names(bits, 7), 6, "Character"),
      choice("rate", "Sample rate", names(rates, 7), 6, "Character"),
      param("signature", "Signature", 0, 4, 1, 0, "Character"),
      param("drift", "VCO drift", 0, 4, 1, 0, "Character"),
      param("velocity", "Velocity", 0, 1, 0.01f, 0.7f, "Output"),
      param("spread", "Stereo spread", 0, 1, 0.001f, 0.4f, "Output"),
      param("voices", "Voices", 1, kMaxVoices, 1, 6, "Output"),
      param("volume", "Volume", 0, 1, 0.001f, 0.5f, "Output"),
  };
  params = &d.params;
  for (int i = 0; i < kPresetCount; ++i) d.presets.push_back({kPresets[i].id, kPresets[i].name, kPresets[i].tag});

  ws.Init(0x4d42524eu);  // the module seeds it with its chip's id
  for (int v = 0; v < kMaxVoices; ++v) {
    BraidsVoice& voice = voices[v];
    voice.osc.Init();
    voice.osc.set_shape(MACRO_OSC_SHAPE_CSAW);
    voice.envelope.Init();
    voice.envelope.Update(0, 48);
    voice.envelope.Trigger(ENV_SEGMENT_DEAD);
    voice.gate.Init();
    voice.jitter.Init();
    voice.gain_lp = 0;
    voice.fade_gain = 1.0f;
    std::memset(voice.sync_buffer, 0, sizeof voice.sync_buffer);
  }
  set_defaults();
  allocator.Init(iv(P_VOICES), 8);  // 8 blocks: a 2 ms fade
  bridge.Init(kModuleRate, sample_rate);
}

void port_render(const float*, const float*, float* out_l, float* out_r, int frames) {
  bridge.Render(out_l, out_r, frames, render_block);
}

void port_note_on(int note, int velocity) { allocator.NoteOn(note, velocity); }
void port_note_off(int note) { allocator.NoteOff(note); }
void port_all_off() { allocator.AllOff(); }
void port_set_param(int index, float value) { values[index] = value; }
float port_get_param(int index) { return values[index]; }

void port_load_preset(int index) {
  const PresetDef& p = kPresets[index];
  const float voices_value = values[P_VOICES];
  const float volume = values[P_VOLUME];
  set_defaults();
  values[P_VOICES] = voices_value;
  values[P_VOLUME] = volume;
  values[P_SHAPE] = float(p.shape);
  values[P_TIMBRE] = p.timbre;
  values[P_COLOR] = p.color;
  values[P_VCA] = float(p.vca);
  values[P_ATTACK] = float(p.attack);
  values[P_DECAY] = float(p.decay);
  values[P_AD_TIMBRE] = float(p.ad_timbre);
  values[P_AD_COLOR] = float(p.ad_color);
  values[P_AD_FM] = float(p.ad_fm);
  values[P_TRANSPOSE] = float(p.transpose);
}
