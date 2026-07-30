import { ThreadId } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDedupedBrowserStateStorage,
  sanitizeRecentHistoryByThreadId,
  selectThreadBrowserHistory,
  useBrowserStateStore,
} from "./browserStateStore";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browserStateStore selectors", () => {
  it("reuses the same empty history snapshot for unknown threads", () => {
    const selector = selectThreadBrowserHistory(THREAD_ID);
    const store = {
      threadStatesByThreadId: {},
      recentHistoryByThreadId: {},
      upsertThreadState: () => undefined,
      removeThreadState: () => undefined,
    };

    const first = selector(store);
    const second = selector(store);

    expect(first).toBe(second);
    expect(first).toEqual([]);
  });

  it("does not let a stale IPC completion overwrite a newer pushed browser state", () => {
    const persisted = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (name: string) => persisted.get(name) ?? null,
      setItem: (name: string, value: string) => persisted.set(name, value),
      removeItem: (name: string) => persisted.delete(name),
    });
    useBrowserStateStore.setState({ threadStatesByThreadId: {}, recentHistoryByThreadId: {} });
    const tab = {
      id: "tab-1",
      url: "https://new.example/",
      title: "New visible page",
      status: "live" as const,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      faviconUrl: null,
      lastCommittedUrl: "https://new.example/",
      lastError: null,
    };
    const upsert = useBrowserStateStore.getState().upsertThreadState;

    upsert({
      threadId: THREAD_ID,
      version: 2,
      open: true,
      activeTabId: tab.id,
      tabs: [tab],
      profile: {
        id: "temporary",
        label: "Temporary",
        kind: "temporary",
        partition: "synara-browser-temporary-test",
        builtIn: true,
      },
      lastError: null,
    });
    upsert({
      threadId: THREAD_ID,
      version: 1,
      open: true,
      activeTabId: tab.id,
      tabs: [
        {
          ...tab,
          url: "https://stale.example/",
          title: "Stale hidden page",
          lastCommittedUrl: "https://stale.example/",
        },
      ],
      profile: {
        id: "temporary",
        label: "Temporary",
        kind: "temporary",
        partition: "synara-browser-temporary-test",
        builtIn: true,
      },
      lastError: null,
    });

    expect(useBrowserStateStore.getState().threadStatesByThreadId[THREAD_ID]).toMatchObject({
      version: 2,
      tabs: [{ url: "https://new.example/", title: "New visible page" }],
    });
});
});

describe("createDedupedBrowserStateStorage", () => {
  it("skips repeated writes of the same serialized browser-history payload", () => {
    const values = new Map<string, string>();
    const writes: Array<{ name: string; value: string }> = [];
    const storage = createDedupedBrowserStateStorage(() => ({
      getItem: (name) => values.get(name) ?? null,
      setItem: (name, value) => {
        writes.push({ name, value });
        values.set(name, value);
      },
      removeItem: (name) => {
        values.delete(name);
      },
    }));

    storage.setItem("browser", '{"history":[]}');
    storage.setItem("browser", '{"history":[]}');
    storage.setItem("browser", '{"history":["https://example.com"]}');

    expect(writes).toEqual([
      { name: "browser", value: '{"history":[]}' },
      { name: "browser", value: '{"history":["https://example.com"]}' },
    ]);
  });

  it("forgets the last written value when a key is removed", () => {
    const values = new Map<string, string>();
    const writes: string[] = [];
    const storage = createDedupedBrowserStateStorage(() => ({
      getItem: (name) => values.get(name) ?? null,
      setItem: (name, value) => {
        writes.push(value);
        values.set(name, value);
      },
      removeItem: (name) => {
        values.delete(name);
      },
    }));

    storage.setItem("browser", "same");
    storage.removeItem("browser");
    storage.setItem("browser", "same");

    expect(writes).toEqual(["same", "same"]);
  });
});

describe("sanitizeRecentHistoryByThreadId", () => {
  it("returns an empty record for non-object input", () => {
    expect(sanitizeRecentHistoryByThreadId(null)).toEqual({});
    expect(sanitizeRecentHistoryByThreadId("nope")).toEqual({});
    expect(sanitizeRecentHistoryByThreadId([1, 2, 3])).toEqual({});
  });

  it("drops malformed entries and keeps only well-formed history", () => {
    const result = sanitizeRecentHistoryByThreadId({
      "thread-1": [
        { url: "https://a.com", title: "A", tabId: "t1" },
        { url: "https://b.com", title: "B" },
        null,
        { url: 5, title: "C", tabId: "synara" },
      ],
      "thread-2": "not-an-array",
    });

    expect(result).toEqual({
      "thread-1": [{ url: "https://a.com", title: "A", tabId: "t1" }],
    });
  });

  it("drops threads whose history fully fails validation", () => {
    const result = sanitizeRecentHistoryByThreadId({
      "thread-1": [null, { url: 5, title: "C", tabId: "synara" }],
      "thread-2": [],
    });

    expect(result).toEqual({});
  });

  it("caps each thread's history at the storage limit", () => {
    const entries = Array.from({ length: 30 }, (_, index) => ({
      url: `https://example.com/${index}`,
      title: `Page ${index}`,
      tabId: `tab-${index}`,
    }));

    const result = sanitizeRecentHistoryByThreadId({ "thread-1": entries });

    expect(result["thread-1"]).toHaveLength(12);
  });
});
