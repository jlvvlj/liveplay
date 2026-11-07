// Vital as a port (common/port.h): its SoundEngine, presets loaded with
// upstream's own LoadSave code, a chosen set of its controls as parameters.
//
// A preset's file is not inside the module: the worklet is sent its bytes with
// the preset message (mp_preset_buffer), so the browser fetches only the
// presets that are played. Reading a file takes up to half a second (most of
// it rendering wavetables and preparing the sample), too long for the audio
// thread every instrument shares, so the app has a second instance of the
// module in a Worker (vital.loader.js) load the file and pack what it built
// (mp_pack_preset): the worklet's instance then only reads the preset's
// settings and copies the wavetables and sample in.

#include "port_load_save.h"
#include "port.h"

#include <emscripten/emscripten.h>

#include <cstdint>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <vector>

// SynthBase, as upstream's src/common/synth_base.cpp does it, modulation
// changes applied to the engine at once
SynthBase::SynthBase() {
  engine_ = std::make_unique<vital::SoundEngine>();
  mod_connections_.reserve(vital::kMaxModulationConnections);
  for (int i = 0; i < vital::kNumOscillators; ++i) {
    vital::Wavetable* wavetable = engine_->getWavetable(i);
    if (wavetable) {
      wavetable_creators_[i] = std::make_unique<WavetableCreator>(wavetable);
      wavetable_creators_[i]->init();
    }
  }
  controls_ = engine_->getControls();
}

vital::modulation_change SynthBase::createModulationChange(vital::ModulationConnection* connection) {
  vital::modulation_change change;
  change.source = engine_->getModulationSource(connection->source_name);
  change.mono_destination = engine_->getMonoModulationDestination(connection->destination_name);
  change.mono_modulation_switch = engine_->getMonoModulationSwitch(connection->destination_name);
  change.destination_scale = vital::Parameters::getParameterRange(connection->destination_name);
  change.poly_modulation_switch = engine_->getPolyModulationSwitch(connection->destination_name);
  change.poly_destination = engine_->getPolyModulationDestination(connection->destination_name);
  change.modulation_processor = connection->modulation_processor.get();

  int num_audio_rate = 0;
  vital::ModulationConnectionBank& modulation_bank = getModulationBank();
  for (int i = 0; i < vital::kMaxModulationConnections; ++i) {
    if (modulation_bank.atIndex(i)->source_name == connection->source_name &&
        modulation_bank.atIndex(i)->destination_name != connection->destination_name &&
        !modulation_bank.atIndex(i)->modulation_processor->isControlRate()) {
      num_audio_rate++;
    }
  }
  change.num_audio_rate = num_audio_rate;
  return change;
}

void SynthBase::connectModulation(vital::ModulationConnection* connection) {
  vital::modulation_change change = createModulationChange(connection);
  if (change.poly_destination && change.poly_destination->router() == change.modulation_processor) {
    connection->destination_name = "";
    connection->source_name = "";
  }
  else if (std::find(mod_connections_.begin(), mod_connections_.end(), connection) == mod_connections_.end()) {
    change.disconnecting = false;
    mod_connections_.push_back(connection);
    engine_->connectModulation(change);
  }
}

void SynthBase::clearModulations() {
  while (!mod_connections_.empty()) {
    vital::ModulationConnection* connection = mod_connections_.back();
    mod_connections_.pop_back();
    vital::modulation_change change = createModulationChange(connection);
    change.disconnecting = true;
    engine_->disconnectModulation(change);
    connection->source_name = "";
    connection->destination_name = "";
  }

  int num_connections = static_cast<int>(getModulationBank().numConnections());
  for (int i = 0; i < num_connections; ++i)
    getModulationBank().atIndex(i)->modulation_processor->lineMapGenerator()->initLinear();

  engine_->disableUnnecessaryModSources();
}

void SynthBase::initEngine() {
  clearModulations();
  for (int i = 0; i < vital::kNumOscillators; ++i)
    wavetable_creators_[i]->init();
  engine_->getSample()->init();
  for (int i = 0; i < vital::kNumLfos; ++i)
    getLfoSource(i)->initTriangle();
  for (auto& control : controls_)
    control.second->set(vital::Parameters::getDetails(control.first).default_value);
  checkOversampling();
}

namespace {

struct PresetEntry {
  const char* id;
  const char* name;
  const char* tag;
};

// Written by tools/list-presets.mjs: every preset the build found that this
// engine's version can load
const PresetEntry kPresets[] = {
#include "presets.inc"
};

// The controls offered as parameters, under these headings
struct Group {
  const char* heading;
  std::vector<const char*> controls;
};
const Group kGroups[] = {
  { "Macros", { "macro_control_1", "macro_control_2", "macro_control_3", "macro_control_4" } },
  { "Oscillators", { "osc_1_level", "osc_1_wave_frame", "osc_1_unison_voices", "osc_1_unison_detune",
                     "osc_2_level", "osc_2_wave_frame", "osc_3_level" } },
  { "Filters", { "filter_1_cutoff", "filter_1_resonance", "filter_1_drive", "filter_1_mix",
                 "filter_2_cutoff", "filter_2_resonance" } },
  { "Envelope", { "env_1_attack", "env_1_decay", "env_1_sustain", "env_1_release" } },
  { "Effects", { "chorus_on", "chorus_dry_wet", "delay_on", "delay_dry_wet", "distortion_on",
                 "distortion_drive", "reverb_on", "reverb_dry_wet" } },
  { "Voice", { "polyphony", "portamento_time", "velocity_track", "volume" } },
};

constexpr float kBpm = 120.0f;
// A note off's release velocity (upstream's own renders use it)
constexpr float kLift = 0.5f;

std::unique_ptr<SynthBase> synth;
// Each parameter's control, and for a continuous one Vital's range: the app
// is sent its knob position (0 to 1), as Vital's own interface shows it
struct ParamControl {
  vital::Value* value;
  bool normalized;
  float min;
  float max;
};
std::vector<ParamControl> param_controls;
std::vector<char> preset_data;
std::vector<char> pack;
bool preset_failed = false;

// A packed preset: "VTPK", the length of its settings (the preset's JSON
// without its wavetables and sample, as LoadSave would upgrade it), the
// settings, then each oscillator's wavetable data and the sample's buffers
constexpr char kPackMagic[4] = { 'V', 'T', 'P', 'K' };

class PackWriter {
  public:
    explicit PackWriter(std::vector<char>& out) : out_(out) { out_.clear(); }
    void bytes(const void* data, size_t size) {
      const char* in = static_cast<const char*>(data);
      out_.insert(out_.end(), in, in + size);
    }
    template <typename T>
    void value(T v) { bytes(&v, sizeof v); }

  private:
    std::vector<char>& out_;
};

class PackReader {
  public:
    PackReader(const char* data, size_t size) : at_(data), end_(data + size) { }
    bool bytes(void* data, size_t size) {
      if (static_cast<size_t>(end_ - at_) < size)
        return false;
      memcpy(data, at_, size);
      at_ += size;
      return true;
    }
    const char* skip(size_t size) {
      if (static_cast<size_t>(end_ - at_) < size)
        return nullptr;
      const char* start = at_;
      at_ += size;
      return start;
    }
    template <typename T>
    bool value(T& v) { return bytes(&v, sizeof v); }

  private:
    const char* at_;
    const char* end_;
};

constexpr int kFrequencyFloats = vital::Wavetable::kPolyFrequencySize * vital::poly_float::kSize;

void packWavetable(PackWriter& out, vital::Wavetable* wavetable) {
  const vital::Wavetable::WavetableData* data = wavetable->getAllData();
  out.value<int32_t>(data->num_frames);
  out.value<float>(data->frequency_ratio);
  out.value<float>(data->sample_rate);
  out.value<int32_t>(wavetable->isShepardTable() ? 1 : 0);
  int frames = data->num_frames;
  out.bytes(data->wave_data.get(), sizeof(float) * vital::Wavetable::kWaveformSize * frames);
  out.bytes(data->frequency_amplitudes.get(), sizeof(float) * kFrequencyFloats * frames);
  out.bytes(data->normalized_frequencies.get(), sizeof(float) * kFrequencyFloats * frames);
  out.bytes(data->phases.get(), sizeof(float) * kFrequencyFloats * frames);
}

bool unpackWavetable(PackReader& in, vital::Wavetable* wavetable) {
  int32_t frames = 0, shepard = 0;
  float frequency_ratio = 0, sample_rate = 0;
  if (!in.value(frames) || !in.value(frequency_ratio) || !in.value(sample_rate) || !in.value(shepard))
    return false;
  if (frames < 1 || frames > vital::kNumOscillatorWaveFrames)
    return false;
  const char* wave = in.skip(sizeof(float) * vital::Wavetable::kWaveformSize * frames);
  const char* amplitudes = in.skip(sizeof(float) * kFrequencyFloats * frames);
  const char* normalized = in.skip(sizeof(float) * kFrequencyFloats * frames);
  const char* phases = in.skip(sizeof(float) * kFrequencyFloats * frames);
  if (!wave || !amplitudes || !normalized || !phases)
    return false;

  // As WavetableCreator::render leaves it
  wavetable->setNumFrames(frames);
  wavetable->setShepardTable(shepard != 0);
  wavetable->setFrequencyRatio(frequency_ratio);
  wavetable->setSampleRate(sample_rate);
  auto* data = const_cast<vital::Wavetable::WavetableData*>(wavetable->getAllData());
  memcpy(data->wave_data.get(), wave, sizeof(float) * vital::Wavetable::kWaveformSize * frames);
  memcpy(data->frequency_amplitudes.get(), amplitudes, sizeof(float) * kFrequencyFloats * frames);
  memcpy(data->normalized_frequencies.get(), normalized, sizeof(float) * kFrequencyFloats * frames);
  memcpy(data->phases.get(), phases, sizeof(float) * kFrequencyFloats * frames);
  return true;
}

// A sample's band-limited buffers: their count, then each one's length and samples
bool packBuffers(PackWriter& out, const std::vector<std::unique_ptr<vital::mono_float[]>>& buffers,
                 const std::vector<int>& lengths) {
  if (!buffers.empty() && buffers.size() != lengths.size())
    return false;
  out.value<int32_t>(static_cast<int32_t>(buffers.size()));
  for (size_t i = 0; i < buffers.size(); ++i) {
    out.value<int32_t>(lengths[i]);
    out.bytes(buffers[i].get(), sizeof(float) * lengths[i]);
  }
  return true;
}

bool unpackBuffers(PackReader& in, std::vector<std::unique_ptr<vital::mono_float[]>>& buffers) {
  int32_t count = 0;
  if (!in.value(count) || count < 0 || count > 64)
    return false;
  for (int i = 0; i < count; ++i) {
    int32_t length = 0;
    if (!in.value(length) || length < 0)
      return false;
    buffers.push_back(std::make_unique<vital::mono_float[]>(length));
    if (!in.bytes(buffers.back().get(), sizeof(float) * length))
      return false;
  }
  return true;
}

// The lengths Sample's createBandLimitedBuffers gives its buffers: the
// upsampled ones first, then the original, then each halving down to kMinSize
std::vector<int> bufferLengths(int size) {
  std::vector<int> lengths;
  int upsampled = size;
  for (int i = 0; i < vital::Sample::kUpsampleTimes; ++i)
    upsampled *= 2;
  for (int i = 0, n = upsampled; i < vital::Sample::kUpsampleTimes; ++i, n /= 2)
    lengths.push_back(n + 2 * vital::Sample::kBufferSamples);
  lengths.push_back(size + 2 * vital::Sample::kBufferSamples);
  for (int current = size; current >= vital::Sample::kMinSize;) {
    current = (current + 1) / 2;
    lengths.push_back(current + 2 * vital::Sample::kBufferSamples);
  }
  return lengths;
}

bool packSample(PackWriter& out, vital::Sample* sample) {
  const vital::Sample::SampleData* data = sample->getData();
  out.value<int32_t>(data->length);
  out.value<int32_t>(data->sample_rate);
  out.value<int32_t>(data->stereo ? 1 : 0);
  std::vector<int> lengths = bufferLengths(data->length);
  return packBuffers(out, data->left_buffers, lengths) && packBuffers(out, data->left_loop_buffers, lengths) &&
         packBuffers(out, data->right_buffers, lengths) && packBuffers(out, data->right_loop_buffers, lengths);
}

bool unpackSample(PackReader& in, vital::Sample* sample) {
  int32_t length = 0, sample_rate = 0, stereo = 0;
  if (!in.value(length) || !in.value(sample_rate) || !in.value(stereo))
    return false;
  auto data = std::make_unique<vital::Sample::SampleData>(length, sample_rate, stereo != 0);
  if (!unpackBuffers(in, data->left_buffers) || !unpackBuffers(in, data->left_loop_buffers) ||
      !unpackBuffers(in, data->right_buffers) || !unpackBuffers(in, data->right_loop_buffers))
    return false;
  sample->adoptData(std::move(data));
  return true;
}

// The preset's settings and modulations, as LoadSave::jsonToState loads them
void loadSettings(const json& settings) {
  LoadSave::loadControls(synth.get(), settings);
  LoadSave::loadModulations(synth.get(), settings["modulations"]);
}

// A preset's file, read as LoadSave::jsonToState does (its names and comments
// aside), then packed for the worklet
bool loadFile(json data) {
  std::string version = data["synth_version"];
  if (LoadSave::compareFeatureVersionStrings(version, ProjectInfo::versionString) > 0)
    return false;
  if (LoadSave::compareVersionStrings(version, ProjectInfo::versionString) < 0 ||
      data["settings"].count("sub_octave"))
    data = LoadSave::updateFromOldVersion(data);

  json settings = data["settings"];
  loadSettings(settings);
  LoadSave::loadSample(synth.get(), settings["sample"]);
  LoadSave::loadWavetables(synth.get(), settings["wavetables"]);
  LoadSave::loadLfos(synth.get(), settings["lfos"]);
  synth->checkOversampling();

  settings.erase("wavetables");
  settings.erase("sample");
  data["settings"] = settings;
  data["synth_version"] = ProjectInfo::versionString;
  std::string text = data.dump();
  PackWriter out(pack);
  out.bytes(kPackMagic, sizeof kPackMagic);
  out.value<uint32_t>(static_cast<uint32_t>(text.size()));
  out.bytes(text.data(), text.size());
  for (int i = 0; i < vital::kNumOscillators; ++i)
    packWavetable(out, synth->getEngine()->getWavetable(i));
  if (!packSample(out, synth->getSample())) {
    pack.clear();
    return false;
  }
  return true;
}

bool loadPacked(const char* bytes, size_t size) {
  PackReader in(bytes + sizeof kPackMagic, size - sizeof kPackMagic);
  uint32_t length = 0;
  if (!in.value(length))
    return false;
  const char* text = in.skip(length);
  if (!text)
    return false;
  json data = json::parse(text, text + length, nullptr, false);
  if (data.is_discarded() || !data.is_object())
    return false;
  json settings = data["settings"];
  loadSettings(settings);
  for (int i = 0; i < vital::kNumOscillators; ++i) {
    if (!unpackWavetable(in, synth->getEngine()->getWavetable(i)))
      return false;
  }
  if (!unpackSample(in, synth->getSample()))
    return false;
  LoadSave::loadLfos(synth.get(), settings["lfos"]);
  synth->checkOversampling();
  return true;
}

// Vital's name for a control, its switches named after their effect
std::string label(const std::string& name, const vital::ValueDetails& details) {
  if (name.rfind("macro_control_", 0) == 0)
    return "Macro " + name.substr(name.size() - 1);
  const std::string suffix = " Switch";
  std::string text = details.display_name;
  if (text.size() > suffix.size() && text.compare(text.size() - suffix.size(), suffix.size(), suffix) == 0)
    return text.substr(0, text.size() - suffix.size());
  return text;
}

}  // namespace

// Every voice made ready for the preset's processors, so that playing never
// allocates (see build.sh: prepareAll)
void prepareVoices() { synth->getEngine()->prepareAll(); }

void port_init(float sample_rate, mp::Description& description) {
  synth = std::make_unique<SynthBase>();
  vital::SoundEngine* engine = synth->getEngine();
  engine->setSampleRate(static_cast<int>(sample_rate));
  engine->setBpm(kBpm);
  synth->initEngine();
  engine->updateAllModulationSwitches();
  prepareVoices();

  vital::control_map& controls = synth->getControls();
  for (const Group& group : kGroups) {
    for (const char* name : group.controls) {
      const vital::ValueDetails& details = vital::Parameters::getDetails(name);
      std::string text = label(name, details);
      mp::Param p;
      bool normalized = false;
      if (details.value_scale == vital::ValueDetails::kIndexed && details.string_lookup) {
        std::vector<std::string> options;
        for (int i = 0; i <= static_cast<int>(details.max - details.min); ++i)
          options.push_back(details.string_lookup[i]);
        p = mp::choice(name, text.c_str(), options, static_cast<int>(details.default_value - details.min),
                       group.heading);
        p.min = details.min;
        p.max = details.max;
        p.def = details.default_value;
      }
      else if (details.value_scale == vital::ValueDetails::kIndexed) {
        p = mp::param(name, text.c_str(), details.min, details.max, 1, details.default_value, group.heading);
      }
      else {
        normalized = true;
        float position = (details.default_value - details.min) / (details.max - details.min);
        p = mp::param(name, text.c_str(), 0, 1, 0.001f, position, group.heading);
      }
      description.params.push_back(p);
      param_controls.push_back({ controls[name], normalized, details.min, details.max });
    }
  }
  for (const PresetEntry& preset : kPresets) {
    mp::Preset p;
    p.id = preset.id;
    p.name = preset.name;
    p.tag = preset.tag;
    description.presets.push_back(p);
  }
}

void port_render(const float*, const float*, float* out_l, float* out_r, int frames) {
  vital::SoundEngine* engine = synth->getEngine();
  while (frames > 0) {
    int samples = std::min(frames, vital::kMaxBufferSize);
    engine->process(samples);
    const float* output = reinterpret_cast<const float*>(engine->output(0)->buffer);
    for (int i = 0; i < samples; ++i) {
      out_l[i] = output[vital::poly_float::kSize * i];
      out_r[i] = output[vital::poly_float::kSize * i + 1];
    }
    out_l += samples;
    out_r += samples;
    frames -= samples;
  }
}

void port_note_on(int note, int velocity) { synth->getEngine()->noteOn(note, velocity / 127.0f, 0, 0); }
void port_note_off(int note) { synth->getEngine()->noteOff(note, kLift, 0, 0); }
void port_all_off() { synth->getEngine()->allNotesOff(0); }
void port_set_param(int index, float value) {
  const ParamControl& control = param_controls[index];
  control.value->set(control.normalized ? control.min + value * (control.max - control.min) : value);
}

float port_get_param(int index) {
  const ParamControl& control = param_controls[index];
  float value = control.value->value();
  return control.normalized ? (value - control.min) / (control.max - control.min) : value;
}

// Loads the preset whose file, or pack, was just written to mp_preset_buffer
void port_load_preset(int) {
  preset_failed = true;
  pack.clear();
  if (preset_data.empty())
    return;
  std::vector<char> bytes = std::move(preset_data);
  preset_data.clear();
  synth->getEngine()->allSoundsOff();
  try {
    if (bytes.size() > sizeof kPackMagic && memcmp(bytes.data(), kPackMagic, sizeof kPackMagic) == 0) {
      preset_failed = !loadPacked(bytes.data(), bytes.size());
    }
    else {
      json data = json::parse(bytes.begin(), bytes.end(), nullptr, false);
      preset_failed = data.is_discarded() || !data.is_object() || !loadFile(data);
    }
  }
  catch (const json::exception&) {
    preset_failed = true;
  }
  prepareVoices();
}

extern "C" {

// Where the worklet writes the next preset's file, `size` bytes
EMSCRIPTEN_KEEPALIVE char* mp_preset_buffer(int size) {
  preset_data.resize(size > 0 ? size : 0);
  return preset_data.data();
}

// The last preset read from its file, packed for another instance of the
// port (empty after a packed preset)
EMSCRIPTEN_KEEPALIVE const char* mp_pack_preset() { return pack.data(); }
EMSCRIPTEN_KEEPALIVE int mp_pack_preset_size() { return static_cast<int>(pack.size()); }

// Whether the last preset could not be loaded (its file unreadable or saved by
// a newer Vital)
EMSCRIPTEN_KEEPALIVE int mp_preset_error() { return preset_failed ? 1 : 0; }

}  // extern "C"
