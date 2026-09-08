/**
 * The real macOS helper, end to end, over its real JSON-RPC stdio protocol.
 *
 * **Perception only.** This test never sends an input RPC — no `move`, `click`,
 * `double-click`, `right-click`, `drag`, `scroll`, `type`, `press-key`,
 * `hotkey`, `set-value`, `perform-action`, `focus-window`, `raise-window`,
 * `write-clipboard`, `launch-app` or `set-agent-cursor` — so it is safe to run
 * against the desktop the developer is sitting in. It talks to
 * `MacComputerHelperClient` directly rather than to `MacComputerBackend`, so no
 * lease is taken, no still-frame loop starts, and nothing touches focus; the
 * helper's agent-cursor overlay exists but stays hidden, because it is only
 * shown by `set-agent-cursor`, which is in the forbidden set below.
 * `FORBIDDEN_METHODS` is asserted against every request the test makes, so a
 * future edit cannot quietly add one.
 *
 * What it is for: the helper `dlsym`s private SkyLight SPI and links
 * ScreenCaptureKit, and the parsers on the Node side (`parseWindows`,
 * `parseMacUiForest`, `readPngDimensions`) encode assumptions about what the
 * Swift answers with. Unit tests cover both sides against fixtures; only this
 * covers the seam.
 *
 * Off unless `SYNARA_MAC_HELPER_TEST` is set, and skipped when no helper binary
 * can be found. Build one first:
 *
 *   bash apps/server/native/computer-use-macos/build.sh /tmp/synara-helper
 *   SYNARA_MAC_HELPER_TEST=1 \
 *   SYNARA_MAC_HELPER_BINARY=/tmp/synara-helper/synara-computer-helper \
 *   bun run --cwd apps/server test src/computer/macComputerHelper.integration.test.ts
 *
 * Grants are not a precondition. A runner has neither Accessibility nor Screen
 * Recording, and the helper answers `-32000` for the calls that need them; the
 * assertions that depend on a grant report a skip instead of failing, so the
 * same file is meaningful on CI (as a symbol tripwire) and on a granted Mac (as
 * a parser contract).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  COMPUTER_HELPER_BUNDLE_EXECUTABLE_SEGMENTS,
  COMPUTER_HELPER_PACKAGED_SEGMENTS,
} from "@synara/shared/computerHelperPaths";
import { afterAll, describe, expect, it } from "vitest";

import { parseWindows, readPngDimensions } from "./computerGeometry.ts";
import {
  MAC_HELPER_METHODS,
  MacComputerHelperClient,
  MacComputerHelperError,
} from "./macComputerHelperClient.ts";
import { parseMacUiForest } from "./macUiTree.ts";

/**
 * Every RPC that moves the pointer, presses a key, changes focus or writes
 * anything. Asserted on each call rather than trusted to review: this file's
 * one safety property is that it drives nobody's desktop, and that property has
 * to survive people editing it.
 */
const FORBIDDEN_METHODS: ReadonlySet<string> = new Set([
  MAC_HELPER_METHODS.move,
  MAC_HELPER_METHODS.click,
  MAC_HELPER_METHODS.doubleClick,
  MAC_HELPER_METHODS.rightClick,
  MAC_HELPER_METHODS.drag,
  MAC_HELPER_METHODS.scroll,
  MAC_HELPER_METHODS.type,
  MAC_HELPER_METHODS.pressKey,
  MAC_HELPER_METHODS.hotkey,
  MAC_HELPER_METHODS.setValue,
  MAC_HELPER_METHODS.performAction,
  MAC_HELPER_METHODS.focusWindow,
  MAC_HELPER_METHODS.writeClipboard,
  MAC_HELPER_METHODS.launchApp,
  MAC_HELPER_METHODS.setAgentCursor,
  MAC_HELPER_METHODS.requestPermissions,
  // Not in MAC_HELPER_METHODS (nothing calls it), and named here so it cannot
  // be reached by spelling the wire method out by hand either.
  "raise-window",
]);

/** `RPCError.permissionDenied`, as the client wraps it. A missing TCC grant, not a failure. */
const PERMISSION_DENIED = "helper_-32000";

/**
 * Whether anything on this host can capture the screen at all.
 *
 * A CI runner, and any process tree that was never granted Screen Recording,
 * fails every capture regardless of what the helper does — and the helper's own
 * `CGPreflightScreenCaptureAccess()` cannot say so, because TCC answers it for
 * the *responsible* process (the terminal, or Synara.app) rather than for the
 * subprocess that will actually take the picture. Asking macOS's own
 * `screencapture` is the discriminator: if it cannot capture either, the host is
 * the problem and the assertions are skipped; if it can and the helper cannot,
 * that is a regression and the test says so.
 *
 * Two pixels, into a temp file that is deleted immediately.
 */
function hostCanCaptureScreen(): boolean {
  const probe = join(mkdtempSync(join(tmpdir(), "synara-capture-probe-")), "probe.png");
  try {
    const result = spawnSync("screencapture", ["-x", "-R", "0,0,2,2", probe], {
      encoding: "utf8",
    });
    return result.status === 0 && existsSync(probe);
  } catch {
    return false;
  } finally {
    rmSync(dirname(probe), { recursive: true, force: true });
  }
}

function resolveHelperBinary(): string | null {
  const configured = process.env.SYNARA_MAC_HELPER_BINARY?.trim();
  if (configured) return existsSync(configured) ? configured : null;
  // The installed app's own signed helper, so a developer with Synara in
  // ~/Applications needs no environment at all.
  const installed = join(
    homedir(),
    "Applications",
    "Synara.app",
    ...COMPUTER_HELPER_PACKAGED_SEGMENTS,
    ...COMPUTER_HELPER_BUNDLE_EXECUTABLE_SEGMENTS,
  );
  return existsSync(installed) ? installed : null;
}

const helperBinary = process.platform === "darwin" ? resolveHelperBinary() : null;
const enabled =
  process.platform === "darwin" &&
  Boolean(process.env.SYNARA_MAC_HELPER_TEST) &&
  helperBinary !== null;

if (process.platform === "darwin" && process.env.SYNARA_MAC_HELPER_TEST && !helperBinary) {
  console.warn(
    "[mac-helper-integration] No helper binary found. Set SYNARA_MAC_HELPER_BINARY or install Synara.app.",
  );
}

describe.skipIf(!enabled)("macOS computer-use helper (perception only)", () => {
  const client = new MacComputerHelperClient({
    binaryPath: helperBinary ?? "",
    onDiagnostic: (message) => console.warn(`[mac-helper-integration] ${message}`),
  });

  /** Every request goes through here, so the forbidden set is enforced, not documented. */
  const perceive = async (method: string, params: Record<string, unknown> = {}) => {
    if (FORBIDDEN_METHODS.has(method)) {
      throw new Error(`This test must never call '${method}': it would drive the user's desktop.`);
    }
    return await client.request(method, params);
  };

  /**
   * Runs a perception call that needs a TCC grant the host may not have.
   * Returns null on `-32000` after saying so, which is the honest outcome on a
   * CI runner and a real failure nowhere.
   */
  const perceiveIfGranted = async (method: string, params: Record<string, unknown> = {}) => {
    try {
      return await perceive(method, params);
    } catch (error) {
      if (error instanceof MacComputerHelperError && error.code === PERMISSION_DENIED) {
        console.warn(
          `[mac-helper-integration] '${method}' needs a TCC grant this host does not have; skipping its assertions.`,
        );
        return null;
      }
      throw error;
    }
  };

  afterAll(async () => {
    await client.dispose();
  });

  it("spawns, frames a request and answers ping", async () => {
    const started = Date.now();
    // The first request pays the spawn, the "ready" notification and the
    // protocol handshake; a helper that cannot come up in seconds on an idle
    // machine is not one the backend's 15 s request budget can absorb.
    const response = (await perceive("ping")) as Record<string, unknown>;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(response.ok).toBe(true);
    expect(response.pid).toBeTypeOf("number");
  });

  it("reports its identity and every SkyLight capability as a boolean", async () => {
    // The symbol tripwire: these come from `dlsym` against private WindowServer
    // entry points, and a renamed symbol shows up here as `false` long before it
    // shows up as a desktop nobody can drive.
    const report = (await perceive(MAC_HELPER_METHODS.capabilities)) as Record<string, unknown>;
    expect(report.protocolVersion).toBe(1);
    expect(typeof report.arch).toBe("string");
    expect(report.macosVersion).toMatch(/^\d+\.\d+(\.\d+)?$/);
    expect(["adhoc", "signed"]).toContain(report.signature);
    const skylight = report.skylight as Record<string, unknown>;
    expect(skylight).toBeTypeOf("object");
    for (const capability of [
      "setWindowLocation",
      "focusWithoutRaise",
      "setFrontProcess",
      "keyWindowRecord",
    ]) {
      expect(typeof skylight[capability], `skylight.${capability}`).toBe("boolean");
    }
    // Everything except `keyWindowRecord`, which SkyLight.swift disables on
    // macOS 14 by design, must have resolved.
    expect(skylight.setWindowLocation).toBe(true);
    expect(skylight.focusWithoutRaise).toBe(true);
    expect(skylight.setFrontProcess).toBe(true);
  });

  it("reports a usable workspace rect", async () => {
    const size = (await perceive(MAC_HELPER_METHODS.screenSize)) as Record<string, number>;
    expect(size.width).toBeGreaterThanOrEqual(1);
    expect(size.height).toBeGreaterThanOrEqual(1);
    expect(size.scale).toBeGreaterThan(0);
  });

  it("enumerates windows that survive the backend's parser", async () => {
    const payload = (await perceiveIfGranted(MAC_HELPER_METHODS.listWindows)) as Record<
      string,
      unknown
    > | null;
    if (payload === null) return;
    const focusedWindowId =
      typeof payload.focusedWindowId === "string" ? payload.focusedWindowId : null;
    const windows = parseWindows(payload.windows, focusedWindowId);
    // An empty desktop is a legitimate answer on a headless runner; what must
    // hold is that nothing the helper emitted was dropped or malformed.
    const rawCount = Array.isArray(payload.windows) ? payload.windows.length : 0;
    expect(windows).toHaveLength(rawCount);
    for (const window of windows) {
      expect(window.id).not.toBe("");
      // `parseWindows` drops any entry without bounds, so a parsed window
      // always has them; asserting it keeps that contract visible here.
      expect(window.bounds).toBeDefined();
      expect(window.bounds?.width).toBeGreaterThanOrEqual(0);
      expect(window.bounds?.height).toBeGreaterThanOrEqual(0);
    }
  });

  it("describes the accessibility forest into a ComputerUiNode", async () => {
    const payload = await perceiveIfGranted(MAC_HELPER_METHODS.describeUi);
    if (payload === null) return;
    const root = parseMacUiForest(payload, undefined, { x: 0, y: 0 });
    // Without the Accessibility grant the helper answers a well-formed but
    // childless desktop, which still proves the shape the parser expects.
    expect(root).toBeDefined();
    expect(root?.role).toBeTypeOf("string");
  });

  it.skipIf(!hostCanCaptureScreen())(
    "captures a small region as a PNG whose geometry round-trips",
    async () => {
      // At the workspace origin, not at (0, 0): a second display placed above or
      // left of the main one puts the origin somewhere negative, and a region
      // outside every display is a request no capture backend can serve.
      const workspace = (await perceive(MAC_HELPER_METHODS.screenSize)) as Record<string, number>;
      const requested = {
        x: workspace.x ?? 0,
        y: workspace.y ?? 0,
        width: 200,
        height: 200,
      };
      const payload = (await perceiveIfGranted(MAC_HELPER_METHODS.capture, {
        kind: "region",
        region: requested,
        maxDimension: 256,
      })) as Record<string, unknown> | null;
      if (payload === null) return;
      const bytes = Buffer.from(String(payload.base64), "base64");
      const dimensions = readPngDimensions(new Uint8Array(bytes), {
        source: "mac helper integration test",
      });
      expect(dimensions.width).toBeGreaterThan(0);
      expect(dimensions.width).toBeLessThanOrEqual(256);
      expect(dimensions.height).toBeLessThanOrEqual(256);
      const region = payload.region as Record<string, number>;
      expect(region.x).toBe(requested.x);
      expect(region.y).toBe(requested.y);
      // The helper may clip the request to the display; it must never return a
      // region larger than what was asked for, which is the bug that puts every
      // subsequent coordinate off by the difference.
      expect(region.width).toBeLessThanOrEqual(requested.width);
      expect(region.height).toBeLessThanOrEqual(requested.height);
      expect(["screencapturekit", "screencapture"]).toContain(String(payload.source));
    },
  );
  it.skipIf(!hostCanCaptureScreen())(
    "forces complete PNGs after native still deduplication",
    async () => {
      const workspace = (await perceive(MAC_HELPER_METHODS.screenSize)) as Record<string, number>;
      const params = {
        kind: "region",
        region: { x: workspace.x ?? 0, y: workspace.y ?? 0, width: 200, height: 200 },
        maxDimension: 128,
        deduplicate: true,
      };
      const first = (await perceiveIfGranted(MAC_HELPER_METHODS.capture, {
        ...params,
        force: true,
      })) as Record<string, unknown> | null;
      if (!first) return;
      expect(first.unchanged).toBe(false);
      expect(
        readPngDimensions(Buffer.from(String(first.base64), "base64"), {
          source: "native keyframe",
        }).width,
      ).toBeGreaterThan(0);
      const next = (await perceive(MAC_HELPER_METHODS.capture, {
        ...params,
        force: false,
      })) as Record<string, unknown>;
      // The real desktop may animate between captures. Either answer is valid,
      // but unchanged must not carry an encoded image.
      if (next.unchanged === true) expect(next.base64).toBeNull();
      else expect(next.base64).toBeTypeOf("string");
      const forced = (await perceive(MAC_HELPER_METHODS.capture, {
        ...params,
        force: true,
      })) as Record<string, unknown>;
      expect(forced.unchanged).toBe(false);
      expect(
        readPngDimensions(Buffer.from(String(forced.base64), "base64"), {
          source: "native forced keyframe",
        }).width,
      ).toBeGreaterThan(0);
    },
  );
});
