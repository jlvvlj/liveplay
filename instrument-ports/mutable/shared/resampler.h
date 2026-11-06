// Streaming stereo sample rate converter: windowed-sinc kernel with
// interpolated phases. The modules run at their own hardware rates (Plaits
// 47.9 kHz, Rings 48 kHz, Elements and Clouds 32 kHz, Braids 96 kHz); this
// converts to and from the audio context's rate.
#pragma once

#include <cmath>
#include <cstdint>

namespace mi_port {

class Resampler {
 public:
  static const int kTaps = 32;
  static const int kPhases = 128;
  static const int kRing = 512;  // a power of two above kTaps + the largest pushed block

  void Init(double from_rate, double to_rate) {
    step_ = from_rate / to_rate;
    // Cutoff in cycles per source sample, a little under the lower Nyquist
    const double cutoff = 0.5 * (to_rate < from_rate ? to_rate / from_rate : 1.0) * 0.92;
    const double half = kTaps / 2;
    for (int p = 0; p <= kPhases; ++p) {
      const double frac = double(p) / kPhases;
      double sum = 0;
      for (int t = 0; t < kTaps; ++t) {
        const double d = t - (half - 1) - frac;
        const double x = 2.0 * cutoff * d;
        const double sinc = std::fabs(x) < 1e-9 ? 1.0 : std::sin(M_PI * x) / (M_PI * x);
        // Blackman-Harris window over the kernel's span
        const double w_pos = (d + half) / (2.0 * half);
        double w = 0;
        if (w_pos > 0 && w_pos < 1) {
          const double a = 2.0 * M_PI * w_pos;
          w = 0.35875 - 0.48829 * std::cos(a) + 0.14128 * std::cos(2 * a) - 0.01168 * std::cos(3 * a);
        }
        kernel_[p][t] = float(sinc * w);
        sum += sinc * w;
      }
      for (int t = 0; t < kTaps; ++t) kernel_[p][t] = float(kernel_[p][t] / sum);
    }
    Reset();
  }

  void Reset() {
    for (int c = 0; c < 2; ++c)
      for (int i = 0; i < kRing; ++i) history_[c][i] = 0.0f;
    written_ = 0;
    base_ = 0;
    frac_ = 0.0;
  }

  inline void Push(float l, float r) {
    const int i = int(written_ & (kRing - 1));
    history_[0][i] = l;
    history_[1][i] = r;
    ++written_;
  }

  // An output sample can be read once every source sample it needs is in
  inline bool Available() const { return base_ + kTaps / 2 < written_; }

  inline void Pull(float* l, float* r) {
    float p = float(frac_ * kPhases);
    int phase = int(p);
    if (phase >= kPhases) phase = kPhases - 1;
    const float f = p - phase;
    const float* k0 = kernel_[phase];
    const float* k1 = kernel_[phase + 1];
    const int64_t start = base_ - (kTaps / 2 - 1);
    float sl = 0.0f, sr = 0.0f;
    for (int t = 0; t < kTaps; ++t) {
      const float k = k0[t] + f * (k1[t] - k0[t]);
      const int i = int((start + t) & (kRing - 1));
      sl += history_[0][i] * k;
      sr += history_[1][i] * k;
    }
    *l = sl;
    *r = sr;
    frac_ += step_;
    const double whole = std::floor(frac_);
    base_ += int64_t(whole);
    frac_ -= whole;
  }

 private:
  float kernel_[kPhases + 1][kTaps];
  float history_[2][kRing];
  int64_t written_;
  int64_t base_;
  double frac_;
  double step_;
};

// Runs a module that renders fixed blocks at its own rate, at the output rate
template <int kBlock>
class Bridge {
 public:
  void Init(double module_rate, double output_rate) { resampler_.Init(module_rate, output_rate); }
  void Reset() { resampler_.Reset(); }

  // render_block(float* left, float* right) renders kBlock frames
  template <typename F>
  inline void Render(float* out_l, float* out_r, int frames, F&& render_block) {
    for (int i = 0; i < frames; ++i) {
      while (!resampler_.Available()) {
        render_block(block_l_, block_r_);
        for (int k = 0; k < kBlock; ++k) resampler_.Push(block_l_[k], block_r_[k]);
      }
      resampler_.Pull(&out_l[i], &out_r[i]);
    }
  }

 private:
  Resampler resampler_;
  float block_l_[kBlock];
  float block_r_[kBlock];
};

}  // namespace mi_port
