// FILE: remoteBootstrap.ts
// Purpose: Drive an upload-first bootstrap of a Synara server onto a remote
//          host: stage the exact-version artifacts, verify their checksums on
//          the far side, activate by symlink swap, install the supervisor, and
//          verify the provisioning handshake before anyone is allowed to talk
//          to it. Interrupted runs resume; failed activations roll back.
// Layer: Server / remote broker
// Exports: bootstrapRemoteServer, uninstallRemoteServer, rollbackRemoteServer,
//          readRemoteReleaseId, BootstrapOutcome, BootstrapProgress,
//          UpgradeRefusedError
//
// Crash safety model
// ------------------
// The only mutation that changes what runs is the `current` symlink swap. It is
// done by creating a uniquely-named sibling link and `mv -T`-ing it over the
// destination, which is a single rename(2) — NOT `ln -sfn`, which unlinks and
// then re-creates, leaving a window where `current` resolves to nothing at all.
// Everything before the swap (upload, checksum, extract) happens in `staging/`
// and `releases/<id>/`, which are inert. So an interruption at any point leaves
// either the old release running or the new one, never a half-written tree
// behind `current`.
//
// The same rename discipline covers the credential: it is written to a temp
// file and renamed into place, and the outgoing credential is copied aside
// first so a rollback can restore the token the old release still expects.
//
// Resume is content-addressed rather than journalled: a re-run re-checksums the
// remote staged file and skips the upload only when it already matches. A
// truncated file from a killed upload fails that check and is re-uploaded, so a
// partial transfer can never be mistaken for a complete one.

import {
  assertDigestMatch,
  type BootstrapArtifact,
  type BootstrapArtifactSet,
  parseRemoteDigest,
  verifyLocalArtifact,
} from "./bootstrapArtifacts";
import {
  type ProvisioningClaim,
  type RemoteCredential,
  mintRemoteCredential,
  verifyProvisioningHandshake,
} from "./provisioningHandshake";
import {
  expectRemoteSuccess,
  type RemoteConnection,
  type RemoteExecResult,
} from "./remoteConnection";
import {
  assertSafeInstallRoot,
  isPathInsideInstallRoot,
  type RemoteInstallLayout,
  remoteReleaseDirectory,
  remoteReleaseNodePath,
} from "./remoteInstallLayout";
import type { SupervisorPlan } from "./remoteSupervisor";
import {
  describeUpgradeGate,
  evaluateUpgradeGate,
  type RequestedUpgrade,
  type UpgradeGate,
} from "./remoteUpgradePolicy";
import {
  normalizeEnvironmentId,
  normalizeReleaseId,
  normalizeRemoteFileName,
} from "./remoteInputs";

export type BootstrapProgress =
  | { readonly step: "preparing" }
  | { readonly step: "uploading"; readonly artifact: BootstrapArtifact["kind"] }
  | { readonly step: "reusing-staged"; readonly artifact: BootstrapArtifact["kind"] }
  | { readonly step: "verifying"; readonly artifact: BootstrapArtifact["kind"] }
  | { readonly step: "extracting" }
  | { readonly step: "activating" }
  | { readonly step: "installing-supervisor" }
  | { readonly step: "handshake" };

export interface BootstrapOutcome {
  readonly releaseId: string;
  readonly environmentId: string;
  readonly credential: RemoteCredential;
  readonly previousReleaseId: string | null;
}

export interface BootstrapInput {
  readonly connection: RemoteConnection;
  readonly layout: RemoteInstallLayout;
  readonly artifacts: BootstrapArtifactSet;
  readonly supervisor: SupervisorPlan;
  readonly environmentId: string;
  /** Probes the running remote server; injected so the caller owns transport. */
  readonly probeHandshake: (credential: RemoteCredential) => Promise<ProvisioningClaim>;
  readonly onProgress?: (progress: BootstrapProgress) => void;
  readonly mintCredential?: () => RemoteCredential;
  /**
   * The drain policy this upgrade must satisfy before it may swap the release.
   *
   * Omitted for a FIRST install, where there is no running server and so no
   * turn to preempt. Supplying it on an upgrade is what makes the policy real:
   * without it, `systemctl restart` runs unconditionally and a weekly release
   * can kill a turn that is still streaming.
   */
  readonly upgrade?: RequestedUpgrade;
}

/** Thrown when the drain policy refuses or defers the release swap. */
export class UpgradeRefusedError extends Error {
  readonly gate: UpgradeGate;

  constructor(gate: UpgradeGate, message: string) {
    super(message);
    this.name = "UpgradeRefusedError";
    this.gate = gate;
  }
}

const REMOTE_DIRECTORY_MODE = "700";
const REMOTE_SECRET_MODE = "600";
const REMOTE_EXECUTABLE_MODE = "700";

/**
 * Where an artifact is uploaded to.
 *
 * `remoteFileName` is caller-influenced, so it is validated rather than
 * concatenated, and the result is gated on the install root the same way every
 * other computed remote path is. Without both, a name of `../../../../tmp/x`
 * would upload outside the tree that uninstall is scoped to delete.
 */
function stagedPath(layout: RemoteInstallLayout, artifact: BootstrapArtifact): string {
  const remotePath = `${layout.stagingDirectory}/${normalizeRemoteFileName(artifact.remoteFileName)}`;
  if (!isPathInsideInstallRoot(layout, remotePath)) {
    throw new Error(`Refusing to stage an artifact outside the install root: ${remotePath}`);
  }
  return remotePath;
}

/**
 * Ask the remote for a file's SHA-256, tolerating either `sha256sum` (Linux) or
 * `shasum -a 256` (macOS). A non-zero exit means "no digest", never "matches".
 */
async function remoteDigest(
  connection: RemoteConnection,
  remotePath: string,
): Promise<string | null> {
  for (const argv of [
    ["sha256sum", "--", remotePath],
    ["shasum", "-a", "256", "--", remotePath],
  ]) {
    const result: RemoteExecResult = await connection.exec(argv);
    if (result.exitCode === 0) {
      const digest = parseRemoteDigest(result.stdout);
      if (digest) return digest;
    }
  }
  return null;
}

/**
 * Take the install's bootstrap lock for the duration of `body`.
 *
 * Two concurrent bootstraps share every path in the layout — staging names, the
 * `.incoming` scratch tree, the credential file, the unit, and `current` — so
 * without this they interleave: each mints a credential, the second overwrites
 * the first, and the first's handshake then fails and rolls back a release the
 * second just activated.
 *
 * `mkdir` is the primitive because it is atomic on every POSIX filesystem
 * including NFS: it either creates the directory or fails, with no
 * check-then-act window. `flock` would be nicer but is not universally present,
 * and a lock FILE opened with `>` is not exclusive at all.
 */
async function withBootstrapLock<T>(
  connection: RemoteConnection,
  layout: RemoteInstallLayout,
  body: () => Promise<T>,
): Promise<T> {
  const acquired = await connection.exec(["mkdir", "--", layout.lockFile]);
  if (acquired.exitCode !== 0) {
    throw new Error(
      `Another bootstrap is already running against ${layout.root} (lock: ${layout.lockFile}). ` +
        "If no bootstrap is in progress, remove that directory and retry.",
    );
  }
  try {
    return await body();
  } finally {
    // Released even when the body throws: a crashed run must not wedge the
    // install permanently. A hard kill still leaves the lock behind, which is
    // why the error above says how to clear it.
    await connection.exec(["rm", "-rf", "--", layout.lockFile]);
  }
}

async function ensureDirectories(input: BootstrapInput): Promise<void> {
  const { connection, layout } = input;
  await expectRemoteSuccess(connection, [
    "mkdir",
    "-p",
    "--",
    layout.root,
    layout.releasesDirectory,
    layout.stateDirectory,
    layout.stagingDirectory,
  ]);
  // The state directory holds the credential; a group/other-readable tree would
  // hand it to every other account on a shared host.
  await expectRemoteSuccess(connection, [
    "chmod",
    REMOTE_DIRECTORY_MODE,
    "--",
    layout.root,
    layout.stateDirectory,
  ]);
}

/**
 * Upload one artifact unless a byte-identical copy is already staged.
 *
 * The remote-side verification after upload is the one that matters: it is the
 * only check that can see transfer corruption or a truncated resume.
 */
async function stageArtifact(input: BootstrapInput, artifact: BootstrapArtifact): Promise<string> {
  const { connection, layout } = input;
  const remotePath = stagedPath(layout, artifact);
  await verifyLocalArtifact(artifact);

  const existing = await remoteDigest(connection, remotePath);
  if (existing !== null && existing === artifact.sha256.toLowerCase()) {
    input.onProgress?.({ step: "reusing-staged", artifact: artifact.kind });
    return remotePath;
  }

  input.onProgress?.({ step: "uploading", artifact: artifact.kind });
  await connection.uploadFile({
    localPath: artifact.localPath,
    remotePath,
    mode: artifact.mode,
  });

  input.onProgress?.({ step: "verifying", artifact: artifact.kind });
  assertDigestMatch({
    artifact,
    where: "remote",
    actual: await remoteDigest(connection, remotePath),
  });
  return remotePath;
}

/** The directory `current` resolves to, or null when nothing is active. */
async function readRemoteCurrentTarget(
  connection: RemoteConnection,
  layout: RemoteInstallLayout,
): Promise<string | null> {
  const result = await connection.exec(["readlink", "--", layout.currentLink]);
  if (result.exitCode !== 0) return null;
  const target = result.stdout.trim();
  return target.length === 0 ? null : target;
}

/** Reads the release id `current` points at, or null when nothing is active. */
export async function readRemoteReleaseId(
  connection: RemoteConnection,
  layout: RemoteInstallLayout,
): Promise<string | null> {
  const target = await readRemoteCurrentTarget(connection, layout);
  if (target === null) return null;
  const name = target.split("/").findLast((segment) => segment.length > 0);
  if (!name) return null;
  try {
    return normalizeReleaseId(name);
  } catch {
    return null;
  }
}

async function extractRelease(
  input: BootstrapInput,
  tarballRemotePath: string,
  releaseDirectory: string,
): Promise<void> {
  const { connection } = input;
  input.onProgress?.({ step: "extracting" });
  // Extract into a scratch directory and rename into place, so an interrupted
  // extraction never leaves a partial tree at a release id that a later resume
  // would treat as complete.
  const scratch = `${releaseDirectory}.incoming`;
  if (!isPathInsideInstallRoot(input.layout, scratch)) {
    throw new Error(`Refusing to extract outside the install root: ${scratch}`);
  }
  await expectRemoteSuccess(connection, ["rm", "-rf", "--", scratch]);
  await expectRemoteSuccess(connection, ["mkdir", "-p", "--", scratch]);
  await expectRemoteSuccess(connection, ["tar", "-xzf", tarballRemotePath, "-C", scratch, "--"]);
  // Never delete the tree the supervisor is currently executing from. A retry
  // of the SAME version after a post-activation interruption resolves `current`
  // to this very directory, and removing it would stop the running server dead
  // — the one release on the box that is definitely in use.
  const activeReleaseDirectory = await readRemoteCurrentTarget(connection, input.layout);
  if (activeReleaseDirectory === releaseDirectory) {
    // Already live at this release: never delete the tree a running server is
    // executing from. The digest proves the ARCHIVE is intact, not the
    // extracted tree, so this path deliberately does not repair a release
    // corrupted on disk — reinstalling the same version is a no-op. Uninstall
    // first to force a clean extraction.
    await expectRemoteSuccess(connection, ["rm", "-rf", "--", scratch]);
    return;
  }
  await expectRemoteSuccess(connection, ["rm", "-rf", "--", releaseDirectory]);
  await expectRemoteSuccess(connection, ["mv", "--", scratch, releaseDirectory]);
}

/**
 * Copy the staged Node binary into the release tree.
 *
 * This has to happen after extraction (which replaces the release directory
 * wholesale) and before activation (after which `current/node` is the path the
 * supervisor executes). Staging is wiped on success, so a runtime left only in
 * staging is a runtime that no longer exists by the time systemd launches it.
 *
 * A copy rather than a move: staging is the content-addressed resume cache, and
 * emptying it here would make any interruption past this point re-upload the
 * whole runtime over the WAN. A duplicate on remote disk until success is the
 * cheaper side of that trade.
 */
async function installReleaseRuntime(
  input: BootstrapInput,
  stagedRuntimePath: string,
  releaseId: string,
): Promise<void> {
  const { connection, layout } = input;
  const runtimePath = remoteReleaseNodePath(layout, releaseId);
  if (!isPathInsideInstallRoot(layout, runtimePath)) {
    throw new Error(`Refusing to install a runtime outside the install root: ${runtimePath}`);
  }
  await expectRemoteSuccess(connection, ["cp", "-f", "--", stagedRuntimePath, runtimePath]);
  await expectRemoteSuccess(connection, ["chmod", REMOTE_EXECUTABLE_MODE, "--", runtimePath]);
}

/**
 * Write a 0600 file whose contents never travel through argv.
 *
 * The write is temp-then-rename: a crash partway through a direct write leaves
 * a TRUNCATED credential, and a server that reads half a token refuses every
 * connection while looking perfectly healthy. `mv -T` makes the file go from
 * fully-old to fully-new with nothing observable in between.
 */
async function writeRemoteSecret(
  connection: RemoteConnection,
  layout: RemoteInstallLayout,
  remotePath: string,
  contents: string,
): Promise<void> {
  const temporaryPath = `${remotePath}.new`;
  if (!isPathInsideInstallRoot(layout, temporaryPath)) {
    throw new Error(`Refusing to write a secret outside the install root: ${temporaryPath}`);
  }
  // The secret travels on stdin, never in argv: argv is visible in the remote
  // process table to every user on the host.
  await expectRemoteSuccess(
    connection,
    ["sh", "-c", 'umask 077; cat > "$1"', "sh", temporaryPath],
    { stdin: contents },
  );
  await expectRemoteSuccess(connection, ["chmod", REMOTE_SECRET_MODE, "--", temporaryPath]);
  await expectRemoteSuccess(connection, ["mv", "-fT", "--", temporaryPath, remotePath]);
}

/**
 * Install a freshly minted credential, keeping the outgoing one recoverable.
 *
 * The previous credential is copied aside before the new one lands. Without
 * that, a crash after the write loses the new token locally while the OLD
 * service — which may still be the one running — keeps authenticating with a
 * credential the broker no longer holds, leaving an authenticated daemon nobody
 * can talk to. Rollback restores this copy.
 */
async function installCredential(
  connection: RemoteConnection,
  layout: RemoteInstallLayout,
  credential: RemoteCredential,
): Promise<void> {
  const existing = await connection.exec(["cat", "--", layout.credentialFile]);
  if (existing.exitCode === 0 && existing.stdout.trim().length > 0) {
    await expectRemoteSuccess(connection, [
      "cp",
      "-f",
      "--",
      layout.credentialFile,
      layout.previousCredentialFile,
    ]);
    await expectRemoteSuccess(connection, [
      "chmod",
      REMOTE_SECRET_MODE,
      "--",
      layout.previousCredentialFile,
    ]);
  }
  await writeRemoteSecret(connection, layout, layout.credentialFile, `${credential.token}\n`);
}

/** Puts the previous credential back, so the restored release stays reachable. */
async function restorePreviousCredential(
  connection: RemoteConnection,
  layout: RemoteInstallLayout,
): Promise<void> {
  const previous = await connection.exec(["cat", "--", layout.previousCredentialFile]);
  if (previous.exitCode !== 0 || previous.stdout.trim().length === 0) return;
  await writeRemoteSecret(connection, layout, layout.credentialFile, `${previous.stdout.trim()}\n`);
}

/**
 * Point a symlink at `target` without the name ever ceasing to exist.
 *
 * `ln -sfn` is NOT atomic — coreutils unlinks the existing link and then
 * creates the new one, so an interruption in between leaves the name missing
 * entirely, and for `current` that means a supervisor with nothing to launch.
 * Creating a uniquely-named sibling link and `mv -T`-ing it over the
 * destination is a single rename(2): observers see either the old target or the
 * new one, never nothing.
 */
async function atomicSymlinkSwap(
  connection: RemoteConnection,
  layout: RemoteInstallLayout,
  input: { readonly target: string; readonly linkPath: string },
): Promise<void> {
  const temporaryLink = `${input.linkPath}.swap`;
  if (!isPathInsideInstallRoot(layout, temporaryLink)) {
    throw new Error(`Refusing to create a symlink outside the install root: ${temporaryLink}`);
  }
  await expectRemoteSuccess(connection, ["rm", "-f", "--", temporaryLink]);
  await expectRemoteSuccess(connection, ["ln", "-sfn", "--", input.target, temporaryLink]);
  await expectRemoteSuccess(connection, ["mv", "-fT", "--", temporaryLink, input.linkPath]);
}

/** Points `current` at `releaseId`, recording the outgoing one as `previous`. */
async function activateRelease(
  input: BootstrapInput,
  releaseId: string,
  previousReleaseId: string | null,
): Promise<void> {
  const { connection, layout } = input;
  input.onProgress?.({ step: "activating" });
  const releaseDirectory = remoteReleaseDirectory(layout, releaseId);
  if (previousReleaseId !== null) {
    await atomicSymlinkSwap(connection, layout, {
      target: remoteReleaseDirectory(layout, previousReleaseId),
      linkPath: layout.previousLink,
    });
  }
  await atomicSymlinkSwap(connection, layout, {
    target: releaseDirectory,
    linkPath: layout.currentLink,
  });
}

async function runPlanCommands(
  connection: RemoteConnection,
  commands: ReadonlyArray<ReadonlyArray<string>>,
): Promise<void> {
  for (const argv of commands) {
    await expectRemoteSuccess(connection, argv);
  }
}

/** Restores `current` to the previous release and restarts the supervisor. */
export async function rollbackRemoteServer(input: {
  readonly connection: RemoteConnection;
  readonly layout: RemoteInstallLayout;
  readonly supervisor: SupervisorPlan;
  readonly previousReleaseId: string | null;
}): Promise<void> {
  const { connection, layout, supervisor, previousReleaseId } = input;
  if (previousReleaseId === null) {
    // Nothing to roll back to: stop the service and leave `current` dangling
    // rather than pointing at a release that failed its handshake.
    await runPlanCommands(connection, supervisor.stopArgv);
    await connection.exec(["rm", "-f", "--", layout.currentLink]);
    return;
  }
  // The restored release authenticates with the credential it was installed
  // with; restarting it under the newly minted one would leave a running server
  // the broker cannot talk to.
  await restorePreviousCredential(connection, layout);
  await atomicSymlinkSwap(connection, layout, {
    target: remoteReleaseDirectory(layout, previousReleaseId),
    linkPath: layout.currentLink,
  });
  await runPlanCommands(connection, supervisor.startArgv);
}

/**
 * Bootstrap or upgrade a remote Synara, serialized against concurrent runs.
 *
 * Input validation happens BEFORE the lock is taken, so a malformed request
 * fails without touching the remote host or creating a lock another run would
 * then have to wait behind.
 */
export async function bootstrapRemoteServer(input: BootstrapInput): Promise<BootstrapOutcome> {
  const releaseId = normalizeReleaseId(input.artifacts.releaseId);
  const environmentId = normalizeEnvironmentId(input.environmentId);
  normalizeRemoteFileName(input.artifacts.serverTarball.remoteFileName);
  normalizeRemoteFileName(input.artifacts.nodeRuntime.remoteFileName);
  await ensureDirectories(input);
  return withBootstrapLock(input.connection, input.layout, () =>
    runBootstrap(input, releaseId, environmentId),
  );
}

async function runBootstrap(
  input: BootstrapInput,
  releaseId: string,
  environmentId: string,
): Promise<BootstrapOutcome> {
  const { connection, layout, artifacts, supervisor } = input;
  input.onProgress?.({ step: "preparing" });

  const previousReleaseId = await readRemoteReleaseId(connection, layout);

  // Consult the drain policy BEFORE anything is uploaded or swapped. A "wait"
  // or "refused" verdict must leave the remote host exactly as it was, so this
  // sits ahead of every mutation rather than in front of the restart alone.
  if (input.upgrade !== undefined) {
    // currentReleaseId comes from the HOST, not the caller: the caller's view
    // can be stale, and "already-current" is a decision about what is actually
    // running.
    const gate = evaluateUpgradeGate({
      ...input.upgrade,
      currentReleaseId: previousReleaseId,
      targetReleaseId: releaseId,
    });
    if (gate.decision !== "swap") {
      throw new UpgradeRefusedError(gate, describeUpgradeGate(gate));
    }
  }

  const tarballRemotePath = await stageArtifact(input, artifacts.serverTarball);
  const stagedRuntimePath = await stageArtifact(input, artifacts.nodeRuntime);

  const releaseDirectory = remoteReleaseDirectory(layout, releaseId);
  await extractRelease(input, tarballRemotePath, releaseDirectory);
  await installReleaseRuntime(input, stagedRuntimePath, releaseId);

  const credential = (input.mintCredential ?? mintRemoteCredential)();
  await installCredential(connection, layout, credential);
  await writeRemoteSecret(connection, layout, layout.environmentIdFile, `${environmentId}\n`);

  // Everything from the symlink swap onward is inside the rollback boundary.
  // Activation is the first step that changes what runs, so an interruption
  // after it — a supervisor that fails to install, a connection dropped during
  // restart — must restore `current` rather than leave it advertising a release
  // the box is not actually running. A later readRemoteReleaseId believes that
  // symlink, and so does the version-skew policy that reads it.
  try {
    await activateRelease(input, releaseId, previousReleaseId);

    input.onProgress?.({ step: "installing-supervisor" });
    await writeRemoteSecret(connection, layout, supervisor.unitPath, supervisor.unitContents);
    await runPlanCommands(connection, supervisor.installArgv);
    await runPlanCommands(connection, supervisor.startArgv);

    input.onProgress?.({ step: "handshake" });
    const claim = await input.probeHandshake(credential);
    const verdict = verifyProvisioningHandshake({
      claim,
      expected: {
        environmentId,
        serverVersion: artifacts.serverVersion,
        credential,
      },
    });
    if (!verdict.ok) {
      throw new Error(verdict.reason);
    }
  } catch (cause) {
    // A server we could not verify must never be reachable by a client, so the
    // failure path is a rollback, not a warning.
    await rollbackRemoteServer({ connection, layout, supervisor, previousReleaseId });
    throw cause;
  }

  // Staged artifacts are only removed once the new release is verified running,
  // so a mid-bootstrap crash leaves them for the next attempt to reuse.
  await connection.exec(["rm", "-rf", "--", layout.stagingDirectory]);

  return { releaseId, environmentId, credential, previousReleaseId };
}

/**
 * A pidfile names a number, not an identity.
 *
 * PIDs are recycled, and a stale pidfile from a machine that rebooted routinely
 * names a live process belonging to someone else. So the number is only the
 * first half: before signalling we confirm the process is actually OUR server,
 * by checking that its executable is the Node binary inside our install root.
 * `/proc/<pid>/exe` is the authoritative answer on Linux and cannot be forged by
 * the target process the way `ps` output (an argv the process controls) can.
 */
const PID_PATTERN = /^\d{1,10}$/;

function parseOwnedPid(contents: string): number | null {
  const trimmed = contents.trim();
  // `Number.parseInt` accepts "4242garbage"; a pidfile is exactly a number.
  if (!PID_PATTERN.test(trimmed)) return null;
  const pid = Number(trimmed);
  // 0 signals the whole process group and 1 is init: neither is ever ours.
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

/**
 * SIGTERM the pidfile's process, but only after proving it belongs to us.
 *
 * Returns silently when the pid is absent, unparseable, or owned by anything
 * other than this install — killing a stranger's process is far worse than
 * leaving a dead pidfile behind, and the supervisor stop above has already done
 * the orderly shutdown in every normal case.
 */
async function terminateOwnedProcess(
  connection: RemoteConnection,
  layout: RemoteInstallLayout,
): Promise<void> {
  const pidResult = await connection.exec(["cat", "--", layout.pidFile]);
  if (pidResult.exitCode !== 0) return;
  const pid = parseOwnedPid(pidResult.stdout);
  if (pid === null) return;

  // Resolve the executable behind the pid. A non-zero exit means the process is
  // gone or unreadable; either way we have not established ownership.
  const exe = await connection.exec(["readlink", "--", `/proc/${pid}/exe`]);
  if (exe.exitCode !== 0) return;
  const executablePath = exe.stdout.trim();
  // A deleted binary shows as "<path> (deleted)"; compare only the path.
  const resolved = executablePath.replace(/ \(deleted\)$/, "");
  if (!isPathInsideInstallRoot(layout, resolved)) return;

  await connection.exec(["kill", "-TERM", String(pid)]);
}

/**
 * Remove a remote install completely.
 *
 * Every command names the exact unit and the exact path. There is deliberately
 * no process-name matching: a `pkill -f synara` here would kill an unrelated
 * Synara that another user, or the same user, is running on the same host.
 *
 * MUST NOT BE CALLED FROM THE "REMOVE HOST" PATH IN THE UI.
 *
 * Removing a host is client-side only: it drops cached rows, resume cursors and
 * the socket, and touches nothing on the remote. The remove confirmation
 * promises the user exactly that — "Threads that ran on this host stay on the
 * host itself — they'll come back if you add it again." This function ends in
 * `rm -rf -- <installRoot>`, so wiring it to Remove would delete the data that
 * sentence guarantees is safe: approved copy becomes a lie and the user loses
 * work they were told they could get back. "Remove" reading like "uninstall" is
 * the plausible mistake, which is why the hazard is recorded here and not just
 * the rule.
 *
 * There is deliberately no uninstall affordance in the UI at all — a user who
 * wants the files gone ssh's in themselves. If that ever changes it needs its
 * own action, its own confirmation, and its own copy stating what is deleted.
 */
export async function uninstallRemoteServer(input: {
  readonly connection: RemoteConnection;
  readonly layout: RemoteInstallLayout;
  readonly supervisor: SupervisorPlan;
}): Promise<void> {
  const { connection, layout, supervisor } = input;
  // Re-assert the root before anything destructive runs. `isPathInsideInstallRoot`
  // cannot serve as this check — comparing the root to itself is structurally
  // `x === x` and can never fail — and the brand on RemoteInstallLayout only
  // constrains the type, so the value is re-validated here too.
  assertSafeInstallRoot(layout.root);
  for (const argv of supervisor.uninstallArgv) {
    // Uninstall is best-effort per step: a unit that was never installed must
    // not block deleting the files, or a half-bootstrapped host stays dirty
    // forever.
    await connection.exec(argv);
  }
  await terminateOwnedProcess(connection, layout);
  await expectRemoteSuccess(connection, ["rm", "-rf", "--", layout.root]);
}
