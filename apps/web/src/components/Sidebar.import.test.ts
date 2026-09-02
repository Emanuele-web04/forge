// FILE: Sidebar.import.test.ts
// Purpose: Smoke-test that the large Sidebar module still imports after project-run wiring.
// Layer: Web component module test
// Depends on: Vitest module mocking and Sidebar's transitive imports.

import { describe, expect, it, vi } from "vitest";
import { resolveThreadRowTrailingReserveClass } from "./Sidebar.logic";

vi.mock("./terminal/terminalRuntimeRegistry", () => ({
  terminalRuntimeRegistry: {
    disposeTerminal: vi.fn(),
  },
}));

describe("Sidebar module", () => {
  it("loads after project-run wiring", async () => {
    vi.stubGlobal("self", globalThis);
    const module = await import("./Sidebar");

    expect(module.default).toBeTypeOf("function");
    // Full-suite runs transform many web files concurrently; this import can cross Vitest's 5s default.
  }, 15_000);

  it("keeps the Synara provenance chip on a subagent row", async () => {
    vi.stubGlobal("self", globalThis);
    const module = await import("./Sidebar");
    const chips = module.resolveThreadRowMetaChips({
      thread: {
        creationSource: "synara_mcp",
        sourceThreadId: "source" as never,
        forkSourceThreadId: null,
        sidechatSourceThreadId: null,
        envMode: "local",
        worktreePath: null,
        handoff: null,
      },
      includeHandoffBadge: false,
    });

    expect(chips).toEqual([
      expect.objectContaining({
        id: "synara-source",
        tooltip: "Sent by Synara from another thread",
      }),
    ]);
    expect(
      resolveThreadRowTrailingReserveClass({
        metaChipCount: chips.length,
        hasTrailingGlyph: false,
      }),
    ).toContain("pr-[1.75rem]");
  }, 15_000);

  it("does not mislabel provider-native subagents as cross-thread Synara sends", async () => {
    vi.stubGlobal("self", globalThis);
    const module = await import("./Sidebar");
    const chips = module.resolveThreadRowMetaChips({
      thread: {
        creationSource: "provider_native",
        sourceThreadId: "parent" as never,
        forkSourceThreadId: null,
        sidechatSourceThreadId: null,
        envMode: "local",
        worktreePath: null,
        handoff: null,
      },
      includeHandoffBadge: false,
    });

    expect(chips).toEqual([]);
  }, 15_000);

  it("keeps the temporary icon independent from the presence of metadata chips", async () => {
    vi.stubGlobal("self", globalThis);
    const module = await import("./Sidebar");

    expect(
      module.shouldShowTemporaryThreadIcon({
        isTemporaryThread: true,
        sidechatSourceThreadId: null,
      }),
    ).toBe(true);
  }, 15_000);
});
