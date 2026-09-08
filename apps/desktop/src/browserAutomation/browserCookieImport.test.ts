import { EventEmitter } from "node:events";
import { BrowserCookieImportInput, ThreadId } from "@synara/contracts";
import { Schema } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBrowserManager } from "../browserManager";

const mocks = vi.hoisted(() => ({
  sources: vi.fn(),
  profiles: vi.fn(),
  sync: vi.fn(),
  closeBrowser: vi.fn(),
  closeConnection: vi.fn(),
  connect: vi.fn(),
}));
vi.mock("betterwright", () => ({
  listCookieSourceBrowsers: mocks.sources,
  listCookieSourceProfiles: mocks.profiles,
  NetworkPolicy: class {},
  BetterWright: class {
    syncCookies = mocks.sync;
    close = mocks.closeBrowser;
  },
}));
vi.mock("./betterwrightConnection", () => ({ openBetterwrightConnection: mocks.connect }));
import { BrowserCookieImport } from "./browserCookieImport";

const input = {
  threadId: ThreadId.makeUnsafe("thread-1"),
  tabId: "tab-1",
  scope: "site",
  origin: "https://example.test",
  browser: "chrome",
  profile: "Default",
} as const;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.sources.mockResolvedValue([
    { id: "chrome", name: "Chrome" },
    { id: "firefox", name: "Firefox" },
  ]);
  mocks.profiles.mockResolvedValue([{ id: "Default", name: "Default" }]);
  mocks.sync.mockResolvedValue({
    ok: true,
    synced: 2,
    skipped: 1,
    cookieImportDomains: ["example.test"],
    warnings: [{ code: "unsupported", count: 1 }],
    cookie: "must-not-be-returned",
  });
  mocks.closeBrowser.mockResolvedValue(undefined);
  mocks.closeConnection.mockResolvedValue(undefined);
  mocks.connect.mockResolvedValue({
    provider: { cdpUrl: "ws://127.0.0.1:1234/browser" },
    close: mocks.closeConnection,
  });
});

function fixture(rememberSessionImport = vi.fn(async (_domains: readonly string[]) => {})) {
  const contents = Object.assign(new EventEmitter(), {
    getURL: (): string => input.origin,
    session: { cookies: { flushStore: vi.fn(async () => {}) } },
  });
  const releaseHumanOperation = vi.fn();
  const waitForAgents = vi.fn(async () => {});
  const manager = {
    beginHumanBrowserOperation: vi.fn(() => releaseHumanOperation),
    getCookieImportRuntime: vi.fn(async () => ({ webContents: contents })),
  };
  return {
    importer: new BrowserCookieImport(
      "/synthetic-home",
      manager as unknown as DesktopBrowserManager,
      waitForAgents,
      rememberSessionImport,
    ),
    contents,
    manager,
    releaseHumanOperation,
    waitForAgents,
    rememberSessionImport,
  };
}

describe("human-only cookie import", () => {
  it("imports only the selected visible site with app-bound injection disabled and returns counts", async () => {
    const { importer, contents } = fixture();
    expect(await importer.sources()).toEqual([{ id: "chrome", name: "Chrome" }]);
    expect(await importer.import(input)).toEqual({
      ok: true,
      imported: 2,
      skipped: 1,
      warnings: [{ code: "unsupported", count: 1 }],
    });
    expect(mocks.sync).toHaveBeenCalledWith({
      source: { browser: "chrome", profile: "Default" },
      domains: ["example.test"],
      windowsAppBound: "disabled",
      timeoutMs: 30_000,
      cloudConsent: "cdp:127.0.0.1:1234",
    });
    expect(mocks.closeConnection).toHaveBeenCalledWith(false);
    expect(mocks.closeBrowser).toHaveBeenCalled();
    expect(contents.listenerCount("did-start-navigation")).toBe(0);
  });

  it("rejects other origins, profile paths and unsupported sources before extraction", async () => {
    const { importer } = fixture();
    await expect(importer.import({ ...input, origin: "https://unrelated.test" })).rejects.toThrow();
    await expect(
      importer.import({ ...input, profile: "/private/arbitrary-path" }),
    ).rejects.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(BrowserCookieImportInput)({ ...input, browser: "unsupported" }),
    ).toThrow();
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("accepts helium as an import source and forwards it to cookie sync", async () => {
    const { importer } = fixture();
    mocks.sources.mockResolvedValue([
      { id: "chrome", name: "Chrome" },
      { id: "firefox", name: "Firefox" },
      { id: "helium", name: "Helium" },
    ]);
    await expect(importer.sources()).resolves.toEqual([
      { id: "chrome", name: "Chrome" },
      { id: "helium", name: "Helium" },
    ]);
    expect(() =>
      Schema.decodeUnknownSync(BrowserCookieImportInput)({ ...input, browser: "helium" }),
    ).not.toThrow();
    await expect(importer.import({ ...input, browser: "helium" })).resolves.toMatchObject({
      ok: true,
      imported: 2,
    });
    expect(mocks.sync).toHaveBeenCalledWith(
      expect.objectContaining({ source: { browser: "helium", profile: "Default" } }),
    );
  });

  it("does not report success or release human control before durable cookie writes finish", async () => {
    const { importer, contents, releaseHumanOperation } = fixture();
    let flushed!: () => void;
    contents.session.cookies.flushStore.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          flushed = resolve;
        }),
    );
    let completed = false;
    const pending = importer.import(input).then((result) => {
      completed = true;
      return result;
    });
    await vi.waitFor(() => expect(contents.session.cookies.flushStore).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    expect(releaseHumanOperation).not.toHaveBeenCalled();
    expect(mocks.closeBrowser).not.toHaveBeenCalled();
    flushed();
    expect((await pending).ok).toBe(true);
    expect(releaseHumanOperation).toHaveBeenCalledOnce();
  });

  it("does not report durable success when the cookie store cannot be flushed", async () => {
    const { importer, contents, releaseHumanOperation } = fixture();
    contents.session.cookies.flushStore.mockRejectedValue(new Error("synthetic-disk-failure"));
    await expect(importer.import(input)).rejects.toThrow("synthetic-disk-failure");
    expect(mocks.closeBrowser).toHaveBeenCalledOnce();
    expect(mocks.closeConnection).toHaveBeenCalledWith(false);
    expect(releaseHumanOperation).toHaveBeenCalledOnce();
  });

  it("requires session restoration checkpointing before reporting import success", async () => {
    const remember = vi.fn(async (_domains: readonly string[]) => {
      throw new Error("synthetic-checkpoint-failure");
    });
    const { importer, releaseHumanOperation } = fixture(remember);
    await expect(importer.import(input)).resolves.toMatchObject({
      ok: false,
      code: "persistence_failed",
    });
    expect(remember).toHaveBeenCalledWith(["example.test"]);
    expect(releaseHumanOperation).toHaveBeenCalledOnce();
  });

  it("revokes the import connection on navigation and always cleans up after failure", async () => {
    const { importer, contents, releaseHumanOperation } = fixture();
    mocks.sync.mockImplementation(async () => {
      contents.emit("did-start-navigation", {}, "https://other.test", false, true);
      throw new Error("synthetic-read-failure");
    });
    await expect(importer.import(input)).rejects.toThrow();
    expect(mocks.closeConnection).toHaveBeenCalledTimes(1);
    expect(mocks.closeBrowser).toHaveBeenCalledTimes(1);
    expect(contents.listenerCount("destroyed")).toBe(0);
    expect(releaseHumanOperation).toHaveBeenCalledTimes(1);
  });

  it("holds human control until agents drain and import cleanup finishes", async () => {
    const { importer, manager, waitForAgents, releaseHumanOperation } = fixture();
    let drain!: () => void;
    waitForAgents.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          drain = resolve;
        }),
    );
    const pending = importer.import(input);
    await vi.waitFor(() => expect(waitForAgents).toHaveBeenCalledTimes(1));
    expect(manager.beginHumanBrowserOperation).toHaveBeenCalledTimes(1);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(releaseHumanOperation).not.toHaveBeenCalled();
    await expect(importer.import(input)).rejects.toThrow("Another cookie import");
    drain();
    await pending;
    expect(mocks.closeBrowser).toHaveBeenCalledTimes(1);
    expect(releaseHumanOperation).toHaveBeenCalledTimes(1);
    expect(releaseHumanOperation.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.closeBrowser.mock.invocationCallOrder[0]!,
    );
  });

  it("rechecks the destination after draining and releases the lease on failure", async () => {
    const { importer, contents, waitForAgents, releaseHumanOperation } = fixture();
    waitForAgents.mockImplementation(async () => {
      contents.getURL = () => "https://other.test";
    });
    await expect(importer.import(input)).rejects.toThrow("destination changed");
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(releaseHumanOperation).toHaveBeenCalledTimes(1);
  });

  it("requires explicit profile consent and permits all-sites import from a blank tab", async () => {
    const { importer, contents, rememberSessionImport } = fixture();
    const profile = {
      threadId: input.threadId,
      tabId: input.tabId,
      browser: input.browser,
      profile: input.profile,
      scope: "profile",
    };
    for (const confirmed of [undefined, false, "true"])
      expect(() =>
        Schema.decodeUnknownSync(BrowserCookieImportInput)({ ...profile, confirmed }),
      ).toThrow();
    contents.getURL = () => "about:blank";
    const request = Schema.decodeUnknownSync(BrowserCookieImportInput)({
      ...profile,
      confirmed: true,
    });
    expect((await importer.import(request)).ok).toBe(true);
    expect(mocks.sync).toHaveBeenCalledWith({
      source: { browser: "chrome", profile: "Default" },
      windowsAppBound: "disabled",
      timeoutMs: 30_000,
      cloudConsent: "cdp:127.0.0.1:1234",
    });
    expect(mocks.sync.mock.calls[0]![0]).not.toHaveProperty("domains");
    expect(rememberSessionImport).toHaveBeenCalledWith(["example.test"]);
  });

  it.each([
    [
      { cookieReaderCode: "source_extraction_failed", cookiePermissionDenied: true },
      "permission_denied",
    ],
    [{ cookieReaderCode: "source_extraction_failed" }, "reader_failed"],
    [{ cookieReaderCode: "timed_out" }, "timed_out"],
    [{ cookieReaderCode: "reader_unavailable" }, "reader_unavailable"],
    [{ cookieReaderCode: "no_selected_source" }, "source_missing"],
    [{}, "transfer_failed"],
  ])(
    "returns only a fixed error category, never native diagnostic content",
    async (diagnostic, code) => {
      const { importer, releaseHumanOperation } = fixture();
      mocks.sync.mockResolvedValue({
        ok: false,
        error: "synthetic-private-diagnostic",
        ...diagnostic,
      });
      const result = await importer.import(input);
      expect(result).toMatchObject({ ok: false, code });
      expect(JSON.stringify(result)).not.toContain("synthetic-private-diagnostic");
      expect(releaseHumanOperation).toHaveBeenCalledOnce();
    },
  );
});
