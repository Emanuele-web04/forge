// FILE: terminalVisualIdentity.test.ts
// Purpose: Verifies shared terminal visual identity rules used by chrome and recent views.
// Layer: UI state logic test

import { describe, expect, it } from "vitest";

import {
  resolveTerminalVisualIdentityMap,
  selectRepresentativeTerminalVisualIdentity,
} from "./terminalVisualIdentity";

describe("terminal visual identity", () => {
  it("resolves terminal icon, title, and activity state from shared metadata", () => {
    const identities = resolveTerminalVisualIdentityMap({
      terminalIds: ["terminal-1", "terminal-2"],
      runningTerminalIds: [" terminal-1 "],
      terminalAttentionStatesById: { "terminal-2": "attention" },
      terminalCliKindsById: { "terminal-1": "codex" },
      terminalLabelsById: { "terminal-1": "Codex 1", "terminal-2": "bun dev" },
      terminalTitleOverridesById: { "terminal-2": "Dev server" },
    });

    expect(identities.get("terminal-1")).toMatchObject({
      cliKind: "codex",
      iconKey: "openai",
      state: "running",
      title: "Codex 1",
    });
    expect(identities.get("terminal-2")).toMatchObject({
      cliKind: null,
      iconKey: "terminal",
      state: "attention",
      title: "Dev server",
    });
  });

  it("does not infer provider icons from stale provider-looking labels", () => {
    const identities = resolveTerminalVisualIdentityMap({
      terminalIds: ["terminal-1"],
      runningTerminalIds: [],
      terminalAttentionStatesById: {},
      terminalCliKindsById: {},
      terminalLabelsById: { "terminal-1": "Codex 1" },
      terminalTitleOverridesById: {},
    });

    expect(identities.get("terminal-1")).toMatchObject({
      cliKind: null,
      iconKey: "terminal",
      title: "Codex 1",
    });
  });

  it("selects the highest-priority terminal identity while preserving active-tab ties", () => {
    const identities = resolveTerminalVisualIdentityMap({
      terminalIds: ["terminal-1", "terminal-2"],
      runningTerminalIds: ["terminal-1"],
      terminalAttentionStatesById: { "terminal-2": "attention" },
      terminalCliKindsById: { "terminal-1": "codex" },
      terminalLabelsById: { "terminal-1": "Codex 1", "terminal-2": "bun dev" },
      terminalTitleOverridesById: {},
    });

    expect(
      selectRepresentativeTerminalVisualIdentity({
        activeTerminalId: "terminal-1",
        terminalIds: ["terminal-1", "terminal-2"],
        terminalVisualIdentityById: identities,
      }),
    ).toMatchObject({
      terminalId: "terminal-2",
      identity: { iconKey: "terminal", state: "attention" },
    });

    const idleIdentities = resolveTerminalVisualIdentityMap({
      terminalIds: ["terminal-1", "terminal-2"],
      runningTerminalIds: [],
      terminalAttentionStatesById: {},
      terminalCliKindsById: { "terminal-1": "codex" },
      terminalLabelsById: { "terminal-1": "Codex 1", "terminal-2": "bun dev" },
      terminalTitleOverridesById: {},
    });

    expect(
      selectRepresentativeTerminalVisualIdentity({
        activeTerminalId: "terminal-1",
        terminalIds: ["terminal-1", "terminal-2"],
        terminalVisualIdentityById: idleIdentities,
      }),
    ).toMatchObject({
      terminalId: "terminal-1",
      identity: { iconKey: "openai", state: "idle" },
    });
  });

  it("keeps attention ahead of running in the terminal identity map", () => {
    expect(
      resolveTerminalVisualIdentityMap({
        terminalIds: ["terminal-1"],
        runningTerminalIds: ["terminal-1"],
        terminalAttentionStatesById: { "terminal-1": "attention" },
        terminalCliKindsById: {},
        terminalLabelsById: {},
        terminalTitleOverridesById: {},
      }).get("terminal-1")?.state,
    ).toBe("attention");
  });
});
