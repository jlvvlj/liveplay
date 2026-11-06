// Dexed as a Melodics port: the MSFA engine (Modern, Mark I and OPL cores),
// Dexed's voice allocation and mono mode, its output filter (PluginFx), and
// every voice of its bundled cartridges as presets.
//
// Differences from the plugin, all for live playing in a worklet:
// - Each voice renders its 64-sample blocks from the sample its note starts
//   on, so notes begin on their exact sample; the LFO still ticks every 64
//   samples for all voices, as in Dexed.
// - A voice taken from a sounding note hands its sound to a short fade-out
//   (3 ms) instead of restarting from silence with a click; allOff fades too.
// - Note-offs find their voice by the key that started it, so changing the
//   transpose while a note is held cannot leave it stuck.

#include "port.h"

#include <cmath>
#include <cstring>
#include <memory>

#include "PluginFx.h"
#include "cartridges.h"
#include "engine/EngineMkI.h"
#include "engine/EngineOpl.h"
#include "msfa/aligned_buf.h"
#include "msfa/controllers.h"
#include "msfa/dx7note.h"
#include "msfa/env.h"
#include "msfa/exp2.h"
#include "msfa/fm_core.h"
#include "msfa/freqlut.h"
#include "msfa/lfo.h"
#include "msfa/pitchenv.h"
#include "msfa/porta.h"
#include "msfa/sin.h"
#include "msfa/synth.h"
#include "msfa/tuning.h"

namespace {

constexpr int kVoices = 16;  // Dexed's MAX_ACTIVE_NOTES
constexpr int kFades = 16;
constexpr float kFadeSeconds = 0.003f;

struct Voice {
  Dx7Note* note = nullptr;
  int key = -1;        // the key that started it
  int midi_note = -1;  // after transpose, as Dexed keeps it
  int velocity = 0;
  bool keydown = false;
  bool live = false;
  int keydown_seq = -1;
  float block[N];
  int pos = N;  // next sample of `block` to play; N: compute a new block
};

struct Fade {
  Dx7Note* note = nullptr;
  bool active = false;
  float gain = 0;
  float block[N];
  int pos = N;
};

Voice voices[kVoices];
Fade fades[kFades];
uint8_t program[156];
Controllers controllers;
FmCore engine_modern;
EngineMkI* engine_mark1 = nullptr;
EngineOpl* engine_opl = nullptr;
Lfo lfo;
PluginFx fx;
std::shared_ptr<TuningState> tuning;
float sample_rate = 48000;
float fade_step = 0;
int current_note = 0;
int next_keydown_seq = 0;
int last_active_voice = 0;
bool mono_mode = false;
int engine_type = 1;  // Dexed starts on Mark I
float master_tune = 0;
int lfo_countdown = 0;
int32_t lfo_value = 0;
int32_t lfo_delay = 0;
float mono_buffer[MP_MAX_FRAMES];
// The LFO's value for each 64-sample tick inside the block being rendered
int32_t lfo_values[MP_MAX_FRAMES / N + 2];
int32_t lfo_delays[MP_MAX_FRAMES / N + 2];

// Parameters ---------------------------------------------------------------

enum Kind { BYTE, OP_SWITCH, ENGINE, MONO, CUTOFF, RESONANCE, OUTPUT, TUNE };

struct Binding {
  Kind kind;
  int offset;  // into the 156-byte voice
  int shift;   // shown value = byte + shift
  int op;      // operator switch bit
  int max;     // largest byte value
};

std::vector<Binding> bindings;

void add(mp::Description& d, mp::Param p, Binding b) {
  d.params.push_back(std::move(p));
  bindings.push_back(b);
}

void add_byte(mp::Description& d, const std::string& key, const std::string& label, int offset, int max,
              const char* group, int shift = 0) {
  add(d, mp::param(key.c_str(), label.c_str(), float(shift), float(max + shift), 1, 0, group),
      {BYTE, offset, shift, 0, max});
}

void add_byte_choice(mp::Description& d, const std::string& key, const std::string& label, int offset,
                     std::vector<std::string> options, const char* group) {
  const int max = int(options.size()) - 1;
  add(d, mp::choice(key.c_str(), label.c_str(), std::move(options), 0, group), {BYTE, offset, 0, 0, max});
}

void describe(mp::Description& d) {
  add(d, mp::choice("engine", "Engine", {"Modern", "Mark I", "OPL"}, 1, "Dexed"), {ENGINE, 0, 0, 0});
  add(d, mp::choice("mono", "Voices", {"Poly", "Mono"}, 0, "Dexed"), {MONO, 0, 0, 0});
  add(d, mp::param("cutoff", "Cutoff", 0, 1, 0.001f, 1, "Dexed"), {CUTOFF, 0, 0, 0});
  add(d, mp::param("resonance", "Resonance", 0, 1, 0.001f, 0, "Dexed"), {RESONANCE, 0, 0, 0});
  add(d, mp::param("output", "Output", 0, 1, 0.001f, 1, "Dexed"), {OUTPUT, 0, 0, 0});
  add(d, mp::param("tune", "Master tune", -1, 1, 0.001f, 0, "Dexed"), {TUNE, 0, 0, 0});

  add_byte(d, "algorithm", "Algorithm", 134, 31, "Voice", 1);
  add_byte(d, "feedback", "Feedback", 135, 7, "Voice");
  add_byte_choice(d, "oscSync", "Oscillator key sync", 136, {"Off", "On"}, "Voice");
  add_byte(d, "transpose", "Transpose", 144, 48, "Voice", -24);
  add_byte(d, "pitchModSens", "Pitch mod sensitivity", 143, 7, "Voice");

  add_byte_choice(d, "lfoWave", "Wave", 142, {"Triangle", "Saw down", "Saw up", "Square", "Sine", "Sample & hold"},
                  "LFO");
  add_byte(d, "lfoRate", "Rate", 137, 99, "LFO");
  add_byte(d, "lfoDelay", "Delay", 138, 99, "LFO");
  add_byte(d, "lfoPitchDepth", "Pitch depth", 139, 99, "LFO");
  add_byte(d, "lfoAmpDepth", "Amp depth", 140, 99, "LFO");
  add_byte_choice(d, "lfoSync", "Key sync", 141, {"Off", "On"}, "LFO");

  for (int i = 0; i < 4; ++i) add_byte(d, "pitchEgRate" + std::to_string(i + 1), "Rate " + std::to_string(i + 1), 126 + i, 99, "Pitch EG");
  for (int i = 0; i < 4; ++i) add_byte(d, "pitchEgLevel" + std::to_string(i + 1), "Level " + std::to_string(i + 1), 130 + i, 99, "Pitch EG");

  static const char* groups[6] = {"Operator 1", "Operator 2", "Operator 3", "Operator 4", "Operator 5", "Operator 6"};
  for (int op = 0; op < 6; ++op) {
    const std::string k = "op" + std::to_string(op + 1);
    const char* g = groups[op];
    const int base = (5 - op) * 21;  // operator 1 is stored last
    add(d, mp::choice((k + "On").c_str(), "On", {"Off", "On"}, 1, g), {OP_SWITCH, 155, 0, 5 - op});
    add_byte(d, k + "Level", "Output level", base + 16, 99, g);
    add_byte_choice(d, k + "Mode", "Frequency mode", base + 17, {"Ratio", "Fixed"}, g);
    add_byte(d, k + "Coarse", "Coarse", base + 18, 31, g);
    add_byte(d, k + "Fine", "Fine", base + 19, 99, g);
    add_byte(d, k + "Detune", "Detune", base + 20, 14, g, -7);
    for (int i = 0; i < 4; ++i) add_byte(d, k + "EgRate" + std::to_string(i + 1), "EG rate " + std::to_string(i + 1), base + i, 99, g);
    for (int i = 0; i < 4; ++i) add_byte(d, k + "EgLevel" + std::to_string(i + 1), "EG level " + std::to_string(i + 1), base + 4 + i, 99, g);
    add_byte(d, k + "Velocity", "Velocity sensitivity", base + 15, 7, g);
    add_byte(d, k + "AmpMod", "Amp mod sensitivity", base + 14, 3, g);
    add_byte(d, k + "RateScaling", "Rate scaling", base + 13, 7, g);
    add_byte(d, k + "Breakpoint", "Breakpoint", base + 8, 99, g);
    add_byte(d, k + "LeftDepth", "Left depth", base + 9, 99, g);
    add_byte(d, k + "RightDepth", "Right depth", base + 10, 99, g);
    add_byte_choice(d, k + "LeftCurve", "Left curve", base + 11, {"-LIN", "-EXP", "+EXP", "+LIN"}, g);
    add_byte_choice(d, k + "RightCurve", "Right curve", base + 12, {"-LIN", "-EXP", "+EXP", "+LIN"}, g);
  }
}

void set_engine(int type) {
  engine_type = type;
  switch (type) {
    case 0:
      controllers.core = &engine_modern;
      break;
    case 2:
      controllers.core = engine_opl;
      break;
    default:
      controllers.core = engine_mark1;
      break;
  }
}

// Dexed's refreshVoice: live notes take the edited voice, the LFO restarts
void refresh_voices() {
  for (Voice& v : voices) {
    if (v.live) v.note->update(program, v.midi_note, v.velocity, 0);
  }
  lfo.reset(program + 137);
}

int transpose_shift() { return program[144] - 24; }

// Voices -------------------------------------------------------------------

// The 24-bit engine output as Dexed turns it into a float, one voice at a time
inline float to_float(int32_t val) {
  val = val >> 4;
  int clip_val = val < -(1 << 24) ? 0x8000 : val >= (1 << 24) ? 0x7fff : val >> 9;
  float f = float(clip_val) / float(0x8000);
  if (f > 1) f = 1;
  if (f < -1) f = -1;
  return f;
}

inline void compute_block(Dx7Note* note, float* block, int tick) {
  AlignedBuf<int32_t, N> audiobuf;
  int32_t* buf = audiobuf.get();
  for (int j = 0; j < N; ++j) buf[j] = 0;
  note->compute(buf, lfo_values[tick], lfo_delays[tick], &controllers);
  for (int j = 0; j < N; ++j) block[j] = to_float(buf[j]);
}

// Hands a sounding voice to a fade-out, so its slot can start a new note
void fade_out(Voice& v) {
  for (Fade& f : fades) {
    if (f.active) continue;
    *f.note = *v.note;
    std::memcpy(f.block, v.block, sizeof f.block);
    f.pos = v.pos;
    f.gain = 1;
    f.active = true;
    return;
  }
  // Every fade is busy (more than 16 notes stolen within 3 ms): the voice is cut
}

void take_signal(Voice& to, const Voice& from) {
  std::memcpy(to.block, from.block, sizeof to.block);
  to.pos = from.pos;
}

void keydown(int key, int velo) {
  int pitch = key + transpose_shift();
  if (pitch < 0) pitch = 0;
  if (pitch > 127) pitch = 127;

  // Dexed's stealing preference: +4 not playing, +2 key up, +1 same pitch,
  // ties to the least recent keydown
  bool trigger_lfo = true;
  int best = current_note;
  int best_score = -1;
  int note = current_note;
  for (int i = 0; i < kVoices; i++) {
    const Voice& v = voices[note];
    if (v.keydown) trigger_lfo = false;
    int score = 0;
    if (!(v.live && v.note->isPlaying())) score += 4;
    if (!v.keydown) score += 2;
    if (v.midi_note == pitch) score += 1;
    if (score > best_score || (score == best_score && v.keydown_seq < voices[best].keydown_seq)) {
      best = note;
      best_score = score;
    }
    note = (note + 1) % kVoices;
  }
  if (trigger_lfo) lfo.keydown();

  note = best;
  Voice& voice = voices[note];
  current_note = (note + 1) % kVoices;
  bool voice_steal = voice.live && voice.note->isPlaying();
  if (voice_steal && !mono_mode) fade_out(voice);
  voice.key = key;
  voice.midi_note = pitch;
  voice.velocity = velo;
  voice.keydown = true;
  voice.keydown_seq = next_keydown_seq++;
  voice.pos = N;
  voice.note->init(program, pitch, velo, 0, &controllers);
  // to avoid click, don't sync oscillators when voice stealing
  if (program[136] && !voice_steal) voice.note->oscSync();

  if (mono_mode) {
    for (int i = 0; i < kVoices; i++) {
      Voice& other = voices[i];
      if (i == note || !other.live) continue;
      // all keys are up, only transfer signal
      if (!other.keydown) {
        other.live = false;
        voice.note->transferSignal(*other.note);
        take_signal(voice, other);
        break;
      }
      if (other.midi_note > pitch) {
        other.live = false;
        voice.note->transferState(*other.note);
        take_signal(voice, other);
        break;
      }
      // a higher key is held: it keeps sounding
      return;
    }
  } else if (!program[136]) {
    // if another note at the same pitch is playing, transfer phase
    for (int i = 0; i < kVoices; i++) {
      if (i != note && voices[i].live && voices[i].note->isPlaying() && voices[i].midi_note == pitch) {
        voice.note->transferPhase(*voices[i].note);
        break;
      }
    }
  }
  voice.live = true;
  last_active_voice = note;
}

void keyup(int key) {
  int note;
  for (note = 0; note < kVoices; ++note) {
    if (voices[note].key == key && voices[note].keydown) {
      voices[note].keydown = false;
      break;
    }
  }
  if (note >= kVoices) return;

  if (mono_mode) {
    int high_note = -1;
    int target = 0;
    for (int i = 0; i < kVoices; i++) {
      if (voices[i].keydown && voices[i].midi_note > high_note) {
        target = i;
        high_note = voices[i].midi_note;
      }
    }
    if (high_note != -1 && voices[note].live) {
      voices[note].live = false;
      voices[target].live = true;
      voices[target].note->transferState(*voices[note].note);
      take_signal(voices[target], voices[note]);
    }
  }
  voices[note].note->keyup();
}

}  // namespace

// Port ---------------------------------------------------------------------

void port_init(float sr, mp::Description& d) {
  sample_rate = sr;
  Exp2::init();
  Tanh::init();
  Sin::init();
  Freqlut::init(sr);
  Lfo::init(sr);
  PitchEnv::init(sr);
  Env::init_sr(sr);
  Porta::init_sr(sr);
  fx.init(int(sr));
  fade_step = 1.0f / (kFadeSeconds * sr);

  engine_mark1 = new EngineMkI();
  engine_opl = new EngineOpl();
  tuning = createStandardTuning();
  for (Voice& v : voices) v.note = new Dx7Note(tuning, nullptr);
  for (Fade& f : fades) f.note = new Dx7Note(tuning, nullptr);

  controllers.pitch_cc = 0x2000;
  controllers.pitch_range_up = 3;
  controllers.pitch_range_dn = 3;
  controllers.pitch_step = 0;
  controllers.modwheel_cc = 0;
  controllers.foot_cc = 0;
  controllers.breath_cc = 0;
  controllers.aftertouch_cc = 0;
  controllers.portamento_enable_cc = false;
  controllers.portamento_cc = 0;
  controllers.portamento_gliss_cc = false;
  controllers.masterTune = 0;
  // One keyboard on one channel: never MPE
  controllers.mpeEnabled = false;
  controllers.refresh();
  set_engine(1);

  std::memcpy(program, kCartridgeVoices[0], sizeof program);
  lfo.reset(program + 137);

  describe(d);
  // The defaults are the voice Dexed starts with: Dexed_01's first
  for (size_t i = 0; i < d.params.size(); ++i) {
    if (bindings[i].kind == BYTE || bindings[i].kind == OP_SWITCH) d.params[i].def = port_get_param(int(i));
  }
  for (int i = 0; i < kCartridgeVoiceCount; ++i) {
    d.presets.push_back({kCartridgeIds[i], kCartridgeNames[i], ""});
  }
}

void port_render(const float*, const float*, float* out_l, float* out_r, int frames) {
  // The LFO ticks every N samples across voices, as in Dexed: its values for
  // each tick this block are taken first
  int first_tick = lfo_countdown;
  int ticks = 0;
  lfo_values[0] = lfo_value;
  lfo_delays[0] = lfo_delay;
  for (int t = first_tick; t < frames; t += N) {
    lfo_value = lfo.getsample();
    lfo_delay = lfo.getdelay();
    ++ticks;
    lfo_values[ticks] = lfo_value;
    lfo_delays[ticks] = lfo_delay;
  }
  lfo_countdown = first_tick + ticks * N - frames;
  auto tick_at = [first_tick](int j) { return j < first_tick ? 0 : 1 + (j - first_tick) / N; };

  for (int j = 0; j < frames; ++j) mono_buffer[j] = 0;

  for (Voice& v : voices) {
    if (!v.live) continue;
    int j = 0;
    while (j < frames) {
      if (v.pos == N) {
        if (!v.keydown && !v.note->isPlaying()) {
          // Finished: nothing more to hear from it
          v.live = false;
          break;
        }
        compute_block(v.note, v.block, tick_at(j));
        v.pos = 0;
      }
      int m = N - v.pos;
      if (m > frames - j) m = frames - j;
      for (int k = 0; k < m; ++k) mono_buffer[j + k] += v.block[v.pos + k];
      v.pos += m;
      j += m;
    }
  }

  for (Fade& f : fades) {
    if (!f.active) continue;
    int j = 0;
    while (j < frames && f.gain > 0) {
      if (f.pos == N) {
        compute_block(f.note, f.block, tick_at(j));
        f.pos = 0;
      }
      int m = N - f.pos;
      if (m > frames - j) m = frames - j;
      for (int k = 0; k < m && f.gain > 0; ++k) {
        mono_buffer[j + k] += f.block[f.pos + k] * f.gain;
        f.gain -= fade_step;
      }
      f.pos += m;
      j += m;
    }
    if (f.gain <= 0) f.active = false;
  }

  fx.process(mono_buffer, frames);
  // DX7 is a mono synth: the same signal on both sides
  for (int j = 0; j < frames; ++j) {
    out_l[j] = mono_buffer[j];
    out_r[j] = mono_buffer[j];
  }
}

void port_note_on(int note, int velocity) { keydown(note, velocity); }

void port_note_off(int note) { keyup(note); }

void port_all_off() {
  for (Voice& v : voices) {
    if (v.live && v.note->isPlaying()) fade_out(v);
    v.live = false;
    v.keydown = false;
    v.key = -1;
    v.midi_note = -1;
    v.pos = N;
  }
}

void port_set_param(int index, float value) {
  const Binding& b = bindings[index];
  const int v = int(std::lround(value));
  switch (b.kind) {
    case BYTE:
      program[b.offset] = uint8_t(v - b.shift);
      refresh_voices();
      break;
    case OP_SWITCH:
      if (v) program[155] |= uint8_t(1u << b.op);
      else program[155] &= uint8_t(~(1u << b.op));
      refresh_voices();
      break;
    case ENGINE:
      set_engine(v);
      break;
    case MONO:
      // Dexed's resetMonoMode: a panic, then the new mode
      port_all_off();
      mono_mode = v != 0;
      break;
    case CUTOFF:
      fx.uiCutoff = value;
      break;
    case RESONANCE:
      fx.uiReso = value;
      break;
    case OUTPUT:
      fx.uiGain = value;
      break;
    case TUNE: {
      master_tune = value;
      int32_t tune = int32_t((value / 2 + 0.5) * 0x4000) - 0x2000;
      controllers.masterTune = int(float(tune << 11) * (1.0 / 12));
      break;
    }
  }
}

float port_get_param(int index) {
  const Binding& b = bindings[index];
  switch (b.kind) {
    case BYTE: {
      // Some cartridge voices carry bytes past the DX7's range; Dexed plays
      // them as they are, the value reported is the nearest in range
      int byte = program[b.offset];
      if (byte > b.max) byte = b.max;
      return float(byte + b.shift);
    }
    case OP_SWITCH:
      return (program[155] >> b.op) & 1 ? 1.0f : 0.0f;
    case ENGINE:
      return float(engine_type);
    case MONO:
      return mono_mode ? 1.0f : 0.0f;
    case CUTOFF:
      return fx.uiCutoff;
    case RESONANCE:
      return fx.uiReso;
    case OUTPUT:
      return fx.uiGain;
    case TUNE:
      return master_tune;
  }
  return 0;
}

void port_load_preset(int index) {
  std::memcpy(program, kCartridgeVoices[index], sizeof program);
  refresh_voices();
}
