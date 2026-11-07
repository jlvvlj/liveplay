// The part of Vital's SynthBase that loading a preset uses: the engine, each
// oscillator's wavetable creator, and modulation connections applied to the
// engine straight away (upstream queues them for its audio thread; the port
// loads presets on the thread that renders)
#pragma once

#include "JuceHeader.h"
#include "line_generator.h"
#include "sound_engine.h"
#include "synth_constants.h"
#include "synth_types.h"
#include "wavetable_creator.h"

#include <memory>
#include <vector>

class SynthBase {
  public:
    SynthBase();

    vital::SoundEngine* getEngine() { return engine_.get(); }
    vital::control_map& getControls() { return controls_; }
    vital::ModulationConnectionBank& getModulationBank() { return engine_->getModulationBank(); }
    WavetableCreator* getWavetableCreator(int index) { return wavetable_creators_[index].get(); }
    vital::Sample* getSample() { return engine_->getSample(); }
    LineGenerator* getLfoSource(int index) { return engine_->getLfoSource(index); }

    void connectModulation(vital::ModulationConnection* connection);
    void clearModulations();
    void modWheelGuiChanged(vital::mono_float value) { engine_->setModWheelAllChannels(value); }
    void checkOversampling() { engine_->checkOversampling(); }

    // Every control at its default, no modulations, each oscillator's basic wavetable
    void initEngine();

  private:
    vital::modulation_change createModulationChange(vital::ModulationConnection* connection);

    std::unique_ptr<vital::SoundEngine> engine_;
    std::unique_ptr<WavetableCreator> wavetable_creators_[vital::kNumOscillators];
    vital::control_map controls_;
    std::vector<vital::ModulationConnection*> mod_connections_;
};
