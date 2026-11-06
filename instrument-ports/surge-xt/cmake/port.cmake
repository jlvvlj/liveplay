# Included right after Surge's top-level project() call (CMAKE_PROJECT_Surge_INCLUDE).
# The worklet engine target is added once Surge's own targets exist, at the end
# of the top-level directory.

set(SXT_PORT_TARGET_FILE ${CMAKE_CURRENT_LIST_DIR}/port-target.cmake)
set(SXT_PORT_DIR ${CMAKE_CURRENT_LIST_DIR}/..)
cmake_language(DEFER DIRECTORY ${CMAKE_SOURCE_DIR} CALL include ${SXT_PORT_TARGET_FILE})
