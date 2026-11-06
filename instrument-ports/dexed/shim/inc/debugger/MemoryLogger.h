// Stands in for Dexed's JUCE memory logger: the headless engine logs nothing.
#pragma once

class MemoryLogger {
 public:
  static MemoryLogger* getInstance() {
    static MemoryLogger logger;
    return &logger;
  }
  template <typename... Args>
  void logFormat(const char*, Args...) {}
};
