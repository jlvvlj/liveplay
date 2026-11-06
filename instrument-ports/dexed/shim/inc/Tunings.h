// Stands in for the surge tuning-library header that msfa/tuning.h includes.
// Only standard tuning is built (standard_tuning.cpp); loading .scl/.kbm
// scales needs a file and the library's exceptions, neither of which this
// port has, so the type only has to exist.
#pragma once

namespace Tunings {
struct Tuning {};
}  // namespace Tunings
