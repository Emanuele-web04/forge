import { describe, expect, it } from "vitest";

import { inspectSubprocessActivity } from "./subprocessActivity";
import type { ProcessChildrenMap } from "./processTreeKiller";

function buildChildrenMap(
  entries: Array<{ ppid: number; pid: number; command: string }>,
): ProcessChildrenMap {
  const map: ProcessChildrenMap = new Map();
  for (const { ppid, pid, command } of entries) {
    const siblings = map.get(ppid) ?? [];
    siblings.push({ pid, command });
    map.set(ppid, siblings);
  }
  return map;
}

describe("inspectSubprocessActivity", () => {
  it("reports no activity for an idle shell with no children", () => {
    const map = buildChildrenMap([]);
    expect(inspectSubprocessActivity(100, map)).toEqual({
      cliKind: null,
      hasNonProviderSubprocess: false,
      hasProviderDescendant: false,
      hasRunningSubprocess: false,
    });
  });

  it("treats nested shell-only descendants as not running", () => {
    const map = buildChildrenMap([
      { ppid: 100, pid: 200, command: "zsh" },
      { ppid: 200, pid: 300, command: "bash" },
    ]);
    expect(inspectSubprocessActivity(100, map)).toEqual({
      cliKind: null,
      hasNonProviderSubprocess: false,
      hasProviderDescendant: false,
      hasRunningSubprocess: false,
    });
  });

  it("flags a non-provider subprocess as running", () => {
    const map = buildChildrenMap([{ ppid: 100, pid: 200, command: "node build.js" }]);
    expect(inspectSubprocessActivity(100, map)).toEqual({
      cliKind: null,
      hasNonProviderSubprocess: true,
      hasProviderDescendant: false,
      hasRunningSubprocess: true,
    });
  });

  it("detects a provider descendant nested under a wrapper shell", () => {
    const map = buildChildrenMap([
      { ppid: 100, pid: 200, command: "zsh" },
      { ppid: 200, pid: 300, command: "codex" },
    ]);
    expect(inspectSubprocessActivity(100, map)).toEqual({
      cliKind: "codex",
      hasNonProviderSubprocess: false,
      hasProviderDescendant: true,
      hasRunningSubprocess: true,
    });
  });

  it("combines provider and non-provider activity across sibling branches", () => {
    const map = buildChildrenMap([
      { ppid: 100, pid: 200, command: "zsh" },
      { ppid: 200, pid: 300, command: "codex" },
      { ppid: 100, pid: 400, command: "node build.js" },
    ]);

    expect(inspectSubprocessActivity(100, map)).toEqual({
      cliKind: "codex",
      hasNonProviderSubprocess: true,
      hasProviderDescendant: true,
      hasRunningSubprocess: true,
    });
  });

  it("preserves provider and shell semantics for Windows executable names", () => {
    const map = buildChildrenMap([
      {
        ppid: 100,
        pid: 200,
        command: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo',
      },
      { ppid: 200, pid: 300, command: "C:\\tools\\codex.exe" },
    ]);

    expect(inspectSubprocessActivity(100, map)).toEqual({
      cliKind: "codex",
      hasNonProviderSubprocess: false,
      hasProviderDescendant: true,
      hasRunningSubprocess: true,
    });
  });

  it("inspects multiple terminals against one shared snapshot", () => {
    // A single captured snapshot must yield independent, correct results per
    // terminal — this is the property the per-cycle batching relies on.
    const map = buildChildrenMap([
      { ppid: 100, pid: 200, command: "codex" },
      { ppid: 400, pid: 500, command: "zsh" },
    ]);

    expect(inspectSubprocessActivity(100, map).hasProviderDescendant).toBe(true);
    expect(inspectSubprocessActivity(100, map).cliKind).toBe("codex");
    expect(inspectSubprocessActivity(400, map)).toEqual({
      cliKind: null,
      hasNonProviderSubprocess: false,
      hasProviderDescendant: false,
      hasRunningSubprocess: false,
    });
  });
});
