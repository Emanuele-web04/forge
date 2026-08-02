// FILE: remoteHost.ts
// Purpose: Schema-only contracts for SSH-reachable remote hosts: connection
//          configuration, launcher shapes, structured probe results, and the
//          per-host connectivity state machine's observable status.
// Layer: Shared contracts (schema only — all runtime logic lives in
//        @synara/shared/remoteCommand, remoteHostProbe, remoteHostConnectivity)

import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProcessEnvRecord,
  TrimmedNonEmptyString,
} from "./baseSchemas";

const SSH_DESTINATION_MAX_LENGTH = 512;
const SSH_ARG_MAX_LENGTH = 1_024;
const SSH_ARGS_MAX_ITEMS = 64;
const REMOTE_PATH_MAX_LENGTH = 4_096;
const REMOTE_SOURCE_FILES_MAX_ITEMS = 16;

export const RemoteHostId = TrimmedNonEmptyString.pipe(Schema.brand("RemoteHostId"));
export type RemoteHostId = typeof RemoteHostId.Type;

/**
 * Host-key verification policy.
 *
 * There is deliberately NO `off` / `insecure` / `no` member. The absence of that
 * option is the point: a Synara remote host can never be configured to skip
 * host-key verification, so an operator cannot trade away MITM protection for
 * convenience and then forget they did. `accept-new` still pins on first use and
 * still refuses a *changed* key, which is the weakest setting we will ever ship.
 */
export const SshHostKeyVerification = Schema.Literals(["strict", "accept-new"]);
export type SshHostKeyVerification = typeof SshHostKeyVerification.Type;

export const DEFAULT_SSH_HOST_KEY_VERIFICATION: SshHostKeyVerification = "strict";

/**
 * Remote shell initialisation.
 *
 * Deliberately NOT a raw shell string. Prior art accepted free-form `shellInit`
 * text and interpolated it into the remote command, which is an unbounded shell
 * injection seam stored in config. Here the two things users actually need —
 * sourcing an environment file (nvm, pyenv, cargo) and exporting variables — are
 * modelled as data, and every value crosses the wire through one audited quoting
 * function. There is no field whose contents are executed as code.
 */
export const RemoteShellInit = Schema.Struct({
  sourceFiles: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(REMOTE_PATH_MAX_LENGTH)))
    .check(Schema.isMaxLength(REMOTE_SOURCE_FILES_MAX_ITEMS))
    .pipe(Schema.withDecodingDefault(() => [])),
  env: ProcessEnvRecord.pipe(Schema.withDecodingDefault(() => ({}))),
});
export type RemoteShellInit = typeof RemoteShellInit.Type;

export const RemoteContainerRuntime = Schema.Literals(["docker", "podman"]);
export type RemoteContainerRuntime = typeof RemoteContainerRuntime.Type;

/**
 * How the remote project script is entered.
 *
 * Every launcher receives the SAME project script as ONE quoted argument, so the
 * script's meaning never changes with the launcher — only the process that
 * interprets it does.
 */
export const RemoteLauncher = Schema.Union([
  /** `sh -c <script>` — no rc files, fastest, the default. */
  Schema.Struct({ kind: Schema.Literal("direct") }),
  /** `<shell> -lc <script>` — pays rc-file cost to pick up a PATH set in a login profile. */
  Schema.Struct({
    kind: Schema.Literal("login-shell"),
    loginShell: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  }),
  /** `docker exec -i <container> sh -c <script>`. */
  Schema.Struct({
    kind: Schema.Literal("container"),
    runtime: RemoteContainerRuntime,
    container: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    execArgs: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(SSH_ARG_MAX_LENGTH)))
      .check(Schema.isMaxLength(SSH_ARGS_MAX_ITEMS))
      .pipe(Schema.withDecodingDefault(() => [])),
  }),
  /** `<command> <args...> <script>` — the script stays a single argument. */
  Schema.Struct({
    kind: Schema.Literal("custom-wrapper"),
    command: TrimmedNonEmptyString.check(Schema.isMaxLength(REMOTE_PATH_MAX_LENGTH)),
    args: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(SSH_ARG_MAX_LENGTH)))
      .check(Schema.isMaxLength(SSH_ARGS_MAX_ITEMS))
      .pipe(Schema.withDecodingDefault(() => [])),
  }),
]);
export type RemoteLauncher = typeof RemoteLauncher.Type;

export const DEFAULT_REMOTE_LAUNCHER: RemoteLauncher = { kind: "direct" };

/**
 * Connection multiplexing. Synara owns connection reuse rather than delegating it
 * to the user's `~/.ssh/config`: the default must be the fast path (one handshake
 * per host) instead of one full SSH handshake per thread.
 */
export const SshConnectionReuse = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  /** How long the master connection outlives its last client. */
  persistSeconds: PositiveInt.check(Schema.isLessThanOrEqualTo(3_600)).pipe(
    Schema.withDecodingDefault(() => 300),
  ),
});
export type SshConnectionReuse = typeof SshConnectionReuse.Type;

export const DEFAULT_SSH_CONNECTION_REUSE: SshConnectionReuse = {
  enabled: true,
  persistSeconds: 300,
};

/**
 * Keepalives are not optional comfort: without them a dead TCP connection (laptop
 * lid, NAT rebind, dropped VPN) leaves a read blocked forever, and a hung turn is
 * indistinguishable from a slow one. With them, the failure surfaces as an error
 * the connectivity state machine can act on.
 */
export const SshKeepalive = Schema.Struct({
  intervalSeconds: PositiveInt.check(Schema.isLessThanOrEqualTo(300)).pipe(
    Schema.withDecodingDefault(() => 15),
  ),
  countMax: PositiveInt.check(Schema.isLessThanOrEqualTo(10)).pipe(
    Schema.withDecodingDefault(() => 3),
  ),
});
export type SshKeepalive = typeof SshKeepalive.Type;

export const DEFAULT_SSH_KEEPALIVE: SshKeepalive = { intervalSeconds: 15, countMax: 3 };

/**
 * An SSH host.
 *
 * `destination` is any `ssh(1)` destination — including a bare `~/.ssh/config`
 * Host alias — so the user's own port, identity, ProxyJump and ProxyCommand apply
 * exactly as they do in their terminal. We do not re-model those fields; we
 * deliberately let ssh's own config resolution own them.
 */
export const RemoteHostConfig = Schema.Struct({
  hostId: RemoteHostId,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  destination: TrimmedNonEmptyString.check(Schema.isMaxLength(SSH_DESTINATION_MAX_LENGTH)),
  /** Path to the local `ssh` client; defaults to `ssh` from PATH. */
  sshBinary: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(REMOTE_PATH_MAX_LENGTH)),
  ),
  /**
   * Extra `ssh` arguments, placed BEFORE our defaults so ssh's first-value-wins
   * rule lets a user genuinely override an option we set. The decider in
   * `@synara/shared/remoteCommand` accepts only an explicit allowlist of flags
   * and `-o` options, so an argument nobody modelled is refused rather than
   * passed through — the ordering is a usability affordance, not an escape
   * hatch. The escape hatch is a `~/.ssh/config` Host alias used as the
   * `destination`.
   */
  sshArgs: Schema.Array(Schema.String.check(Schema.isMaxLength(SSH_ARG_MAX_LENGTH)))
    .check(Schema.isMaxLength(SSH_ARGS_MAX_ITEMS))
    .pipe(Schema.withDecodingDefault(() => [])),
  hostKeyVerification: SshHostKeyVerification.pipe(
    Schema.withDecodingDefault(() => DEFAULT_SSH_HOST_KEY_VERIFICATION),
  ),
  connectTimeoutSeconds: PositiveInt.check(Schema.isLessThanOrEqualTo(120)).pipe(
    Schema.withDecodingDefault(() => 10),
  ),
  keepalive: SshKeepalive.pipe(Schema.withDecodingDefault(() => DEFAULT_SSH_KEEPALIVE)),
  connectionReuse: SshConnectionReuse.pipe(
    Schema.withDecodingDefault(() => DEFAULT_SSH_CONNECTION_REUSE),
  ),
  shellInit: Schema.optional(RemoteShellInit),
  launcher: RemoteLauncher.pipe(Schema.withDecodingDefault(() => DEFAULT_REMOTE_LAUNCHER)),
  /** Default remote binary when a session does not name one. */
  binaryPath: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(REMOTE_PATH_MAX_LENGTH)),
  ),
});
export type RemoteHostConfig = typeof RemoteHostConfig.Type;

/** What a session wants to run on the host. */
export const RemoteCommandTarget = Schema.Struct({
  cwd: TrimmedNonEmptyString.check(Schema.isMaxLength(REMOTE_PATH_MAX_LENGTH)),
  binary: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(REMOTE_PATH_MAX_LENGTH))),
  args: Schema.Array(Schema.String.check(Schema.isMaxLength(SSH_ARG_MAX_LENGTH)))
    .check(Schema.isMaxLength(256))
    .pipe(Schema.withDecodingDefault(() => [])),
  /** Arguments substituted for the turn when probing (typically `--version`). */
  versionArgs: Schema.Array(Schema.String.check(Schema.isMaxLength(SSH_ARG_MAX_LENGTH)))
    .check(Schema.isMaxLength(16))
    .pipe(Schema.withDecodingDefault(() => ["--version"])),
});
export type RemoteCommandTarget = typeof RemoteCommandTarget.Type;

/**
 * Probe outcome classes. `missing-path` is listed before `missing-binary` because
 * classification must check them in that order: `cd` runs first and both failures
 * say "no such file or directory".
 */
export const RemoteHostProbeOutcome = Schema.Literals([
  "ok",
  "unreachable",
  "missing-path",
  "missing-binary",
  "noisy-shell",
  "command-failed",
  "launcher-rejected",
]);
export type RemoteHostProbeOutcome = typeof RemoteHostProbeOutcome.Type;

/**
 * Why a host was unreachable — each maps to a different user action.
 *
 * The two host-key reasons are split because they are OPPOSITE situations that
 * happen to share ssh's "Host key verification failed" epilogue:
 *
 * - `host-key-unknown` is routine first contact. Nothing is wrong; the user has
 *   simply never connected to this host before. Offering to trust the key after
 *   showing its fingerprint is the correct affordance.
 * - `host-key-changed` is the on-the-wire signature of a machine-in-the-middle
 *   attack (and, more often but indistinguishably, a rebuilt server). There is
 *   NO trust affordance for it — ever. A single "trust this host key" button
 *   that serves both cases trains the user to click through the one case where
 *   clicking through is how they get owned.
 */
export const RemoteHostUnreachableReason = Schema.Literals([
  "auth",
  "host-key-unknown",
  "host-key-changed",
  "dns",
  "refused",
  "network",
  "timeout",
  "ssh-missing",
  "unknown",
]);
export type RemoteHostUnreachableReason = typeof RemoteHostUnreachableReason.Type;

export const RemoteHostProbeResult = Schema.Struct({
  outcome: RemoteHostProbeOutcome,
  /**
   * Hash of the exact rendered command the probe ran. A result is only ever
   * reused for an identical signature, so editing any field that changes the
   * command discards a stale "ready" instead of vouching for a command that will
   * never run.
   */
  signature: TrimmedNonEmptyString,
  checkedAt: IsoDateTime,
  /** Actionable, human-readable summary. Never contains key material. */
  message: TrimmedNonEmptyString,
  unreachableReason: Schema.optional(RemoteHostUnreachableReason),
  /** Version line the remote binary printed, when the probe succeeded. */
  version: Schema.optional(Schema.String),
  /** Stdout the remote shell printed before our marker — this corrupts the stream. */
  noisyOutput: Schema.optional(Schema.String),
  /** A launcher that succeeded on retry when the configured one did not. */
  suggestedLauncher: Schema.optional(RemoteLauncher),
  /** Trimmed remote stderr, for display. */
  detail: Schema.optional(Schema.String),
});
export type RemoteHostProbeResult = typeof RemoteHostProbeResult.Type;

/**
 * Per-host connectivity. `degraded` exists so a single blip does not present as
 * an outage, and `reconnecting` so a user can tell "we are working on it" from
 * "this is not coming back without you".
 */
export const RemoteHostConnectivityState = Schema.Literals([
  "connected",
  "degraded",
  "reconnecting",
  "down",
]);
export type RemoteHostConnectivityState = typeof RemoteHostConnectivityState.Type;

export const RemoteHostConnectivityStatus = Schema.Struct({
  hostId: RemoteHostId,
  state: RemoteHostConnectivityState,
  consecutiveFailures: NonNegativeInt,
  /** When the host entered its current state. */
  since: IsoDateTime,
  /** Epoch millis of the next scheduled reconnect attempt, when backing off. */
  nextAttemptAtMs: Schema.optional(NonNegativeInt),
  lastError: Schema.optional(Schema.String),
  lastProbeOutcome: Schema.optional(RemoteHostProbeOutcome),
});
export type RemoteHostConnectivityStatus = typeof RemoteHostConnectivityStatus.Type;

/**
 * A host's public-key fingerprint, for the user to compare against the machine
 * they own before trusting it. Public key material only — never a private key.
 */
export const RemoteHostKeyFingerprint = Schema.Struct({
  /** ssh's wire name, e.g. `ssh-ed25519`. */
  keyType: TrimmedNonEmptyString,
  /** Short name for display, e.g. `ed25519`. */
  displayType: TrimmedNonEmptyString,
  /** `SHA256:…`, byte-identical to `ssh-keygen -lf`. */
  fingerprint: TrimmedNonEmptyString,
});
export type RemoteHostKeyFingerprint = typeof RemoteHostKeyFingerprint.Type;

export const RemoteHostFingerprintInput = Schema.Struct({ host: RemoteHostConfig });
export type RemoteHostFingerprintInput = typeof RemoteHostFingerprintInput.Type;

export const RemoteHostFingerprintResult = Schema.Struct({
  /** Resolved hostname ssh would actually dial; shown so an alias is unambiguous. */
  hostname: TrimmedNonEmptyString,
  port: PositiveInt,
  /** Empty when the host offered nothing we could parse — never a placeholder. */
  fingerprints: Schema.Array(RemoteHostKeyFingerprint),
  /** Set when the scan failed; the UI shows this instead of a fingerprint. */
  error: Schema.optional(Schema.String),
});
export type RemoteHostFingerprintResult = typeof RemoteHostFingerprintResult.Type;

/** Probe RPC. Rate-limited server-side; see `remoteHostBroker.ts`. */
export const RemoteHostProbeInput = Schema.Struct({
  host: RemoteHostConfig,
  target: RemoteCommandTarget,
});
export type RemoteHostProbeInput = typeof RemoteHostProbeInput.Type;

export const RemoteHostProbeRpcResult = Schema.Struct({
  probe: RemoteHostProbeResult,
  connectivity: RemoteHostConnectivityStatus,
});
export type RemoteHostProbeRpcResult = typeof RemoteHostProbeRpcResult.Type;
