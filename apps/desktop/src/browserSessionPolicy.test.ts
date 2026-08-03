import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  headerListener: {
    current: null as
      | null
      | ((
          details: { requestHeaders: Record<string, string> },
          callback: (result: { requestHeaders: Record<string, string> }) => void,
        ) => void),
  },
  fromPartition: vi.fn(),
  partitionSetUserAgent: vi.fn(),
  onBeforeSendHeaders: vi.fn(),
  protocolHandle: vi.fn(),
  protocolUnhandle: vi.fn(),
  netFetch: vi.fn(),
  sessionOn: vi.fn(),
  sessionRemoveListener: vi.fn(),
  willDownloadListener: {
    current: null as null | ((event: object, item: object, webContents: object) => void),
  },
}));

vi.mock("electron", () => ({
  app: {
    getName: () => "Synara",
    getPreferredSystemLanguages: () => ["en-US", "it-IT"],
    userAgentFallback:
      "Mozilla/5.0 AppleWebKit/537.36 Chrome/140.0.0.0 Electron/40.0.0 Safari/537.36 Synara/0.5.5",
  },
  session: {
    fromPartition: electronMocks.fromPartition,
  },
  net: {
    fetch: electronMocks.netFetch,
  },
}));

import { BROWSER_SESSION_PARTITION, BrowserSessionPolicy } from "./browserSessionPolicy";

describe("BrowserSessionPolicy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electronMocks.headerListener.current = null;
    electronMocks.willDownloadListener.current = null;
    electronMocks.onBeforeSendHeaders.mockImplementation((listener) => {
      electronMocks.headerListener.current = listener;
    });
    electronMocks.fromPartition.mockReturnValue({
      setUserAgent: electronMocks.partitionSetUserAgent,
      webRequest: { onBeforeSendHeaders: electronMocks.onBeforeSendHeaders },
      protocol: {
        handle: electronMocks.protocolHandle,
        unhandle: electronMocks.protocolUnhandle,
      },
      on: electronMocks.sessionOn,
      removeListener: electronMocks.sessionRemoveListener,
    });
    electronMocks.sessionOn.mockImplementation((event, listener) => {
      if (event === "will-download") electronMocks.willDownloadListener.current = listener;
    });
  });

  it("configures the persistent partition only once", () => {
    const policy = new BrowserSessionPolicy();

    policy.ensureConfigured();
    policy.ensureConfigured();

    expect(electronMocks.fromPartition).toHaveBeenCalledOnce();
    expect(electronMocks.fromPartition).toHaveBeenCalledWith(BROWSER_SESSION_PARTITION);
    expect(electronMocks.partitionSetUserAgent).toHaveBeenCalledOnce();
    expect(electronMocks.onBeforeSendHeaders).toHaveBeenCalledOnce();
    expect(electronMocks.protocolHandle).toHaveBeenCalledOnce();
  });

  it("replaces identity headers case-insensitively without Electron product tokens", () => {
    const policy = new BrowserSessionPolicy();
    policy.ensureConfigured();
    const listener = electronMocks.headerListener.current;
    expect(listener).not.toBeNull();
    if (!listener) return;

    const headers = {
      "user-agent": "Old Electron/40.0.0",
      "SEC-CH-UA": '"Electron";v="40"',
      "accept-language": "fr",
      "X-Preserved": "yes",
    };
    const callback = vi.fn();
    listener({ requestHeaders: headers }, callback);

    expect(callback).toHaveBeenCalledWith({ requestHeaders: headers });
    expect(headers["X-Preserved"]).toBe("yes");
    const normalizedHeaders = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
    );
    expect(normalizedHeaders["user-agent"]).not.toMatch(/Electron|Synara/iu);
    expect(normalizedHeaders["sec-ch-ua"]).not.toMatch(/Electron/iu);
    expect(normalizedHeaders["accept-language"]).toContain("en-US");
    for (const name of ["user-agent", "sec-ch-ua", "accept-language"]) {
      expect(Object.keys(headers).filter((key) => key.toLowerCase() === name)).toHaveLength(1);
    }
  });

  it("retries partition configuration after a transient failure", () => {
    electronMocks.fromPartition.mockImplementationOnce(() => {
      throw new Error("session not ready");
    });
    const policy = new BrowserSessionPolicy();

    policy.ensureConfigured();
    policy.ensureConfigured();

    expect(electronMocks.fromPartition).toHaveBeenCalledTimes(2);
    expect(electronMocks.partitionSetUserAgent).toHaveBeenCalledOnce();
    expect(electronMocks.onBeforeSendHeaders).toHaveBeenCalledOnce();
  });

  it("does not duplicate download listeners when protocol setup is retried", () => {
    electronMocks.protocolHandle.mockImplementationOnce(() => {
      throw new Error("protocol not ready");
    });
    const policy = new BrowserSessionPolicy(vi.fn());

    policy.ensureConfigured();
    expect(electronMocks.sessionOn).not.toHaveBeenCalled();

    policy.ensureConfigured();
    expect(electronMocks.protocolHandle).toHaveBeenCalledTimes(2);
    expect(electronMocks.sessionOn).toHaveBeenCalledOnce();

    policy.dispose();
    expect(electronMocks.sessionRemoveListener).toHaveBeenCalledOnce();
    expect(electronMocks.protocolUnhandle).toHaveBeenCalledOnce();
  });

  it("forwards partition downloads and removes the listener on disposal", () => {
    const onDownload = vi.fn();
    const policy = new BrowserSessionPolicy(onDownload);
    const event = { preventDefault: vi.fn() };
    const item = { getURL: () => "https://example.test/file.zip" };
    const webContents = { id: 42 };

    policy.ensureConfigured();
    electronMocks.willDownloadListener.current?.(event, item, webContents);

    expect(onDownload).toHaveBeenCalledWith({ event, item, webContents });
    expect(electronMocks.sessionOn).toHaveBeenCalledWith(
      "will-download",
      electronMocks.willDownloadListener.current,
    );
    policy.dispose();
    expect(electronMocks.sessionRemoveListener).toHaveBeenCalledWith(
      "will-download",
      expect.any(Function),
    );
    expect(electronMocks.protocolUnhandle).toHaveBeenCalledOnce();
  });

  it("builds hardened popup options with an optional parent", () => {
    const policy = new BrowserSessionPolicy();
    const parent = {} as BrowserWindow;

    expect(policy.buildOAuthPopupWindowOptions(parent)).toMatchObject({
      parent,
      webPreferences: {
        partition: BROWSER_SESSION_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    expect(policy.buildOAuthPopupWindowOptions(null)).not.toHaveProperty("parent");
  });

  it("applies the same derived identity to the partition, tabs, and popups", () => {
    const policy = new BrowserSessionPolicy();
    const firstContents = { setUserAgent: vi.fn() };
    const secondContents = { setUserAgent: vi.fn() };

    policy.ensureConfigured();
    policy.applyUserAgent(firstContents);
    policy.applyUserAgent(secondContents);

    const partitionUserAgent = electronMocks.partitionSetUserAgent.mock.calls[0]?.[0];
    expect(partitionUserAgent).not.toMatch(/Electron|Synara/iu);
    expect(firstContents.setUserAgent).toHaveBeenCalledWith(partitionUserAgent);
    expect(secondContents.setUserAgent).toHaveBeenCalledWith(partitionUserAgent);
  });

  it("keeps file URLs user-facing while assigning an opaque runtime origin", () => {
    const policy = new BrowserSessionPolicy();
    const sourceUrl = "file:///Users/example/project/index.html";

    const runtimeUrl = policy.resolveRuntimeUrl(sourceUrl);

    expect(runtimeUrl).toMatch(/^synara-local-preview:\/\/[a-f0-9]+\/index\.html$/u);
    expect(policy.resolveDisplayUrl(runtimeUrl)).toBe(sourceUrl);
  });
});
