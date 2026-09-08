# Builds the Synara computer-use plugin for the Hyprland version installed on
# this machine. Hyprland's plugin ABI churns per release, so like the KWin
# plugin this is a per-version build; the loader refuses a mismatched .so.
#
# `--no-gnu-unique` matters: without it the .so cannot be fully unloaded and a
# reload after rebuild dlopens the stale image.

HYPR_VERSION   := $(shell pkg-config --modversion hyprland 2>/dev/null || echo unknown)
GIT_HASH       := $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
BUILD_TS       := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

CXX            ?= g++
PKGS           := hyprland pixman-1 libdrm sdbus-c++ cairo xkbcommon
CXXFLAGS       += -shared -fPIC --no-gnu-unique -std=c++26 -O2 -g \
                  $(shell pkg-config --cflags $(PKGS)) \
                  -DSYNARA_CU_BUILD_ID='"hyprland-$(HYPR_VERSION)"' \
                  -DSYNARA_CU_GIT_HASH='"$(GIT_HASH)"' \
                  -DSYNARA_CU_BUILD_TS='"$(BUILD_TS)"'
LDLIBS         := $(shell pkg-config --libs sdbus-c++ cairo xkbcommon)

OUT            := SynaraComputerUseHyprland.so

all: $(OUT)

$(OUT): synarahyprlandplugin.cpp
	$(CXX) $(CXXFLAGS) $< -o $@ $(LDLIBS)

clean:
	rm -f $(OUT)

.PHONY: all clean
