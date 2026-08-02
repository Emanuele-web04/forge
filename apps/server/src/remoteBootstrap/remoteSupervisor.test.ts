import { describe, expect, it } from "vitest";

import { remoteInstallLayout } from "./remoteInstallLayout";
import {
  launchdLabel,
  remoteSupervisorPlan,
  renderLaunchdPlist,
  renderSystemdUnit,
  supervisorCapability,
  type SupervisorInput,
  systemdUnitName,
} from "./remoteSupervisor";

const layout = remoteInstallLayout("/home/deploy/.synara/remote");

function input(overrides: Partial<SupervisorInput> = {}): SupervisorInput {
  return {
    os: "linux",
    layout,
    releaseId: "0.6.3",
    nodePath: `${layout.root}/current/runtime/bin/node`,
    entrypointPath: `${layout.root}/current/dist/index.mjs`,
    port: 45123,
    instanceId: "env-abc123",
    homeDirectory: "/home/deploy",
    userId: 1000,
    ...overrides,
  };
}

function flatten(plan: ReadonlyArray<ReadonlyArray<string>>): ReadonlyArray<string> {
  return plan.flat();
}

describe("supervisorCapability", () => {
  it("reports systemd as supported on Linux", () => {
    expect(supervisorCapability("linux")).toEqual({ kind: "systemd-user", supported: true });
  });

  // Mutation guard: flipping this to `supported: true` would let a caller start
  // an end-to-end macOS bootstrap that is not wired up.
  it("gates launchd behind an unsupported capability with a reason", () => {
    const capability = supervisorCapability("darwin");
    expect(capability.kind).toBe("launchd-user");
    expect(capability.supported).toBe(false);
    expect(capability.reason).toMatch(/not enabled yet/);
  });
});

describe("systemd unit rendering", () => {
  it("launches the pinned node against the release entrypoint on loopback", () => {
    const unit = renderSystemdUnit(input());
    expect(unit).toContain(
      `ExecStart=/home/deploy/.synara/remote/current/runtime/bin/node /home/deploy/.synara/remote/current/dist/index.mjs --host 127.0.0.1 --port 45123`,
    );
  });

  it("enables restart-on-failure but never restart-always", () => {
    const unit = renderSystemdUnit(input());
    expect(unit).toContain("Restart=on-failure");
    // Mutation guard: `Restart=always` would defeat drain-then-upgrade by
    // resurrecting a server the upgrade deliberately stopped.
    expect(unit).not.toContain("Restart=always");
  });

  it("allows a long stop timeout so an active turn can drain", () => {
    expect(renderSystemdUnit(input())).toContain("TimeoutStopSec=120");
  });

  it("points the unit at the provisioned credential file", () => {
    expect(renderSystemdUnit(input())).toContain(
      `Environment=SYNARA_AUTH_TOKEN_FILE=${layout.credentialFile}`,
    );
  });

  /**
   * The environment-id file must be named EXPLICITLY, not left to the server's
   * own default.
   *
   * The default is `<SYNARA_HOME>/userdata/environment-id`, and the server
   * GENERATES a fresh id when that file is absent. SYNARA_HOME here is
   * `<root>/state`, so the default resolves to `<root>/state/userdata/environment-id`
   * — a different path from the `<root>/state/environment-id` bootstrap writes.
   * Without this line the remote would invent an id, report it, and fail the
   * provisioning handshake against the one we provisioned: a first install that
   * could never succeed.
   */
  it("points the unit at the provisioned environment id, not the derived default", () => {
    const unit = renderSystemdUnit(input());
    expect(unit).toContain(`Environment=SYNARA_ENVIRONMENT_ID_FILE=${layout.environmentIdFile}`);
    // Specifically NOT the path SYNARA_HOME would derive.
    expect(unit).not.toContain(`${layout.stateDirectory}/userdata/environment-id`);
  });

  // Mutation guard: dropping escapeSystemdValue turns a `%` in a path into a
  // systemd specifier, silently rewriting the ExecStart line.
  it("escapes a percent sign so systemd cannot expand it as a specifier", () => {
    const unit = renderSystemdUnit(
      input({ entrypointPath: "/home/deploy/100%dir/dist/index.mjs" }),
    );
    expect(unit).toContain("100%%dir");
    expect(unit).not.toMatch(/[^%]%[a-zA-Z][^%]/);
  });

  // Mutation guard: without quoting, a space in the install path splits into
  // two ExecStart arguments and the server launches with a wrong argv.
  it("quotes a path containing spaces into a single ExecStart token", () => {
    const unit = renderSystemdUnit(
      input({ entrypointPath: "/home/deploy/my server/dist/index.mjs" }),
    );
    expect(unit).toContain("'/home/deploy/my server/dist/index.mjs'");
  });

  // Mutation guard: a newline in a value would append a second unit directive,
  // so the renderer must refuse rather than emit it.
  it.each([
    ["a newline", "/tmp/x\nExecStartPost=/bin/sh"],
    ["a carriage return", "/tmp/x\rExecStartPost=/bin/sh"],
    ["a NUL byte", "/tmp/x\0y"],
    ["a vertical tab", "/tmp/x\v y"],
  ])("refuses %s in a rendered value", (_label, entrypointPath) => {
    expect(() => renderSystemdUnit(input({ entrypointPath }))).toThrow(
      /must not contain control characters/,
    );
  });

  it("refuses an invalid release id", () => {
    expect(() => renderSystemdUnit(input({ releaseId: "../evil" }))).toThrow(
      /Invalid remote release id/,
    );
  });
});

describe("port and identity validation", () => {
  it.each([80, 443, 1023, 0, -1, 65536, 1.5, Number.NaN])("refuses port %s", (port) => {
    expect(() => remoteSupervisorPlan(input({ port }))).toThrow(/unprivileged integer port/);
  });

  it.each(["", "a b", "a/b", "a;b", "a\nb", "$(id)", "-leading"])(
    "refuses instance id %j",
    (instanceId) => {
      expect(() => remoteSupervisorPlan(input({ instanceId }))).toThrow(
        /Invalid remote instance id/,
      );
    },
  );

  it.each(["relative/home", "/home/../etc", "/home/x\ny"])(
    "refuses home directory %j",
    (homeDirectory) => {
      expect(() => remoteSupervisorPlan(input({ homeDirectory }))).toThrow(
        /Invalid remote home directory/,
      );
    },
  );
});

describe("systemd plan", () => {
  const plan = remoteSupervisorPlan(input());

  it("names one exact unit everywhere", () => {
    expect(plan.unitName).toBe(systemdUnitName("env-abc123"));
    expect(plan.unitName).toBe("synara-env-abc123.service");
  });

  it("enables linger so the service survives logout and reboot", () => {
    expect(plan.installArgv).toContainEqual(["loginctl", "enable-linger"]);
  });

  // The single most important invariant in this file: cleanup is name- and
  // path-scoped. A pattern kill would take down an unrelated Synara.
  it.each(["pkill", "killall", "pgrep", "ps", "grep", "xargs", "kill"])(
    "never invokes %s in stop or uninstall",
    (command) => {
      for (const argv of [...plan.uninstallArgv, ...plan.stopArgv]) {
        expect(argv[0]).not.toBe(command);
      }
    },
  );

  it("stops and disables exactly the unit it installed", () => {
    expect(plan.stopArgv).toEqual([["systemctl", "--user", "stop", plan.unitName]]);
    expect(plan.uninstallArgv).toContainEqual(["systemctl", "--user", "stop", plan.unitName]);
    expect(plan.uninstallArgv).toContainEqual(["systemctl", "--user", "disable", plan.unitName]);
  });

  it("removes exactly one unit link by absolute path", () => {
    const removals = plan.uninstallArgv.filter((argv) => argv[0] === "rm");
    expect(removals).toEqual([
      ["rm", "-f", "--", `/home/deploy/.config/systemd/user/${plan.unitName}`],
    ]);
  });

  // Mutation guard: any `$VAR` or `$(...)` in an argv element means the command
  // only works via a shell, which is the injection seam this design forbids.
  it("contains no shell substitutions in any argv element", () => {
    const everyToken = [
      ...flatten(plan.installArgv),
      ...flatten(plan.startArgv),
      ...flatten(plan.stopArgv),
      ...flatten(plan.uninstallArgv),
      ...plan.statusArgv,
    ];
    for (const token of everyToken) {
      expect(token).not.toMatch(/[$`]/);
    }
  });
});

describe("launchd plan", () => {
  const plan = remoteSupervisorPlan(input({ os: "darwin" }));

  it("uses the resolved uid rather than a shell substitution", () => {
    expect(plan.startArgv).toEqual([
      ["launchctl", "kickstart", "-k", `gui/1000/${launchdLabel("env-abc123")}`],
    ]);
  });

  it("scopes uninstall to the exact label and plist path", () => {
    expect(plan.uninstallArgv).toEqual([
      ["launchctl", "bootout", `gui/1000/${launchdLabel("env-abc123")}`],
      ["rm", "-f", "--", `/home/deploy/Library/LaunchAgents/${launchdLabel("env-abc123")}.plist`],
    ]);
  });

  it("renders the same argv as the systemd unit", () => {
    const plist = renderLaunchdPlist(input({ os: "darwin" }));
    expect(plist).toContain("<string>--host</string>");
    expect(plist).toContain("<string>127.0.0.1</string>");
    expect(plist).toContain("<string>45123</string>");
  });

  /** The same explicit environment id the systemd unit sets, for the same reason. */
  it("names the provisioned environment id file too", () => {
    const plist = renderLaunchdPlist(input({ os: "darwin" }));
    expect(plist).toContain("<key>SYNARA_ENVIRONMENT_ID_FILE</key>");
    expect(plist).toContain(`<string>${layout.environmentIdFile}</string>`);
  });

  // Mutation guard (M47): KeepAlive must be the SuccessfulExit/false dict, not
  // a bare <true/>. A bare true restarts the server even after a deliberate
  // stop, which would turn drain-then-upgrade into a race with launchd — the
  // same distinction systemd's Restart=on-failure makes.
  it("restarts only on failure, never after a clean stop", () => {
    const plist = renderLaunchdPlist(input({ os: "darwin" }));
    expect(plist).toContain(
      ["  <key>KeepAlive</key>", "  <dict>", "    <key>SuccessfulExit</key>", "    <false/>"].join(
        "\n",
      ),
    );
    expect(plist).not.toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });

  // Mutation guard: dropping escapeXml lets a path close the <string> element
  // and inject arbitrary plist keys.
  it("escapes XML metacharacters in a path", () => {
    const plist = renderLaunchdPlist(
      input({ os: "darwin", entrypointPath: "/tmp/</string><key>Evil</key><string>x" }),
    );
    expect(plist).not.toContain("<key>Evil</key>");
    expect(plist).toContain("&lt;/string&gt;");
  });
});

describe("whitespace in the install root", () => {
  // systemd splits an unquoted directive on whitespace, so a root containing a
  // space silently truncates the value: SYNARA_AUTH_TOKEN_FILE would become
  // "/home/deploy/My" plus a stray second assignment, and the server would
  // start unable to read its credential.
  const spacedLayout = remoteInstallLayout("/home/deploy/My Synara/remote");
  const spacedInput = {
    os: "linux",
    layout: spacedLayout,
    releaseId: "0.6.3",
    nodePath: `${spacedLayout.currentLink}/node`,
    entrypointPath: `${spacedLayout.currentLink}/dist/index.mjs`,
    port: 45123,
    instanceId: "env-abc123",
    homeDirectory: "/home/deploy",
    userId: 1000,
  } as const;

  it("keeps each Environment value a single token", () => {
    const unit = renderSystemdUnit(spacedInput);
    for (const line of unit.split("\n")) {
      if (!line.startsWith("Environment=")) continue;
      const assignment = line.slice("Environment=".length);
      const value = assignment.slice(assignment.indexOf("=") + 1);
      // Either quoted, or free of the whitespace that would split it.
      expect(/^'.*'$/.test(value) || !/\s/.test(value)).toBe(true);
      expect(value).toContain("My Synara");
    }
  });

  it.each(["WorkingDirectory", "PIDFile"])("keeps %s a single token", (directive) => {
    const unit = renderSystemdUnit(spacedInput);
    const line = unit.split("\n").find((candidate) => candidate.startsWith(`${directive}=`));
    expect(line).toBeDefined();
    const value = line?.slice(directive.length + 1) ?? "";
    expect(/^'.*'$/.test(value) || !/\s/.test(value)).toBe(true);
    expect(value).toContain("My Synara");
  });

  it("does not emit a truncated credential path", () => {
    const unit = renderSystemdUnit(spacedInput);
    expect(unit).not.toMatch(/SYNARA_AUTH_TOKEN_FILE=\/home\/deploy\/My\s/);
    expect(unit).not.toMatch(/SYNARA_AUTH_TOKEN_FILE=\/home\/deploy\/My$/m);
  });
});
