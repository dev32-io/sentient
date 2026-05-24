# Sentient ESP32 Cube — top-level CMakeLists (v2 rescope).
# Owned, flat firmware tree. No submodule, no patches.
cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
# Task 27: components/ removed (agent_console + net_logger deleted). The
# esp32_devtool_companion lives under esp32/devtool/firmware/ and is added
# via the project's IDF managed-component or main/CMakeLists.txt include path.
project(sentient_cube)
