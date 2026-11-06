// MTS-ESP connects a plugin to a tuning master running in the same host.
// A browser has no such master, so the client always reports none and the
// engine plays twelve-tone equal temperament, as upstream does without one.
#pragma once

struct MTSClient
{
};

inline MTSClient *MTS_RegisterClient() { return nullptr; }
inline void MTS_DeregisterClient(MTSClient *) {}
inline bool MTS_HasMaster(MTSClient *) { return false; }
inline double MTS_RetuningInSemitones(MTSClient *, char, char) { return 0.0; }
inline const char *MTS_GetScaleName(MTSClient *) { return ""; }
