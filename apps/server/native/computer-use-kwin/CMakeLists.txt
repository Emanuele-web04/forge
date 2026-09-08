cmake_minimum_required(VERSION 3.25)
project(synaracomputeruse VERSION 0.1 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

# This is a Qt 6 / KF6 plugin, and ECM must be told so before any KDE module
# runs: without a version request (>= 5.240) or an explicit QT_MAJOR_VERSION,
# ECM's QtVersionOption defaults to Qt 5, and on a host that also has Qt 5
# installed KDEInstallDirs then loads Qt5Core, which pins
# QT_DEFAULT_MAJOR_VERSION=5 and makes the later find_package(Qt6) fail inside
# Qt6Qml's macros ("only available in Qt 6").
set(QT_MAJOR_VERSION 6)
find_package(ECM 5.240 REQUIRED NO_MODULE)
set(CMAKE_MODULE_PATH ${ECM_MODULE_PATH})

include(KDEInstallDirs)
include(KDECompilerSettings NO_POLICY_SCOPE)

find_package(Qt6 REQUIRED COMPONENTS Core DBus Gui Quick Widgets)
find_package(KF6CoreAddons REQUIRED)
find_package(KF6GlobalAccel REQUIRED)
find_package(KWin REQUIRED)
find_package(PkgConfig REQUIRED)
pkg_check_modules(XKBCOMMON REQUIRED IMPORTED_TARGET xkbcommon)

find_package(Git QUIET)
set(SYNARA_GIT_SHORT_HASH "unknown")
if(GIT_FOUND)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -C "${CMAKE_SOURCE_DIR}" rev-parse --short=12 HEAD
        OUTPUT_VARIABLE SYNARA_GIT_SHORT_HASH
        OUTPUT_STRIP_TRAILING_WHITESPACE
        ERROR_QUIET
        RESULT_VARIABLE SYNARA_GIT_RESULT
    )
    if(NOT SYNARA_GIT_RESULT EQUAL 0 OR SYNARA_GIT_SHORT_HASH STREQUAL "")
        set(SYNARA_GIT_SHORT_HASH "unknown")
    endif()
endif()

set(SYNARA_KWIN_VERSION "${KWin_VERSION}")
if(SYNARA_KWIN_VERSION STREQUAL "" AND EXISTS "${KWin_DIR}/KWinConfigVersion.cmake")
    file(STRINGS "${KWin_DIR}/KWinConfigVersion.cmake" SYNARA_KWIN_VERSION_LINE REGEX "^set\\(PACKAGE_VERSION ")
    string(REGEX MATCH "set\\(PACKAGE_VERSION \"([^\"]+)\"\\)" SYNARA_KWIN_VERSION_MATCH "${SYNARA_KWIN_VERSION_LINE}")
    set(SYNARA_KWIN_VERSION "${CMAKE_MATCH_1}")
endif()
if(SYNARA_KWIN_VERSION STREQUAL "")
    message(FATAL_ERROR "Could not determine the KWin version used to compile the plugin")
endif()

string(TIMESTAMP SYNARA_BUILD_TIMESTAMP "%Y-%m-%dT%H:%M:%SZ" UTC)
set(SYNARA_BUILD_ID "${SYNARA_GIT_SHORT_HASH}-${SYNARA_BUILD_TIMESTAMP}")
configure_file(
    "${CMAKE_CURRENT_SOURCE_DIR}/synaracomputerusebuildinfo.h.in"
    "${CMAKE_CURRENT_BINARY_DIR}/synaracomputerusebuildinfo.h"
    @ONLY
)

add_library(SynaraComputerUsePlugin MODULE
    synaracomputeruseplugin.cpp
    synaracomputeruseplugin.h
    main.cpp
    "${CMAKE_CURRENT_BINARY_DIR}/synaracomputerusebuildinfo.h"
)

target_include_directories(SynaraComputerUsePlugin PRIVATE
    "${CMAKE_CURRENT_BINARY_DIR}"
)

target_link_libraries(SynaraComputerUsePlugin PRIVATE
    KWin::kwin
    KF6::CoreAddons
    KF6::GlobalAccel
    Qt6::Core
    Qt6::DBus
    Qt6::Gui
    Qt6::Quick
    Qt6::Widgets
    PkgConfig::XKBCOMMON
)

set_target_properties(SynaraComputerUsePlugin PROPERTIES
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/kwin/plugins"
    PREFIX ""
)

install(TARGETS SynaraComputerUsePlugin DESTINATION "${KDE_INSTALL_QTPLUGINDIR}/kwin/plugins")
