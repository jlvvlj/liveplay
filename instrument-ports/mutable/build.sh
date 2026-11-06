#!/usr/bin/env bash
# Builds the Mutable Instruments ports: dist/{plaits,rings,elements,braids,clouds}.wasm
# and their worklets. Usage: ./build.sh [module...]  (all five by default)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/../common/build-lib.sh"

ensure_emcc
"$here/fetch.sh"

eurorack=$here/upstream/eurorack
dist=$here/dist
build=$here/build
mkdir -p "$dist" "$build"

# The module sources, as each module's desktop test build lists them
plaits_sources="
plaits/dsp/chords/chord_bank.cc
plaits/dsp/engine/additive_engine.cc
plaits/dsp/engine/bass_drum_engine.cc
plaits/dsp/engine/chord_engine.cc
plaits/dsp/engine/fm_engine.cc
plaits/dsp/engine/grain_engine.cc
plaits/dsp/engine/hi_hat_engine.cc
plaits/dsp/engine/modal_engine.cc
plaits/dsp/engine/noise_engine.cc
plaits/dsp/engine/particle_engine.cc
plaits/dsp/engine/snare_drum_engine.cc
plaits/dsp/engine/speech_engine.cc
plaits/dsp/engine/string_engine.cc
plaits/dsp/engine/swarm_engine.cc
plaits/dsp/engine/virtual_analog_engine.cc
plaits/dsp/engine/waveshaping_engine.cc
plaits/dsp/engine/wavetable_engine.cc
plaits/dsp/engine2/chiptune_engine.cc
plaits/dsp/engine2/phase_distortion_engine.cc
plaits/dsp/engine2/six_op_engine.cc
plaits/dsp/engine2/string_machine_engine.cc
plaits/dsp/engine2/virtual_analog_vcf_engine.cc
plaits/dsp/engine2/wave_terrain_engine.cc
plaits/dsp/fm/algorithms.cc
plaits/dsp/fm/dx_units.cc
plaits/dsp/physical_modelling/modal_voice.cc
plaits/dsp/physical_modelling/resonator.cc
plaits/dsp/physical_modelling/string.cc
plaits/dsp/physical_modelling/string_voice.cc
plaits/dsp/speech/lpc_speech_synth.cc
plaits/dsp/speech/lpc_speech_synth_controller.cc
plaits/dsp/speech/lpc_speech_synth_phonemes.cc
plaits/dsp/speech/lpc_speech_synth_words.cc
plaits/dsp/speech/naive_speech_synth.cc
plaits/dsp/speech/sam_speech_synth.cc
plaits/dsp/voice.cc
plaits/resources.cc
stmlib/dsp/units.cc
stmlib/utils/random.cc
"
rings_sources="
rings/dsp/fm_voice.cc
rings/dsp/part.cc
rings/dsp/resonator.cc
rings/dsp/string.cc
rings/dsp/string_synth_part.cc
rings/resources.cc
stmlib/dsp/units.cc
stmlib/utils/random.cc
"
elements_sources="
elements/dsp/exciter.cc
elements/dsp/multistage_envelope.cc
elements/dsp/ominous_voice.cc
elements/dsp/part.cc
elements/dsp/resonator.cc
elements/dsp/string.cc
elements/dsp/tube.cc
elements/dsp/voice.cc
elements/resources.cc
stmlib/dsp/units.cc
stmlib/utils/random.cc
"
braids_sources="
braids/analog_oscillator.cc
braids/digital_oscillator.cc
braids/macro_oscillator.cc
braids/quantizer.cc
braids/resources.cc
stmlib/utils/random.cc
"
# correlator.cc and window.h come patched from patch-clouds.sh (see there)
clouds_sources="
../../build/clouds-patched/clouds/dsp/correlator.cc
clouds/dsp/granular_processor.cc
clouds/dsp/mu_law.cc
clouds/dsp/pvoc/frame_transformation.cc
clouds/dsp/pvoc/phase_vocoder.cc
clouds/dsp/pvoc/stft.cc
clouds/resources.cc
stmlib/dsp/atan.cc
stmlib/dsp/units.cc
stmlib/utils/random.cc
"

flags=("${MP_CFLAGS[@]}" -DTEST -w -I"$eurorack" -I"$here")

# build_module <name> <inputs 0|1> <sources>
build_module() {
  local name=$1 inputs=$2 sources=$3
  local list=$build/$name.sources
  : >"$list"
  for s in $sources; do echo "$eurorack/$s" >>"$list"; done
  echo "$here/$name.cpp" >>"$list"
  echo "$common_dir/port.cpp" >>"$list"
  compile_objects "$build/$name" "$list" "${flags[@]}" >"$build/$name.objects"
  # shellcheck disable=SC2046
  em++ "${MP_CFLAGS[@]}" "${MP_LDFLAGS[@]}" $(cat "$build/$name.objects") -o "$dist/$name.wasm"
  emit_worklet "$name" "$inputs" "$dist"
  echo "built $name: $(wc -c <"$dist/$name.wasm" | tr -d ' ') bytes"
}

modules=("$@")
[ ${#modules[@]} -eq 0 ] && modules=(plaits rings elements braids clouds)
for m in "${modules[@]}"; do
  case $m in
    plaits) build_module plaits 0 "$plaits_sources" ;;
    rings) build_module rings 0 "$rings_sources" ;;
    elements) build_module elements 0 "$elements_sources" ;;
    braids) build_module braids 0 "$braids_sources" ;;
    clouds)
      "$here/patch-clouds.sh" "$eurorack" "$build/clouds-patched"
      saved_flags=("${flags[@]}")
      flags=(-I"$build/clouds-patched" "${flags[@]}")
      build_module clouds 1 "$clouds_sources"
      flags=("${saved_flags[@]}")
      ;;
    *) echo "unknown module $m" >&2; exit 1 ;;
  esac
done
