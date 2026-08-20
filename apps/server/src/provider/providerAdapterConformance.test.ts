import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { ProviderAdapterShape } from "./Services/ProviderAdapter.ts";
import {
  assertProviderAdapterConformance,
  providerAdapterConformanceIssues,
} from "./providerAdapterConformance.ts";

function makeAdapter(
  overrides: Partial<ProviderAdapterShape<never>> = {},
): ProviderAdapterShape<never> {
  return {
    provider: "codex",
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: () => Effect.die("unused"),
    sendTurn: () => Effect.die("unused"),
    interruptTurn: () => Effect.void,
    respondToRequest: () => Effect.void,
    respondToUserInput: () => Effect.void,
    stopSession: () => Effect.void,
    listSessions: () => Effect.succeed([]),
    hasSession: () => Effect.succeed(false),
    readThread: () => Effect.die("unused"),
    rollbackThread: () => Effect.die("unused"),
    stopAll: () => Effect.void,
    streamEvents: Stream.empty,
    ...overrides,
  };
}

describe("provider adapter conformance", () => {
  it("requires turn steering when the capability is advertised", () => {
    const adapter = makeAdapter({
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsTurnSteering: true,
      },
    });

    expect(providerAdapterConformanceIssues(adapter)).toEqual([
      {
        capability: "supportsTurnSteering",
        missingMethod: "steerTurn",
      },
    ]);
  });

  it("requires both plugin methods when plugin discovery is advertised", () => {
    const adapter = makeAdapter({
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsPluginDiscovery: true,
      },
      listPlugins: () => Effect.die("unused"),
    });

    expect(providerAdapterConformanceIssues(adapter)).toEqual([
      {
        capability: "supportsPluginDiscovery",
        missingMethod: "readPlugin",
      },
    ]);
  });

  it("accepts adapters whose advertised discovery and steering methods exist", () => {
    const adapter = makeAdapter({
      capabilities: {
        sessionModelSwitch: "restart-session",
        supportsTurnSteering: true,
        supportsSkillDiscovery: true,
        supportsNativeSlashCommandDiscovery: true,
        supportsPluginDiscovery: true,
        supportsRuntimeModelList: true,
      },
      steerTurn: () => Effect.die("unused"),
      listSkills: () => Effect.die("unused"),
      listCommands: () => Effect.die("unused"),
      listPlugins: () => Effect.die("unused"),
      readPlugin: () => Effect.die("unused"),
      listModels: () => Effect.die("unused"),
    });

    expect(providerAdapterConformanceIssues(adapter)).toEqual([]);
    expect(() => assertProviderAdapterConformance(adapter)).not.toThrow();
  });

  it("reports all invalid capability declarations in one error", () => {
    const adapter = makeAdapter({
      provider: "opencode",
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsSkillDiscovery: true,
        supportsRuntimeModelList: true,
      },
    });

    expect(() => assertProviderAdapterConformance(adapter)).toThrow(
      'Provider adapter "opencode" has invalid capabilities: supportsSkillDiscovery requires listSkills(), supportsRuntimeModelList requires listModels().',
    );
  });
});
