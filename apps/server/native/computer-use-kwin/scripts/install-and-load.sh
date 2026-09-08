#!/usr/bin/env bash
set -euo pipefail

umask 077

PLUGIN_PREFIX="SynaraComputerUsePlugin"

# The plugin goes in the user's home by default, and /usr is only used when the
# caller points here explicitly. KWin finds plugins through Qt's library paths,
# and the Plasma session env script Synara writes puts this root on
# QT_PLUGIN_PATH - so a normal install needs no root at all. The lib64/lib split
# is read off the system Qt rather than guessed, because it is a distro
# packaging choice; keep this in sync with resolveInstallTarget() in
# apps/server/src/computer/kwinPluginProvisioning.ts.
if [[ -d /usr/lib64/qt6/plugins ]]; then
    USER_QT_PLUGIN_ROOT="$HOME/.local/lib64/qt6/plugins"
else
    USER_QT_PLUGIN_ROOT="$HOME/.local/lib/qt6/plugins"
fi
PLUGIN_DIR="${SYNARA_KWIN_PLUGIN_DIR:-$USER_QT_PLUGIN_ROOT/kwin/plugins}"
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_ROOT="${SYNARA_KWIN_CACHE_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/synara/kwin-computer-use-plugin}"
STATE_ROOT="${SYNARA_KWIN_STATE_ROOT:-${XDG_STATE_HOME:-$HOME/.local/state}/synara/kwin-computer-use-plugin}"
BUILD_DIR="${SYNARA_KWIN_BUILD_DIR:-$CACHE_ROOT/build}"
STAMP_FILE="$STATE_ROOT/install.stamp"
LOCK_FILE="$STATE_ROOT/install.lock"
BUILD_LOCK_FILE="$STATE_ROOT/build.lock"
# Must match s_service in synaracomputeruseplugin.cpp and COMPUTER_SERVICE in
# the server's kwinDbus.ts: it is the name the health check pins an owner for.
SERVICE_NAME="org.synara.ComputerUse"

FORCE=0
NONINTERACTIVE=0
BUILD_ONLY=0

usage() {
    cat <<EOF
Usage: $0 [--force] [--noninteractive]

Builds the Synara KWin plugin against the installed KWin headers, installs it
under the next unused versioned filename, unloads older Synara plugin ids, and
loads the new id into the current KWin session.

  --force           create and load a new version even when the signature is unchanged
  --noninteractive  pass -n to sudo, for user systemd services
  --build-only      build against the local KWin headers, print the built .so
                    path, and stop. Nothing is installed, loaded, or stamped,
                    and no session bus is needed. This is what Synara's own
                    provisioning calls when it has no prebuilt for this KWin:
                    the build lives here so there is exactly one of it, and the
                    install and load stay on the caller.
EOF
}

log() {
    printf '[synara-kwin-plugin] %s\n' "$*"
}

warn() {
    printf '[synara-kwin-plugin] WARNING: %s\n' "$*" >&2
}

die() {
    printf '[synara-kwin-plugin] ERROR: %s\n' "$*" >&2
    exit 1
}

need_command() {
    command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --force)
            FORCE=1
            shift
            ;;
        --noninteractive)
            NONINTERACTIVE=1
            shift
            ;;
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

need_command cmake
need_command ninja
need_command sha256sum
need_command stat
need_command awk
need_command grep
need_command sort
need_command flock
need_command mktemp
if (( BUILD_ONLY == 0 )); then
    need_command busctl
fi

mkdir -p "$PLUGIN_DIR" || die "Cannot create the KWin plugin directory: $PLUGIN_DIR"

# Only a caller who aimed this at a system directory pays for sudo, and they find
# out now rather than after a full build.
NEEDS_SUDO=0
if (( BUILD_ONLY == 0 )) && [[ ! -w "$PLUGIN_DIR" ]]; then
    NEEDS_SUDO=1
    need_command sudo
    log "$PLUGIN_DIR is not writable; installing with sudo"
fi

mkdir -p "$CACHE_ROOT" "$STATE_ROOT"

# Two locks, because --build-only shares the build directory with a full install
# but nothing else. Taking the install lock for a build that installs and stamps
# nothing would make two concurrent --build-only runs fight over a lock neither
# of them needs; sharing one build directory is the collision that is real.
# Ordering is always install then build, and --build-only only ever takes the
# second, so the two can never deadlock.
if (( BUILD_ONLY == 0 )); then
    exec 9>"$LOCK_FILE"
    if ! flock -n 9; then
        die "another install is already running"
    fi
fi

# Bounded rather than non-blocking: the caller of --build-only wants the built
# path, and a concurrent build will produce exactly the one it is waiting for.
BUILD_LOCK_WAIT_SECONDS=900

take_build_lock() {
    exec 8>"$BUILD_LOCK_FILE"
    if flock -n 8; then
        return 0
    fi
    log "another build is already running; waiting up to ${BUILD_LOCK_WAIT_SECONDS}s for it"
    flock -w "$BUILD_LOCK_WAIT_SECONDS" 8 ||
        die "timed out after ${BUILD_LOCK_WAIT_SECONDS}s waiting for the build lock: $BUILD_LOCK_FILE"
}

BUILT_PLUGIN_RELATIVE="kwin/plugins/${PLUGIN_PREFIX}.so"

build_plugin() {
    take_build_lock
    log "configuring the plugin build in $BUILD_DIR"
    cmake -S "$SOURCE_DIR" -B "$BUILD_DIR" -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo
    cmake --build "$BUILD_DIR"
    [[ -f "$BUILD_DIR/$BUILT_PLUGIN_RELATIVE" ]] ||
        die "CMake did not produce $BUILD_DIR/$BUILT_PLUGIN_RELATIVE"
}

if (( BUILD_ONLY )); then
    build_plugin
    # The only thing on stdout that is not a log line, because the caller reads
    # the last line as the path.
    printf '%s\n' "$BUILD_DIR/$BUILT_PLUGIN_RELATIVE"
    exit 0
fi

source_hash() {
    (
        cd -- "$SOURCE_DIR"
        sha256sum \
            CMakeLists.txt \
            metadata.json \
            main.cpp \
            synaracomputeruseplugin.h \
            synaracomputeruseplugin.cpp \
            synaracomputerusebuildinfo.h.in |
            sha256sum |
            awk '{ print $1 }'
    )
}

path_signature() {
    local path
    for path in \
        /usr/lib64/libkwin.so* \
        /usr/lib64/cmake/KWin/KWinConfig.cmake \
        /usr/lib64/cmake/KWin/KWinConfigVersion.cmake \
        /usr/lib64/cmake/KWin/KWinTargets.cmake
    do
        if [[ -e "$path" ]]; then
            stat -Lc '%n:%i:%s:%Y' "$path"
        fi
    done
}

rpm_signature() {
    if command -v rpm >/dev/null 2>&1; then
        rpm -q kwin kwin-libs kwin-devel 2>/dev/null || true
    fi
}

kwin_version() {
    if command -v kwin_wayland >/dev/null 2>&1; then
        kwin_wayland --version 2>/dev/null || true
    fi
}

current_signature_details() {
    printf 'source=%s\n' "$(source_hash)"
    printf 'plugin_dir=%s\n' "$PLUGIN_DIR"
    printf 'kwin_version=%s\n' "$(kwin_version)"
    printf 'rpm_signature<<EOF\n%s\nEOF\n' "$(rpm_signature)"
    printf 'path_signature<<EOF\n%s\nEOF\n' "$(path_signature)"
}

current_signature="$(current_signature_details | sha256sum | awk '{ print $1 }')"
installed_signature=""
installed_plugin_id=""
if [[ -f "$STAMP_FILE" ]]; then
    installed_signature="$(awk -F= '/^signature=/{ print $2; exit }' "$STAMP_FILE")"
    installed_plugin_id="$(awk -F= '/^plugin_id=/{ print $2; exit }' "$STAMP_FILE")"
fi

valid_plugin_id() {
    [[ "$1" =~ ^${PLUGIN_PREFIX}(V[0-9]+)?$ ]]
}

known_plugin_ids() {
    local path name
    local plugin_files=()

    shopt -s nullglob
    plugin_files=("$PLUGIN_DIR"/${PLUGIN_PREFIX}*.so)
    shopt -u nullglob

    {
        printf '%s\n' "$PLUGIN_PREFIX"
        for path in "${plugin_files[@]}"; do
            name="${path##*/}"
            name="${name%.so}"
            if valid_plugin_id "$name"; then
                printf '%s\n' "$name"
            fi
        done
    } | sort -u
}

extract_plugin_ids() {
    printf '%s\n' "$1" |
        grep -oE "${PLUGIN_PREFIX}(V[0-9]+)?" |
        sort -u || true
}

# The next id must outrank every version KWin could know about, not just the
# ones in the target directory. A machine can carry installs in more than one
# root (an earlier sudo install under /usr next to the home-directory root), and
# KWin pins a plugin id for the life of the compositor once it has loaded it -
# numbering from one root alone can hand back an id the compositor has already
# pinned to an older library, which fails at load with no reason given.
next_plugin_id() {
    local path name version max_version=0 dir
    local plugin_files=()
    local search_dirs=("$PLUGIN_DIR"
        /usr/lib64/qt6/plugins/kwin/plugins
        /usr/lib/qt6/plugins/kwin/plugins
        "$HOME/.local/lib64/qt6/plugins/kwin/plugins"
        "$HOME/.local/lib/qt6/plugins/kwin/plugins")

    for dir in "${search_dirs[@]}"; do
        shopt -s nullglob
        plugin_files=("$dir"/${PLUGIN_PREFIX}*.so)
        shopt -u nullglob
        for path in "${plugin_files[@]}"; do
            name="${path##*/}"
            if [[ "$name" =~ ^${PLUGIN_PREFIX}V([0-9]+)\.so$ ]]; then
                version="${BASH_REMATCH[1]}"
                if (( version > max_version )); then
                    max_version="$version"
                fi
            fi
        done
    done

    # The compositor's own lists cover ids whose files are gone but whose
    # libraries are still pinned in the running process.
    local kwin_ids response property
    for property in LoadedPlugins AvailablePlugins; do
        if response="$(busctl --user get-property org.kde.KWin /Plugins org.kde.KWin.Plugins "$property" 2>/dev/null)"; then
            kwin_ids="$(extract_plugin_ids "$response")"
            while IFS= read -r name; do
                if [[ "$name" =~ ^${PLUGIN_PREFIX}V([0-9]+)$ ]]; then
                    version="${BASH_REMATCH[1]}"
                    if (( version > max_version )); then
                        max_version="$version"
                    fi
                fi
            done <<< "$kwin_ids"
        fi
    done

    printf '%sV%d\n' "$PLUGIN_PREFIX" "$((max_version + 1))"
}

# KWin's UnloadPlugin reply differs by version: some return `b`, newer ones are
# void. Treat a successful call with an empty or `b true` reply as unloaded and
# only `b false` as "was not loaded"; any call failure is fatal.
unload_plugin() {
    local plugin_id="$1"
    local response

    if ! response="$(busctl --user call org.kde.KWin /Plugins org.kde.KWin.Plugins UnloadPlugin s "$plugin_id" 2>&1)"; then
        die "KWin D-Bus UnloadPlugin failed for $plugin_id: $response"
    fi
    if [[ "$response" == *"b false"* ]]; then
        return 0
    fi
    log "unloaded $plugin_id"
}

install_plugin() {
    local source_path="$1"
    local destination_path="$2"
    local sudo_options=()

    if (( NEEDS_SUDO == 0 )); then
        install -m 755 "$source_path" "$destination_path" ||
            die "install failed for $destination_path"
        return 0
    fi
    if (( NONINTERACTIVE )); then
        sudo_options=(-n)
    fi
    if ! sudo "${sudo_options[@]}" install -m 755 "$source_path" "$destination_path"; then
        die "sudo install failed for $destination_path"
    fi
}

remove_plugin() {
    local path="$1"
    local sudo_options=()

    if (( NEEDS_SUDO == 0 )); then
        rm -f "$path"
        return $?
    fi
    if (( NONINTERACTIVE )); then
        sudo_options=(-n)
    fi
    sudo "${sudo_options[@]}" rm -f "$path"
}

plugin_id=""
needs_install=1
if (( FORCE == 0 )) && [[ "$installed_signature" == "$current_signature" ]] && valid_plugin_id "$installed_plugin_id" && [[ -f "$PLUGIN_DIR/$installed_plugin_id.so" ]]; then
    plugin_id="$installed_plugin_id"
    needs_install=0
    log "signature is unchanged; reusing installed $plugin_id"
fi

expected_build_id=""
if (( needs_install )); then
    build_plugin
    built_plugin="$BUILD_DIR/$BUILT_PLUGIN_RELATIVE"
    # The compiled-in build id, read from the same generated header the build
    # just compiled. The health check below compares the running plugin's
    # reported id against it, which is the only proof the compositor is serving
    # the binary this run produced rather than an older generation that still
    # holds the service name. Only a fresh build carries this guarantee - a
    # reused install may legitimately predate the checkout's HEAD.
    expected_build_id="$(sed -n 's/^#define SYNARA_COMPUTER_USE_BUILD_ID "\(.*\)"$/\1/p' \
        "$BUILD_DIR/synaracomputerusebuildinfo.h" 2>/dev/null || true)"

    plugin_id="$(next_plugin_id)"
    destination="$PLUGIN_DIR/$plugin_id.so"
    log "installing $plugin_id to $destination"
    install_plugin "$built_plugin" "$destination"
else
    destination="$PLUGIN_DIR/$plugin_id.so"
fi

# Before touching anything that is loaded, make sure the running compositor can
# actually see the file that was just installed. AvailablePlugins rescans the
# plugin roots on read, so a fresh install shows up immediately - unless the
# install landed in a root the compositor was never told about (QT_PLUGIN_PATH
# is read once, at KWin startup). Failing here, with everything still loaded,
# beats the alternative: unloading the working plugin and then discovering the
# replacement is invisible.
if available_response="$(busctl --user get-property org.kde.KWin /Plugins org.kde.KWin.Plugins AvailablePlugins 2>/dev/null)"; then
    if [[ "$available_response" != *"\"$plugin_id\""* ]]; then
        die "KWin cannot see $plugin_id in $PLUGIN_DIR. The compositor reads QT_PLUGIN_PATH once at startup, so a first install into this root needs one log-out/log-in before it can load - or rerun with SYNARA_KWIN_PLUGIN_DIR pointing at a directory this session already scans (for a system-wide install: /usr/lib64/qt6/plugins/kwin/plugins, which needs sudo). Nothing was unloaded."
    fi
fi

# Loaded-plugin discovery also differs by KWin version: prefer the
# LoadedPlugins property, fall back to the loadedPlugins method, then to every
# Synara id we could have installed.
old_plugin_ids=""
if loaded_response="$(busctl --user get-property org.kde.KWin /Plugins org.kde.KWin.Plugins LoadedPlugins 2>&1)"; then
    old_plugin_ids="$(extract_plugin_ids "$loaded_response")"
    log "queried the LoadedPlugins property"
elif loaded_response="$(busctl --user call org.kde.KWin /Plugins org.kde.KWin.Plugins loadedPlugins 2>&1)"; then
    old_plugin_ids="$(extract_plugin_ids "$loaded_response")"
    log "queried loaded KWin plugin ids"
else
    old_plugin_ids="$(known_plugin_ids)"
    log "KWin loaded-plugin queries are unavailable; trying known Synara plugin ids"
fi

if [[ -n "$old_plugin_ids" ]]; then
    while IFS= read -r old_plugin_id; do
        [[ -n "$old_plugin_id" ]] || continue
        unload_plugin "$old_plugin_id"
    done <<< "$old_plugin_ids"
fi

# Whoever owns the well-known service name owns healthJson and every later
# call, so the unique owner is pinned across the LoadPlugin boundary: a load
# that left the previous registration in place - an unload race, or another
# process holding the name - would make this script's own health check run
# against the wrong build.
service_owner_before=""
if owner_response="$(busctl --user call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus GetNameOwner s "$SERVICE_NAME" 2>/dev/null)"; then
    service_owner_before="$owner_response"
fi

load_response=""
if ! load_response="$(busctl --user call org.kde.KWin /Plugins org.kde.KWin.Plugins LoadPlugin s "$plugin_id" 2>&1)"; then
    die "KWin D-Bus LoadPlugin failed for $plugin_id: $load_response"
fi
if [[ "$load_response" != *"b true"* ]]; then
    die "KWin refused $plugin_id: $load_response. This usually means the plugin has a mismatching plugin version. Rebuild on this host against its installed kwin-devel package and inspect: journalctl --user -b -g 'mismatching plugin version'"
fi

service_owner_now=""
for _ in 1 2 3; do
    if owner_response="$(busctl --user call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus GetNameOwner s "$SERVICE_NAME" 2>/dev/null)"; then
        service_owner_now="$owner_response"
        break
    fi
    sleep 0.1
done
if [[ -z "$service_owner_now" ]]; then
    die "$plugin_id loaded, but nothing owns $SERVICE_NAME on the session bus, so the plugin did not register its service."
fi
if [[ -n "$service_owner_before" && "$service_owner_before" == "$service_owner_now" ]]; then
    die "$SERVICE_NAME is still owned by $service_owner_now from before $plugin_id was loaded, so the health check below would answer from the wrong process."
fi

health_response=""
if ! health_response="$(busctl --user call org.synara.ComputerUse /org/synara/ComputerUse org.synara.ComputerUse1 healthJson 2>&1)"; then
    die "plugin $plugin_id loaded, but healthJson failed: $health_response"
fi
printf '%s\n' "$health_response"

if [[ -n "$expected_build_id" ]]; then
    # busctl prints the JSON as an escaped string, so the quotes arrive as \".
    reported_build_id="$(printf '%s' "$health_response" | sed -n 's/.*\\"build\\":\\"\([^\\]*\)\\".*/\1/p')"
    if [[ -z "$reported_build_id" ]]; then
        log "healthJson reports no build id (older plugin interface); skipping the build identity check"
    elif [[ "$reported_build_id" != "$expected_build_id" ]]; then
        die "the compositor is serving build $reported_build_id, not the $expected_build_id this run just installed as $plugin_id - another plugin generation still owns $SERVICE_NAME"
    else
        log "the running plugin is the build this run installed ($reported_build_id)"
    fi
fi

# Superseded builds are deleted, not merely unloaded. KWin auto-loads any plugin
# in this directory whose metadata does not opt out, so an old build silently
# comes back on the next compositor start and races the current one for the
# org.synara.ComputerUse name - and the oldest registrant wins, which shadows the
# build that was just installed and makes an explicit LoadPlugin answer false.
# Only the id that just passed its health check may stay on disk.
prune_old_plugins() {
    local path name removed=0 failed=0
    local plugin_files=()

    shopt -s nullglob
    plugin_files=("$PLUGIN_DIR"/${PLUGIN_PREFIX}*.so)
    shopt -u nullglob

    for path in "${plugin_files[@]}"; do
        name="${path##*/}"
        name="${name%.so}"
        if [[ "$name" == "$plugin_id" ]] || ! valid_plugin_id "$name"; then
            continue
        fi
        unload_plugin "$name"
        if remove_plugin "$path"; then
            removed=$((removed + 1))
        else
            # A stale .so left behind wins the bus name on the next compositor
            # start (oldest registrant), shadowing the build this run installed
            # — never report that silently.
            warn "could not remove superseded plugin build $path; it will shadow $plugin_id on the next KWin start. Remove it manually."
            failed=$((failed + 1))
        fi
    done
    if (( removed )); then
        log "removed $removed superseded plugin build(s)"
    fi
    if (( failed )); then
        warn "$failed superseded plugin build(s) are still on disk"
    fi
}

prune_old_plugins

if (( needs_install )); then
    stamp_tmp="$(mktemp "$STATE_ROOT/install.stamp.XXXXXX")"
    {
        printf 'signature=%s\n' "$current_signature"
        printf 'plugin_id=%s\n' "$plugin_id"
        printf 'installed_at=%s\n' "$(date -Is)"
        printf 'plugin_path=%s\n' "$destination"
        # The server reads this back to explain a later LoadPlugin refusal:
        # KWin only accepts a plugin built against the running KWin version.
        printf 'kwin_version=%s\n' "$(kwin_version | head -n 1)"
    } >"$stamp_tmp"
    mv -f "$stamp_tmp" "$STAMP_FILE"
fi

log "Synara KWin plugin is loaded as $plugin_id"
