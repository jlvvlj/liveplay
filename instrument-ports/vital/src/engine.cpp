// Vital's engine as one translation unit, the way its own build compiles it
// (src/unity_build): the synthesis code, then the wavetable and LFO shape code
// presets carry. The plugin, the interface, files and MIDI handling are not built.

#include "synthesis.cpp"

#include "line_generator.cpp"
#include "synth_parameters.cpp"
#include "synth_types.cpp"
#include "wavetable_component_factory.cpp"
#include "wavetable_keyframe.cpp"
#include "file_source.cpp"
#include "shepard_tone_source.cpp"
#include "frequency_filter_modifier.cpp"
#include "wave_fold_modifier.cpp"
#include "phase_modifier.cpp"
#include "wavetable_creator.cpp"
#include "wave_line_source.cpp"
#include "wave_source.cpp"
#include "wavetable_group.cpp"
#include "wave_window_modifier.cpp"
#include "wavetable_component.cpp"
#include "pitch_detector.cpp"
#include "wave_warp_modifier.cpp"
#include "slew_limit_modifier.cpp"
