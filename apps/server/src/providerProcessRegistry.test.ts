import { describe, expect, it } from "vitest";

import {
  dropProviderProcess,
  listRegisteredProviderProcesses,
  registerProviderProcess,
  resetProviderProcessRegistryForTesting,
} from "./providerProcessRegistry";

describe("providerProcessRegistry", () => {
  it("registers and lists live processes", () => {
    resetProviderProcessRegistryForTesting();
    registerProviderProcess({ pid: process.pid, provider: "codex", threadIds: ["thread-1"] });
    const entries = listRegisteredProviderProcesses();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      pid: process.pid,
      provider: "codex",
      threadIds: ["thread-1"],
    });
    resetProviderProcessRegistryForTesting();
  });

  it("prunes dead pids lazily", () => {
    resetProviderProcessRegistryForTesting();
    registerProviderProcess({ pid: 2_147_483_647, provider: "codex" });
    registerProviderProcess({ pid: process.pid, provider: "opencode" });
    const entries = listRegisteredProviderProcesses();
    expect(entries.map((entry) => entry.pid)).toEqual([process.pid]);
    resetProviderProcessRegistryForTesting();
  });

  it("refuses invalid pids and blank providers", () => {
    resetProviderProcessRegistryForTesting();
    registerProviderProcess({ pid: 0, provider: "codex" });
    registerProviderProcess({ pid: -5, provider: "codex" });
    registerProviderProcess({ pid: process.pid, provider: "  " });
    expect(listRegisteredProviderProcesses()).toHaveLength(0);
    resetProviderProcessRegistryForTesting();
  });

  it("drops entries on demand", () => {
    resetProviderProcessRegistryForTesting();
    registerProviderProcess({ pid: process.pid, provider: "codex" });
    dropProviderProcess(process.pid);
    expect(listRegisteredProviderProcesses()).toHaveLength(0);
    resetProviderProcessRegistryForTesting();
  });
});
