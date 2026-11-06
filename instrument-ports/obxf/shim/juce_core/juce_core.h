// The few JUCE utilities the OB-Xf engine headers use, without JUCE.
// Behaviour follows JUCE where the engine depends on it (Random, the fast sine,
// AbstractFifo). XmlElement and String exist only so the engine's patch
// streaming code compiles; this port never streams patches through them.
#pragma once

// The standard headers juce_core.h brings with it, which upstream relies on
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <functional>
#include <iostream>
#include <limits>
#include <map>
#include <memory>
#include <set>
#include <sstream>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#define JUCE_LITTLE_ENDIAN 1
#define JUCE_DECLARE_NON_COPYABLE(className)                                                       \
    className(const className &) = delete;                                                         \
    className &operator=(const className &) = delete;
#define JUCE_DECLARE_NON_MOVEABLE(className)                                                       \
    className(className &&) = delete;                                                              \
    className &operator=(className &&) = delete;
#define JUCE_LEAK_DETECTOR(className)
#define JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(className) JUCE_DECLARE_NON_COPYABLE(className)

namespace juce
{

template <typename T> constexpr T jlimit(T lower, T upper, T value) noexcept
{
    return value < lower ? lower : (upper < value ? upper : value);
}
template <typename T> constexpr T jmax(T a, T b) noexcept { return a < b ? b : a; }
template <typename T> constexpr T jmin(T a, T b) noexcept { return b < a ? b : a; }
template <typename T> inline int roundToInt(T value) noexcept
{
    return static_cast<int>(std::lround(static_cast<double>(value)));
}

template <typename T> struct MathConstants
{
    static constexpr T pi = static_cast<T>(3.141592653589793238L);
    static constexpr T twoPi = static_cast<T>(2 * 3.141592653589793238L);
    static constexpr T halfPi = static_cast<T>(3.141592653589793238L / 2);
    static constexpr T euler = static_cast<T>(2.71828182845904523536L);
    static constexpr T sqrt2 = static_cast<T>(1.4142135623730950488L);
};

struct ByteOrder
{
    static uint32_t swap(uint32_t v) noexcept { return __builtin_bswap32(v); }
    static int32_t swap(int32_t v) noexcept
    {
        return static_cast<int32_t>(__builtin_bswap32(static_cast<uint32_t>(v)));
    }
    static uint64_t swap(uint64_t v) noexcept { return __builtin_bswap64(v); }
    static uint32_t swapIfLittleEndian(uint32_t v) noexcept { return swap(v); }
    static uint32_t littleEndianInt(const void *bytes) noexcept
    {
        uint32_t v;
        std::memcpy(&v, bytes, 4);
        return v;
    }
    static uint32_t bigEndianInt(const void *bytes) noexcept { return swap(littleEndianInt(bytes)); }
};

// JUCE's linear congruential generator
class Random
{
  public:
    explicit Random(int64_t seedValue) noexcept : seed(seedValue) {}
    Random() noexcept : seed(nextDefaultSeed()) {}

    void setSeed(int64_t newSeed) noexcept { seed = newSeed; }

    int nextInt() noexcept
    {
        seed = static_cast<int64_t>(((static_cast<uint64_t>(seed) * 0x5deece66dULL) + 11) &
                                    0xffffffffffffULL);
        return static_cast<int>(seed >> 16);
    }

    float nextFloat() noexcept
    {
        auto result = static_cast<float>(static_cast<uint32_t>(nextInt())) /
                      (static_cast<float>(std::numeric_limits<uint32_t>::max()) + 1.0f);
        return result == 1.0f ? 1.0f - std::numeric_limits<float>::epsilon() : result;
    }

    static Random &getSystemRandom() noexcept
    {
        static Random sys(0x2545f4914f6cdd1dLL);
        return sys;
    }

  private:
    // Each default-constructed generator starts from its own seed
    static int64_t nextDefaultSeed() noexcept
    {
        static uint64_t counter = 0x9e3779b97f4a7c15ULL;
        counter = counter * 6364136223846793005ULL + 1442695040888963407ULL;
        return static_cast<int64_t>(counter >> 16);
    }

    int64_t seed;
};

class String
{
  public:
    String() = default;
    String(const char *s) : text(s) {}
    String(const std::string &s) : text(s) {}
    String(int v) : text(std::to_string(v)) {}
    const std::string &toStdString() const { return text; }
    bool operator==(const String &o) const { return text == o.text; }
    String operator+(const String &o) const { return String(text + o.text); }

  private:
    std::string text;
};

class XmlElement
{
  public:
    explicit XmlElement(const char *) {}
    ~XmlElement()
    {
        for (auto *c : children)
            delete c;
    }
    void setAttribute(const char *, int) {}
    void setAttribute(const char *, double) {}
    void setAttribute(const char *, const String &) {}
    void setAttribute(const char *, const std::string &) {}
    void addChildElement(XmlElement *child) { children.push_back(child); }
    const std::vector<XmlElement *> &getChildIterator() const { return children; }
    int getIntAttribute(const char *, int fallback = 0) const { return fallback; }
    double getDoubleAttribute(const char *, double fallback = 0) const { return fallback; }
    String getStringAttribute(const char *) const { return {}; }

  private:
    std::vector<XmlElement *> children;
};

// JUCE's single-reader, single-writer FIFO index manager
class AbstractFifo
{
  public:
    explicit AbstractFifo(int capacity) noexcept : bufferSize(capacity) {}

    int getTotalSize() const noexcept { return bufferSize; }
    int getNumReady() const noexcept
    {
        const int vs = validStart, ve = validEnd;
        return ve >= vs ? (ve - vs) : (bufferSize - (vs - ve));
    }
    int getFreeSpace() const noexcept { return bufferSize - getNumReady() - 1; }

    struct Scope
    {
        int startIndex1, blockSize1, startIndex2, blockSize2;
    };

    void prepareToWrite(int numToWrite, int &startIndex1, int &blockSize1, int &startIndex2,
                        int &blockSize2) const noexcept
    {
        const int vs = validStart, ve = validEnd;
        const int freeSpace = ve >= vs ? (bufferSize - (ve - vs)) : (vs - ve);
        numToWrite = std::min(numToWrite, freeSpace - 1);
        if (numToWrite <= 0)
        {
            startIndex1 = blockSize1 = startIndex2 = blockSize2 = 0;
            return;
        }
        startIndex1 = ve;
        startIndex2 = 0;
        blockSize1 = std::min(bufferSize - ve, numToWrite);
        numToWrite -= blockSize1;
        blockSize2 = numToWrite <= 0 ? 0 : std::min(numToWrite, vs);
    }
    void finishedWrite(int numWritten) noexcept
    {
        int newEnd = validEnd + numWritten;
        if (newEnd >= bufferSize)
            newEnd -= bufferSize;
        validEnd = newEnd;
    }
    void prepareToRead(int numWanted, int &startIndex1, int &blockSize1, int &startIndex2,
                       int &blockSize2) const noexcept
    {
        const int vs = validStart, ve = validEnd;
        const int numReady = ve >= vs ? (ve - vs) : (bufferSize - (vs - ve));
        numWanted = std::min(numWanted, numReady);
        if (numWanted <= 0)
        {
            startIndex1 = blockSize1 = startIndex2 = blockSize2 = 0;
            return;
        }
        startIndex1 = vs;
        startIndex2 = 0;
        blockSize1 = std::min(bufferSize - vs, numWanted);
        numWanted -= blockSize1;
        blockSize2 = numWanted <= 0 ? 0 : std::min(numWanted, ve);
    }
    void finishedRead(int numRead) noexcept
    {
        int newStart = validStart + numRead;
        if (newStart >= bufferSize)
            newStart -= bufferSize;
        validStart = newStart;
    }

    Scope write(int n) noexcept
    {
        Scope s;
        prepareToWrite(n, s.startIndex1, s.blockSize1, s.startIndex2, s.blockSize2);
        finishedWrite(s.blockSize1 + s.blockSize2);
        return s;
    }
    Scope read(int n) noexcept
    {
        Scope s;
        prepareToRead(n, s.startIndex1, s.blockSize1, s.startIndex2, s.blockSize2);
        finishedRead(s.blockSize1 + s.blockSize2);
        return s;
    }

  private:
    int bufferSize;
    int validStart = 0, validEnd = 0;
};

namespace dsp
{
struct FastMathApproximations
{
    // JUCE's Pade approximation of sin, for -pi..pi
    template <typename FloatType> static FloatType sin(FloatType x) noexcept
    {
        auto x2 = x * x;
        auto numerator = -x * (-(FloatType)11511339840 +
                               x2 * ((FloatType)1640635920 +
                                     x2 * (-(FloatType)52785432 + x2 * (FloatType)479249)));
        auto denominator =
            (FloatType)11511339840 +
            x2 * ((FloatType)277920720 + x2 * ((FloatType)3177720 + x2 * (FloatType)18361));
        return numerator / denominator;
    }
};
} // namespace dsp

} // namespace juce
