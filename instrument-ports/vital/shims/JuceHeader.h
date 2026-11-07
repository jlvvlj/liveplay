// The few JUCE pieces Vital's synthesis engine, wavetable code and preset
// loading use, for building them without JUCE: a String over std::string,
// Base64 and a memory stream. Nothing here touches files, threads or the UI.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#define JUCE_LEAK_DETECTOR(Class)
#define JUCE_DECLARE_NON_COPYABLE(Class)
#define JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(Class)
#define jassert(x) ((void)0)
#define jassertfalse ((void)0)

template <typename T>
inline T jmin(T a, T b) { return a < b ? a : b; }
template <typename T>
inline T jmax(T a, T b) { return a < b ? b : a; }
template <typename T>
inline T jlimit(T low, T high, T value) { return value < low ? low : (high < value ? high : value); }
inline int roundToInt(double value) { return static_cast<int>(std::lround(value)); }

namespace ProjectInfo {
  // The version of the open-source Vital (standalone/builds/linux/Makefile);
  // presets saved by a newer feature version (1.5) are refused, as upstream does
  const char* const versionString = "1.0.6";
}

class String {
  public:
    String() = default;
    String(const char* text) : text_(text ? text : "") { }
    String(const std::string& text) : text_(text) { }
    String(int value) : text_(std::to_string(value)) { }

    const std::string& toStdString() const { return text_; }
    const char* toRawUTF8() const { return text_.c_str(); }
    bool isEmpty() const { return text_.empty(); }
    bool isNotEmpty() const { return !text_.empty(); }
    int length() const { return static_cast<int>(text_.size()); }

    int getIntValue() const { return std::atoi(text_.c_str()); }
    float getFloatValue() const { return static_cast<float>(std::atof(text_.c_str())); }

    String trim() const {
      size_t start = text_.find_first_not_of(" \t\r\n");
      if (start == std::string::npos)
        return String();
      size_t end = text_.find_last_not_of(" \t\r\n");
      return text_.substr(start, end - start + 1);
    }

    bool containsOnly(const char* characters) const {
      return text_.find_first_not_of(characters) == std::string::npos;
    }

    String upToFirstOccurrenceOf(const String& sub, bool include, bool) const {
      size_t at = text_.find(sub.text_);
      if (at == std::string::npos)
        return *this;
      return text_.substr(0, at + (include ? sub.text_.size() : 0));
    }

    String fromFirstOccurrenceOf(const String& sub, bool include, bool) const {
      size_t at = text_.find(sub.text_);
      if (at == std::string::npos)
        return String();
      return text_.substr(include ? at : at + sub.text_.size());
    }

    String upToLastOccurrenceOf(const String& sub, bool include, bool) const {
      size_t at = text_.rfind(sub.text_);
      if (at == std::string::npos)
        return *this;
      return text_.substr(0, at + (include ? sub.text_.size() : 0));
    }

    operator std::string() const { return text_; }
    bool operator==(const String& other) const { return text_ == other.text_; }
    bool operator!=(const String& other) const { return text_ != other.text_; }
    bool operator==(const char* other) const { return text_ == other; }
    bool operator!=(const char* other) const { return text_ != other; }
    String operator+(const String& other) const { return text_ + other.text_; }
    String& operator+=(const String& other) {
      text_ += other.text_;
      return *this;
    }

  private:
    std::string text_;
};

inline String operator+(const char* a, const String& b) { return String(a) + b; }

struct FloatVectorOperations {
  // WebAssembly has no flush-to-zero mode to switch on (its floats keep
  // denormals), so the engine's call before each block does nothing
  static void disableDenormalisedNumberSupport() { }
};

// Named by declarations of LoadSave's file functions, which the port does not
// build (it never reads or writes files)
class File;
class CriticalSection;
template <typename T>
class Array;

class MemoryOutputStream {
  public:
    MemoryOutputStream() = default;
    explicit MemoryOutputStream(size_t reserve) { data_.reserve(reserve); }

    bool write(const void* data, size_t size) {
      const char* bytes = static_cast<const char*>(data);
      data_.insert(data_.end(), bytes, bytes + size);
      return true;
    }
    bool writeByte(char byte) {
      data_.push_back(byte);
      return true;
    }

    const void* getData() const { return data_.data(); }
    size_t getDataSize() const { return data_.size(); }

  private:
    std::vector<char> data_;
};

struct Base64 {
  static const char* alphabet() { return "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; }

  static String toBase64(const void* data, size_t size) {
    const unsigned char* in = static_cast<const unsigned char*>(data);
    std::string out;
    out.reserve(((size + 2) / 3) * 4);
    for (size_t i = 0; i < size; i += 3) {
      unsigned value = in[i] << 16;
      if (i + 1 < size) value |= in[i + 1] << 8;
      if (i + 2 < size) value |= in[i + 2];
      out += alphabet()[(value >> 18) & 63];
      out += alphabet()[(value >> 12) & 63];
      out += i + 1 < size ? alphabet()[(value >> 6) & 63] : '=';
      out += i + 2 < size ? alphabet()[value & 63] : '=';
    }
    return out;
  }

  static bool convertFromBase64(MemoryOutputStream& out, const String& text) {
    const std::string& in = text.toStdString();
    unsigned value = 0;
    int bits = 0;
    for (char c : in) {
      int digit;
      if (c >= 'A' && c <= 'Z') digit = c - 'A';
      else if (c >= 'a' && c <= 'z') digit = c - 'a' + 26;
      else if (c >= '0' && c <= '9') digit = c - '0' + 52;
      else if (c == '+') digit = 62;
      else if (c == '/') digit = 63;
      else if (c == '=') break;
      else continue;
      value = (value << 6) | digit;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.writeByte(static_cast<char>((value >> bits) & 0xff));
      }
    }
    return true;
  }
};
