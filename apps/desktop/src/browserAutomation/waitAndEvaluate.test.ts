import { ThreadId, type BrowserCssSelector } from "@synara/contracts";
import type { WebContents } from "electron";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { beginBrowserNavigation } from "./navigationTracker";
import {
  boundedGlobMatches,
  evaluateBrowserExpression,
  waitForBrowserConditions,
  waitForLoadMilestone,
} from "./waitAndEvaluate";

const THREAD_ID = ThreadId.makeUnsafe("thread-wait-target");
const TAB_ID = "1193e0d9-eb76-43d2-ae99-6bc14346b3a6";

interface TargetState {
  readonly count?: number;
  readonly attached?: boolean;
  readonly visible?: boolean;
  readonly enabled?: boolean;
  readonly credentialSurface?: boolean;
  readonly editable?: boolean;
}

const createRuntime = (state: TargetState): BrowserAutomationVisibleRuntime => {
  const debuggerEvents = new EventEmitter();
  const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 12 };
    if (method === "Page.getLayoutMetrics") {
      return { cssLayoutViewport: { clientWidth: 1024, clientHeight: 768 } };
    }
    if (method === "Runtime.evaluate") {
      const expression = String(params?.expression ?? "");
      if (expression.includes("classifyCredentialInput")) {
        return {
          result: {
            value: state.credentialSurface ? { reason: "password-type", field: "password" } : false,
          },
        };
      }
      if (expression.includes("performance.getEntriesByType")) return { result: { value: 0 } };
      if (expression.includes("document.body?.innerText")) {
        const encodedNeedle = expression.match(/\.includes\((.*)\)$/)?.[1] ?? '""';
        return { result: { value: "Ready for work".includes(JSON.parse(encodedNeedle)) } };
      }
      if (
        expression.includes("state.currentTarget =") ||
        expression.includes("const matches = []")
      ) {
        return { result: { value: { count: state.count ?? 1, generation: 0 } } };
      }
      if (expression.includes("globalThis.__synaraBrowserAutomationV1.currentTarget")) {
        return { result: { objectId: "target-1", type: "object", subtype: "node" } };
      }
      return {
        result: {
          value: {
            url: "https://example.test/",
            title: "Example",
            readyState: "complete",
            deviceScaleFactor: 1,
          },
        },
      };
    }
    if (method === "Runtime.callFunctionOn") {
      return {
        result: {
          value: {
            attached: state.attached ?? true,
            visible: state.visible ?? true,
            enabled: state.enabled ?? true,
            editable: state.editable ?? false,
            role: "button",
            name: "Target",
            point: { x: 50, y: 25 },
          },
        },
      };
    }
    return {};
  });
  const webContents = {
    isDestroyed: () => false,
    getURL: () => "https://example.test/",
    debugger: {
      isAttached: () => true,
      attach: vi.fn(),
      sendCommand,
      on: debuggerEvents.on.bind(debuggerEvents),
      removeListener: debuggerEvents.removeListener.bind(debuggerEvents),
    },
  } as unknown as WebContents;
  return { threadId: THREAD_ID, tabId: TAB_ID, webContents };
};

const target = { selector: "#target" as BrowserCssSelector } as const;

describe("browser_wait URL globs", () => {
  it("matches stars, single-character wildcards, and literal RegExp metacharacters", () => {
    expect(boundedGlobMatches("https://example.test/a/b", "https://*.test/*")).toBe(true);
    expect(boundedGlobMatches("https://example.test/a", "https://example.test/?")).toBe(true);
    expect(boundedGlobMatches("https://example.test/a", "https://example.test/??")).toBe(false);
    expect(boundedGlobMatches("https://example.test/(a)+", "https://example.test/(a)+")).toBe(true);
  });

  it("matches the reference wildcard language exhaustively for small inputs", () => {
    const combinations = (alphabet: readonly string[], maximumLength: number): string[] => {
      const values = [""];
      let frontier = [""];
      for (let length = 1; length <= maximumLength; length += 1) {
        frontier = frontier.flatMap((prefix) => alphabet.map((character) => prefix + character));
        values.push(...frontier);
      }
      return values;
    };
    const referenceMatch = (value: string, glob: string): boolean => {
      const valueCharacters = Array.from(value);
      const pattern = Array.from(glob);
      let states = Array.from({ length: pattern.length + 1 }, (_, index) => index === 0);
      for (let index = 1; index <= pattern.length; index += 1) {
        states[index] = pattern[index - 1] === "*" && states[index - 1] === true;
      }
      for (const character of valueCharacters) {
        const next = Array.from({ length: pattern.length + 1 }, () => false);
        for (let index = 1; index <= pattern.length; index += 1) {
          const token = pattern[index - 1];
          next[index] =
            token === "*"
              ? next[index - 1] === true || states[index] === true
              : states[index - 1] === true && (token === "?" || token === character);
        }
        states = next;
      }
      return states[pattern.length] === true;
    };

    const values = combinations(["a", "b", "🦊"], 3);
    const globs = combinations(["a", "b", "🦊", "*", "?"], 3);
    for (const value of values) {
      for (const glob of globs) {
        expect(boundedGlobMatches(value, glob), JSON.stringify({ value, glob })).toBe(
          referenceMatch(value, glob),
        );
      }
    }
  });

  it("handles every schema-allowed condition at the URL and glob size bounds", () => {
    const value = "a".repeat(8_192);
    const glob = `*${"a".repeat(2_046)}b`;

    for (let index = 0; index < 8; index += 1) {
      expect(boundedGlobMatches(value, glob)).toBe(false);
    }
  });
});

describe("browser_wait target states", () => {
  it("supports a bounded delay condition without leaving the browser wait lifecycle", async () => {
    const runtime = createRuntime({});
    const startedAt = Date.now();

    await expect(
      waitForBrowserConditions(
        runtime,
        {
          mode: "all",
          conditions: [{ kind: "delay", timeMs: 25 }],
        },
        undefined,
        250,
      ),
    ).resolves.toMatchObject({ satisfiedConditionIndexes: [0] });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20);
  });

  it("interrupts a delay condition through the existing abort signal", async () => {
    const runtime = createRuntime({});
    const controller = new AbortController();
    const waiting = waitForBrowserConditions(
      runtime,
      {
        mode: "all",
        conditions: [{ kind: "delay", timeMs: 1_000 }],
      },
      undefined,
      2_000,
      controller.signal,
    );

    setTimeout(() => controller.abort(new Error("turn stopped")), 10);

    await expect(waiting).rejects.toThrow("turn stopped");
  });

  it("treats a hidden disabled element as attached, hidden, and not enabled", async () => {
    const runtime = createRuntime({ visible: false, enabled: false });

    await expect(
      waitForBrowserConditions(
        runtime,
        {
          mode: "any",
          conditions: [
            { kind: "target", target, state: "attached" },
            { kind: "target", target, state: "visible" },
            { kind: "target", target, state: "enabled" },
            { kind: "target", target, state: "hidden" },
          ],
        },
        undefined,
        100,
      ),
    ).resolves.toMatchObject({ satisfiedConditionIndexes: [0, 3] });
  });

  it("observes editable independently from visibility", async () => {
    const runtime = createRuntime({ visible: false, enabled: true, editable: true });

    await expect(
      waitForBrowserConditions(
        runtime,
        {
          mode: "all",
          conditions: [{ kind: "target", target, state: "editable" }],
        },
        undefined,
        100,
      ),
    ).resolves.toMatchObject({ satisfiedConditionIndexes: [0] });
  });

  it("treats a missing target as detached and hidden", async () => {
    const runtime = createRuntime({ count: 0 });

    await expect(
      waitForBrowserConditions(
        runtime,
        {
          mode: "all",
          conditions: [
            { kind: "target", target, state: "detached" },
            { kind: "target", target, state: "hidden" },
          ],
        },
        undefined,
        100,
      ),
    ).resolves.toMatchObject({ satisfiedConditionIndexes: [0, 1] });
  });

  it("evaluates text predicates in the renderer and shares page observations", async () => {
    const runtime = createRuntime({});
    const sendCommand = runtime.webContents.debugger.sendCommand as ReturnType<typeof vi.fn>;

    await expect(
      waitForBrowserConditions(
        runtime,
        {
          mode: "all",
          conditions: [
            { kind: "text", text: "Ready", state: "present" },
            { kind: "text", text: "work", state: "present" },
            { kind: "url", exact: "https://example.test/" },
            { kind: "load", state: "load" },
          ],
        },
        undefined,
        100,
      ),
    ).resolves.toMatchObject({ satisfiedConditionIndexes: [0, 1, 2, 3] });

    const runtimeEvaluations = sendCommand.mock.calls.filter(
      ([method, params]) =>
        method === "Runtime.evaluate" &&
        String((params as Record<string, unknown> | undefined)?.expression ?? "").includes(
          "document.body?.innerText",
        ),
    );
    const pageEvaluations = sendCommand.mock.calls.filter(
      ([method, params]) =>
        method === "Runtime.evaluate" &&
        String((params as Record<string, unknown> | undefined)?.expression ?? "").includes(
          "readyState: document.readyState",
        ),
    );
    expect(runtimeEvaluations).toHaveLength(2);
    expect(pageEvaluations).toHaveLength(1);
  });

  it("derives networkidle from CDP request lifecycle instead of ResourceTiming stability", async () => {
    const debuggerEvents = new EventEmitter();
    const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "main-frame", url: "https://example.test/" } } };
      }
      if (method === "Page.getLayoutMetrics") {
        return { cssLayoutViewport: { clientWidth: 1024, clientHeight: 768 } };
      }
      if (method === "Runtime.evaluate") {
        const expression = String(params?.expression ?? "");
        if (expression.includes("performance.getEntriesByType")) {
          throw new Error("ResourceTiming must not define networkidle");
        }
        return {
          result: {
            value: {
              url: "https://example.test/",
              title: "Example",
              readyState: "complete",
              deviceScaleFactor: 1,
            },
          },
        };
      }
      return {};
    });
    const webContents = {
      isDestroyed: () => false,
      getURL: () => "https://example.test/",
      debugger: {
        isAttached: () => true,
        attach: vi.fn(),
        sendCommand,
        on: debuggerEvents.on.bind(debuggerEvents),
        removeListener: debuggerEvents.removeListener.bind(debuggerEvents),
      },
    } as unknown as WebContents;
    const runtime = { threadId: THREAD_ID, tabId: TAB_ID, webContents };
    const waiting = waitForBrowserConditions(
      runtime,
      {
        mode: "all",
        conditions: [{ kind: "load", state: "networkidle" }],
      },
      undefined,
      1_500,
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    debuggerEvents.emit("message", {}, "Network.requestWillBeSent", {
      requestId: "request-1",
      frameId: "main-frame",
      loaderId: "loader-1",
      type: "Fetch",
      request: { url: "https://example.test/data" },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    debuggerEvents.emit("message", {}, "Network.loadingFinished", { requestId: "request-1" });

    await expect(waiting).resolves.toMatchObject({
      satisfiedConditionIndexes: [0],
      observed: { loadState: "networkidle" },
    });
    expect(sendCommand).not.toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({
        expression: expect.stringContaining("performance.getEntriesByType"),
      }),
    );
  });

  it("treats a committed same-document navigation as an already loaded document", async () => {
    let url = "https://example.test/page";
    const debuggerEvents = new EventEmitter();
    const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "main-frame", url } } };
      }
      if (method === "Page.navigate") {
        url = String(params?.url ?? url);
        queueMicrotask(() =>
          debuggerEvents.emit("message", {}, "Page.navigatedWithinDocument", {
            frameId: "main-frame",
            url,
            navigationType: "fragment",
          }),
        );
        return { frameId: "main-frame" };
      }
      return {};
    });
    const webContents = {
      isDestroyed: () => false,
      getURL: () => url,
      debugger: {
        isAttached: () => true,
        attach: vi.fn(),
        sendCommand,
        on: debuggerEvents.on.bind(debuggerEvents),
        removeListener: debuggerEvents.removeListener.bind(debuggerEvents),
      },
    } as unknown as WebContents;
    const runtime = { threadId: THREAD_ID, tabId: TAB_ID, webContents };

    const navigation = await beginBrowserNavigation(runtime, "https://example.test/page#details");
    await expect(
      waitForLoadMilestone(runtime, "domcontentloaded", 100, undefined, navigation.mark),
    ).resolves.toMatchObject({
      url: "https://example.test/page#details",
      state: "load",
    });
  });
});

describe("browser_evaluate credential boundary", () => {
  it("does not expose an alternate credential entry channel", async () => {
    const runtime = createRuntime({ credentialSurface: true });

    await expect(
      evaluateBrowserExpression(runtime, {
        idempotencyKey: "credential-evaluation" as never,
        expression: "document.querySelector('input').value = 'secret'; true",
      }),
    ).rejects.toMatchObject({
      browserError: { code: "BrowserCredentialInputRequired" },
      credentialContext: { reason: "password-type", field: "password" },
    });
  });
});
