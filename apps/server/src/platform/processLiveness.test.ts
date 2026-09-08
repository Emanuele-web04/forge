import { describe, expect, it, vi } from "vitest";

const { spawnProcessSync } = vi.hoisted(() => ({ spawnProcessSync: vi.fn() }));
vi.mock("@synara/shared/processRuntime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synara/shared/processRuntime")>()),
  spawnProcessSync,
}));

import { isProcessRunning } from "./processTreeController";

describe("native process liveness", () => {
  it.each(["R", "S+", "D", "I", "T", "t", "U", "W"])(
    "recognizes a live POSIX process in state %s",
    async (state) => {
      spawnProcessSync.mockReturnValue({ status: 0, stdout: `${state}\n` });
      expect(await isProcessRunning(91, { platform: "linux" })).toBe(true);
    },
  );

  it.each(["Z", "Z+", "X", "", "?"])(
    "does not certify an exited or unknown POSIX process in state %s",
    async (state) => {
      spawnProcessSync.mockReturnValue({ status: 0, stdout: `${state}\n` });
      expect(await isProcessRunning(91, { platform: "darwin" })).toBe(false);
    },
  );

  it("treats absent PIDs, failed probes and unreadable process tables as unproven", async () => {
    spawnProcessSync.mockReturnValue({ status: 1, stdout: "" });
    expect(await isProcessRunning(91, { platform: "linux" })).toBe(false);
    spawnProcessSync.mockReturnValue({ status: null, stdout: "S", error: new Error("timeout") });
    expect(await isProcessRunning(91, { platform: "linux" })).toBe(false);
    spawnProcessSync.mockImplementation(() => {
      throw new Error("ps unavailable");
    });
    expect(await isProcessRunning(91, { platform: "linux" })).toBe(false);
  });

  it("checks the Windows root itself, not a reparented descendant", async () => {
    const root = { pid: 91, command: "codex.exe", startedAt: "20260908090000" };
    expect(
      await isProcessRunning(91, {
        platform: "win32",
        captureWindowsChildren: async () => new Map([[1, [root]]]),
      }),
    ).toBe(true);
    expect(
      await isProcessRunning(91, {
        platform: "win32",
        captureWindowsChildren: async () => new Map([[1, [{ ...root, pid: 92 }]]]),
      }),
    ).toBe(false);
    expect(
      await isProcessRunning(91, {
        platform: "win32",
        captureWindowsChildren: async () => null,
      }),
    ).toBe(false);
  });
});
