// FILE: remoteCommand.ts
// Purpose: The single audited construction path for every command Synara runs on
//          a remote host over ssh(1). Argv-style throughout; exactly one quoting
//          function; every rejection decided here rather than in a UI.
// Layer: Shared runtime (server + tests)
// Exports: posixShellQuote, buildRemoteScript, buildLauncherArgv, buildSshArgv,
//          validateRemoteHostConfig, remoteCommandSignature, sshControlPathFor

import * as Crypto from "node:crypto";

import type {
  RemoteCommandTarget,
  RemoteHostConfig,
  RemoteLauncher,
  RemoteShellInit,
} from "@synara/contracts";

// ── Quoting ──────────────────────────────────────────────────────────────────

/**
 * The ONE quoting function. Every string that reaches a remote shell — a path, an
 * argument, an environment value, the whole project script as it is handed to a
 * launcher — passes through here and nothing else.
 *
 * POSIX single quotes are the only quoting form with no escape processing at all:
 * inside `'...'` every byte is literal, including backslashes, newlines, `$`,
 * backticks and UTF-8 sequences. The only character that cannot appear is `'`
 * itself, which we close, escape, and reopen around.
 *
 * The empty string must still produce a word (`''`), otherwise it would vanish
 * from the command line and shift every argument after it.
 */
export function posixShellQuote(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Joins an argv into one shell-safe command line. Used for ssh's remote command. */
export function posixShellJoin(argv: readonly string[]): string {
  return argv.map(posixShellQuote).join(" ");
}

// ── Rejections ───────────────────────────────────────────────────────────────

export class RemoteHostConfigError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "RemoteHostConfigError";
    this.field = field;
  }
}

/**
 * Wrappers that detach the process they launch. If a session command is wrapped
 * in one of these, ssh's stdout closes while the agent keeps running unattached:
 * the turn never produces output and never ends — it hangs, and no timeout can
 * tell it apart from a slow model.
 *
 * Refused HERE, at the decider, not in the UI: a config that would hang must be
 * impossible to persist, so it cannot be written by an older client, restored
 * from a backup, or hand-edited into the state file and then reappear.
 */
export const DETACHING_LAUNCHER_COMMANDS: ReadonlySet<string> = new Set([
  "abduco",
  "at",
  "batch",
  "byobu",
  "daemonize",
  "dtach",
  "nohup",
  "screen",
  "setsid",
  "start-stop-daemon",
  "systemd-run",
  "tmux",
  "zellij",
]);

/** Flags that ask a wrapper to detach even when the wrapper itself is benign. */
export const DETACHING_LAUNCHER_FLAGS: ReadonlySet<string> = new Set([
  "-d",
  "-D",
  "--detach",
  "--detach-keys",
  "--daemon",
  "--background",
  "--fork",
  "-bg",
]);

/**
 * `sshArgs` is an ALLOWLIST, not a denylist.
 *
 * The arguments are placed before our defaults so ssh's first-value-wins rule
 * lets a user genuinely override a timeout or a cipher. That ordering is what
 * makes the surface dangerous, and a denylist of option names cannot hold it:
 * ssh spells the same capability several ways (`-S` is `ControlPath`, `-t` is
 * `RequestTTY`, and `-F` replaces the config file wholesale — and with it every
 * option name a denylist could ever enumerate), so any spelling nobody thought
 * of sails through. An allowlist inverts that: an unmodelled spelling is simply
 * not on the list, so it fails closed.
 *
 * The parser refuses any token that is neither a known flag nor a known flag's
 * value. That single rule covers three separate attacks at once: positional
 * injection (a bare `attacker.example.com` here becomes THE destination, since
 * these args go first, demoting the real host to the first word of the remote
 * command), bundled short flags (`-Nf`, `-vtt`), and attached values (`-F/x`,
 * `-S/x`) — all three are simply "a token I cannot parse".
 *
 * The escape hatch for anything not listed here is the user's own
 * `~/.ssh/config`. `destination` accepts a Host alias, and ssh applies that
 * host's ProxyCommand, ProxyJump, identities and forwards exactly as it does in
 * a terminal. That file is the user's own trusted territory; `sshArgs` is a
 * value persisted in Synara's state and writable by any route that can reach the
 * state file, which is why it gets the narrower grammar.
 */

/**
 * `-o Key=value` names a user may set. Every entry either tunes the transport or
 * selects credentials. None can execute a local command (ProxyCommand,
 * LocalCommand, PermitLocalCommand, KnownHostsCommand), relocate the config,
 * known-hosts or control state ssh reads and writes (Include, UserKnownHostsFile,
 * ControlPath), or switch off a guarantee the rest of this module depends on
 * (StrictHostKeyChecking, BatchMode, RequestTTY, our multiplexing).
 *
 * Compared lower-cased: ssh option names are case-insensitive.
 */
export const ALLOWED_SSH_OPTIONS: ReadonlySet<string> = new Set([
  // Transport tuning.
  "addressfamily",
  "compression",
  "connectionattempts",
  "connecttimeout",
  "ipqos",
  "port",
  "serveralivecountmax",
  "serveraliveinterval",
  "tcpkeepalive",
  // Algorithm selection: a host that only speaks older or newer crypto than our
  // client's default is a real reason to reach for sshArgs.
  "ciphers",
  "hostkeyalgorithms",
  "kexalgorithms",
  "macs",
  "pubkeyacceptedalgorithms",
  // Credentials and routing. ProxyJump is listed because ssh resolves it itself,
  // by opening an inner ssh connection — unlike ProxyCommand, which hands a
  // string to a local shell and therefore can never be listed.
  "identitiesonly",
  "identityfile",
  "preferredauthentications",
  "proxyjump",
  "pubkeyauthentication",
  "user",
  // Environment, handed to the remote side only.
  "sendenv",
  "setenv",
]);

/** Short flags taking a value, either as the next argv element or attached. */
export const ALLOWED_SSH_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-b", // bind address
  "-c", // cipher spec
  "-i", // identity file
  "-J", // jump host, i.e. ProxyJump
  "-l", // login user
  "-m", // MAC spec
  "-o", // option, gated by ALLOWED_SSH_OPTIONS
  "-p", // port
]);

/** Short flags taking no value. Each one only ever restricts what ssh does. */
export const ALLOWED_SSH_BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "-4", // force IPv4
  "-6", // force IPv6
  "-C", // compression
  "-a", // disable agent forwarding
  "-x", // disable X11 forwarding
]);

const SSH_ARGS_ESCAPE_HATCH =
  "Anything else belongs in your own ~/.ssh/config: put the settings under a Host alias and use that alias as the destination.";

function sortedList(values: Iterable<string>): string {
  return [...values].sort().join(", ");
}

function refuseSshArg(reason: string): never {
  throw new RemoteHostConfigError(
    "sshArgs",
    `${reason} Allowed ssh flags are ${sortedList([
      ...ALLOWED_SSH_BOOLEAN_FLAGS,
      ...ALLOWED_SSH_VALUE_FLAGS,
    ])}. ${SSH_ARGS_ESCAPE_HATCH}`,
  );
}

/** Lower-cased option name from a `-o` value, which is `Key=value` or `Key value`. */
function parseSshOptionKey(raw: string): string {
  const trimmed = raw.trimStart();
  const separator = trimmed.search(/[=\s]/);
  return (separator === -1 ? trimmed : trimmed.slice(0, separator)).toLowerCase();
}

function assertNoLeadingDash(field: string, value: string, what: string): void {
  if (value.startsWith("-")) {
    throw new RemoteHostConfigError(field, `${what} may not start with "-".`);
  }
}

/**
 * Validates every user-supplied ssh argument against the allowlist above.
 * Returns the arguments unchanged so callers cannot accidentally use the
 * unvalidated list.
 */
export function validateSshArgs(args: readonly string[]): readonly string[] {
  // Every element, flag or value alike, before any of them is interpreted.
  for (const token of args) {
    if (token.includes("\u0000")) {
      throw new RemoteHostConfigError("sshArgs", "ssh arguments may not contain NUL bytes.");
    }
  }

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (ALLOWED_SSH_BOOLEAN_FLAGS.has(token)) continue;

    // A value flag is either its own argv element (`-p 2222`) or carries the
    // value attached (`-p2222`). Only these two shapes are recognised, so a
    // bundle like `-vtt` and an unlisted flag like `-F` fall through to the
    // refusal below rather than being read as a listed flag plus a value.
    let flag: string | undefined;
    let value: string | undefined;
    if (ALLOWED_SSH_VALUE_FLAGS.has(token)) {
      flag = token;
      value = args[index + 1];
      if (value === undefined) refuseSshArg(`The ssh flag "${token}" needs a value.`);
      // Consumed here as data: to ssh it is a value too, never a flag of its own.
      index += 1;
    } else {
      for (const candidate of ALLOWED_SSH_VALUE_FLAGS) {
        if (token.length > candidate.length && token.startsWith(candidate)) {
          flag = candidate;
          value = token.slice(candidate.length);
          break;
        }
      }
    }
    if (flag === undefined || value === undefined) {
      refuseSshArg(`The ssh argument "${token}" is not allowed.`);
    }

    // No port, path, user, cipher spec or jump host legitimately begins with a
    // dash, so a dashed value is either a mistake or a flag smuggled in behind
    // the one it hides under.
    if (value.startsWith("-")) {
      refuseSshArg(`The value for "${flag}" may not start with "-".`);
    }
    if (flag === "-o") {
      const key = parseSshOptionKey(value);
      if (!ALLOWED_SSH_OPTIONS.has(key)) {
        throw new RemoteHostConfigError(
          "sshArgs",
          `The ssh option "${key}" is not allowed. Synara accepts only ${sortedList(ALLOWED_SSH_OPTIONS)}. ${SSH_ARGS_ESCAPE_HATCH}`,
        );
      }
    }
  }
  return args;
}

function validateLauncherCommand(field: string, command: string, args: readonly string[]): void {
  assertNoLeadingDash(field, command, "A launcher command");
  const basename = command.split(/[/\\]/).pop() ?? command;
  if (DETACHING_LAUNCHER_COMMANDS.has(basename.toLowerCase())) {
    throw new RemoteHostConfigError(
      field,
      `"${basename}" detaches the process it starts, so the session would produce no output and never finish. Run the agent in the foreground instead.`,
    );
  }
  for (const arg of args) {
    if (DETACHING_LAUNCHER_FLAGS.has(arg)) {
      throw new RemoteHostConfigError(
        field,
        `The launcher flag "${arg}" detaches the process, which would hang the session.`,
      );
    }
  }
}

export function validateLauncher(launcher: RemoteLauncher): RemoteLauncher {
  switch (launcher.kind) {
    case "direct":
      break;
    case "login-shell":
      if (launcher.loginShell !== undefined) {
        assertNoLeadingDash("launcher.loginShell", launcher.loginShell, "A login shell");
      }
      break;
    case "container":
      assertNoLeadingDash("launcher.container", launcher.container, "A container name");
      // `-d`/`--detach` detaches exactly like tmux; `-t` allocates a pty that
      // corrupts the protocol stream.
      validateLauncherCommand("launcher.execArgs", launcher.runtime, launcher.execArgs);
      for (const arg of launcher.execArgs) {
        if (arg === "-t" || arg === "--tty" || arg === "-dt" || arg === "-td") {
          throw new RemoteHostConfigError(
            "launcher.execArgs",
            `"${arg}" allocates a terminal, which corrupts the session stream.`,
          );
        }
      }
      break;
    case "custom-wrapper":
      validateLauncherCommand("launcher.command", launcher.command, launcher.args);
      break;
  }
  return launcher;
}

/**
 * Full config gate. Called both when a host is persisted and again when a command
 * is built, so a config that slipped in by any other route still cannot run.
 */
export function validateRemoteHostConfig(config: RemoteHostConfig): RemoteHostConfig {
  // buildSshArgv also passes `--`, but a dashed destination is refused here too:
  // this is the gate a persisted config passes through, and it should never hold
  // a value whose safety depends on one caller remembering a separator.
  assertNoLeadingDash("destination", config.destination, "An ssh destination");
  if (/\s/.test(config.destination) || config.destination.includes("\u0000")) {
    throw new RemoteHostConfigError(
      "destination",
      "An ssh destination may not contain whitespace or NUL bytes.",
    );
  }
  if (config.sshBinary !== undefined) {
    assertNoLeadingDash("sshBinary", config.sshBinary, "An ssh binary path");
  }
  if (config.binaryPath !== undefined) {
    assertNoLeadingDash("binaryPath", config.binaryPath, "A remote binary path");
  }
  validateSshArgs(config.sshArgs);
  validateLauncher(config.launcher);
  return config;
}

// ── Remote script ────────────────────────────────────────────────────────────

export interface RemoteScriptProbeMarkers {
  /** Printed on stdout immediately before exec; stdout before it is shell noise. */
  readonly begin: string;
  readonly cwdMissing: string;
  readonly binaryMissing: string;
}

export const PROBE_EXIT_CWD_MISSING = 91;
export const PROBE_EXIT_BINARY_MISSING = 92;

export interface BuildRemoteScriptInput {
  readonly target: RemoteCommandTarget;
  readonly shellInit?: RemoteShellInit | undefined;
  readonly defaultBinary?: string | undefined;
  /**
   * When present the script becomes the probe: the SAME cd, the SAME shell-init,
   * the SAME binary, with the turn's arguments replaced by the version check and
   * classification markers added. A probe that passed therefore cannot have
   * passed for a different command than the one that will run.
   */
  readonly probe?: RemoteScriptProbeMarkers | undefined;
}

export function resolveRemoteBinary(input: BuildRemoteScriptInput): string {
  const binary = input.target.binary ?? input.defaultBinary;
  if (binary === undefined || binary.length === 0) {
    throw new RemoteHostConfigError("binary", "No remote binary is configured for this host.");
  }
  assertNoLeadingDash("binary", binary, "A remote binary path");
  return binary;
}

export function buildRemoteScript(input: BuildRemoteScriptInput): string {
  const binary = resolveRemoteBinary(input);
  const lines: string[] = [];

  for (const [name, value] of Object.entries(input.shellInit?.env ?? {})) {
    // Names are constrained by ProcessEnvRecord's schema pattern; values are data
    // and go through the quoting function like everything else.
    lines.push(`export ${name}=${posixShellQuote(value)}`);
  }
  for (const file of input.shellInit?.sourceFiles ?? []) {
    const quoted = posixShellQuote(file);
    // A missing init file is normal (a host without nvm), so it must not abort the
    // session; a readable file that fails is the user's own script erroring.
    lines.push(`if [ -r ${quoted} ]; then . ${quoted}; fi`);
  }

  const cwd = posixShellQuote(input.target.cwd);
  const quotedBinary = posixShellQuote(binary);

  if (input.probe) {
    lines.push(
      `cd -- ${cwd} 2>/dev/null || { printf '%s\\n' ${posixShellQuote(input.probe.cwdMissing)} >&2; exit ${PROBE_EXIT_CWD_MISSING}; }`,
    );
    lines.push(
      `command -v ${quotedBinary} >/dev/null 2>&1 || { printf '%s\\n' ${posixShellQuote(input.probe.binaryMissing)} >&2; exit ${PROBE_EXIT_BINARY_MISSING}; }`,
    );
    lines.push(`printf '%s\\n' ${posixShellQuote(input.probe.begin)}`);
    lines.push(`exec ${quotedBinary} ${posixShellJoin(input.target.versionArgs)}`.trimEnd());
    return lines.join("\n");
  }

  // The session `cd` is guarded exactly like the probe's. An unguarded `cd` that
  // fails leaves the shell in the ssh login home and execs the agent there: a
  // coding agent with write access, pointed at the wrong directory, reporting
  // success. The probe classifying a missing cwd is not enough — the directory
  // can disappear between the probe and the turn.
  lines.push(`cd -- ${cwd} || exit ${PROBE_EXIT_CWD_MISSING}`);
  lines.push(`exec ${quotedBinary} ${posixShellJoin(input.target.args)}`.trimEnd());
  return lines.join("\n");
}

// ── Launcher ─────────────────────────────────────────────────────────────────

/**
 * Every launcher receives the project script as ONE argument. The script is never
 * re-split, re-quoted or concatenated per launcher, so switching launcher changes
 * only which process interprets the script — never what the script means.
 */
export function buildLauncherArgv(launcher: RemoteLauncher, script: string): readonly string[] {
  validateLauncher(launcher);
  switch (launcher.kind) {
    case "direct":
      return ["/bin/sh", "-c", script];
    case "login-shell":
      return [launcher.loginShell ?? "/bin/sh", "-lc", script];
    case "container":
      return [
        launcher.runtime,
        "exec",
        "-i",
        ...launcher.execArgs,
        launcher.container,
        "/bin/sh",
        "-c",
        script,
      ];
    case "custom-wrapper":
      return [launcher.command, ...launcher.args, script];
  }
}

// ── ssh argv ─────────────────────────────────────────────────────────────────

export interface BuildSshArgvInput {
  readonly config: RemoteHostConfig;
  readonly remoteArgv: readonly string[];
  /**
   * Absolute directory for multiplexing sockets. Must be created 0700 by the
   * caller: a control socket in a directory another local user can write lets
   * that user ride our authenticated connection.
   */
  readonly controlDirectory?: string | undefined;
  /** Deadline for the whole ssh invocation, used by the probe. */
  readonly connectTimeoutSecondsOverride?: number | undefined;
}

export interface SshInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * A control socket path is derived, never taken from config: it must be stable
 * per host, unpredictable to other local users, and short enough for the ~104
 * byte sockaddr_un limit that `%h/%p/%r` templates routinely blow past.
 */
export function sshControlPathFor(controlDirectory: string, config: RemoteHostConfig): string {
  const digest = Crypto.createHash("sha256")
    .update(`${config.hostId} ${config.destination}`)
    .digest("hex")
    .slice(0, 16);
  return `${controlDirectory.replace(/\/+$/, "")}/s-${digest}`;
}

export function buildSshArgv(input: BuildSshArgvInput): SshInvocation {
  const config = validateRemoteHostConfig(input.config);
  const connectTimeout = input.connectTimeoutSecondsOverride ?? config.connectTimeoutSeconds;

  const args: string[] = [
    // USER ARGS FIRST. ssh takes the first value it sees for an option, so this
    // position is what makes an override real. Everything that must not be
    // overridable was already refused by validateSshArgs.
    ...validateSshArgs(config.sshArgs),
    // No prompts: stdin carries the protocol, so a password or passphrase prompt
    // would block forever. BatchMode turns that hang into an immediate error.
    "-o",
    "BatchMode=yes",
    "-o",
    `StrictHostKeyChecking=${config.hostKeyVerification === "strict" ? "yes" : "accept-new"}`,
    "-o",
    `ConnectTimeout=${connectTimeout}`,
    // Without keepalives a dead TCP connection never returns: the read just never
    // completes. These turn an invisible hang into a reported failure.
    "-o",
    `ServerAliveInterval=${config.keepalive.intervalSeconds}`,
    "-o",
    `ServerAliveCountMax=${config.keepalive.countMax}`,
    "-o",
    "RequestTTY=no",
    "-o",
    "ExitOnForwardFailure=yes",
  ];

  if (config.connectionReuse.enabled && input.controlDirectory !== undefined) {
    // Connection reuse is ours, not the user's ssh config: N concurrent sessions
    // to one host share one handshake by default instead of paying a full SSH
    // handshake (TCP + KEX + auth, often > 1s over WAN) per thread.
    args.push(
      "-o",
      "ControlMaster=auto",
      "-o",
      `ControlPath=${sshControlPathFor(input.controlDirectory, config)}`,
      "-o",
      `ControlPersist=${config.connectionReuse.persistSeconds}`,
    );
  }

  // `--` ends ssh's own option parsing, so the destination is positional even if
  // a dashed value ever reached here. validateRemoteHostConfig already refuses a
  // dashed destination; this is the second, independent guarantee.
  args.push("--", config.destination, ...input.remoteArgv.map(posixShellQuote));

  return { command: config.sshBinary ?? "ssh", args };
}

// ── Signature ────────────────────────────────────────────────────────────────

/**
 * Identity of a rendered command. A probe result is only ever reused for an
 * identical signature, so editing a field that changes the command — the
 * destination, an ssh arg, the launcher, the cwd, the binary, shell-init —
 * discards a stale "ready" instead of vouching for a command that will never run.
 */
export function remoteCommandSignature(invocation: SshInvocation): string {
  const payload = [invocation.command, ...invocation.args].join(" ");
  return Crypto.createHash("sha256").update(payload).digest("hex");
}
