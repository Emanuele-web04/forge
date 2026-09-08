#!/usr/bin/env bash
# Enables the auto-rebuild units for the Synara KWin computer-use plugin.
#
# The .path and .service units are GENERATED here rather than linked from this
# directory, because both depend on facts about this machine: which ABI
# directory actually carries KWin's development files (lib64 vs lib vs Debian
# multiarch — the same candidates the server's KWIN_CMAKE_CONFIG_PATHS probes),
# and where this checkout lives. A checked-in unit could only hardcode one
# machine's answers.
set -euo pipefail

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="$SOURCE_DIR/scripts/install-and-load.sh"
README_PATH="$SOURCE_DIR/README.md"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

command -v systemctl >/dev/null 2>&1 || {
    printf 'Missing required command: systemctl\n' >&2
    exit 1
}

[[ -f "$SCRIPT_PATH" ]] || {
    printf 'install-and-load.sh is missing next to this script; the checkout looks wrong\n' >&2
    exit 1
}

# The ABI directory is whichever one really holds KWin's cmake config, in the
# same order KWIN_CMAKE_CONFIG_PATHS probes it server-side.
abi_dir=""
for candidate in /usr/lib64 /usr/lib/x86_64-linux-gnu /usr/lib/aarch64-linux-gnu /usr/lib; do
    if [[ -f "$candidate/cmake/KWin/KWinConfig.cmake" ]]; then
        abi_dir="$candidate"
        break
    fi
done
if [[ -z "$abi_dir" ]]; then
    printf 'No KWin cmake config found under /usr/lib64, /usr/lib/<multiarch>, or /usr/lib;\n' >&2
    printf 'install kwin-devel (or your distribution equivalent) first.\n' >&2
    exit 1
fi

mkdir -p "$SYSTEMD_USER_DIR"

path_unit="$SYSTEMD_USER_DIR/synara-kwin-computer-use-rebuild.path"
{
    echo "[Unit]"
    echo "Description=Watch KWin ABI files for Synara KWin computer-use rebuilds"
    echo ""
    echo "[Path]"
    for watched in \
        "$abi_dir/libkwin.so" \
        "$abi_dir/libkwin.so.6" \
        "$abi_dir/cmake/KWin/KWinConfig.cmake" \
        "$abi_dir/cmake/KWin/KWinConfigVersion.cmake" \
        "$abi_dir/cmake/KWin/KWinTargets.cmake"; do
        echo "PathChanged=$watched"
    done
    echo "Unit=synara-kwin-computer-use-rebuild.service"
    echo ""
    echo "[Install]"
    echo "WantedBy=paths.target"
} >"$path_unit"

service_unit="$SYSTEMD_USER_DIR/synara-kwin-computer-use-rebuild.service"
{
    echo "[Unit]"
    echo "Description=Rebuild and install the Synara KWin computer-use plugin"
    echo "Documentation=file:$README_PATH"
    echo "After=graphical-session.target"
    echo "ConditionPathExists=$SCRIPT_PATH"
    echo ""
    echo "[Service]"
    echo "Type=oneshot"
    echo "ExecStart=$SCRIPT_PATH --noninteractive"
} >"$service_unit"

# The timer is machine-independent and ships checked in; systemctl enable is
# all-or-nothing, so it must exist in the unit directory alongside the
# generated units before either can be enabled.
cp -- "$SOURCE_DIR/systemd/synara-kwin-computer-use-rebuild.timer" "$SYSTEMD_USER_DIR/"

systemctl --user daemon-reload
systemctl --user enable \
    synara-kwin-computer-use-rebuild.path \
    synara-kwin-computer-use-rebuild.timer

printf 'Synara KWin rebuild units are enabled for the user manager (watching %s). They were not started.\n' "$abi_dir"
