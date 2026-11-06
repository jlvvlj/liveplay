# Shared build steps, sourced by each port's build.sh.

common_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# emscripten from Homebrew, installed when missing
ensure_emcc() {
  if ! command -v em++ >/dev/null 2>&1; then
    if [ -x /opt/homebrew/bin/em++ ]; then
      export PATH="/opt/homebrew/bin:$PATH"
    elif command -v brew >/dev/null 2>&1; then
      brew install emscripten
      export PATH="$(brew --prefix)/bin:$PATH"
    else
      echo "emscripten is missing and Homebrew is not installed" >&2
      exit 1
    fi
  fi
}

# Flags every port compiles with: a standalone reactor module, no exceptions,
# no file system, the shared exports
MP_CFLAGS=(-O3 -msimd128 -fno-exceptions -fno-math-errno -DNDEBUG -I"$common_dir")
MP_LDFLAGS=(
  -sSTANDALONE_WASM=1 --no-entry
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16MB -sSTACK_SIZE=1MB
  -sFILESYSTEM=0 -sMALLOC=emmalloc
)

# emit_worklet <name> <inputs 0|1> <dist dir>
# Writes <dist>/<name>.worklet.js registering melodics-<name>
emit_worklet() {
  local name=$1 inputs=$2 dist=$3 effect=false
  [ "$inputs" = 1 ] && effect=true
  sed -e "s/__PROCESSOR__/melodics-$name/g" -e "s/__NAME__/$name/g" \
    -e "s/__EFFECT__/$effect/g" -e "s/__INPUTS__/$inputs/g" \
    "$common_dir/worklet.template.js" >"$dist/$name.worklet.js"
}

# Compiles sources to objects in parallel, then prints the object paths.
# Call it with its output redirected to a file, so a failure stops the build:
#   compile_objects <object dir> <source list file> <flags...> >objects.txt
compile_objects() {
  local objdir=$1 list=$2
  shift 2
  mkdir -p "$objdir"
  local jobs
  jobs=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)
  export MP_OBJDIR=$objdir
  tr '\n' '\0' <"$list" | xargs -0 -P "$jobs" -I{} bash -c '
    src="$1"; shift
    obj="$MP_OBJDIR/$(echo "$src" | sed -e "s|^/||" -e "s|/|_|g").o"
    em++ "$@" -c "$src" -o "$obj"
  ' _ {} "$@" >&2 || return 1
  while IFS= read -r src; do
    [ -n "$src" ] && echo "$objdir/$(echo "$src" | sed -e "s|^/||" -e "s|/|_|g").o"
  done <"$list"
}
