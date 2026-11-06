# The surge-xt worklet engine: surge-common plus the C interface in src/surge_wasm.cpp

# surge-common asks Linux linkers for -Wl,--no-undefined, which wasm-ld does not know
get_target_property(SXT_COMMON_LINKS surge-common INTERFACE_LINK_LIBRARIES)
list(FILTER SXT_COMMON_LINKS EXCLUDE REGEX "no-undefined")
set_target_properties(surge-common PROPERTIES INTERFACE_LINK_LIBRARIES "${SXT_COMMON_LINKS}")

add_executable(surge-xt-engine ${SXT_PORT_DIR}/src/surge_wasm.cpp)
target_link_libraries(surge-xt-engine PRIVATE surge::surge-common)
set_target_properties(surge-xt-engine PROPERTIES OUTPUT_NAME surge-xt-engine SUFFIX ".js")

target_link_options(surge-xt-engine PRIVATE
  -sMODULARIZE=1
  -sEXPORT_NAME=createSurgeXt
  -sENVIRONMENT=shell
  -sFILESYSTEM=1
  -sFORCE_FILESYSTEM=1
  -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=33554432
  -sMAXIMUM_MEMORY=1073741824
  -sSTACK_SIZE=1048576
  -sTEXTDECODER=1
  -sGROWABLE_ARRAYBUFFERS=0
  -sDYNAMIC_EXECUTION=0
  -sEXIT_RUNTIME=0
  -sINVOKE_RUN=0
  -sEXPORTED_RUNTIME_METHODS=FS,UTF8ToString,stringToNewUTF8,HEAPF32,HEAPU8
  -sEXPORTED_FUNCTIONS=_malloc,_free
  --js-library=${SXT_PORT_DIR}/src/worklet-scope.js
  -msimd128
  -O3
)
set_property(TARGET surge-xt-engine APPEND PROPERTY LINK_DEPENDS ${SXT_PORT_DIR}/src/worklet-scope.js)
