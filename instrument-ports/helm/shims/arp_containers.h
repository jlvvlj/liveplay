// Containers for mopo's Arpeggiator that never allocate while notes play.
// build.sh swaps them in for the std::map and std::vectors of
// arpeggiator.h; they keep the same interface the arpeggiator uses.
#pragma once

#include <vector>

#include "common.h"

namespace helm_port {

// The arpeggiator's held notes and their velocities, at most 128 of them
class NoteVelocityMap {
 public:
  NoteVelocityMap() : size_(0) {}

  size_t count(mopo::mopo_float note) const { return find(note) >= 0 ? 1 : 0; }

  mopo::mopo_float& operator[](mopo::mopo_float note) {
    int i = find(note);
    if (i >= 0) return values_[i];
    if (size_ == kCapacity) return spare_;
    keys_[size_] = note;
    values_[size_] = 0.0;
    return values_[size_++];
  }

  size_t erase(mopo::mopo_float note) {
    int i = find(note);
    if (i < 0) return 0;
    --size_;
    keys_[i] = keys_[size_];
    values_[i] = values_[size_];
    return 1;
  }

  void clear() { size_ = 0; }

 private:
  static const int kCapacity = 128;
  int find(mopo::mopo_float note) const {
    for (int i = 0; i < size_; ++i)
      if (keys_[i] == note) return i;
    return -1;
  }
  mopo::mopo_float keys_[kCapacity];
  mopo::mopo_float values_[kCapacity];
  mopo::mopo_float spare_;
  int size_;
};

// A vector with room for every note reserved up front
class ReservedVector : public std::vector<mopo::mopo_float> {
 public:
  ReservedVector() { reserve(256); }
};

}  // namespace helm_port
