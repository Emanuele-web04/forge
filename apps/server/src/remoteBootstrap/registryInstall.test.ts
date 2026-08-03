import { describe, expect, it } from "vitest";

import {
  registryPackageSpec,
  RegistryInstallRefusedError,
  renderRegistryRunnerScript,
} from "./registryInstall";

describe("registryPackageSpec", () => {
  it("pins an exact version", () => {
    expect(registryPackageSpec("@synara/cli", "0.6.5")).toBe("@synara/cli@0.6.5");
    expect(registryPackageSpec("@synara/cli", "1.0.0-rc.2")).toBe("@synara/cli@1.0.0-rc.2");
  });

  // The whole reason this is not a copy of the prior art: `@latest` resolves on
  // the REMOTE at install time, so the client cannot know which build answered,
  // the skew policy has nothing to compare, and an upgrade has nothing to roll
  // back to. npm may resolve the dependencies; it may not choose the version.
  it.each(["latest", "nightly", "^1.2.0", "~1.2.0", "1.2", "*", ""])(
    "refuses the floating spec %s",
    (version) => {
      expect(() => registryPackageSpec("@synara/cli", version)).toThrow(
        RegistryInstallRefusedError,
      );
    },
  );

  it("refuses a package name that is not a package name", () => {
    expect(() => registryPackageSpec("../../evil", "1.0.0")).toThrow(RegistryInstallRefusedError);
    expect(() => registryPackageSpec("a; rm -rf /", "1.0.0")).toThrow(RegistryInstallRefusedError);
  });
});

describe("renderRegistryRunnerScript", () => {
  const script = renderRegistryRunnerScript({
    packageSpec: "@synara/cli@0.6.5",
    stateDirectory: "/home/dev/.synara-remote/state",
    port: 45123,
  });

  it("installs from the registry at the pinned spec", () => {
    expect(script).toContain("SPEC='@synara/cli@0.6.5'");
    expect(script).toContain("npx --yes $SPEC");
    expect(script).toContain("npm exec --yes $SPEC --");
  });

  it("binds loopback only, so the tunnel is the only way in", () => {
    expect(script).toContain("--host 127.0.0.1");
    expect(script).toContain("--port $PORT");
    // No browser on a headless remote; the CLI takes flags directly, it has no
    // "serve" subcommand (verified against the real binary on a Mac).
    expect(script).toContain("--no-browser");
    expect(script).not.toContain(" serve ");
  });

  it("adopts a healthy server instead of restarting one mid-turn", () => {
    expect(script).toContain('kill -0 "$EXISTING"');
    expect(script).toContain("reused");
  });

  it("survives the ssh channel closing", () => {
    // Without nohup the server dies with the exec channel, so the tunnel that
    // opens a moment later finds nothing listening.
    expect(script).toContain("nohup");
  });

  it("keeps the state directory and pidfile private", () => {
    expect(script).toContain('chmod 700 "$STATE_DIR"');
    expect(script).toContain('chmod 600 "$PID_FILE"');
  });

  it("says which tool is missing rather than failing silently", () => {
    expect(script).toMatch(/neither npx nor npm/);
    // Names the actual remedy: on a Mac npm exists but only on the LOGIN shell
    // PATH, which is what the login-shell launcher is for.
    expect(script).toMatch(/login-shell/);
    expect(script).toContain("exit 127");
  });

  it("refuses a port outside the unprivileged range", () => {
    for (const port of [80, 1023, 70_000, -1]) {
      expect(() =>
        renderRegistryRunnerScript({
          packageSpec: "@synara/cli@0.6.5",
          stateDirectory: "/s",
          port,
        }),
      ).toThrow(RegistryInstallRefusedError);
    }
  });

  it("needs no init system, so one path serves linux and macOS", () => {
    // The supervisor backends this replaces were the source of a GNU-vs-BSD
    // divergence that only appeared on a real Mac, and systemd's user manager
    // cannot run in a container at all.
    expect(script).not.toContain("systemctl");
    expect(script).not.toContain("launchctl");
  });
});
