// OB-Xf as a Melodics port: upstream's SynthEngine (Motherboard, voices,
// filters, envelopes, voice allocation and stealing) with its full parameter
// list and every factory patch. Parameters are set through the same engine
// callbacks upstream's ParameterCoordinator registers.

#include "port.h"

#include "SynthEngine.h"
#include "obxf_data.h"

#include <cmath>
#include <string>

namespace
{

SynthEngine engine;
float sampleRate = 48000.f;
// Normalized (0..1) value of every parameter, as upstream's program holds them
float values[obxf_data::numParams];
// Upstream gives the engine a 120 BPM transport when the host has none
double ppq = 0.0;
bool resetTransport = true;

float toNormalized(int index, float value)
{
    const auto &p = obxf_data::params[index];
    float n = (value - p.min) / (p.max - p.min);
    return n < 0.f ? 0.f : (n > 1.f ? 1.f : n);
}

float fromNormalized(int index, float n)
{
    const auto &p = obxf_data::params[index];
    float v = p.min + n * (p.max - p.min);
    if (p.kind != obxf_data::Float)
        v = std::round(v);
    return v;
}

void setNormalized(int index, float n)
{
    values[index] = n;
    obxf_data::apply(engine, index, n);
}

std::vector<std::string> split(const char *options)
{
    std::vector<std::string> out;
    std::string current;
    for (const char *c = options; *c; ++c)
    {
        if (*c == '|')
        {
            out.push_back(current);
            current.clear();
        }
        else
        {
            current += *c;
        }
    }
    out.push_back(current);
    return out;
}

} // namespace

void port_init(float sr, mp::Description &description)
{
    sampleRate = sr;

    // As ObxfAudioProcessor::prepareToPlay: every parameter, then the sample rate
    for (int i = 0; i < obxf_data::numParams; ++i)
        setNormalized(i, toNormalized(i, obxf_data::params[i].def));
    engine.setSampleRate(sr);

    for (int i = 0; i < obxf_data::numParams; ++i)
    {
        const auto &p = obxf_data::params[i];
        if (p.kind == obxf_data::Choice)
        {
            auto options = split(p.options);
            mp::Param param = mp::choice(p.key, p.label, options, static_cast<int>(p.def - p.min),
                                         p.group);
            description.params.push_back(param);
        }
        else
        {
            const float step = p.kind == obxf_data::Int ? 1.f : (p.max - p.min) / 1000.f;
            description.params.push_back(mp::param(p.key, p.label, p.min, p.max, step, p.def, p.group));
        }
    }
    for (int i = 0; i < obxf_data::numPresets; ++i)
    {
        const auto &p = obxf_data::presets[i];
        description.presets.push_back({p.id, p.name, p.tag});
    }
}

void port_render(const float *, const float *, float *outL, float *outR, int frames)
{
    engine.setPlayHead(120.f, static_cast<float>(ppq), resetTransport);
    resetTransport = false;
    engine.processBlock(outL, outR, frames);
    ppq += frames * 120.0 / (60.0 * sampleRate);
}

void port_note_on(int note, int velocity) { engine.processNoteOn(note, velocity / 127.f, 0); }

void port_note_off(int note) { engine.processNoteOff(note, 64.f / 127.f, 0); }

// Every held note is released, as a MIDI all-notes-off; voices fade on their
// own release instead of being cut
void port_all_off()
{
    engine.sustainOff();
    engine.allNotesOff();
}

void port_set_param(int index, float value)
{
    const auto &p = obxf_data::params[index];
    if (p.kind == obxf_data::Choice)
        value = p.min + std::round(value);
    setNormalized(index, toNormalized(index, value));
}

float port_get_param(int index)
{
    const auto &p = obxf_data::params[index];
    const float v = fromNormalized(index, values[index]);
    return p.kind == obxf_data::Choice ? v - p.min : v;
}

// As upstream loads a patch: every parameter in ParameterList order
void port_load_preset(int index)
{
    for (int i = 0; i < obxf_data::numParams; ++i)
        setNormalized(i, obxf_data::presetValues[index][i]);
}
