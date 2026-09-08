/**
 * Tier 3 end to end, against a real compositor.
 *
 * Off unless `SYNARA_NESTED_KWIN_TEST` is set: it spawns kwin_wayland and a
 * session bus, which no ordinary test run or CI runner without KWin can do.
 * Everything it starts lives on a private bus and an invisible virtual output,
 * so it never touches the desktop the developer is sitting in.
 *
 *   SYNARA_NESTED_KWIN_TEST=1 bunx vitest run src/computer/nestedKWinSession.integration.test.ts
 */
import { execFileSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { KWinComputerBackend } from "./KWinComputerBackend.ts";
import {
  nestedKWinBackendOptions,
  startNestedKWinSession,
  type NestedKWinSession,
} from "./nestedKWinSession.ts";

const NESTED_SIZE = { width: 1_280, height: 800 };
const BOOT_TIMEOUT_MS = 90_000;
const WINDOW_TIMEOUT_MS = 30_000;
const POLL_MS = 250;
const TEST_APP = "kcalc";

describe.skipIf(!process.env.SYNARA_NESTED_KWIN_TEST)("nested KWin session", () => {
  let session: NestedKWinSession | undefined;
  let backend: KWinComputerBackend | undefined;
  const appInstalled = commandExists(TEST_APP);

  beforeAll(async () => {
    session = await startNestedKWinSession({ size: NESTED_SIZE });
    backend = new KWinComputerBackend(nestedKWinBackendOptions(session));
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await backend?.dispose();
    await session?.dispose();
  });

  it("comes up with exactly one plugin loaded and reports availability", async () => {
    expect(session?.pluginId).toMatch(/^SynaraComputerUsePlugin/);
    await expect(backend!.availability()).resolves.toEqual({ kind: "available", backend: "kwin" });
    expect(backend!.health().status).toBe("connected");
  });

  it("reports the requested virtual geometry", async () => {
    await expect(backend!.getScreenSize()).resolves.toMatchObject(NESTED_SIZE);
  });

  it("lists windows, of which an empty desktop has none", async () => {
    await expect(backend!.listWindows()).resolves.toEqual([]);
  });

  it.skipIf(!appInstalled)(
    "launches an app into the nested session and sees its window",
    async () => {
      await backend!.launchApp(TEST_APP, []);
      const window = await waitFor(async () => {
        const windows = await backend!.listWindows();
        return windows.find((candidate) => candidate.appName?.includes(TEST_APP));
      }, WINDOW_TIMEOUT_MS);
      // KWin is the one compositor that always reports geometry, so a nested
      // session missing it is a regression in the plugin, not a capability gap.
      const bounds = window?.bounds;
      expect(bounds).toBeDefined();
      expect(bounds!.width).toBeGreaterThan(0);
      // The virtual output is the only screen, so the window is inside it.
      expect(bounds!.x).toBeLessThan(NESTED_SIZE.width);
    },
    WINDOW_TIMEOUT_MS + 10_000,
  );

  it("captures the workspace when the loaded plugin supports capture", async (context) => {
    if (!backend!.health().captureAvailable) context.skip();
    const screenshot = await backend!.captureScreenshot({
      kind: "region",
      region: { x: 0, y: 0, ...NESTED_SIZE },
    });
    expect(screenshot.mimeType).toBe("image/png");
    expect(screenshot.width).toBeGreaterThan(0);
    expect(screenshot.height).toBeGreaterThan(0);
  });

  /** The nested compositor has its own seat0, so its clipboard is its own too. */
  it.skipIf(!commandExists("wl-copy"))("round-trips the nested clipboard", async () => {
    await backend!.writeClipboard("nested clipboard");
    await expect(backend!.readClipboard()).resolves.toBe("nested clipboard");
  });

  /**
   * A nested compositor dies the way a real one does: the private bus outlives
   * it, so this backend's connection stays open and only KWin's names vanish.
   * Health therefore turns over on the next call, not on the kill itself, which
   * is the same behaviour a KWin crash has in the user's own session.
   */
  it("surfaces a compositor crash as lost health rather than a fresh desktop", async () => {
    expect(backend!.health().status).toBe("connected");
    execFileSync("pkill", ["-f", session!.waylandDisplay]);
    const health = await waitFor(async () => {
      await backend!.listWindows().catch(() => undefined);
      const current = backend!.health();
      return current.status === "connected" ? undefined : current;
    }, WINDOW_TIMEOUT_MS);
    expect(health.status).toBe("reconnecting");
    expect(health.captureAvailable).toBe(false);
    expect(health.lastFailure?.message).toMatch(/org\.kde\.KWin|org\.synara\.ComputerUse/);
    // The dead compositor is never replaced, so no empty desktop stands in.
    await expect(backend!.listWindows()).rejects.toThrow();
  }, 60_000);
});

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs} ms.`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function commandExists(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}
