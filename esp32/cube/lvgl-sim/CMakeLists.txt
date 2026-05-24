cmake_minimum_required(VERSION 3.13)
project(sentient_cube_lvgl_sim C)

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)

# ---- Configuration ----------------------------------------------------------
# LVGL source lives next to this CMakeLists (cloned by setup step, see
# README.md). Version is pinned to match firmware/main's managed component.
set(LVGL_DIR        "${CMAKE_CURRENT_LIST_DIR}/lvgl"      CACHE PATH "Path to LVGL source clone.")
set(SENTIENT_FW_DIR "${CMAKE_CURRENT_LIST_DIR}/../firmware" CACHE PATH "Path to sentient cube firmware/.")

if(NOT EXISTS "${LVGL_DIR}/lvgl.h")
    message(FATAL_ERROR
        "LVGL source not found at ${LVGL_DIR}.\n"
        "Clone the pinned LVGL version next to this CMakeLists.txt:\n"
        "  cd ${CMAKE_CURRENT_LIST_DIR}\n"
        "  git clone --depth 1 --branch v9.5.0 https://github.com/lvgl/lvgl lvgl")
endif()

if(NOT EXISTS "${CMAKE_CURRENT_LIST_DIR}/lv_conf.h")
    message(FATAL_ERROR
        "Sim-side lv_conf.h not found at ${CMAKE_CURRENT_LIST_DIR}/lv_conf.h.\n"
        "This file is part of the repo; if it is missing, your checkout is\n"
        "incomplete. Restore via: git checkout HEAD -- lv_conf.h")
endif()

# ---- LVGL config dispatch ---------------------------------------------------
# Point LVGL at the sim-side lv_conf.h via LV_CONF_PATH. This bypasses any
# Kconfig-driven config (none here) and the `../../lv_conf.h` default.
# Quoting the path with backslash escapes is the supported syntax — see
# lvgl/src/lv_conf_internal.h dispatch logic.
add_compile_definitions(
    LV_CONF_PATH=\"${CMAKE_CURRENT_LIST_DIR}/lv_conf.h\"
)

# ---- SDL2 -------------------------------------------------------------------
find_package(SDL2 REQUIRED)
include_directories(${SDL2_INCLUDE_DIRS})

# ---- LVGL as a library ------------------------------------------------------
# LVGL provides its own CMakeLists at the cloned-source root. Disable the
# examples + demos + ThorVG targets — they build by default but are never
# linked into sentient_cube_lvgl_sim. Skipping them keeps the ~2s iteration
# loop the spec wants. Option names come from lvgl/env_support/cmake/
# os_desktop.cmake (the desktop-build entry point).
set(CONFIG_LV_BUILD_EXAMPLES      OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_BUILD_DEMOS         OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_USE_THORVG_INTERNAL OFF CACHE BOOL "" FORCE)
add_subdirectory(${LVGL_DIR} ${CMAKE_CURRENT_BINARY_DIR}/lvgl_build)

# ---- Sentient shared UI sources --------------------------------------------
set(SENTIENT_UI_SRCS
    "${SENTIENT_FW_DIR}/ui-shared/test_screen.c"
)

# ---- Sim app ----------------------------------------------------------------
add_executable(sentient_cube_lvgl_sim
    main/main.c
    main/sdl2_driver.c
    ${SENTIENT_UI_SRCS}
)

target_include_directories(sentient_cube_lvgl_sim PRIVATE
    "${SENTIENT_FW_DIR}/ui-shared"
    "${SENTIENT_FW_DIR}/main"
    "${LVGL_DIR}"
)

target_link_libraries(sentient_cube_lvgl_sim PRIVATE lvgl ${SDL2_LIBRARIES})
