import {ThreadId} from "@synara/contracts";
import type {WebContents} from "electron";
import {EventEmitter} from "node:events";
import {describe,expect,it,vi} from "vitest";
import {beginBrowserNavigation} from "./navigationTracker";
import {waitForLoadMilestone,browserEvaluationOutput} from "./waitAndEvaluate";
const THREAD_ID=ThreadId.makeUnsafe("thread-host-results");
const TAB_ID="1193e0d9-eb76-43d2-ae99-6bc14346b3a6";

describe("browser host results",()=>{
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

  it("bounds Betterwright results without evaluating page code",()=>{
    expect(browserEvaluationOutput(TAB_ID,{ok:true})).toMatchObject({value:{ok:true}});
    expect(()=>browserEvaluationOutput(TAB_ID,undefined)).toThrow();
    expect(()=>browserEvaluationOutput(TAB_ID,"x".repeat(262145))).toThrow();
    const cyclic={};cyclic.self=cyclic;
    expect(()=>browserEvaluationOutput(TAB_ID,cyclic)).toThrow();
  });
});
