#!/usr/bin/env bash
set -euo pipefail

umask 077

PLUGIN_PREFIX="SynaraComputerUsePlugin"

# User-owned everywhere, no sudo anywhere: hyprctl loads a plugin by absolute
# path, live, from any directory this user can read. Keep these defaults in
# sync with hyprlandPluginDirectory()/hyprlandInstallStampPath() in
# apps/server/src/computer/hyprlandPluginProvisioning.ts.
PLUGIN_DIR="${SYNARA_HYPRLAND_PLUGIN_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/synara/hyprland-computer-use/plugins}"
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_ROOT="${SYNARA_HYPRLAND_CACHE_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/synara/hyprland-computer-use-plugin}"
STATE_ROOT="${SYNARA_HYPRLAND_STATE_ROOT:-${XDG_STATE_HOME:-$HOME/.local/state}/synara/hyprland-computer-use-plugin}"
BUILD_DIR="${SYNARA_HYPRLAND_BUILD_DIR:-$CACHE_ROOT/build}"
STAMP_FILE="$STATE_ROOT/install.stamp"

BUILD_ONLY=0

usage() {
    cat <<EOF
Usage: $0 [--build-only]

Builds the Synara Hyprland plugin against the installed Hyprland headers,
installs it under the next unused versioned filename, unloads older Synara
plugin builds, and loads the new one into the running Hyprland session — live,
with no relogin.

  --build-only      build against the local Hyprland headers, print the built
                    .so path, and stop. Nothing is installed, loaded, or
                    stamped, and no compositor is needed. This is what Synara's
                    own provisioning calls when it has no prebuilt for this
                    Hyprland: the build lives here so there is exactly one of
                    it, and the install and load stay on the caller.
EOF
}

log() {
    printf '[synara-hyprland-plugin] %s\n' "$*"
}

die() {
    printf '[synara-hyprland-plugin] ERROR: %s\n' "$*" >&2
    exit 1
}

need_command() {
    command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --build-only)
            BUILD_ONLY=1
            shift
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            usage >&2
            die "Unknown argument: $1"
            ;;
    esac
done

need_command make
need_command g++
need_command pkg-config
pkg-config --exists hyprland \
    || die "Hyprland development headers are not installed (pkg-config cannot find hyprland). On Arch they ship with the hyprland package itself; check that /usr/share/pkgconfig/hyprland.pc exists."
for pkg in pixman-1 libdrm sdbus-c++ cairo xkbcommon; do
    pkg-config --exists "$pkg" || die "Missing development package: $pkg (pkg-config cannot find it)."
done

HYPR_VERSION="$(pkg-config --modversion hyprland)"

# Build out of tree so a source checkout stays clean: the Makefile writes its
# .so next to the sources it compiles, so give it a copy of them.
mkdir -p "$BUILD_DIR"
cp -f "$SOURCE_DIR/Makefile" "$SOURCE_DIR/synarahyprlandplugin.cpp" "$BUILD_DIR/"
log "Building against Hyprland $HYPR_VERSION ..."
make -C "$BUILD_DIR" >/dev/null
BUILT_SO="$BUILD_DIR/SynaraComputerUseHyprland.so"
[[ -f "$BUILT_SO" ]] || die "Build finished but $BUILT_SO does not exist."

if [[ "$BUILD_ONLY" -eq 1 ]]; then
    # The path is the contract: provisioning reads the last stdout line.
    printf '%s\n' "$BUILT_SO"
    exit 0
fi

need_command hyprctl
[[ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ]] \
    || die "HYPRLAND_INSTANCE_SIGNATURE is not set; run this from inside the Hyprland session."

mkdir -p "$PLUGIN_DIR" "$STATE_ROOT"

# Next unused generation. A live-dlopened .so must never be overwritten, so
# every install is a new file; superseded ones are removed below (the inode
# stays alive while Hyprland has it mapped).
next=1
for existing in "$PLUGIN_DIR/${PLUGIN_PREFIX}V"*.so; do
    [[ -e "$existing" ]] || continue
    n="${existing##*"${PLUGIN_PREFIX}V"}"
    n="${n%.so}"
    [[ "$n" =~ ^[0-9]+$ ]] && (( n >= next )) && next=$(( n + 1 ))
done
PLUGIN_ID="${PLUGIN_PREFIX}V${next}"
PLUGIN_PATH="$PLUGIN_DIR/$PLUGIN_ID.so"
install -m 0755 "$BUILT_SO" "$PLUGIN_PATH"
log "Installed $PLUGIN_PATH"

# Unload every older Synara build first: the plugin claims the
# org.synara.ComputerUse bus name in its constructor, and the first registrant
# wins. hyprctl always exits 0, so replies are informational only.
for existing in "$PLUGIN_DIR/${PLUGIN_PREFIX}V"*.so; do
    [[ -e "$existing" && "$existing" != "$PLUGIN_PATH" ]] || continue
    hyprctl plugin unload "$existing" >/dev/null 2>&1 || true
    rm -f "$existing"
    log "Removed superseded $(basename "$existing")"
done

REPLY="$(hyprctl plugin load "$PLUGIN_PATH")"
[[ "$REPLY" == "ok" ]] || die "Hyprland refused to load $PLUGIN_PATH: $REPLY"
log "Loaded $PLUGIN_ID into the running Hyprland session."

cat > "$STAMP_FILE" <<EOF
plugin_id=$PLUGIN_ID
installed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
plugin_path=$PLUGIN_PATH
hyprland_version=$HYPR_VERSION
EOF
log "Done."
