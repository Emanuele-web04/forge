import { describe, expect, it } from "vitest";

import {
  makeDeferredDesktopQuitIntentCoordinator,
  settleDeferredDesktopQuitAfterUpdaterFailure,
} from "./desktopQuitIntent";

function makeRecoveryHarness() {
  const quitReasons: string[] = [];
  let backendRestarts = 0;
  return {
    quitReasons,
    get backendRestarts() {
      return backendRestarts;
    },
    actions: {
      replayQuit: ({ reason }: { readonly reason: string }) => quitReasons.push(reason),
      resumeApp: () => {
        backendRestarts += 1;
      },
    },
  };
}

describe("deferred desktop quit intent coordination", () => {
  it("replays the first deferred quit when updater preflight fails", () => {
    const coordinator = makeDeferredDesktopQuitIntentCoordinator();
    const recovery = makeRecoveryHarness();

    expect(coordinator.defer("window-close")).toBe(true);
    expect(coordinator.defer("before-quit")).toBe(false);
    expect(settleDeferredDesktopQuitAfterUpdaterFailure(coordinator, recovery.actions)).toBe(
      "replayed-quit",
    );
    expect(recovery.quitReasons).toEqual(["window-close"]);
    expect(recovery.backendRestarts).toBe(0);
  });

  it("preserves a valid updater before-quit through watchdog failure", () => {
    const coordinator = makeDeferredDesktopQuitIntentCoordinator();
    const recovery = makeRecoveryHarness();

    coordinator.defer("before-quit");
    expect(coordinator.observeUpdaterQuitAttempt()).toBe(true);
    expect(settleDeferredDesktopQuitAfterUpdaterFailure(coordinator, recovery.actions)).toBe(
      "replayed-quit",
    );
    expect(recovery.quitReasons).toEqual(["before-quit"]);
    expect(recovery.backendRestarts).toBe(0);
  });

  it("ignores duplicate failure signals after starting quit replay", () => {
    const coordinator = makeDeferredDesktopQuitIntentCoordinator();
    const recovery = makeRecoveryHarness();

    coordinator.defer("SIGTERM");
    expect(settleDeferredDesktopQuitAfterUpdaterFailure(coordinator, recovery.actions)).toBe(
      "replayed-quit",
    );
    expect(settleDeferredDesktopQuitAfterUpdaterFailure(coordinator, recovery.actions)).toBe(
      "already-replaying",
    );
    expect(coordinator.defer("duplicate-quit")).toBe(false);
    expect(recovery.quitReasons).toEqual(["SIGTERM"]);
    expect(recovery.backendRestarts).toBe(0);
  });

  it("resumes the app when updater failure has no deferred quit", () => {
    const coordinator = makeDeferredDesktopQuitIntentCoordinator();
    const recovery = makeRecoveryHarness();

    expect(coordinator.observeUpdaterQuitAttempt()).toBe(false);
    expect(settleDeferredDesktopQuitAfterUpdaterFailure(coordinator, recovery.actions)).toBe(
      "resumed-app",
    );
    expect(recovery.quitReasons).toEqual([]);
    expect(recovery.backendRestarts).toBe(1);
  });
});
