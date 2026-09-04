import { describe, expect, it } from "vitest";

import { LauncherUsageError, parseLauncherInvocation, SYNARA_LAUNCHER_SHIM } from "./cli.ts";

describe("parseLauncherInvocation", () => {
  it("maps shim names to providers and forwards all arguments", () => {
    const invocation = parseLauncherInvocation(["--flag", "value"], {
      [SYNARA_LAUNCHER_SHIM]: "claude",
    });
    expect(invocation.provider).toBe("claudeAgent");
    expect(invocation.providerArgs).toEqual(["--flag", "value"]);
    expect(invocation.explicitOrdinal).toBeUndefined();
  });

  it("parses run mode with provider, ordinal, and provider arguments", () => {
    const invocation = parseLauncherInvocation(
      ["run", "codex", "--ordinal", "3", "--", "exec", "review"],
      {},
    );
    expect(invocation).toEqual({
      provider: "codex",
      explicitOrdinal: 3,
      providerArgs: ["exec", "review"],
    });
  });

  it("stops flag parsing at the first provider argument", () => {
    const invocation = parseLauncherInvocation(["run", "cursor-agent", "status"], {});
    expect(invocation.provider).toBe("cursor");
    expect(invocation.providerArgs).toEqual(["status"]);
  });

  it("rejects unknown providers and missing subcommands", () => {
    expect(() => parseLauncherInvocation(["run", "vim"], {})).toThrow(LauncherUsageError);
    expect(() => parseLauncherInvocation(["codex"], {})).toThrow(LauncherUsageError);
    expect(() => parseLauncherInvocation(["run", "codex", "--ordinal", "x"], {})).toThrow(
      LauncherUsageError,
    );
  });
});
