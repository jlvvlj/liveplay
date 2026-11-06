// The C exports the worklet calls, shared by every port. Each port provides
// the port_* functions declared in port.h.

#include "port.h"

#include <emscripten/emscripten.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <new>

namespace {

float in_buffer[2][MP_MAX_FRAMES];
float out_buffer[2][MP_MAX_FRAMES];
mp::Description description;
std::string description_json;
unsigned allocations = 0;

void append_string(std::string& out, const std::string& s) {
  out += '"';
  for (char c : s) {
    unsigned char u = static_cast<unsigned char>(c);
    if (c == '"' || c == '\\') {
      out += '\\';
      out += c;
    } else if (u < 0x20) {
      char escaped[8];
      snprintf(escaped, sizeof escaped, "\\u%04x", u);
      out += escaped;
    } else {
      out += c;
    }
  }
  out += '"';
}

void append_number(std::string& out, float v) {
  char number[32];
  if (!std::isfinite(v)) v = 0;
  snprintf(number, sizeof number, "%.9g", v);
  out += number;
}

void build_json() {
  std::string& j = description_json;
  j = "{\"params\":[";
  for (size_t i = 0; i < description.params.size(); ++i) {
    const mp::Param& p = description.params[i];
    if (i) j += ',';
    j += "{\"key\":";
    append_string(j, p.key);
    j += ",\"label\":";
    append_string(j, p.label);
    j += ",\"min\":";
    append_number(j, p.min);
    j += ",\"max\":";
    append_number(j, p.max);
    j += ",\"step\":";
    append_number(j, p.step);
    j += ",\"default\":";
    append_number(j, p.def);
    if (!p.group.empty()) {
      j += ",\"group\":";
      append_string(j, p.group);
    }
    if (!p.options.empty()) {
      j += ",\"options\":[";
      for (size_t k = 0; k < p.options.size(); ++k) {
        if (k) j += ',';
        append_string(j, p.options[k]);
      }
      j += ']';
    }
    j += '}';
  }
  j += "],\"presets\":[";
  for (size_t i = 0; i < description.presets.size(); ++i) {
    const mp::Preset& p = description.presets[i];
    if (i) j += ',';
    j += "{\"id\":";
    append_string(j, p.id);
    j += ",\"name\":";
    append_string(j, p.name);
    if (!p.tag.empty()) {
      j += ",\"tag\":";
      append_string(j, p.tag);
    }
    j += '}';
  }
  j += "]}";
}

}  // namespace

// Every C++ allocation is counted, so the checks can prove none happens while
// the worklet renders or receives notes.
void* operator new(size_t size) {
  ++allocations;
  void* p = malloc(size ? size : 1);
  if (!p) abort();
  return p;
}
void* operator new[](size_t size) { return operator new(size); }
void* operator new(size_t size, const std::nothrow_t&) noexcept {
  ++allocations;
  return malloc(size ? size : 1);
}
void* operator new[](size_t size, const std::nothrow_t&) noexcept { return operator new(size, std::nothrow); }
void* operator new(size_t size, std::align_val_t align) {
  ++allocations;
  void* p = aligned_alloc(static_cast<size_t>(align), (size + static_cast<size_t>(align) - 1) &
                                                          ~(static_cast<size_t>(align) - 1));
  if (!p) abort();
  return p;
}
void* operator new[](size_t size, std::align_val_t align) { return operator new(size, align); }
void operator delete(void* p) noexcept { free(p); }
void operator delete[](void* p) noexcept { free(p); }
void operator delete(void* p, size_t) noexcept { free(p); }
void operator delete[](void* p, size_t) noexcept { free(p); }
void operator delete(void* p, std::align_val_t) noexcept { free(p); }
void operator delete[](void* p, std::align_val_t) noexcept { free(p); }
void operator delete(void* p, size_t, std::align_val_t) noexcept { free(p); }
void operator delete[](void* p, size_t, std::align_val_t) noexcept { free(p); }

extern "C" {

EMSCRIPTEN_KEEPALIVE void mp_init(float sample_rate) {
  port_init(sample_rate, description);
  build_json();
}

EMSCRIPTEN_KEEPALIVE const char* mp_describe() { return description_json.c_str(); }
EMSCRIPTEN_KEEPALIVE int mp_describe_length() { return static_cast<int>(description_json.size()); }

EMSCRIPTEN_KEEPALIVE float* mp_input(int channel) { return in_buffer[channel & 1]; }
EMSCRIPTEN_KEEPALIVE float* mp_output(int channel) { return out_buffer[channel & 1]; }
EMSCRIPTEN_KEEPALIVE int mp_max_frames() { return MP_MAX_FRAMES; }

// Renders frames [offset, offset + frames) of the current block
EMSCRIPTEN_KEEPALIVE void mp_render(int offset, int frames) {
  if (frames <= 0 || offset < 0 || offset + frames > MP_MAX_FRAMES) return;
  port_render(in_buffer[0] + offset, in_buffer[1] + offset, out_buffer[0] + offset, out_buffer[1] + offset,
              frames);
}

EMSCRIPTEN_KEEPALIVE void mp_note_on(int note, int velocity) {
  if (note < 0 || note > 127) return;
  if (velocity < 1) velocity = 1;
  if (velocity > 127) velocity = 127;
  port_note_on(note, velocity);
}
EMSCRIPTEN_KEEPALIVE void mp_note_off(int note) {
  if (note < 0 || note > 127) return;
  port_note_off(note);
}
EMSCRIPTEN_KEEPALIVE void mp_all_off() { port_all_off(); }

EMSCRIPTEN_KEEPALIVE void mp_set_param(int index, float value) {
  if (index < 0 || index >= static_cast<int>(description.params.size())) return;
  if (!std::isfinite(value)) return;
  const mp::Param& p = description.params[index];
  if (value < p.min) value = p.min;
  if (value > p.max) value = p.max;
  port_set_param(index, value);
}
EMSCRIPTEN_KEEPALIVE float mp_get_param(int index) {
  if (index < 0 || index >= static_cast<int>(description.params.size())) return 0;
  return port_get_param(index);
}
EMSCRIPTEN_KEEPALIVE void mp_load_preset(int index) {
  if (index < 0 || index >= static_cast<int>(description.presets.size())) return;
  port_load_preset(index);
}

EMSCRIPTEN_KEEPALIVE unsigned mp_allocations() { return allocations; }

}  // extern "C"
