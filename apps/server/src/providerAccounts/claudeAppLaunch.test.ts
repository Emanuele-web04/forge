import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildClaudeAccountEnvironment } from "@synara/shared/providerAccounts/claudeAccountEnvironment";
import { buildClaudeDesktopLaunchPlan, resolveClaudeDesktopExecutable } from "./claudeAppLaunch";

const DARWIN_EXECUTABLE = "/Applications/Claude.app/Contents/MacOS/Claude";

describe("resolveClaudeDesktopExecutable", () => {
  it("resolves the macOS app bundle binary", () => {
    expect(resolveClaudeDesktopExecutable({ platform: "darwin" })).toBe(DARWIN_EXECUTABLE);
  });

  it("resolves the Windows install under LOCALAPPDATA", () => {
    expect(
      resolveClaudeDesktopExecutable({
        platform: "win32",
        localAppData: "C:\\Users\\k\\AppData\\Local",
      }),
    ).toBe(join("C:\\Users\\k\\AppData\\Local", "AnthropicClaude", "claude.exe"));
  });

  it("stays unavailable on Windows without LOCALAPPDATA", () => {
    expect(resolveClaudeDesktopExecutable({ platform: "win32" })).toBeUndefined();
  });

  it("stays unavailable on platforms without an official desktop build", () => {
    expect(resolveClaudeDesktopExecutable({ platform: "linux" })).toBeUndefined();
  });
});

describe("buildClaudeDesktopLaunchPlan", () => {
  it("builds a native account plan with no environment overrides", () => {
    const plan = buildClaudeDesktopLaunchPlan({ ordinal: 0, host: { platform: "darwin" } });
    expect(plan).toEqual({
      provider: "claudeAgent",
      ordinal: 0,
      appGeneration: 1,
      executable: DARWIN_EXECUTABLE,
      args: [],
      environment: {},
      supportLevel: "supported",
    });
  });

  it("refuses managed ordinals until desktop isolation is proven", () => {
    const launchEnvironment = buildClaudeAccountEnvironment({
      provider: "claudeAgent",
      ordinal: 2,
      surface: "app",
      authMethod: "oauth",
      agentHome: "/accounts/claudeAgent/2/agent",
      appDataDir: "/accounts/claudeAgent/2/app/data",
    });
    const plan = buildClaudeDesktopLaunchPlan({
      ordinal: 2,
      accountLaunch: {
        ordinal: 2,
        generation: 3,
        profilePath: launchEnvironment.profilePath,
        environment: launchEnvironment.environment,
      },
      host: { platform: "darwin" },
    });
    expect(plan).toBeUndefined();
  });

  it("returns undefined where no official desktop build exists", () => {
    expect(
      buildClaudeDesktopLaunchPlan({ ordinal: 0, host: { platform: "linux" } }),
    ).toBeUndefined();
  });
});
