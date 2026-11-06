// Surge XT engine (surge-common) behind a small C interface for the AudioWorklet.
//
// Everything that allocates (construction, patch loads, effect changes) runs in
// the message calls; sxt_render() only runs the engine.

#include "SurgeSynthesizer.h"
#include "SurgeStorage.h"

#include <emscripten/emscripten.h>

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <new>
#include <memory>
#include <string>
#include <vector>

// Heap allocations made while the engine renders: the global operator new is
// replaced to count them (check.mjs fails if there are any). Deletes stay
// libc++'s, which free() what these return.
static bool rendering = false;
static unsigned renderAllocations = 0;

static void *allocate(std::size_t n)
{
    renderAllocations += rendering;
#ifdef SXT_TRACE_ALLOC
    if (rendering)
        EM_ASM({ console.log('alloc', $0, new Error().stack); }, n);
#endif
    if (void *p = std::malloc(n ? n : 1))
        return p;
    throw std::bad_alloc();
}
static void *allocateAligned(std::size_t n, std::align_val_t a)
{
    renderAllocations += rendering;
    void *p = nullptr;
    if (posix_memalign(&p, std::max(sizeof(void *), (std::size_t)a), n ? n : 1) == 0)
        return p;
    throw std::bad_alloc();
}
void *operator new(std::size_t n) { return allocate(n); }
void *operator new[](std::size_t n) { return allocate(n); }
void *operator new(std::size_t n, std::align_val_t a) { return allocateAligned(n, a); }
void *operator new[](std::size_t n, std::align_val_t a) { return allocateAligned(n, a); }

namespace
{
struct Host : public SurgeSynthesizer::PluginLayer
{
    void surgeParameterUpdated(const SurgeSynthesizer::ID &, float) override {}
    void surgeMacroUpdated(long, float) override {}
};

enum Kind
{
    PARAM, // a Surge parameter, set through setParameter01
    MACRO, // macro n, 0..1
    FX_MIX // the "Mix" parameter of whatever effect sits in an FX slot
};

struct Exposed
{
    std::string key, label, group;
    Kind kind;
    Parameter *param{nullptr};
    int index{0};
    Parameter *mute{nullptr}; // a mixer level's mute switch, cleared when the level is raised
};

Host host;
std::unique_ptr<SurgeSynthesizer> synth;
std::vector<Exposed> exposed;
std::vector<int> presets; // patch_list indices, by category then name
std::string json;
std::string initError;
constexpr const char *INITIAL_PRESET = "Templates/Init Saw";

void addParam(const char *key, const char *label, const char *group, Parameter &p)
{
    exposed.push_back({key, label, group, PARAM, &p, 0});
}

void buildParams()
{
    auto &patch = synth->storage.getPatch();
    auto &a = patch.scene[0];
    char key[64], label[64];

    for (int i = 0; i < n_customcontrollers; ++i)
    {
        snprintf(key, sizeof key, "macro%d", i + 1);
        snprintf(label, sizeof label, "Macro %d", i + 1);
        exposed.push_back({key, label, "Macros", MACRO, nullptr, i});
    }

    for (int o = 0; o < n_oscs; ++o)
    {
        auto &osc = a.osc[o];
        snprintf(key, sizeof key, "osc%d_octave", o + 1);
        snprintf(label, sizeof label, "Osc %d octave", o + 1);
        addParam(key, label, "Oscillators", osc.octave);
        snprintf(key, sizeof key, "osc%d_pitch", o + 1);
        snprintf(label, sizeof label, "Osc %d pitch", o + 1);
        addParam(key, label, "Oscillators", osc.pitch);
    }
    addParam("osc1_level", "Osc 1 level", "Oscillators", a.level_o1);
    exposed.back().mute = &a.mute_o1;
    addParam("osc2_level", "Osc 2 level", "Oscillators", a.level_o2);
    exposed.back().mute = &a.mute_o2;
    addParam("osc3_level", "Osc 3 level", "Oscillators", a.level_o3);
    exposed.back().mute = &a.mute_o3;
    addParam("noise_level", "Noise level", "Oscillators", a.level_noise);
    exposed.back().mute = &a.mute_noise;
    addParam("fm_depth", "FM depth", "Oscillators", a.fm_depth);
    addParam("drift", "Drift", "Oscillators", a.drift);

    for (int f = 0; f < 2; ++f)
    {
        auto &fu = a.filterunit[f];
        snprintf(key, sizeof key, "filter%d_cutoff", f + 1);
        snprintf(label, sizeof label, "Filter %d cutoff", f + 1);
        addParam(key, label, "Filters", fu.cutoff);
        snprintf(key, sizeof key, "filter%d_resonance", f + 1);
        snprintf(label, sizeof label, "Filter %d resonance", f + 1);
        addParam(key, label, "Filters", fu.resonance);
        snprintf(key, sizeof key, "filter%d_envmod", f + 1);
        snprintf(label, sizeof label, "Filter %d envelope", f + 1);
        addParam(key, label, "Filters", fu.envmod);
        snprintf(key, sizeof key, "filter%d_keytrack", f + 1);
        snprintf(label, sizeof label, "Filter %d keytrack", f + 1);
        addParam(key, label, "Filters", fu.keytrack);
    }
    addParam("filter_balance", "Filter balance", "Filters", a.filter_balance);
    addParam("waveshaper_drive", "Waveshaper drive", "Filters", a.wsunit.drive);
    addParam("highpass", "Highpass", "Filters", a.lowcut);

    const char *envNames[2] = {"Amp", "Filter"};
    const char *envKeys[2] = {"amp", "filter"};
    for (int e = 0; e < 2; ++e)
    {
        auto &env = a.adsr[e];
        Parameter *parts[4] = {&env.a, &env.d, &env.s, &env.r};
        const char *stage[4] = {"attack", "decay", "sustain", "release"};
        for (int s = 0; s < 4; ++s)
        {
            snprintf(key, sizeof key, "%s_%s", envKeys[e], stage[s]);
            snprintf(label, sizeof label, "%s %s", envNames[e], stage[s]);
            addParam(key, label, "Envelopes", *parts[s]);
        }
    }

    struct Slot
    {
        int slot;
        const char *key, *label;
    };
    const Slot slots[] = {{fxslot_ains1, "fx_a1_mix", "A insert 1 mix"},
                          {fxslot_ains2, "fx_a2_mix", "A insert 2 mix"},
                          {fxslot_send1, "fx_send1_mix", "Send 1 mix"},
                          {fxslot_send2, "fx_send2_mix", "Send 2 mix"},
                          {fxslot_global1, "fx_global1_mix", "Global 1 mix"},
                          {fxslot_global2, "fx_global2_mix", "Global 2 mix"}};
    for (auto &s : slots)
        exposed.push_back({s.key, s.label, "Effects", FX_MIX, nullptr, s.slot});
    addParam("send1_level", "Send 1 level", "Effects", a.send_level[0]);
    addParam("send2_level", "Send 2 level", "Effects", a.send_level[1]);
    addParam("send1_return", "Send 1 return", "Effects", patch.fx[fxslot_send1].return_level);
    addParam("send2_return", "Send 2 return", "Effects", patch.fx[fxslot_send2].return_level);

    addParam("scene_volume", "Scene volume", "Output", a.volume);
    addParam("scene_width", "Width", "Output", a.width);
    addParam("volume", "Volume", "Output", patch.volume);
}

bool isInteger(const Parameter *p) { return p->valtype == vt_int || p->valtype == vt_bool; }

Parameter *fxMix(int slot)
{
    auto &fx = synth->storage.getPatch().fx[slot];
    if (fx.type.val.i == fxt_off)
        return nullptr;
    for (int i = 0; i < n_fx_params; ++i)
        if (fx.p[i].ctrltype != ct_none && strcmp(fx.p[i].get_name(), "Mix") == 0)
            return &fx.p[i];
    return nullptr;
}

void appendEscaped(std::string &out, const std::string &s)
{
    out += '"';
    for (char c : s)
    {
        if (c == '"' || c == '\\')
        {
            out += '\\';
            out += c;
        }
        else if ((unsigned char)c < 0x20)
            out += ' ';
        else
            out += c;
    }
    out += '"';
}

void appendNumber(std::string &out, double v)
{
    char b[32];
    snprintf(b, sizeof b, "%.6g", v);
    out += b;
}

// Current value in the units the worklet protocol uses: 0..1 for continuous
// parameters, the integer itself for integer ones
double currentValue(const Exposed &e)
{
    switch (e.kind)
    {
    case PARAM:
        if (isInteger(e.param))
            return e.param->val.i;
        // A muted mixer source reads as level 0: what it sounds like
        if (e.mute && e.mute->val.b)
            return 0;
        return e.param->get_value_f01();
    case MACRO:
        return synth->getMacroParameter01(e.index);
    case FX_MIX:
    {
        auto *p = fxMix(e.index);
        return p ? p->get_value_f01() : 1.0;
    }
    }
    return 0;
}

void setParam(Parameter *p, float value01, bool integer)
{
    SurgeSynthesizer::ID id;
    if (synth->fromSynthSideId(p->id, id))
        synth->setParameter01(id, std::clamp(value01, 0.f, 1.f), false, integer);
}

// After a patch load: run what Surge would otherwise do on the
// audio thread at the start of the next block
void settle()
{
    synth->processAudioThreadOpsWhenAudioEngineUnavailable(true);
    synth->halt_engine = false;
}
} // namespace

extern "C"
{
    int sxt_load_preset_named(const char *name);

    // Why sxt_init failed, when it returns -1
    EMSCRIPTEN_KEEPALIVE const char *sxt_error() { return initError.c_str(); }

    EMSCRIPTEN_KEEPALIVE int sxt_init(float sampleRate, const char *dataPath)
    {
        try
        {
            synth = std::make_unique<SurgeSynthesizer>(&host, std::string(dataPath));
        }
        catch (const std::exception &e)
        {
            initError = e.what();
            return -1;
        }
        synth->setSamplerate(sampleRate);
        synth->time_data.tempo = 120;
        synth->time_data.ppqPos = 0;
        synth->audio_processing_active = false;

        auto &st = synth->storage;
        for (auto idx : st.patchOrdering)
        {
            auto &p = st.patch_list[idx];
            if (p.category >= st.firstThirdPartyCategory)
                continue;
            auto &cat = st.patch_category[p.category].name;
            // Patches built around audio input are silent without it
            if (cat.rfind("Vocoder", 0) == 0 || p.name.rfind("Audio In", 0) == 0)
                continue;
            // Formula modulators run Lua, which this build leaves out (check.mjs --all
            // fails if a listed preset still routes one)
            if (cat == "Tutorials/Formula Modulator" ||
                (cat == "Templates" && (p.name == "Init Arpeggiator" || p.name == "Init Duophonic")))
                continue;
            presets.push_back(idx);
        }
        // By category, then name
        auto lower = [](std::string s) {
            for (auto &c : s)
                c = (char)std::tolower((unsigned char)c);
            return s;
        };
        std::stable_sort(presets.begin(), presets.end(), [&](int x, int y) {
            auto &a = st.patch_list[x], &b = st.patch_list[y];
            auto ca = lower(st.patch_category[a.category].name);
            auto cb = lower(st.patch_category[b.category].name);
            return ca != cb ? ca < cb : lower(a.name) < lower(b.name);
        });
        // Start from the plain init patch, as Surge XT does
        if (sxt_load_preset_named(INITIAL_PRESET) < 0)
        {
            initError = std::string("no factory preset ") + INITIAL_PRESET;
            return -1;
        }
        buildParams();
        return (int)presets.size();
    }

    EMSCRIPTEN_KEEPALIVE int sxt_block_size() { return BLOCK_SIZE; }
    EMSCRIPTEN_KEEPALIVE float *sxt_output_left() { return synth->output[0]; }
    EMSCRIPTEN_KEEPALIVE float *sxt_output_right() { return synth->output[1]; }

    EMSCRIPTEN_KEEPALIVE void sxt_render()
    {
        synth->audio_processing_active = true;
        rendering = true;
        synth->process();
        rendering = false;
    }

    EMSCRIPTEN_KEEPALIVE void sxt_note_on(int note, int velocity)
    {
        synth->playNote(0, (char)note, (char)velocity, 0);
    }
    EMSCRIPTEN_KEEPALIVE void sxt_note_off(int note) { synth->releaseNote(0, (char)note, 0); }
    EMSCRIPTEN_KEEPALIVE void sxt_all_off() { synth->allNotesOff(); }

    // Preset id -> index; ids are "Category/Name" paths below patches_factory
    EMSCRIPTEN_KEEPALIVE int sxt_preset_count() { return (int)presets.size(); }

    EMSCRIPTEN_KEEPALIVE int sxt_load_preset(int i)
    {
        if (i < 0 || i >= (int)presets.size())
            return 0;
        synth->allNotesOff();
        // Patches saved before Surge's streaming revision 17 leave the global volume
        // as it was; start each load from the default so a preset always sounds the same
        auto &volume = synth->storage.getPatch().volume;
        volume.set_value_f01(volume.get_default_value_f01());
        synth->patchid_queue = presets[i];
        settle();
        return 1;
    }

    EMSCRIPTEN_KEEPALIVE int sxt_load_preset_named(const char *name)
    {
        auto &st = synth->storage;
        for (int i = 0; i < (int)presets.size(); ++i)
        {
            auto &p = st.patch_list[presets[i]];
            if (st.patch_category[p.category].name + "/" + p.name == name)
                return sxt_load_preset(i) ? i : -1;
        }
        return -1;
    }

    EMSCRIPTEN_KEEPALIVE int sxt_param_count() { return (int)exposed.size(); }

    // A parameter's value now, in the units sxt_set_param takes
    EMSCRIPTEN_KEEPALIVE double sxt_param_value(int i)
    {
        if (i < 0 || i >= (int)exposed.size())
            return 0;
        return currentValue(exposed[i]);
    }

    EMSCRIPTEN_KEEPALIVE void sxt_set_param(int i, float value)
    {
        if (i < 0 || i >= (int)exposed.size())
            return;
        auto &e = exposed[i];
        switch (e.kind)
        {
        case PARAM:
        {
            auto *p = e.param;
            float v01 = value;
            if (isInteger(p))
            {
                int lo = p->val_min.i, hi = p->val_max.i;
                v01 = hi > lo ? (value - lo) / (float)(hi - lo) : 0.f;
            }
            setParam(p, v01, isInteger(p));
            if (e.mute && value > 0 && e.mute->val.b)
                setParam(e.mute, 0.f, true);
            break;
        }
        case MACRO:
            synth->setMacroParameter01(e.index, std::clamp(value, 0.f, 1.f));
            break;
        case FX_MIX:
            if (auto *p = fxMix(e.index))
                setParam(p, value, false);
            break;
        }
    }

    // The ready message's params and presets, as JSON
    EMSCRIPTEN_KEEPALIVE const char *sxt_describe()
    {
        auto &st = synth->storage;
        json.clear();
        json += "{\"params\":[";
        for (size_t i = 0; i < exposed.size(); ++i)
        {
            auto &e = exposed[i];
            double lo = 0, hi = 1, step = 0.001;
            if (e.kind == PARAM && isInteger(e.param))
            {
                lo = e.param->val_min.i;
                hi = e.param->val_max.i;
                step = 1;
            }
            if (i)
                json += ',';
            json += "{\"key\":";
            appendEscaped(json, e.key);
            json += ",\"label\":";
            appendEscaped(json, e.label);
            json += ",\"group\":";
            appendEscaped(json, e.group);
            json += ",\"min\":";
            appendNumber(json, lo);
            json += ",\"max\":";
            appendNumber(json, hi);
            json += ",\"step\":";
            appendNumber(json, step);
            json += ",\"default\":";
            appendNumber(json, currentValue(e));
            json += '}';
        }
        json += "],\"presets\":[";
        for (size_t i = 0; i < presets.size(); ++i)
        {
            auto &p = st.patch_list[presets[i]];
            auto &cat = st.patch_category[p.category].name;
            if (i)
                json += ',';
            json += "{\"id\":";
            appendEscaped(json, cat + "/" + p.name);
            json += ",\"name\":";
            appendEscaped(json, p.name);
            json += ",\"tag\":";
            appendEscaped(json, cat);
            json += '}';
        }
        json += "]}";
        return json.c_str();
    }

    EMSCRIPTEN_KEEPALIVE unsigned sxt_render_allocations() { return renderAllocations; }

    // Whether the loaded patch routes a formula modulator (Lua) to anything
    EMSCRIPTEN_KEEPALIVE int sxt_patch_uses_formula()
    {
        auto &patch = synth->storage.getPatch();
        auto formula = [&](int scene, int source) {
            if (scene < 0 || scene >= n_scenes || source < ms_lfo1 || source > ms_slfo6)
                return false;
            return patch.scene[scene].lfo[source - ms_lfo1].shape.val.i == lt_formula;
        };
        for (int s = 0; s < n_scenes; ++s)
        {
            for (auto &r : patch.scene[s].modulation_voice)
                if (formula(s, r.source_id))
                    return 1;
            for (auto &r : patch.scene[s].modulation_scene)
                if (formula(s, r.source_id))
                    return 1;
        }
        for (auto &r : patch.modulation_global)
            if (formula(r.source_scene, r.source_id))
                return 1;
        return 0;
    }
}
