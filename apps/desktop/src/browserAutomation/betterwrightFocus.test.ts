import { createContext, runInContext } from "node:vm";
import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { withRendererGuestFocus } from "./betterwrightFocus";

function fixture() {
  const previous = { isConnected: true, focus: vi.fn() };
  const document = { activeElement: previous as unknown, querySelectorAll: vi.fn() };
  previous.focus.mockImplementation(() => {
    document.activeElement = previous;
  });
  const guest = {
    isConnected: true,
    getWebContentsId: () => 42,
    focus: vi.fn(() => {
      document.activeElement = guest;
    }),
  };
  document.querySelectorAll.mockReturnValue([guest]);
  const context = createContext({ document });
  const host = {
    isDestroyed: vi.fn(() => false),
    executeJavaScript: vi.fn(async (code: string) => runInContext(code, context)),
  };
  const contents = {
    id: 42,
    getType: () => "webview",
    hostWebContents: host,
    isDestroyed: vi.fn(() => false),
  };
  const run = <T>(operation: () => Promise<T>) =>
    withRendererGuestFocus(contents as unknown as WebContents, operation);
  return { previous, document, guest, context, host, contents, run };
}

describe("renderer guest focus", () => {
  it("scopes input to the exact guest and restores focus once without returning host data", async () => {
    const f = fixture();
    const operation = vi.fn(async () => {
      expect(f.document.activeElement).toBe(f.guest);
      return "guest result";
    });
    expect(await f.run(operation)).toBe("guest result");
    expect(f.document.activeElement).toBe(f.previous);
    expect(f.previous.focus).toHaveBeenCalledOnce();
    expect(f.host.executeJavaScript).toHaveBeenCalledTimes(2);
    expect(Object.keys(f.context)).toEqual(["document"]);
  });

  it.each(["missing", "foreign", "duplicate", "detached", "unfocused"])(
    "denies input when the guest is %s",
    async (failure) => {
      const f = fixture();
      if (failure === "missing") f.document.querySelectorAll.mockReturnValue([]);
      if (failure === "foreign") f.guest.getWebContentsId = () => 43;
      if (failure === "duplicate") f.document.querySelectorAll.mockReturnValue([f.guest, f.guest]);
      if (failure === "detached") f.guest.isConnected = false;
      if (failure === "unfocused") f.guest.focus.mockImplementation(() => {});
      const operation = vi.fn();
      await expect(f.run(operation)).rejects.toThrow("Browser focus unavailable");
      expect(operation).not.toHaveBeenCalled();
      expect(Object.keys(f.context)).toEqual(["document"]);
    },
  );

  it.each(["focus moved", "previous removed", "host destroyed"])(
    "does not steal focus back when %s",
    async (change) => {
      const f = fixture();
      await f.run(async () => {
        if (change === "focus moved") f.document.activeElement = {};
        if (change === "previous removed") f.previous.isConnected = false;
        if (change === "host destroyed") f.host.isDestroyed.mockReturnValue(true);
      });
      expect(f.previous.focus).not.toHaveBeenCalled();
    },
  );

  it("restores focus after dispatch fails", async () => {
    const f = fixture();
    await expect(
      f.run(async () => {
        throw new Error("dispatch failed");
      }),
    ).rejects.toThrow("dispatch failed");
    expect(f.document.activeElement).toBe(f.previous);
    expect(Object.keys(f.context)).toEqual(["document"]);
  });

  it("rejects a guest destroyed during focus acquisition", async () => {
    const f = fixture();
    f.guest.focus.mockImplementation(() => {
      f.contents.isDestroyed.mockReturnValue(true);
    });
    const operation = vi.fn();
    await expect(f.run(operation)).rejects.toThrow("Browser focus unavailable");
    expect(operation).not.toHaveBeenCalled();
  });

  it("leaves native views on their existing input path", async () => {
    const f = fixture();
    f.contents.getType = () => "browserView";
    expect(await f.run(async () => "native")).toBe("native");
    expect(f.host.executeJavaScript).not.toHaveBeenCalled();
  });
});
