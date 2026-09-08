import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { BetterwrightCdpTarget } from "./betterwrightCdp";
import type { BrowserAutomationVisibleRuntime } from "../browserManager";

const focusState = vi.hoisted(() => ({ current: null as WebContents | null }));
vi.mock("electron", () => ({ webContents: { getFocusedWebContents: () => focusState.current } }));

function fixture(
  uploadFiles: readonly string[] = [],
  backendSessionId?: string,
  cookieImport = false,
  expectInput?: BrowserAutomationVisibleRuntime["expectAgentInput"],
) {
  focusState.current = null;
  const debuggerApi = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    sendCommand: vi.fn(
      async (_method: string, _params?: Record<string, unknown>, _sessionId?: string) => ({}),
    ),
    detach: vi.fn(),
  });
  const contents = {
    debugger: debuggerApi,
    isDestroyed: () => false,
    getURL: () => "https://fixture.example/",
    getTitle: () => "Fixture",
    getType: vi.fn(() => "browserView"),
    close: vi.fn(),
    focus: vi.fn(() => {
      focusState.current = contents as unknown as WebContents;
    }),
  };
  const messages: Record<string, unknown>[] = [];
  const target = new BetterwrightCdpTarget(
    contents as unknown as WebContents,
    (message) => messages.push({ ...message }),
    undefined,
    undefined,
    new Set(uploadFiles),
    backendSessionId,
    cookieImport,
    expectInput,
  );
  return { contents, target, messages, debuggerApi };
}

describe("Betterwright target boundary", () => {
  it("drains pending renderer focus and skips input after cancellation", async () => {
    const f = fixture([], "backend");
    f.contents.getType.mockReturnValue("webview");
    let focused!: (value: boolean) => void;
    const host = {
      isDestroyed: () => false,
      executeJavaScript: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              focused = resolve;
            }),
        )
        .mockResolvedValue(undefined),
    };
    Object.assign(f.contents, { id: 42, hostWebContents: host });
    await f.target.receive({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: f.target.targetId },
    });
    const sessionId = (f.messages[0]!.result as { sessionId: string }).sessionId;
    const input = f.target.receive({
      id: 2,
      sessionId,
      method: "Input.insertText",
      params: { text: "must-not-type" },
    });
    await vi.waitFor(() => expect(focused).toBeTypeOf("function"));
    let drained = false;
    const disposal = f.target.dispose(false).then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(drained).toBe(false);
    focused(true);
    await Promise.all([input, disposal]);
    expect(host.executeJavaScript).toHaveBeenCalledTimes(2);
    expect(
      f.debuggerApi.sendCommand.mock.calls.some(([method]) => method.startsWith("Input.")),
    ).toBe(false);
  });

  it.each([false, true])(
    "serializes native focus across targets and skips revoked queued work (%s)",
    async (cancelQueued) => {
      const first = fixture([], "first-backend");
      const second = fixture([], "second-backend");
      for (const f of [first, second])
        await f.target.receive({
          id: 1,
          method: "Target.attachToTarget",
          params: { targetId: f.target.targetId },
        });
      const firstSession = (first.messages[0]!.result as { sessionId: string }).sessionId;
      const secondSession = (second.messages[0]!.result as { sessionId: string }).sessionId;
      const host = {
        isDestroyed: () => false,
        focus: vi.fn(() => {
          focusState.current = host as unknown as WebContents;
        }),
      };
      focusState.current = host as unknown as WebContents;
      let finish!: (value: {}) => void;
      first.debuggerApi.sendCommand.mockImplementation((method) => {
        if (method !== "Input.insertText") return Promise.resolve({});
        expect(focusState.current).toBe(first.contents);
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      second.debuggerApi.sendCommand.mockImplementation(async (method) => {
        if (method === "Input.insertText") expect(focusState.current).toBe(second.contents);
        return {};
      });
      const a = first.target.receive({
        id: 2,
        sessionId: firstSession,
        method: "Input.insertText",
        params: { text: "first" },
      });
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      const b = second.target.receive({
        id: 2,
        sessionId: secondSession,
        method: "Input.insertText",
        params: { text: "second" },
      });
      await Promise.resolve();
      expect(second.contents.focus).not.toHaveBeenCalled();
      expect(focusState.current).toBe(first.contents);
      if (cancelQueued) await second.target.dispose(false);
      finish({});
      await Promise.all([a, b]);
      expect(focusState.current).toBe(host);
      expect(second.contents.focus).toHaveBeenCalledTimes(cancelQueued ? 0 : 1);
      if (cancelQueued) {
        expect(second.messages.find((message) => message.id === 2)).toHaveProperty("error");
        expect(
          second.debuggerApi.sendCommand.mock.calls.some(
            ([method]) => method === "Input.insertText",
          ),
        ).toBe(false);
      }
      await first.target.dispose(false);
      await second.target.dispose(false);
    },
  );

  it.each(["Input.insertText", "Input.dispatchKeyEvent"])(
    "scopes %s to the guest and restores the host focus afterward",
    async (method) => {
      const f = fixture();
      const host = {
        isDestroyed: () => false,
        focus: vi.fn(() => {
          focusState.current = host as unknown as WebContents;
        }),
      };
      focusState.current = host as unknown as WebContents;
      await f.target.receive({
        id: 1,
        method: "Target.attachToTarget",
        params: { targetId: f.target.targetId },
      });
      const sessionId = (f.messages[0]!.result as { sessionId: string }).sessionId;
      f.debuggerApi.sendCommand.mockImplementation(async () => {
        expect(focusState.current).toBe(f.contents);
        return {};
      });
      await f.target.receive({
        id: 2,
        sessionId,
        method,
        params: { type: "keyDown", key: "a", text: "a" },
      });
      expect(f.contents.focus).toHaveBeenCalledOnce();
      expect(host.focus).toHaveBeenCalledOnce();
      expect(focusState.current).toBe(host);
      f.debuggerApi.sendCommand.mockResolvedValue({});
      await f.target.dispose(false);
    },
  );

  it.each(["user moved focus", "host destroyed", "dispatch failed"])(
    "cleans up keyboard focus safely when %s",
    async (outcome) => {
      const f = fixture();
      let destroyed = false;
      const host = { isDestroyed: () => destroyed, focus: vi.fn() };
      focusState.current = host as unknown as WebContents;
      await f.target.receive({
        id: 1,
        method: "Target.attachToTarget",
        params: { targetId: f.target.targetId },
      });
      const sessionId = (f.messages[0]!.result as { sessionId: string }).sessionId;
      f.debuggerApi.sendCommand.mockImplementationOnce(async () => {
        if (outcome === "user moved focus") focusState.current = null;
        if (outcome === "host destroyed") destroyed = true;
        if (outcome === "dispatch failed") throw new Error("Input failed");
        return {};
      });
      await f.target.receive({
        id: 2,
        sessionId,
        method: "Input.insertText",
        params: { text: "synthetic" },
      });
      expect(host.focus).toHaveBeenCalledTimes(outcome === "dispatch failed" ? 1 : 0);
      await f.target.dispose(false);
    },
  );
  it("blocks app shortcuts before provenance or dispatch across session aliases", async () => {
    const expected = vi.fn();
    const f = fixture([], undefined, false, expected);
    const sessions: string[] = [];
    for (let id = 1; id <= 2; id++) {
      await f.target.receive({
        id,
        method: "Target.attachToTarget",
        params: { targetId: f.target.targetId },
      });
      sessions.push((f.messages.at(-1)!.result as { sessionId: string }).sessionId);
    }
    await f.target.receive({
      id: 3,
      sessionId: sessions[0]!,
      method: "Input.dispatchKeyEvent",
      params: { type: "rawKeyDown", key: "Meta", code: "MetaLeft", modifiers: 4 },
    });
    f.debuggerApi.sendCommand.mockClear();
    expected.mockClear();
    for (const params of [
      { type: "rawKeyDown", key: "w", modifiers: 0 },
      { type: "char", key: "a", commands: ["selectAll", "unknown"] },
    ]) {
      await f.target.receive({
        id: 4,
        sessionId: sessions[1]!,
        method: "Input.dispatchKeyEvent",
        params,
      });
      expect(f.messages.at(-1)).toHaveProperty("error");
    }
    expect(f.debuggerApi.sendCommand).not.toHaveBeenCalled();
    expect(expected).not.toHaveBeenCalled();
    await f.target.receive({
      id: 5,
      sessionId: sessions[0]!,
      method: "Input.dispatchKeyEvent",
      params: { type: "keyUp", key: "Meta", code: "MetaLeft" },
    });
    await f.target.receive({
      id: 6,
      sessionId: sessions[1]!,
      method: "Input.insertText",
      params: { text: "Synthetic text" },
    });
    expect(f.messages.at(-1)).toHaveProperty("result");
    await f.target.dispose(false);
  });
  it("preserves the upstream movement, key and wheel command sequence and parameters", async () => {
    const f = fixture();
    await f.target.receive({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: f.target.targetId },
    });
    const sessionId = (f.messages[0]!.result as { sessionId: string }).sessionId;
    const commands = [
      {
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseMoved", x: 21.4, y: 32.8, timestamp: 1, button: "none" },
      },
      {
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseMoved", x: 35.6, y: 43.2, timestamp: 1.011, button: "none" },
      },
      {
        method: "Input.dispatchMouseEvent",
        params: {
          type: "mousePressed",
          x: 35.6,
          y: 43.2,
          timestamp: 1.095,
          button: "left",
          clickCount: 1,
        },
      },
      {
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseReleased", x: 35.6, y: 43.2, timestamp: 1.164, button: "left" },
      },
      {
        method: "Input.dispatchKeyEvent",
        params: { type: "keyDown", key: "a", text: "a", timestamp: 1.243, modifiers: 0 },
      },
      {
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseWheel", x: 35.6, y: 43.2, deltaX: 0, deltaY: 12, timestamp: 1.292 },
      },
      {
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseWheel", x: 35.6, y: 43.2, deltaX: 0, deltaY: 38, timestamp: 1.337 },
      },
    ];
    for (const command of commands) await f.target.receive({ id: 2, sessionId, ...command });
    expect(f.debuggerApi.sendCommand.mock.calls).toEqual(
      commands.map(({ method, params }) => [method, params, undefined]),
    );
    await f.target.dispose(false);
  });
  it("marks synthetic input before CDP dispatch and releases the exact marker on failure", async () => {
    const release = vi.fn();
    const expected = vi.fn(() => release);
    const f = fixture([], undefined, false, expected);
    await f.target.receive({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: f.target.targetId },
    });
    const sessionId = (f.messages[0]!.result as { sessionId: string }).sessionId;
    f.debuggerApi.sendCommand.mockImplementationOnce(async () => {
      expect(expected).toHaveBeenCalledWith({
        kind: "mouse",
        type: "mouseDown",
        button: "left",
        x: 25,
        y: 30,
      });
      expect(release).not.toHaveBeenCalled();
      throw new Error("Synthetic CDP failure");
    });
    await f.target.receive({
      id: 2,
      sessionId,
      method: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", button: "left", x: 25, y: 30 },
    });
    expect(release).toHaveBeenCalledTimes(1);
    await f.target.dispose(false);
  });
  it("reserves cookie-store access for a trusted import lease and always denies certificate bypass", async () => {
    for (const cookieImport of [false, true]) {
      const f = fixture([], "owned-session", cookieImport);
      await f.target.receive({
        id: 1,
        method: "Target.attachToTarget",
        params: { targetId: f.target.targetId },
      });
      const sessionId = (f.messages[0]!.result as { sessionId: string }).sessionId;
      for (const method of ["Network.getAllCookies", "Network.setCookies"]) {
        await f.target.receive({ id: 2, sessionId, method, params: { cookies: [] } });
        expect(f.messages.at(-1)).toHaveProperty(cookieImport ? "result" : "error");
      }
      await f.target.receive({
        id: 3,
        sessionId,
        method: "Security.setIgnoreCertificateErrors",
        params: { ignore: true },
      });
      expect(f.messages.at(-1)).toHaveProperty("error");
      await f.target.dispose(false);
    }
  });
  it("only enumerates its own target and denies foreign sessions", async () => {
    const f = fixture();
    await f.target.receive({ id: 1, method: "Target.getTargets" });
    expect(f.messages[0]).toMatchObject({
      result: { targetInfos: [{ targetId: f.target.targetId }] },
    });
    await f.target.receive({
      id: 2,
      sessionId: "foreign",
      method: "Runtime.evaluate",
      params: { expression: "secret" },
    });
    expect(f.debuggerApi.sendCommand).not.toHaveBeenCalled();
    expect(f.messages[1]).toHaveProperty("error");
    expect(JSON.stringify(f.messages)).not.toContain("secret");
    await f.target.dispose();
  });

  it("refuses browser-wide mutations even through a browser CDP session", async () => {
    const f = fixture();
    await f.target.receive({ id: 1, method: "Target.attachToBrowserTarget" });
    const sessionId = (f.messages[0]!.result as { sessionId: string }).sessionId;
    for (const method of [
      "Browser.close",
      "Browser.setDownloadBehavior",
      "Target.createTarget",
      "Target.disposeBrowserContext",
      "Storage.setCookies",
    ]) {
      await f.target.receive({ id: 2, sessionId, method });
      expect(f.messages.at(-1)).toHaveProperty("error");
    }
    expect(f.debuggerApi.sendCommand).not.toHaveBeenCalled();
    await f.target.dispose();
    expect(f.contents.close).not.toHaveBeenCalled();
    expect(f.debuggerApi.detach).not.toHaveBeenCalled();
  });

  it("bounds cookie reads to the current page", async () => {
    const f = fixture();
    await f.target.receive({ id: 1, method: "Storage.getCookies" });
    expect(f.debuggerApi.sendCommand).toHaveBeenCalledWith(
      "Network.getCookies",
      { urls: ["https://fixture.example/"] },
      undefined,
    );
    await f.target.dispose();
  });

  it("revokes commands before draining pending browser work", async () => {
    const f = fixture();
    await f.target.receive({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: f.target.targetId },
    });
    const sessionId = (f.messages[0]!.result as { sessionId: string }).sessionId;
    let resolve!: (value: {}) => void;
    f.debuggerApi.sendCommand.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const running = f.target.receive({ id: 2, sessionId, method: "Runtime.evaluate" });
    let disposed = false;
    const disposal = f.target.dispose().then(() => {
      disposed = true;
    });
    await f.target.receive({ id: 3, sessionId, method: "Input.dispatchMouseEvent" });
    expect(f.messages.at(-1)).toHaveProperty("error");
    expect(disposed).toBe(false);
    resolve({});
    await running;
    await disposal;
    expect(disposed).toBe(true);
    expect(
      f.debuggerApi.sendCommand.mock.calls.some(
        ([method]) => method === "Input.dispatchMouseEvent",
      ),
    ).toBe(false);
  });

  it("does not stop the user's page on normal disconnect", async () => {
    const f = fixture();
    await f.target.dispose(false);
    await f.target.dispose(true);
    expect(f.debuggerApi.sendCommand.mock.calls.map(([method]) => method)).toEqual([
      "Fetch.disable",
    ]);
    expect(f.debuggerApi.listenerCount("message")).toBe(0);
    expect(f.debuggerApi.listenerCount("detach")).toBe(0);
  });

  it.each(["resolve", "reject"])(
    "releases stale Runtime replies only after child-session detachment, then tolerates late %s",
    async (lateOutcome) => {
      const f = fixture([], "owned-session");
      await f.target.receive({
        id: 1,
        method: "Target.attachToTarget",
        params: { targetId: f.target.targetId },
      });
      const sessionId = (f.messages[0]!.result as { sessionId: string }).sessionId;
      let finishRaw!: (value: {}) => void;
      let rejectRaw!: (error: Error) => void;
      let detach!: (value: {}) => void;
      f.debuggerApi.sendCommand.mockImplementation((method) => {
        if (method === "Runtime.callFunctionOn")
          return new Promise((resolve, reject) => {
            finishRaw = resolve;
            rejectRaw = reject;
          });
        if (method === "Target.detachFromTarget")
          return new Promise((resolve) => {
            detach = resolve;
          });
        return Promise.resolve({});
      });
      const running = f.target.receive({ id: 2, sessionId, method: "Runtime.callFunctionOn" });
      let disposed = false;
      const disposal = f.target.dispose().then(() => {
        disposed = true;
      });
      await vi.waitFor(() => expect(detach).toBeTypeOf("function"));
      expect(disposed).toBe(false);
      await f.target.receive({ id: 3, sessionId, method: "Input.dispatchMouseEvent" });
      expect(f.messages.at(-1)).toHaveProperty("error");
      expect(f.debuggerApi.sendCommand).toHaveBeenCalledWith(
        "Runtime.terminateExecution",
        {},
        "owned-session",
      );
      expect(f.debuggerApi.sendCommand).toHaveBeenCalledWith(
        "Runtime.evaluate",
        { expression: "void 0", silent: true },
        "owned-session",
      );
      detach({});
      await disposal;
      await running;
      expect(disposed).toBe(true);
      expect(f.messages.find((message) => message.id === 2)).toHaveProperty("error");
      const count = f.messages.length;
      if (lateOutcome === "resolve") finishRaw({});
      else rejectRaw(new Error("Late debugger failure"));
      await Promise.resolve();
      expect(f.messages).toHaveLength(count);
      expect(f.debuggerApi.detach).not.toHaveBeenCalled();
    },
  );

  it("does not treat a rejected detach as revocation of pending work", async () => {
    const f = fixture([], "owned-session");
    await f.target.receive({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: f.target.targetId },
    });
    const sessionId = (f.messages[0]!.result as { sessionId: string }).sessionId;
    let finish!: (value: {}) => void;
    f.debuggerApi.sendCommand.mockImplementation((method) => {
      if (method === "Runtime.callFunctionOn")
        return new Promise((resolve) => {
          finish = resolve;
        });
      if (method === "Target.detachFromTarget") return Promise.reject(new Error("Detach failed"));
      return Promise.resolve({});
    });
    const running = f.target.receive({ id: 2, sessionId, method: "Runtime.callFunctionOn" });
    let disposed = false;
    const disposal = f.target.dispose().then(() => {
      disposed = true;
    });
    await vi.waitFor(() =>
      expect(f.debuggerApi.sendCommand).toHaveBeenCalledWith("Target.detachFromTarget", {
        sessionId: "owned-session",
      }),
    );
    expect(disposed).toBe(false);
    finish({});
    await running;
    await disposal;
    expect(disposed).toBe(true);
  });

  it("does not allow a page CDP session to read another site's cookies", async () => {
    const f = fixture();
    await f.target.receive({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: f.target.targetId },
    });
    const sessionId = (f.messages[0]!.result as { sessionId: string }).sessionId;
    await f.target.receive({
      id: 2,
      sessionId,
      method: "Network.getCookies",
      params: { urls: ["https://unrelated.example/"] },
    });
    expect(f.debuggerApi.sendCommand).toHaveBeenCalledWith(
      "Network.getCookies",
      { urls: ["https://fixture.example/"] },
      undefined,
    );
    await f.target.dispose(false);
  });

  it("denies direct file uploads and non-web navigation", async () => {
    const f = fixture();
    await f.target.receive({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: f.target.targetId },
    });
    const sessionId = (f.messages[0]!.result as { sessionId: string }).sessionId;
    for (const message of [
      { method: "DOM.setFileInputFiles", params: { files: ["/private/secret.txt"] } },
      { method: "Page.navigate", params: { url: "file:///private/secret.txt" } },
      { method: "Page.navigate", params: { url: "javascript:alert(1)" } },
      { method: "Network.loadNetworkResource", params: { url: "file:///private/secret.txt" } },
    ]) {
      await f.target.receive({ id: 2, sessionId, ...message });
      expect(f.messages.at(-1)).toHaveProperty("error");
    }
    expect(f.debuggerApi.sendCommand).not.toHaveBeenCalled();
    await f.target.receive({
      id: 3,
      sessionId,
      method: "Page.navigate",
      params: { url: "https://fixture.example/next" },
    });
    expect(f.messages.at(-1)).toMatchObject({ result: {} });
    await f.target.dispose(false);
  });

  it("allows only the exact host-authorized staged upload files", async () => {
    const stagedPath = "/private/staging/lease-1/report.txt";
    const f = fixture([stagedPath]);
    await f.target.receive({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: f.target.targetId },
    });
    const sessionId = (f.messages[0]!.result as { sessionId: string }).sessionId;
    for (const files of [[stagedPath], []]) {
      await f.target.receive({
        id: 2,
        sessionId,
        method: "DOM.setFileInputFiles",
        params: { backendNodeId: 12, files },
      });
      expect(f.messages.at(-1)).toHaveProperty("result");
      expect(f.debuggerApi.sendCommand).toHaveBeenLastCalledWith(
        "DOM.setFileInputFiles",
        { backendNodeId: 12, files },
        undefined,
      );
    }
    for (const files of [
      [stagedPath, "/private/secret.txt"],
      ["/private/staging/lease-1/../secret.txt"],
      [12],
      undefined,
    ]) {
      await f.target.receive({
        id: 3,
        sessionId,
        method: "DOM.setFileInputFiles",
        params: { backendNodeId: 12, files },
      });
      expect(f.messages.at(-1)).toHaveProperty("error");
    }
    expect(f.debuggerApi.sendCommand).toHaveBeenCalledTimes(2);
    await f.target.dispose(false);
  });

  it("keeps protocol enablement and events inside a dedicated backend session", async () => {
    const f = fixture([], "owned-session");
    await f.target.receive({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: f.target.targetId },
    });
    const sessionId = (f.messages[0]!.result as { sessionId: string }).sessionId;
    await f.target.receive({ id: 2, sessionId, method: "Runtime.enable" });
    expect(f.debuggerApi.sendCommand).toHaveBeenCalledWith("Runtime.enable", {}, "owned-session");
    f.messages.length = 0;
    f.debuggerApi.emit("message", {}, "Runtime.executionContextCreated", { context: { id: 1 } });
    f.debuggerApi.emit(
      "message",
      {},
      "Runtime.executionContextCreated",
      { context: { id: 2 } },
      "other-session",
    );
    expect(f.messages).toEqual([]);
    f.debuggerApi.emit(
      "message",
      {},
      "Runtime.executionContextCreated",
      { context: { id: 3 } },
      "owned-session",
    );
    expect(f.messages).toEqual([
      { sessionId, method: "Runtime.executionContextCreated", params: { context: { id: 3 } } },
    ]);
    await f.target.dispose(false);
    expect(f.debuggerApi.sendCommand).toHaveBeenLastCalledWith("Target.detachFromTarget", {
      sessionId: "owned-session",
    });
    expect(f.debuggerApi.detach).not.toHaveBeenCalled();
  });
});
