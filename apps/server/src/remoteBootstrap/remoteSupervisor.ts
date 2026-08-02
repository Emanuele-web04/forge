// FILE: remoteSupervisor.ts
// Purpose: Render and drive the OS supervisor that keeps a bootstrapped Synara
//          alive across reboots — systemd user units with linger on Linux, and
//          the launchd shape behind a capability flag on macOS.
// Layer: Server / remote broker
// Exports: SupervisorKind, SupervisorPlan, supervisorCapability,
//          remoteSupervisorPlan, renderSystemdUnit, renderLaunchdPlist,
//          systemdUnitName, launchdLabel
//
// Two rules run through every command built here:
//  1. argv only. Nothing is concatenated into a shell string; where a unit file
//     needs a command line, each token goes through `quotePosixShellArgument`.
//  2. Stop/uninstall names the EXACT unit and the EXACT install path. There is
//     no `pkill -f synara` anywhere in this file, and there must never be: the
//     remote host may legitimately run another Synara that we do not own.

import { quotePosixShellArgument } from "@synara/shared/posixShell";

import type { RemoteInstallLayout } from "./remoteInstallLayout";
import { containsControlCharacter, normalizeReleaseId } from "./remoteInputs";

export type SupervisorKind = "systemd-user" | "launchd-user";

export interface SupervisorCapability {
  readonly kind: SupervisorKind;
  /** False means the plan is renderable but not yet wired end to end. */
  readonly supported: boolean;
  readonly reason?: string;
}

/**
 * macOS/launchd is rendered and unit-tested, but the install flow is not yet
 * exercised end to end, so it is gated rather than silently half-working.
 */
export function supervisorCapability(os: "linux" | "darwin"): SupervisorCapability {
  return os === "linux"
    ? { kind: "systemd-user", supported: true }
    : {
        kind: "launchd-user",
        supported: false,
        reason:
          "launchd bootstrap is not enabled yet; use a Linux host or run the remote server manually.",
      };
}

export interface SupervisorPlan {
  readonly kind: SupervisorKind;
  /** Absolute remote path the unit/plist is written to. */
  readonly unitPath: string;
  readonly unitContents: string;
  /** Name used by every start/stop/status command; never a pattern. */
  readonly unitName: string;
  readonly installArgv: ReadonlyArray<ReadonlyArray<string>>;
  readonly startArgv: ReadonlyArray<ReadonlyArray<string>>;
  /** Stops the service without removing it — the drain step of an upgrade. */
  readonly stopArgv: ReadonlyArray<ReadonlyArray<string>>;
  /** Removes unit + service registration. Path- and name-scoped only. */
  readonly uninstallArgv: ReadonlyArray<ReadonlyArray<string>>;
  readonly statusArgv: ReadonlyArray<string>;
}

export interface SupervisorInput {
  readonly os: "linux" | "darwin";
  readonly layout: RemoteInstallLayout;
  readonly releaseId: string;
  /** Absolute remote path of the pinned Node binary. */
  readonly nodePath: string;
  /** Absolute remote path of the server entrypoint inside the release. */
  readonly entrypointPath: string;
  /** Loopback port the remote server listens on; the tunnel's far end. */
  readonly port: number;
  /** Unique per install so two Synaras on one host cannot collide. */
  readonly instanceId: string;
  /**
   * The remote user's resolved home directory and numeric uid.
   *
   * These are probed once over the connection and passed in as concrete values
   * rather than written into commands as `$HOME` / `$(id -u)`. A command with a
   * substitution in it is a command that only works when a shell interprets it,
   * which is exactly the seam this design refuses to have.
   */
  readonly homeDirectory: string;
  readonly userId: number;
}

const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

function normalizeInstanceId(instanceId: string): string {
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new Error(`Invalid remote instance id: ${JSON.stringify(instanceId)}`);
  }
  return instanceId;
}

function assertLoopbackPort(port: number): number {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Remote server port must be an unprivileged integer port, got ${port}`);
  }
  return port;
}

export function systemdUnitName(instanceId: string): string {
  return `synara-${normalizeInstanceId(instanceId)}.service`;
}

export function launchdLabel(instanceId: string): string {
  return `dev.synara.remote.${normalizeInstanceId(instanceId)}`;
}

/**
 * The argv the supervisor launches. Built once and shared by both renderers so
 * systemd and launchd can never drift into launching different things.
 */
function serverArgv(input: SupervisorInput): ReadonlyArray<string> {
  return [
    input.nodePath,
    input.entrypointPath,
    // The remote server binds loopback only: the browser reaches it through the
    // broker's forwarded port, never directly. This is also what keeps the
    // deployment "local-only" by the Phase 1 policy while still requiring the
    // provisioned credential below.
    "--host",
    "127.0.0.1",
    "--port",
    String(assertLoopbackPort(input.port)),
  ];
}

/**
 * systemd escapes `%` as a specifier; a literal one in a value must be `%%`.
 * Applied to every interpolated value, not just the ones we expect to be
 * risky, so a future field cannot forget it.
 */
function escapeSystemdValue(value: string): string {
  if (containsControlCharacter(value)) {
    throw new Error("systemd unit values must not contain control characters");
  }
  return value.replaceAll("%", "%%");
}

/**
 * Render one `Environment=` assignment.
 *
 * systemd splits an unquoted Environment= directive on whitespace, so a value
 * containing a space silently becomes a TRUNCATED variable plus a second
 * assignment — an install root like `/home/deploy/My Synara/remote` would hand
 * the server a credential path of `/home/deploy/My`. Quoting the value keeps it
 * one token; PIDFile and WorkingDirectory have the same hazard.
 */
function systemdEnvironmentAssignment(name: string, value: string): string {
  return `${name}=${escapeSystemdValue(quotePosixShellArgument(value))}`;
}

export function renderSystemdUnit(input: SupervisorInput): string {
  const releaseId = normalizeReleaseId(input.releaseId);
  const argv = serverArgv(input);
  const execStart = argv
    .map((token) => escapeSystemdValue(quotePosixShellArgument(token)))
    .join(" ");
  return [
    "[Unit]",
    `Description=Synara remote server (${escapeSystemdValue(releaseId)})`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${escapeSystemdValue(quotePosixShellArgument(input.layout.root))}`,
    `Environment=${systemdEnvironmentAssignment("SYNARA_AUTH_TOKEN_FILE", input.layout.credentialFile)}`,
    // Named explicitly, not derived from SYNARA_HOME. The server's own default
    // is `<SYNARA_HOME>/userdata/environment-id` and it GENERATES a fresh id
    // when that file is absent — so without this the remote would invent an id,
    // report it, and fail the handshake against the one bootstrap provisioned.
    `Environment=${systemdEnvironmentAssignment("SYNARA_ENVIRONMENT_ID_FILE", input.layout.environmentIdFile)}`,
    `Environment=${systemdEnvironmentAssignment("SYNARA_HOME", input.layout.stateDirectory)}`,
    `ExecStart=${execStart}`,
    // A crashed server restarts; a server we deliberately stopped for an
    // upgrade stays stopped, which is what makes drain-then-upgrade a decision
    // the user gets to make rather than a race with the supervisor.
    "Restart=on-failure",
    "RestartSec=2",
    `PIDFile=${escapeSystemdValue(quotePosixShellArgument(input.layout.pidFile))}`,
    "KillMode=mixed",
    // Long turns must survive a stop request long enough to drain.
    "TimeoutStopSec=120",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * A plist value is XML text. Without this, a path containing `</string>` could
 * close the element and inject arbitrary launchd keys into the agent.
 */
function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderLaunchdPlist(input: SupervisorInput): string {
  const argv = serverArgv(input);
  const arguments_ = argv.map((token) => `    <string>${escapeXml(token)}</string>`).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${escapeXml(launchdLabel(input.instanceId))}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    arguments_,
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${escapeXml(input.layout.root)}</string>`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>SYNARA_AUTH_TOKEN_FILE</key>",
    `    <string>${escapeXml(input.layout.credentialFile)}</string>`,
    "    <key>SYNARA_ENVIRONMENT_ID_FILE</key>",
    `    <string>${escapeXml(input.layout.environmentIdFile)}</string>`,
    "    <key>SYNARA_HOME</key>",
    `    <string>${escapeXml(input.layout.stateDirectory)}</string>`,
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>StandardOutPath</key>",
    `  <string>${escapeXml(input.layout.logFile)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${escapeXml(input.layout.logFile)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function normalizeHomeDirectory(homeDirectory: string): string {
  const trimmed = homeDirectory.trim();
  if (!trimmed.startsWith("/") || trimmed.includes("..") || containsControlCharacter(trimmed)) {
    throw new Error(`Invalid remote home directory: ${JSON.stringify(homeDirectory)}`);
  }
  return trimmed.length > 1 && trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function normalizeUserId(userId: number): number {
  if (!Number.isInteger(userId) || userId < 0) {
    throw new Error(`Invalid remote user id: ${userId}`);
  }
  return userId;
}

function systemdPlan(input: SupervisorInput): SupervisorPlan {
  const unitName = systemdUnitName(input.instanceId);
  const unitPath = `${input.layout.stateDirectory}/${unitName}`;
  // The unit is materialised inside the install root and symlinked into the
  // systemd user directory, so uninstall removes exactly one link, by name.
  const unitDirectory = `${normalizeHomeDirectory(input.homeDirectory)}/.config/systemd/user`;
  const linkPath = `${unitDirectory}/${unitName}`;
  return {
    kind: "systemd-user",
    unitPath,
    unitContents: renderSystemdUnit(input),
    unitName,
    installArgv: [
      ["mkdir", "-p", "--", unitDirectory],
      ["ln", "-sfn", "--", unitPath, linkPath],
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", unitName],
      // Linger is what makes "survives reboot" true: without it the user
      // manager is torn down at logout and the service dies with it.
      ["loginctl", "enable-linger"],
    ],
    startArgv: [["systemctl", "--user", "restart", unitName]],
    stopArgv: [["systemctl", "--user", "stop", unitName]],
    uninstallArgv: [
      ["systemctl", "--user", "stop", unitName],
      ["systemctl", "--user", "disable", unitName],
      ["rm", "-f", "--", linkPath],
      ["systemctl", "--user", "daemon-reload"],
    ],
    statusArgv: ["systemctl", "--user", "is-active", unitName],
  };
}

function launchdPlan(input: SupervisorInput): SupervisorPlan {
  const label = launchdLabel(input.instanceId);
  const unitPath = `${input.layout.stateDirectory}/${label}.plist`;
  const agentDirectory = `${normalizeHomeDirectory(input.homeDirectory)}/Library/LaunchAgents`;
  const linkPath = `${agentDirectory}/${label}.plist`;
  const domain = `gui/${normalizeUserId(input.userId)}`;
  return {
    kind: "launchd-user",
    unitPath,
    unitContents: renderLaunchdPlist(input),
    unitName: label,
    installArgv: [
      ["mkdir", "-p", "--", agentDirectory],
      ["ln", "-sfn", "--", unitPath, linkPath],
      ["launchctl", "bootstrap", domain, linkPath],
    ],
    startArgv: [["launchctl", "kickstart", "-k", `${domain}/${label}`]],
    stopArgv: [["launchctl", "kill", "SIGTERM", `${domain}/${label}`]],
    uninstallArgv: [
      ["launchctl", "bootout", `${domain}/${label}`],
      ["rm", "-f", "--", linkPath],
    ],
    statusArgv: ["launchctl", "print", `${domain}/${label}`],
  };
}

export function remoteSupervisorPlan(input: SupervisorInput): SupervisorPlan {
  normalizeInstanceId(input.instanceId);
  normalizeReleaseId(input.releaseId);
  assertLoopbackPort(input.port);
  normalizeHomeDirectory(input.homeDirectory);
  return input.os === "linux" ? systemdPlan(input) : launchdPlan(input);
}
