// Stands in for the MTS-ESP client. MTS-ESP retunes plugins from a master
// plugin in the same desktop host; a browser worklet has no such master, so
// the client always reports none and Dexed keeps its own tuning.
#pragma once

struct MTSClient;

inline bool MTS_HasMaster(const MTSClient*) { return false; }
inline double MTS_NoteToFrequency(const MTSClient*, char midinote, char) {
  return 440.0 * __builtin_pow(2.0, (midinote - 69) / 12.0);
}
