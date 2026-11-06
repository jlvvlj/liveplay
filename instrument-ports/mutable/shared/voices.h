// Voice allocation for modules played polyphonically (several copies of the
// module's voice). Works at the module's block rate:
// - a new note takes a free voice, else the quietest released one, else the
//   oldest held one;
// - a voice still sounding is faded out over a few blocks before it starts
//   the new note, so stealing never clicks;
// - the same note played again retriggers its own voice.
#pragma once

#include <cstdint>

namespace mi_port {

template <int kMaxVoices>
class VoiceAllocator {
 public:
  struct Slot {
    int note;          // the note it plays, -1 when free
    int velocity;
    bool gate;         // key held
    bool start;        // its note starts this block
    bool reset;        // faded to silence: the module may clear its state
    uint32_t age;      // when it started
    float level;       // recent peak output
    int pending_note;  // the note to start once the fade is over, -1 none
    int pending_velocity;
    bool pending_gate;
    int fade;          // blocks of fade left
    float gain;        // fade gain for its output this block
  };

  void Init(int voices, int fade_blocks) {
    fade_blocks_ = fade_blocks < 1 ? 1 : fade_blocks;
    clock_ = 0;
    for (int i = 0; i < kMaxVoices; ++i) {
      Slot& s = slots_[i];
      s.note = -1;
      s.velocity = 0;
      s.gate = false;
      s.start = false;
      s.reset = false;
      s.age = 0;
      s.level = 0;
      s.pending_note = -1;
      s.pending_velocity = 0;
      s.pending_gate = false;
      s.fade = 0;
      s.gain = 1.0f;
    }
    voices_ = 1;
    set_voices(voices);
  }

  void set_voices(int voices) {
    voices_ = voices < 1 ? 1 : (voices > kMaxVoices ? kMaxVoices : voices);
    for (int i = voices_; i < kMaxVoices; ++i) FadeOut(slots_[i]);
  }
  int voices() const { return voices_; }

  void NoteOn(int note, int velocity) {
    ++clock_;
    for (int i = 0; i < voices_; ++i) {
      Slot& s = slots_[i];
      if (s.pending_note == note) {
        s.pending_velocity = velocity;
        s.pending_gate = true;
        return;
      }
    }
    for (int i = 0; i < voices_; ++i) {
      Slot& s = slots_[i];
      if (s.note == note && s.fade == 0) {
        Begin(s, note, velocity, true);
        return;
      }
    }
    int best = 0;
    float best_score = 1e30f;
    for (int i = 0; i < voices_; ++i) {
      const Slot& s = slots_[i];
      float score;
      if (s.pending_note >= 0) {
        score = 1e20f;
      } else if (s.note < 0) {
        score = -1e9f + float(s.age);  // free: the longest free
      } else if (!s.gate) {
        score = -1e6f + s.level * 1e5f + float(s.age) * 1e-3f;  // released: the quietest
      } else {
        score = float(s.age);  // held: the oldest
      }
      if (score < best_score) {
        best_score = score;
        best = i;
      }
    }
    Slot& s = slots_[best];
    if (s.note >= 0 && s.level > 1e-4f) {
      FadeOut(s);
      s.pending_note = note;
      s.pending_velocity = velocity;
      s.pending_gate = true;
    } else {
      Begin(s, note, velocity, true);
    }
  }

  void NoteOff(int note) {
    for (int i = 0; i < kMaxVoices; ++i) {
      Slot& s = slots_[i];
      if (s.note == note && s.fade == 0) s.gate = false;
      if (s.pending_note == note) s.pending_gate = false;
    }
  }

  void AllOff() {
    for (int i = 0; i < kMaxVoices; ++i) {
      Slot& s = slots_[i];
      s.gate = false;
      s.pending_note = -1;
    }
  }

  // Before rendering a block: advances fades and starts the notes waiting on them
  void BeginBlock() {
    for (int i = 0; i < kMaxVoices; ++i) {
      Slot& s = slots_[i];
      if (s.fade > 0) {
        --s.fade;
        s.gain = float(s.fade) / float(fade_blocks_);
        if (s.fade == 0) {
          s.note = -1;
          s.level = 0;
          s.gain = 1.0f;
          s.reset = true;
          if (s.pending_note >= 0) {
            Begin(s, s.pending_note, s.pending_velocity, s.pending_gate);
            s.pending_note = -1;
          }
        }
      }
    }
  }

  // After rendering a block: the voice's peak output, and the end of its start
  void EndBlock(int i, float peak) {
    Slot& s = slots_[i];
    s.start = false;
    s.reset = false;
    s.level = peak > s.level ? peak : s.level * 0.8f + peak * 0.2f;
    if (s.note >= 0 && !s.gate && s.fade == 0 && s.pending_note < 0 && s.level < 1e-5f) {
      s.note = -1;  // finished sounding
    }
  }

  const Slot& slot(int i) const { return slots_[i]; }
  // Whether a voice needs rendering at all
  bool active(int i) const { return slots_[i].note >= 0 || slots_[i].fade > 0; }

 private:
  void FadeOut(Slot& s) {
    s.gate = false;
    if (s.note >= 0 && s.fade == 0) s.fade = fade_blocks_;
  }

  void Begin(Slot& s, int note, int velocity, bool gate) {
    s.note = note;
    s.velocity = velocity;
    s.gate = gate;
    s.start = true;
    s.age = clock_;
    s.fade = 0;
    s.gain = 1.0f;
  }

  Slot slots_[kMaxVoices];
  int voices_;
  int fade_blocks_;
  uint32_t clock_;
};

}  // namespace mi_port
