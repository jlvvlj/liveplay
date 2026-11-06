// The interface every port implements, behind the shared C exports in
// port.cpp. The worklet (worklet.template.js) calls those exports; nothing in
// here knows about AudioWorklets.
//
// Rules for a port:
// - port_init allocates everything; port_render, port_note_on, port_note_off,
//   port_all_off and port_set_param never allocate.
// - port_render writes `frames` stereo samples (frames <= MP_MAX_FRAMES).
// - Velocities arrive as MIDI 1-127; parameter values in the units of their
//   Param (min..max, an option's index for a choice).
#pragma once

#include <string>
#include <vector>

#define MP_MAX_FRAMES 1024

namespace mp {

struct Param {
  std::string key;
  std::string label;
  float min;
  float max;
  float step;
  float def;
  std::string group;
  // A choice: the value is the index of the chosen option
  std::vector<std::string> options;
};

struct Preset {
  std::string id;
  std::string name;
  // The kind of sound: Lead, Pad, Bass... (optional)
  std::string tag;
};

struct Description {
  std::vector<Param> params;
  std::vector<Preset> presets;
};

inline Param param(const char* key, const char* label, float min, float max, float step, float def,
                   const char* group = "") {
  Param p;
  p.key = key;
  p.label = label;
  p.min = min;
  p.max = max;
  p.step = step;
  p.def = def;
  p.group = group;
  return p;
}

inline Param choice(const char* key, const char* label, std::vector<std::string> options, int def,
                    const char* group = "") {
  Param p = param(key, label, 0, float(options.size() - 1), 1, float(def), group);
  p.options = std::move(options);
  return p;
}

}  // namespace mp

void port_init(float sample_rate, mp::Description& description);
// in: two input channels (silence for instruments); out: two output channels
void port_render(const float* in_l, const float* in_r, float* out_l, float* out_r, int frames);
void port_note_on(int note, int velocity);
void port_note_off(int note);
void port_all_off();
void port_set_param(int index, float value);
float port_get_param(int index);
void port_load_preset(int index);
