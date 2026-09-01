import { describe, expect, it } from "vitest";

import {
  captureProcessTree,
  inspectProcessTree,
  type ProcessChildrenMap,
} from "./processTreeController";

function windowsTree(): ProcessChildrenMap {
  return new Map([
    [
      100,
      [{ pid: 101, command: "provider-child.exe --serve", startedAt: "20260901100000.000000+000" }],
    ],
    [
      101,
      [{ pid: 102, command: "provider-grandchild.exe", startedAt: "20260901100001.000000+000" }],
    ],
  ]);
}

describe("Windows process-tree controller", () => {
  it("captures child and grandchild identities from one platform snapshot", async () => {
    await expect(
      captureProcessTree(100, {
        platform: "win32",
        captureWindowsChildren: async () => windowsTree(),
      }),
    ).resolves.toEqual({
      captureComplete: true,
      descendants: [
        { pid: 101, command: "provider-child.exe --serve", startedAt: "20260901100000.000000+000" },
        { pid: 102, command: "provider-grandchild.exe", startedAt: "20260901100001.000000+000" },
      ],
    });
  });

  it("treats a failed Windows snapshot as unknown, never an empty proven tree", async () => {
    const captured = await captureProcessTree(100, {
      platform: "win32",
      captureWindowsChildren: async () => null,
    });

    expect(captured).toEqual({ descendants: [], captureComplete: false });
    await expect(
      inspectProcessTree(captured, {
        platform: "win32",
        captureWindowsChildren: async () => new Map(),
      }),
    ).resolves.toEqual({ verified: false, survivors: [] });
  });

  it("rejects a reused Windows PID when the creation identity changed", async () => {
    const tree = await captureProcessTree(100, {
      platform: "win32",
      captureWindowsChildren: async () => windowsTree(),
    });
    const reused: ProcessChildrenMap = new Map([
      [
        900,
        [
          {
            pid: 101,
            command: "provider-child.exe --serve",
            startedAt: "20260901110000.000000+000",
          },
        ],
      ],
    ]);

    await expect(
      inspectProcessTree(tree, {
        platform: "win32",
        captureWindowsChildren: async () => reused,
      }),
    ).resolves.toEqual({ verified: true, survivors: [] });
  });

  it("reports only descendants whose command and creation identity still match", async () => {
    const tree = await captureProcessTree(100, {
      platform: "win32",
      captureWindowsChildren: async () => windowsTree(),
    });
    const current: ProcessChildrenMap = new Map([
      [
        900,
        [{ pid: 102, command: "provider-grandchild.exe", startedAt: "20260901100001.000000+000" }],
      ],
    ]);

    await expect(
      inspectProcessTree(tree, {
        platform: "win32",
        captureWindowsChildren: async () => current,
      }),
    ).resolves.toEqual({
      verified: true,
      survivors: [
        { pid: 102, command: "provider-grandchild.exe", startedAt: "20260901100001.000000+000" },
      ],
    });
  });
});
