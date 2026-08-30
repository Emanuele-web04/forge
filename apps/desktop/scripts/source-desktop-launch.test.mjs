import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { spawnSourceDesktop } from "./source-desktop-launch.mjs";

function captureSourceDesktopSpawn(environment) {
  const child = { on: vi.fn() };
  const spawnProcess = vi.fn(() => child);

  const result = spawnSourceDesktop({
    desktopDirectory: "/workspace/apps/desktop",
    electronPath: "/runtime/electron",
    environment,
    homeDirectory: "/Users/tester",
    spawnProcess,
  });

  return { child, result, spawnProcess };
}

describe("source desktop launch", () => {
  it("pins a safe spawned home even when the built main is stale", () => {
    const environment = {
      ELECTRON_RUN_AS_NODE: "1",
      PATH: "/usr/bin",
    };

    const { child, result, spawnProcess } = captureSourceDesktopSpawn(environment);

    expect(result).toBe(child);
    expect(spawnProcess).toHaveBeenCalledWith("/runtime/electron", ["dist-electron/main.js"], {
      cwd: "/workspace/apps/desktop",
      env: {
        PATH: "/usr/bin",
        SYNARA_DESKTOP_FLAVOR: "development",
        SYNARA_HOME: join("/Users/tester", ".synara-dev"),
      },
      stdio: "inherit",
    });
    expect(environment).toEqual({
      ELECTRON_RUN_AS_NODE: "1",
      PATH: "/usr/bin",
    });
  });

  it("preserves an explicit Synara home", () => {
    const { spawnProcess } = captureSourceDesktopSpawn({
      SYNARA_HOME: "/tmp/custom-synara-home",
    });

    expect(spawnProcess.mock.calls[0][2].env).toMatchObject({
      SYNARA_DESKTOP_FLAVOR: "development",
      SYNARA_HOME: "/tmp/custom-synara-home",
    });
  });

  it("preserves Canary flavor and storage defaults", () => {
    const { spawnProcess } = captureSourceDesktopSpawn({
      SYNARA_DESKTOP_FLAVOR: "canary",
    });

    expect(spawnProcess.mock.calls[0][2].env).toMatchObject({
      SYNARA_DESKTOP_FLAVOR: "canary",
      SYNARA_HOME: join("/Users/tester", ".synara-canary"),
    });
  });
});
