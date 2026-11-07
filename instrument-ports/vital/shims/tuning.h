// Vital's Tuning, as its voices use it: the port plays standard tuning (Vital's
// own default), so the scale files, tunings and their parsing are not built
#pragma once

#include "common.h"

class Tuning {
  public:
    vital::mono_float convertMidiNote(int note) const { return static_cast<vital::mono_float>(note); }
};
