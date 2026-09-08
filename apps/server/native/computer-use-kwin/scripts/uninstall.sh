#!/usr/bin/env bash
set -euo pipefail

PLUGIN_PREFIX="SynaraComputerUsePlugin"

# Every root an install could have landed in, not just the system one: the normal
# install needs no root at all and goes under $HOME, and a machine can carry both
# (an older sudo install under /usr next to the home-directory root). Removing
# from only one of them is how `uninstall` reports success and leaves a plugin
# KWin still auto-loads. Keep in sync with install-and-load.sh.
if [[ -n "${SYNARA_KWIN_PLUGIN_DIR:-}" ]]; then
    PLUGIN_DIRS=("$SYNARA_KWIN_PLUGIN_DIR")
else
    PLUGIN_DIRS=(
        "$HOME/.local/lib64/qt6/plugins/kwin/plugins"
        "$HOME/.local/lib/qt6/plugins/kwin/plugins"
        /usr/lib64/qt6/plugins/kwin/plugins
        /usr/lib/qt6/plugins/kwin/plugins
    )
fi

log() {
    printf '[synara-kwin-plugin] %s\n' "$*"
}

die() {
    printf '[synara-kwin-plugin] ERROR: %s\n' "$*" >&2
    exit 1
}

valid_plugin_id() {
    [[ "$1" =~ ^${PLUGIN_PREFIX}(V[0-9]+)?$ ]]
}

installed_plugin_files() {
    local dir
    local plugin_files=()

    for dir in "${PLUGIN_DIRS[@]}"; do
        [[ -d "$dir" ]] || continue
        shopt -s nullglob
        plugin_files=("$dir"/${PLUGIN_PREFIX}*.so)
        shopt -u nullglob
        (( ${#plugin_files[@]} )) && printf '%s\n' "${plugin_files[@]}"
    done
}

known_plugin_ids() {
    local path name

    while IFS= read -r path; do
        [[ -n "$path" ]] || continue
        name="${path##*/}"
        name="${name%.so}"
        if valid_plugin_id "$name"; then
            printf '%s\n' "$name"
        fi
    done < <(installed_plugin_files) | sort -u
}

extract_plugin_ids() {
    printf '%s\n' "$1" |
        grep -oE "${PLUGIN_PREFIX}(V[0-9]+)?" |
        sort -u || true
}

# KWin's UnloadPlugin reply differs by version: some return `b`, newer ones are
# void. Treat a successful call with an empty or `b true` reply as unloaded and
# only `b false` as a refusal; any call failure is fatal. Same rule as
# install-and-load.sh's unload_plugin.
unload_required() {
    local plugin_id="$1"
    local response

    if ! response="$(busctl --user call org.kde.KWin /Plugins org.kde.KWin.Plugins UnloadPlugin s "$plugin_id" 2>&1)"; then
        die "failed to unload currently-loaded plugin $plugin_id: $response"
    fi
    if [[ "$response" == *"b false"* ]]; then
        die "KWin refused to unload currently-loaded plugin $plugin_id: $response"
    fi
    log "unloaded $plugin_id"
}

unload_if_present() {
    local plugin_id="$1"
    local response

    if ! response="$(busctl --user call org.kde.KWin /Plugins org.kde.KWin.Plugins UnloadPlugin s "$plugin_id" 2>&1)"; then
        log "could not contact KWin while trying $plugin_id; continuing with file removal"
        return
    fi
    if [[ "$response" != *"b false"* ]]; then
        log "unloaded $plugin_id"
    fi
}

plugin_files=()
while IFS= read -r plugin_file; do
    [[ -n "$plugin_file" ]] || continue
    plugin_files+=("$plugin_file")
done < <(installed_plugin_files)

if (( ${#plugin_files[@]} == 0 )); then
    log "no installed Synara KWin plugin files found in: ${PLUGIN_DIRS[*]}"
    exit 0
fi

loaded_query_available=0
loaded_plugin_ids=""
if command -v busctl >/dev/null 2>&1; then
    if loaded_response="$(busctl --user call org.kde.KWin /Plugins org.kde.KWin.Plugins loadedPlugins 2>&1)"; then
        loaded_query_available=1
        loaded_plugin_ids="$(extract_plugin_ids "$loaded_response")"
    else
        loaded_plugin_ids="$(known_plugin_ids)"
        log "KWin loadedPlugins is unavailable; trying known Synara plugin ids"
    fi

    if [[ -n "$loaded_plugin_ids" ]]; then
        while IFS= read -r plugin_id; do
            [[ -n "$plugin_id" ]] || continue
            if (( loaded_query_available )); then
                unload_required "$plugin_id"
            else
                unload_if_present "$plugin_id"
            fi
        done <<< "$loaded_plugin_ids"
    fi
else
    log "busctl is unavailable; removing plugin files without a KWin unload call"
fi

# Only a system-wide install costs root. The normal install is under $HOME and
# removing it must not stop to ask for a password, so sudo is required exactly
# for the files that need it and never demanded up front.
removed=0
sudo_files=()
for plugin_file in "${plugin_files[@]}"; do
    if [[ -w "${plugin_file%/*}" ]]; then
        rm -f -- "$plugin_file" || die "could not remove $plugin_file"
        removed=$((removed + 1))
    else
        sudo_files+=("$plugin_file")
    fi
done

if (( ${#sudo_files[@]} )); then
    command -v sudo >/dev/null 2>&1 ||
        die "sudo is unavailable and these need root to remove: ${sudo_files[*]}"
    if ! sudo rm -f -- "${sudo_files[@]}"; then
        die "sudo could not remove: ${sudo_files[*]}"
    fi
    removed=$((removed + ${#sudo_files[@]}))
fi

log "removed $removed installed Synara KWin plugin file(s)"
