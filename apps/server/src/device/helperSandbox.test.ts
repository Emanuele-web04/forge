import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  SANDBOX_OPT_OUT_ENV,
  SANDBOX_PROFILE_NAME,
  describeSandboxSuspicion,
  sandboxDisabled,
  sandboxedHelperCommand,
  xcodeAppRoot,
} from "./helperSandbox.ts";

/** The real profile, so these tests break if it is renamed or removed. */
const HELPER_SOURCE_DIR = path.resolve(import.meta.dirname, "..", "..", "native", "device-helper");

const darwin = process.platform === "darwin";

describe("xcodeAppRoot", () => {
  it("climbs from a developer dir to the enclosing app bundle", () => {
    // The profile has to cover the whole bundle: the helper mmaps frameworks
    // from all over it, not just Contents/Developer.
    expect(xcodeAppRoot("/Applications/Xcode.app/Contents/Developer")).toBe(
      "/Applications/Xcode.app",
    );
  });

  it("handles a beta or a relocated Xcode, not just /Applications", () => {
    expect(xcodeAppRoot("/Users/me/Xcode-beta.app/Contents/Developer")).toBe(
      "/Users/me/Xcode-beta.app",
    );
  });

  it("leaves CommandLineTools alone, since it has no bundle", () => {
    // Covered by /Library/Developer in the profile instead.
    expect(xcodeAppRoot("/Library/Developer/CommandLineTools")).toBe(
      "/Library/Developer/CommandLineTools",
    );
  });
});

describe("the opt-out", () => {
  it("is off unless explicitly set to something truthy", () => {
    expect(sandboxDisabled({})).toBe(false);
    expect(sandboxDisabled({ [SANDBOX_OPT_OUT_ENV]: "" })).toBe(false);
    expect(sandboxDisabled({ [SANDBOX_OPT_OUT_ENV]: "0" })).toBe(false);
    expect(sandboxDisabled({ [SANDBOX_OPT_OUT_ENV]: "false" })).toBe(false);
  });

  it("is on for the values a user would actually type", () => {
    expect(sandboxDisabled({ [SANDBOX_OPT_OUT_ENV]: "1" })).toBe(true);
    expect(sandboxDisabled({ [SANDBOX_OPT_OUT_ENV]: "true" })).toBe(true);
  });
});

describe("sandboxedHelperCommand", () => {
  const context = {
    binaryPath: "/tmp/helper-cache/synara-device-helper",
    helperSourceDir: HELPER_SOURCE_DIR,
    developerDir: "/Applications/Xcode.app/Contents/Developer",
  };

  it.runIf(darwin)("wraps the helper in sandbox-exec with every parameter bound", async () => {
    const launch = await sandboxedHelperCommand([context.binaryPath, "--probe"], context);

    expect(launch.command).toBe("/usr/bin/sandbox-exec");
    expect(launch.profilePath).toBe(path.join(HELPER_SOURCE_DIR, SANDBOX_PROFILE_NAME));
    // An unbound parameter is not an error at load time; it silently matches
    // nothing, so every one the profile references must be passed.
    for (const name of [
      "HELPER_BUNDLE",
      "USER_HOME",
      "CORESIM_HOME",
      "CORESIM_LOGS",
      "DARWIN_TMP",
      "XCODE_APP",
    ]) {
      expect(launch.args.some((arg) => arg.startsWith(`${name}=`))).toBe(true);
    }
    // The helper's own argv survives, last, so --probe still reaches it.
    expect(launch.args.at(-2)).toBe(context.binaryPath);
    expect(launch.args.at(-1)).toBe("--probe");
  });

  it.runIf(darwin)("resolves DARWIN_TMP through symlinks", async () => {
    // $TMPDIR is /var/folders/... which really lives at /private/var/folders/...
    // Seatbelt matches the real path, so an unresolved parameter would deny the
    // frame socket and hang the video path.
    const launch = await sandboxedHelperCommand([context.binaryPath], context);
    const darwinTmp = launch.args.find((arg) => arg.startsWith("DARWIN_TMP="))?.slice(11);
    expect(darwinTmp).toBeDefined();
    expect(path.isAbsolute(darwinTmp!)).toBe(true);
    if (tmpdir().startsWith("/var/")) expect(darwinTmp).toMatch(/^\/private\/var\//u);
  });

  it("hands back the plain command when the opt-out is set", async () => {
    const launch = await sandboxedHelperCommand([context.binaryPath, "--probe"], {
      ...context,
      env: { [SANDBOX_OPT_OUT_ENV]: "1" },
    });

    expect(launch.command).toBe(context.binaryPath);
    expect(launch.args).toEqual(["--probe"]);
    // Null profile is what tells a later timeout not to blame the sandbox.
    expect(launch.profilePath).toBeNull();
  });

  it("runs unconfined rather than failing when the profile is missing", async () => {
    // A packaging mistake should cost the confinement, not the whole feature.
    const launch = await sandboxedHelperCommand([context.binaryPath], {
      ...context,
      helperSourceDir: "/nonexistent/device-helper",
    });

    expect(launch.command).toBe(context.binaryPath);
    expect(launch.profilePath).toBeNull();
  });
});

describe("describeSandboxSuspicion", () => {
  it("names the profile and the way out, because a denial reads as a hang", () => {
    const message = describeSandboxSuspicion("/x/device-helper.sb");
    expect(message).toContain("/x/device-helper.sb");
    expect(message).toContain(SANDBOX_OPT_OUT_ENV);
  });

  it("says nothing when the helper was not confined", () => {
    // Blaming a sandbox that was never applied would send the reader the wrong way.
    expect(describeSandboxSuspicion(null)).toBe("");
  });
});
