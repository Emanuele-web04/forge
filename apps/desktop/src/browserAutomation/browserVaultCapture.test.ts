import { EventEmitter } from "node:events";
import type { BrowserVaultSnapshot } from "@synara/contracts";
import type { CaptureContext } from "betterwright/capture";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import type { BrowserVault } from "./browserVault";

const mocks = vi.hoisted(() => ({ install: vi.fn(), dispose: vi.fn() }));
vi.mock("betterwright/capture", () => ({ installVaultCapture: mocks.install }));
import { BrowserVaultCapture } from "./browserVaultCapture";

beforeEach(() => { vi.clearAllMocks(); mocks.dispose.mockResolvedValue(undefined); mocks.install.mockReturnValue({ dispose: mocks.dispose }); });

function fixture() {
  let changed = () => {};
  let state: BrowserVaultSnapshot = { protection: { configured: true, locked: false, osProtected: false }, settings: { offerSave: false, autosave: false, agentUse: true }, logins: [], pending: [], error: null };
  const vault = { snapshot: async () => state, onChanged: (listener: () => void) => { changed = listener; return () => { changed = () => {}; }; }, reportCaptureFailure: vi.fn() };
  const capture = new BrowserVaultCapture(vault as unknown as BrowserVault);
  return { capture, vault, update: (patch: Partial<BrowserVaultSnapshot>) => { state = { ...state, ...patch }; changed(); } };
}

describe("native credential capture lifecycle", () => {
  it("does not install sensors without consent and removes them when the vault locks", async () => {
    const f = fixture();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.install).not.toHaveBeenCalled();
    f.update({ settings: { offerSave: true, autosave: false, agentUse: true } });
    await vi.waitFor(() => expect(mocks.install).toHaveBeenCalledTimes(1));
    f.update({ protection: { configured: true, locked: true, osProtected: false } });
    await vi.waitFor(() => expect(mocks.dispose).toHaveBeenCalledTimes(1));
    await f.capture.dispose();
  });

  it("uses a dedicated debugger session and cleans up only its own listeners", async () => {
    const f = fixture();
    f.update({ settings: { offerSave: true, autosave: false, agentUse: true } });
    await vi.waitFor(() => expect(mocks.install).toHaveBeenCalled());
    const context = mocks.install.mock.calls[0]![0] as CaptureContext;
    const debuggerApi = Object.assign(new EventEmitter(), {
      isAttached: () => true,
      sendCommand: vi.fn(async (method: string) => method === "Target.getTargetInfo" ? { targetInfo: { targetId: "own-target" } } : { sessionId: "capture-session" }),
    });
    const unregister = f.capture.register({ webContents: { debugger: debuggerApi, isDestroyed: () => false } } as unknown as BrowserAutomationVisibleRuntime);
    const session = await context.newCDPSession(context.pages()[0]!);
    const listener = vi.fn();
    session.on("Runtime.bindingCalled", listener);
    debuggerApi.emit("message", {}, "Runtime.bindingCalled", {}, "foreign-session");
    expect(listener).not.toHaveBeenCalled();
    debuggerApi.emit("message", {}, "Runtime.bindingCalled", {}, "capture-session");
    expect(listener).toHaveBeenCalledTimes(1);
    await session.detach();
    expect(debuggerApi.listenerCount("message")).toBe(0);
    expect(debuggerApi.sendCommand).toHaveBeenLastCalledWith("Target.detachFromTarget", { sessionId: "capture-session" });
    unregister();
    expect(context.pages()).toEqual([]);
    await f.capture.dispose();
  });
});
