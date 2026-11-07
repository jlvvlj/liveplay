// Vital's LoadSave, only its preset loading: these functions are taken from
// upstream's src/common/load_save.cpp at build time (tools/extract-load-save.mjs),
// unchanged, and built against the port's SynthBase (synth_base.h)
#pragma once

#include "JuceHeader.h"
#include "json/json.h"

#include <map>
#include <string>

using json = nlohmann::json;

class SynthBase;

class LoadSave {
  public:
    static void convertBufferToPcm(json& data, const std::string& field);
    static void convertPcmToFloatBuffer(json& data, const std::string& field);
    static json updateFromOldVersion(json state);
    static void loadControls(SynthBase* synth, const json& data);
    static void loadModulations(SynthBase* synth, const json& modulations);
    static void loadSample(SynthBase* synth, const json& json_sample);
    static void loadWavetables(SynthBase* synth, const json& wavetables);
    static void loadLfos(SynthBase* synth, const json& lfos);
    static int compareFeatureVersionStrings(String a, String b);
    static int compareVersionStrings(String a, String b);
};
