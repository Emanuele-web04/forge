import { ThreadId } from "@synara/contracts";
import type { WebContents } from "electron";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { beginBrowserNavigation } from "./navigationTracker";
import { waitForLoadMilestone, browserEvaluationOutput } from "./waitAndEvaluate";
const THREAD_ID = ThreadId.makeUnsafe("thread-host-results");
const TAB_ID = "1193e0d9-eb76-43d2-ae99-6bc14346b3a6";

describe("browser host results", () => {
  it.each([true, false])(
    "follows client redirects without accepting stale/iframe lifecycle events (ready=%s)",
    async (ready) => {
      const events = new EventEmitter();
      const sendCommand = vi.fn(async (method: string) => {
        if (method === "Page.getFrameTree")
          return { frameTree: { frame: { id: "main", url: "about:blank" } } };
        if (method === "Page.navigate") {
          events.emit("message", {}, "Page.frameNavigated", {
            frame: { id: "main", loaderId: "initial", url: "https://example.test/signin" },
          });
          events.emit("message", {}, "Page.frameNavigated", {
            frame: { id: "main", loaderId: "redirected", url: "https://example.test/app" },
          });
          events.emit("message", {}, "Page.lifecycleEvent", {
            frameId: "main",
            loaderId: "initial",
            name: "load",
          });
          events.emit("message", {}, "Page.lifecycleEvent", {
            frameId: "iframe",
            loaderId: "redirected",
            name: "load",
          });
          events.emit(
            "message",
            {},
            "Page.lifecycleEvent",
            { frameId: "main", loaderId: "redirected", name: "load" },
            "other-session",
          );
          if (ready)
            events.emit("message", {}, "Page.lifecycleEvent", {
              frameId: "main",
              loaderId: "redirected",
              name: "DOMContentLoaded",
            });
          return { frameId: "main", loaderId: "initial" };
        }
        return {};
      });
      const runtime = {
        threadId: THREAD_ID,
        tabId: TAB_ID,
        webContents: {
          isDestroyed: () => false,
          getURL: () => "https://example.test/app",
          debugger: {
            isAttached: () => true,
            sendCommand,
            on: events.on.bind(events),
            removeListener: events.removeListener.bind(events),
          },
        } as unknown as WebContents,
      };
      const navigation = await beginBrowserNavigation(runtime, "https://example.test/signin");
      const result = waitForLoadMilestone(
        runtime,
        "domcontentloaded",
        80,
        undefined,
        navigation.mark,
      );
      if (ready)
        await expect(result).resolves.toMatchObject({
          url: "https://example.test/app",
          state: "domcontentloaded",
        });
      else await expect(result).rejects.toMatchObject({ browserError: { code: "BrowserTimeout" } });
    },
  );

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

  it("bounds Betterwright results without evaluating page code", () => {
    expect(browserEvaluationOutput(TAB_ID, { ok: true })).toMatchObject({ value: { ok: true } });
    expect(() => browserEvaluationOutput(TAB_ID, undefined)).toThrow();
    expect(() => browserEvaluationOutput(TAB_ID, "x".repeat(262145))).toThrow();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => browserEvaluationOutput(TAB_ID, cyclic)).toThrow();
  });
});
