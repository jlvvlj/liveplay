// Dexed's standard tuning, as in msfa/tuning.cc (Apache-2.0). tuning.cc
// itself is not built: its scale-file half needs JUCE alert windows and the
// tuning library's exceptions.

#include "msfa/tuning.h"

namespace {

struct StandardTuning : public TuningState {
  StandardTuning() {
    const int base = 50857777;  // (1 << 24) * (log(440) / log(2) - 69/12)
    const int step = (1 << 24) / 12;
    for (int mn = 0; mn < 128; ++mn) current_logfreq_table_[mn] = base + step * mn;
  }
  int32_t midinote_to_logfreq(int midinote) override { return current_logfreq_table_[midinote]; }
  int current_logfreq_table_[128];
};

}  // namespace

std::shared_ptr<TuningState> createStandardTuning() { return std::make_shared<StandardTuning>(); }
