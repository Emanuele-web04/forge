import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { registerComputerDesktopLifecycle } from "./computerDesktopLifecycle";

it("keeps lock, sleep and user-session gates independent and removes handlers", () => {
  const monitor = Object.assign(new EventEmitter(), { getSystemIdleState: () => "active" });
  const reasons = new Set<string>();
  const dispose = registerComputerDesktopLifecycle(
    monitor,
    {
      pauseDesktop: async (reason) => {
        reasons.add(reason);
      },
      resumeDesktop: (reason) => {
        reasons.delete(reason);
      },
    },
    () => {
      throw new Error("Unexpected cleanup failure");
    },
  );
  monitor.emit("lock-screen");
  monitor.emit("suspend");
  monitor.emit("user-did-resign-active");
  monitor.emit("resume");
  monitor.emit("unlock-screen");
  expect([...reasons]).toEqual(["user-session"]);
  monitor.emit("user-did-become-active");
  expect(reasons.size).toBe(0);
  dispose();
  monitor.emit("lock-screen");
  expect(reasons.size).toBe(0);
});

describe("desktop startup", () => {
  it("blocks an already locked desktop and reports failed native cleanup", async () => {
    const monitor = Object.assign(new EventEmitter(), { getSystemIdleState: () => "locked" });
    const errors: unknown[] = [];
    const reasons: string[] = [];
    const failure = new Error("Native cleanup not acknowledged");
    const dispose = registerComputerDesktopLifecycle(
      monitor,
      {
        pauseDesktop: async (reason) => {
          reasons.push(reason);
          throw failure;
        },
        resumeDesktop: () => {},
      },
      (error) => errors.push(error),
    );
    await Promise.resolve();
    expect(reasons).toEqual(["screen-lock"]);
    expect(errors).toEqual([failure]);
    dispose();
  });
});
