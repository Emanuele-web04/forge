import { describe, expect, it, vi } from "vitest";

import type { TerminalContextSelection } from "./terminalContext";
import {
  getTerminalContextComposerTarget,
  registerTerminalContextComposerTarget,
  subscribeTerminalContextComposerTarget,
} from "./terminalContextComposerRegistry";

const selection: TerminalContextSelection = {
  terminalId: "terminal-1",
  terminalLabel: "Terminal 1",
  lineStart: 2,
  lineEnd: 3,
  text: "first\nsecond",
};

describe("terminalContextComposerRegistry", () => {
  it("publishes a composer target and removes it on cleanup", () => {
    const target = vi.fn();
    const cleanup = registerTerminalContextComposerTarget("pane-1", target);

    getTerminalContextComposerTarget("pane-1")?.(selection);
    expect(target).toHaveBeenCalledWith(selection);

    cleanup();
    expect(getTerminalContextComposerTarget("pane-1")).toBeUndefined();
  });

  it("does not let stale cleanup remove a replacement target", () => {
    const firstTarget = vi.fn();
    const secondTarget = vi.fn();
    const cleanupFirst = registerTerminalContextComposerTarget("pane-2", firstTarget);
    const cleanupSecond = registerTerminalContextComposerTarget("pane-2", secondTarget);

    cleanupFirst();
    expect(getTerminalContextComposerTarget("pane-2")).toBe(secondTarget);

    cleanupSecond();
    expect(getTerminalContextComposerTarget("pane-2")).toBeUndefined();
  });

  it("notifies subscribers when availability changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTerminalContextComposerTarget("pane-3", listener);
    const cleanup = registerTerminalContextComposerTarget("pane-3", vi.fn());

    expect(listener).toHaveBeenCalledTimes(1);
    cleanup();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    registerTerminalContextComposerTarget("pane-3", vi.fn())();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
