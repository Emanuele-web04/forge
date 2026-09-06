import { join } from "node:path";

import type { ProviderAccountLaunchContext, ProviderAppLaunchPlan } from "@synara/contracts";

import { registerProviderAppLaunchSpec } from "./appLaunch";

export interface ClaudeDesktopPlatform {
  readonly platform: NodeJS.Platform;
  readonly localAppData?: string;
}

const currentPlatform = (): ClaudeDesktopPlatform => ({
  platform: process.platform,
  ...(process.env.LOCALAPPDATA !== undefined ? { localAppData: process.env.LOCALAPPDATA } : {}),
});

/**
 * Resolves the official Claude desktop app executable for the host platform.
 * Returns undefined where no official desktop build exists: launch must stay
 * unavailable rather than guessing at a binary.
 */
export function resolveClaudeDesktopExecutable(
  host: ClaudeDesktopPlatform = currentPlatform(),
): string | undefined {
  if (host.platform === "darwin") {
    return "/Applications/Claude.app/Contents/MacOS/Claude";
  }
  if (host.platform === "win32" && host.localAppData !== undefined) {
    return join(host.localAppData, "AnthropicClaude", "claude.exe");
  }
  return undefined;
}

export interface ClaudeDesktopLaunchPlanInput {
  readonly ordinal: number;
  readonly accountLaunch?: ProviderAccountLaunchContext;
  readonly host?: ClaudeDesktopPlatform;
}

/**
 * Builds the Claude desktop app launch plan. Only the native account 0 can
 * open the official desktop app: there is no verified mechanism to isolate
 * Claude Desktop profiles (CLAUDE_CONFIG_DIR is proven for the Claude Code
 * CLI only), so managed ordinals return undefined instead of pretending an
 * unproven isolation works.
 */
export function buildClaudeDesktopLaunchPlan(
  input: ClaudeDesktopLaunchPlanInput,
): ProviderAppLaunchPlan | undefined {
  if (input.ordinal > 0) {
    return undefined;
  }
  const executable = resolveClaudeDesktopExecutable(input.host ?? currentPlatform());
  if (executable === undefined) {
    return undefined;
  }
  return {
    provider: "claudeAgent",
    ordinal: input.ordinal,
    appGeneration: input.accountLaunch?.generation ?? 1,
    executable,
    args: [],
    environment: {},
    supportLevel: "supported",
  } satisfies ProviderAppLaunchPlan;
}

registerProviderAppLaunchSpec("claudeAgent", ({ ordinal }) => {
  // unsupported until isolation E2E proof: only the native account 0 may
  // open the official desktop app (the capability matrix marks every app
  // surface unsupported).
  if (ordinal > 0) return undefined;
  const executable = resolveClaudeDesktopExecutable();
  return executable === undefined ? undefined : { executable };
});
