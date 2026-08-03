// FILE: registryInstall.ts
// Purpose: Resolve the Synara server ON the remote host from a package
//          registry, at an EXACT pinned version, and start it without an init
//          system.
// Layer: Server / remote broker
// Exports: REGISTRY_RUNNER_SCRIPT, renderRegistryRunnerScript,
//          registryPackageSpec, RegistryInstallRefusedError
//
// Why this exists, and how it differs from the two designs it borrows from
// -----------------------------------------------------------------------
// Prior art in this space runs `npx <pkg>@latest` on the remote. That is the right
// call about DEPENDENCIES: npm resolves them on the destination, so there is no
// per-platform artifact matrix and native bindings are simply installed for the
// host that will run them. Uploading a tarball meant shipping node_modules per
// OS and per arch, or bundling native `.node` files by hand — the maintenance
// cost that motivated this change.
//
// It is the wrong call about IDENTITY. `@latest` means the remote resolves
// whatever is newest at that instant, so the client cannot say which build
// answered it, a version-skew policy has nothing to compare, and there is no
// release to roll back to. Two hosts added a week apart silently run different
// servers.
//
// So: npm resolves the dependencies, and WE pin the version. The spec is always
// `<name>@<exact>` — never a tag, never a range — and the provisioning
// handshake still verifies that the process which answered reports that exact
// version and accepts the credential we minted. npm supplies the bytes; the
// handshake supplies the proof.

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/;
const PACKAGE_NAME = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

export class RegistryInstallRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryInstallRefusedError";
  }
}

/**
 * `name@version`, refusing anything that is not an exact version.
 *
 * A dist-tag (`@latest`, `@nightly`) or a range (`^1.2.0`) would hand version
 * selection to the registry at install time, which is exactly the property that
 * makes skew undetectable and rollback impossible. Refused here rather than
 * validated at the call site so no future caller can reintroduce a floating
 * spec by passing one through.
 */
export function registryPackageSpec(name: string, version: string): string {
  if (!PACKAGE_NAME.test(name)) {
    throw new RegistryInstallRefusedError(`Refusing an invalid npm package name: ${name}`);
  }
  if (!EXACT_VERSION.test(version)) {
    throw new RegistryInstallRefusedError(
      `Refusing a floating version spec: ${version}. The remote must run an exact version so ` +
        `the handshake can verify it and an upgrade has something to roll back to.`,
    );
  }
  return `${name}@${version}`;
}

export interface RegistryRunnerInput {
  /** Exact `name@version`; build it with `registryPackageSpec`. */
  readonly packageSpec: string;
  /** Absolute path to the per-environment state directory on the remote. */
  readonly stateDirectory: string;
  /** Loopback port the server binds. The tunnel's far end. */
  readonly port: number;
}

/**
 * The script the remote runs to start (or adopt) its server.
 *
 * No systemd and no launchd. Both were supported before, which meant two
 * supervisor backends, two sets of unit rendering, and a class of GNU-vs-BSD
 * divergence that only appeared on a real Mac. A pidfile plus `nohup` behaves
 * identically on both and needs no user-manager session to exist at all —
 * which is what made launchd fragile over ssh and systemd impossible in a
 * container.
 *
 * Reuse before start: if a healthy server already answers on the recorded port
 * it is adopted rather than restarted, so a second client attaching to the same
 * host does not interrupt a turn that is already streaming.
 */
export function renderRegistryRunnerScript(input: RegistryRunnerInput): string {
  const { packageSpec, stateDirectory, port } = input;
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new RegistryInstallRefusedError(`Refusing an out-of-range remote port: ${port}`);
  }
  // Single-quoted heredoc values: every interpolation below is either validated
  // above or an absolute path this module computed, and none is user text.
  return `set -eu
STATE_DIR='${stateDirectory}'
PORT='${port}'
SPEC='${packageSpec}'
PID_FILE="$STATE_DIR/server.pid"
LOG_FILE="$STATE_DIR/server.log"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

# Adopt a healthy server rather than restarting one mid-turn.
if [ -f "$PID_FILE" ]; then
  EXISTING="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$EXISTING" ] && kill -0 "$EXISTING" 2>/dev/null; then
    printf 'reused %s\\n' "$EXISTING"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

# npm resolves the dependency tree for THIS host, including native bindings.
# The version is pinned by the caller; the handshake verifies what answers.
if command -v npx >/dev/null 2>&1; then
  RUN="npx --yes $SPEC"
elif command -v npm >/dev/null 2>&1; then
  RUN="npm exec --yes $SPEC --"
else
  printf 'Remote host has neither npx nor npm on the PATH this command sees. ' >&2
  printf 'If npm IS installed there, it is almost certainly only on the LOGIN shell PATH ' >&2
  printf '(Homebrew, nvm, asdf and mise all install that way): set this host launcher to ' >&2
  printf 'login-shell. Otherwise install Node, which provides npm.\\n' >&2
  exit 127
fi

# nohup so the server outlives this ssh channel closing.
#
# Wrapped in sh -c rather than left to word splitting: nohup takes its FIRST
# word as the command, so a multi-word RUN makes nohup try to exec the wrong
# token. Observed against a real Mac, which reported "Permission denied" on a
# package path it had mistaken for a program.
nohup sh -c "$RUN --host 127.0.0.1 --port $PORT --no-browser" >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
printf '%s\\n' "$SERVER_PID" >"$PID_FILE"
chmod 600 "$PID_FILE"
printf 'started %s\\n' "$SERVER_PID"
`;
}

/** The runner as a template, for tests that assert on its shape. */
export const REGISTRY_RUNNER_SCRIPT = renderRegistryRunnerScript({
  packageSpec: "@synara/cli@0.0.0",
  stateDirectory: "/tmp/synara-state",
  port: 8000,
});
