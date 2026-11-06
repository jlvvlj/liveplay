// Helm (Matt Tytel) as a Melodics port: HelmEngine, the mopo synthesis graph
// Helm's plugin runs, without JUCE. Parameters are Helm's own controls with
// the ranges of its parameter list; presets are its factory patches with their
// modulation routings.

#include "port.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>
#include <vector>

#include <emscripten/emscripten.h>

#include "helm_common.h"
#include "helm_engine.h"
#include "stutter.h"

struct HelmPresetValue {
  unsigned short param;  // index in ValueDetailsLookup::parameter_list
  float value;
};
struct HelmPresetMod {
  unsigned short source;  // index in kHelmModNames
  unsigned short destination;
  float amount;
};
struct HelmPresetDef {
  const char* id;
  const char* name;
  const char* tag;
  int value_start;
  int value_count;
  int mod_start;
  int mod_count;
};

#include "presets.inc"

namespace {

using mopo::ValueDetails;
using mopo::ValueDetailsLookup;

mopo::HelmEngine* engine = nullptr;
mopo::ModulationConnectionBank* bank = nullptr;
std::vector<mopo::ModulationConnection*> connections;
bool note_pending = false;

struct Control {
  mopo::Value* value;
  int list_index;     // in ValueDetailsLookup::parameter_list
  float scale;        // port value = engine value * scale (only the tempo differs)
};
std::vector<Control> controls;
// parameter_list index -> engine control (null when Helm has no such control)
std::vector<mopo::Value*> by_list_index;

const char* const kGroups[] = {
    "Oscillator 1", "Oscillator 2", "Oscillators", "Sub & noise", "Filter", "Filter envelope",
    "Amp envelope", "Mod envelope", "Formant", "Mono LFO 1", "Mono LFO 2", "Poly LFO",
    "Step sequencer", "Arpeggiator", "Distortion", "Delay", "Reverb", "Stutter", "Voice",
};

bool starts(const std::string& s, const char* prefix) { return s.compare(0, strlen(prefix), prefix) == 0; }

int group_of(const std::string& name) {
  if (starts(name, "osc_1_") || name == "unison_1_harmonize") return 0;
  if (starts(name, "osc_2_") || name == "unison_2_harmonize") return 1;
  if (starts(name, "osc_feedback") || name == "cross_modulation") return 2;
  if (starts(name, "sub_") || name == "noise_volume") return 3;
  if (starts(name, "filter_") || name == "cutoff" || name == "resonance" || name == "keytrack" ||
      name == "fil_env_depth")
    return 4;
  if (starts(name, "fil_")) return 5;
  if (starts(name, "amp_")) return 6;
  if (starts(name, "mod_")) return 7;
  if (starts(name, "formant_")) return 8;
  if (starts(name, "mono_lfo_1_")) return 9;
  if (starts(name, "mono_lfo_2_")) return 10;
  if (starts(name, "poly_lfo_")) return 11;
  if (starts(name, "step_") || name == "num_steps") return 12;
  if (starts(name, "arp_")) return 13;
  if (starts(name, "distortion_")) return 14;
  if (starts(name, "delay_")) return 15;
  if (starts(name, "reverb_")) return 16;
  if (starts(name, "stutter_")) return 17;
  return 18;
}

// The control's label inside its group: Helm's display name without the
// group's own words
std::string label_of(const std::string& name, const std::string& display) {
  if (name == "stutter_resample_sync") return "Resample Sync";
  if (name == "stutter_resample_tempo") return "Resample Tempo";
  if (name == "beats_per_minute") return "Tempo";
  if (starts(name, "step_seq_")) return display;
  static const char* const prefixes[] = {"Osc 1 ", "Osc 2 ", "Mono LFO 1 ", "Mono LFO 2 ", "Poly LFO ",
                                         "Amp ", "Filter ", "Mod Env ", "Arp ", "Delay ", "Reverb ",
                                         "Distortion ", "Stutter ", "Sub Osc ", "Formant "};
  std::string label = display;
  for (const char* prefix : prefixes) {
    if (starts(label, prefix)) {
      label = label.substr(strlen(prefix));
      break;
    }
  }
  if (label == "Switch") label = "On";
  return label;
}

std::vector<std::string> capitalised(const std::string* names, int count) {
  std::vector<std::string> out;
  for (int i = 0; i < count; ++i) {
    std::string s = names[i];
    if (!s.empty()) s[0] = static_cast<char>(toupper(s[0]));
    out.push_back(s);
  }
  return out;
}

bool ends(const std::string& s, const char* suffix) {
  size_t n = strlen(suffix);
  return s.size() >= n && s.compare(s.size() - n, n, suffix) == 0;
}

// Named choices where Helm shows names for a discrete control
std::vector<std::string> options_of(const std::string& name, const ValueDetails& d) {
  namespace s = mopo::strings;
  if (d.steps == 0) return {};
  if (name == "osc_1_waveform" || name == "osc_2_waveform" || name == "sub_waveform")
    return capitalised(s::waveforms, 11);
  if (ends(name, "lfo_1_waveform") || ends(name, "lfo_2_waveform") || name == "poly_lfo_waveform")
    return capitalised(s::waveforms, 13);
  if (ends(name, "_sync")) return capitalised(s::freq_sync_styles, 4);
  if (ends(name, "_tempo") && d.min == 0.0 && d.max == 11.0) return capitalised(s::synced_frequencies, 12);
  if (ends(name, "_retrigger")) return capitalised(s::freq_retrigger_styles, 3);
  if (name == "filter_style") return capitalised(s::filter_style, 3);
  if (name == "filter_shelf") return capitalised(s::filter_shelves, 3);
  if (name == "distortion_type") return capitalised(s::distortion_types_long, 4);
  if (name == "arp_pattern") return capitalised(s::arp_patterns, 5);
  if (name == "portamento_type") return capitalised(s::off_auto_on, 3);
  if (d.steps == 2 && d.min == 0.0 && d.max == 1.0) return capitalised(s::off_on, 2);
  return {};
}

void clear_modulations() {
  for (mopo::ModulationConnection* c : connections) {
    engine->disconnectModulation(c);
    bank->recycle(c);
  }
  connections.clear();
}

mopo::Value* stutter_on = nullptr;

void allocate_stutter(mopo::Processor* processor) {
  mopo::Stutter* stutter = dynamic_cast<mopo::Stutter*>(processor);
  if (stutter) stutter->allocateMemory();
}

// Clones the processors a preset added into every voice, and gives every
// voice's stutter its memory once the stutter is on, so that neither happens
// later while playing
void prepare() { engine->visitAll(stutter_on && stutter_on->value() > 0.0 ? allocate_stutter : nullptr); }

void load_defaults() {
  for (size_t i = 0; i < by_list_index.size(); ++i)
    if (by_list_index[i]) by_list_index[i]->set(ValueDetailsLookup::parameter_list[i].default_value);
}

}  // namespace

void port_init(float sample_rate, mp::Description& description) {
  engine = new mopo::HelmEngine();
  bank = new mopo::ModulationConnectionBank();
  connections.reserve(256);
  engine->setSampleRate(static_cast<int>(sample_rate + 0.5f));
  engine->setBufferSize(mopo::MAX_BUFFER_SIZE);

  mopo::control_map engine_controls = engine->getControls();
  by_list_index.assign(kHelmParameterListSize, nullptr);
  std::vector<std::vector<int>> grouped(sizeof kGroups / sizeof kGroups[0]);
  for (int i = 0; i < kHelmParameterListSize; ++i) {
    const ValueDetails& d = ValueDetailsLookup::parameter_list[i];
    auto found = engine_controls.find(d.name);
    if (found == engine_controls.end()) continue;  // deprecated names Helm no longer builds
    by_list_index[i] = found->second;
    grouped[group_of(d.name)].push_back(i);
  }

  for (size_t g = 0; g < grouped.size(); ++g) {
    for (int i : grouped[g]) {
      const ValueDetails& d = ValueDetailsLookup::parameter_list[i];
      std::vector<std::string> options = options_of(d.name, d);
      mp::Param p;
      float scale = 1.0f;
      if (d.name == "beats_per_minute") {
        // Helm keeps beats per second; the port shows beats per minute
        scale = 60.0f;
        p = mp::param(d.name.c_str(), "Tempo", 20.0f, 300.0f, 1.0f, float(d.default_value * 60.0), kGroups[g]);
      } else if (!options.empty() && d.min == 0.0 && int(options.size()) == d.steps) {
        p = mp::choice(d.name.c_str(), label_of(d.name, d.display_name).c_str(), options,
                       int(d.default_value + 0.5), kGroups[g]);
      } else {
        float step = d.steps > 1 ? float((d.max - d.min) / (d.steps - 1)) : float((d.max - d.min) / 1000.0);
        p = mp::param(d.name.c_str(), label_of(d.name, d.display_name).c_str(), float(d.min), float(d.max), step,
                      float(d.default_value), kGroups[g]);
      }
      description.params.push_back(p);
      controls.push_back({by_list_index[i], i, scale});
    }
  }

  for (const HelmPresetDef& def : kHelmPresets) {
    mp::Preset preset;
    preset.id = def.id;
    preset.name = def.name;
    preset.tag = def.tag;
    description.presets.push_back(preset);
  }

  auto stutter = engine_controls.find("stutter_on");
  if (stutter != engine_controls.end()) stutter_on = stutter->second;
  load_defaults();
  prepare();
}

void port_render(const float*, const float*, float* out_l, float* out_r, int frames) {
  while (frames > 0) {
    int n = std::min(frames, mopo::MAX_BUFFER_SIZE);
    // Helm's envelopes run once per block, starting with the block after a
    // note's: a one-sample block right after a note on starts the note on the
    // next sample instead of at the end of the block
    if (note_pending) {
      n = 1;
      note_pending = false;
    }
    if (engine->getBufferSize() != n) engine->setBufferSize(n);
    engine->process();
    const mopo::mopo_float* left = engine->output(0)->buffer;
    const mopo::mopo_float* right = engine->output(1)->buffer;
    for (int i = 0; i < n; ++i) {
      out_l[i] = static_cast<float>(left[i]);
      out_r[i] = static_cast<float>(right[i]);
    }
    out_l += n;
    out_r += n;
    frames -= n;
  }
}

void port_note_on(int note, int velocity) {
  engine->noteOn(note, velocity / 127.0);
  note_pending = true;
}

void port_note_off(int note) { engine->noteOff(note); }

void port_all_off() { engine->allNotesOff(); }

void port_set_param(int index, float value) {
  const Control& c = controls[index];
  c.value->set(value / c.scale);
  if (c.value == stutter_on && value > 0.0f) prepare();
}

float port_get_param(int index) {
  const Control& c = controls[index];
  return static_cast<float>(c.value->value() * c.scale);
}

// As Helm's LoadSave::varToState: every control to the patch's value or its
// default, then the patch's modulation routings in place of the old ones
void port_load_preset(int index) {
  const HelmPresetDef& def = kHelmPresets[index];
  load_defaults();
  for (int i = 0; i < def.value_count; ++i) {
    const HelmPresetValue& v = kHelmPresetValues[def.value_start + i];
    if (v.param < by_list_index.size() && by_list_index[v.param]) by_list_index[v.param]->set(v.value);
  }

  clear_modulations();
  for (int i = 0; i < def.mod_count; ++i) {
    const HelmPresetMod& m = kHelmPresetMods[def.mod_start + i];
    std::string source = kHelmModNames[m.source];
    std::string destination = kHelmModNames[m.destination];
    mopo::Output* output = engine->getModulationSource(source);
    if (!output) continue;
    if (!engine->getModulationDestination(destination, output->owner->isPolyphonic()) ||
        !engine->getMonoModulationSwitch(destination))
      continue;
    mopo::ModulationConnection* c = bank->get(source, destination);
    c->amount.set(m.amount);
    engine->connectModulation(c);
    connections.push_back(c);
  }
  prepare();
}

// Modulation routings of the factory patches that name a source or a
// destination this engine does not have (the checks expect none)
extern "C" EMSCRIPTEN_KEEPALIVE int helm_unresolved_modulations() {
  int unresolved = 0;
  for (const HelmPresetMod& m : kHelmPresetMods) {
    mopo::Output* output = engine->getModulationSource(kHelmModNames[m.source]);
    if (!output || !engine->getModulationDestination(kHelmModNames[m.destination], output->owner->isPolyphonic()) ||
        !engine->getMonoModulationSwitch(kHelmModNames[m.destination]))
      ++unresolved;
  }
  return unresolved;
}
