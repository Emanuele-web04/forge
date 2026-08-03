import { describe, expect, it, vi } from "vitest";

import {
  browserAnnotationDraftFromCommittedEvent,
  browserAnnotationMarkers,
  browserAnnotationTheme,
  browserAddressDisplayValue,
  buildBrowserAddressSuggestions,
  browserWebviewInitialUrl,
  createBrowserPanelHideScheduler,
  createBrowserRendererLossHandler,
  formatBrowserAnnotationActionError,
  isBrowserAnnotationEventInScope,
  normalizeBrowserAddressInput,
  resolveBrowserChromeStatus,
  resolveBrowserAddressSync,
} from "./BrowserPanel.logic";
import { ThreadId, type BrowserAnnotationEvent } from "@synara/contracts";
import type { BrowserAnnotationDraft } from "../lib/browserAnnotations";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const DOCUMENT_KEY = `sha256:${"0".repeat(64)}`;

function committedEvent(
  overrides: Partial<Extract<BrowserAnnotationEvent, { kind: "committed" }>> = {},
): Extract<BrowserAnnotationEvent, { kind: "committed" }> {
  return {
    kind: "committed",
    threadId: THREAD_A,
    tabId: "tab-a",
    sessionId: "session-a",
    document: { token: "document-a", key: DOCUMENT_KEY, url: "https://example.test/a" },
    source: { url: "https://example.test/a", pageTitle: "Example" },
    annotation: {
      id: "annotation-a",
      source: { url: "https://example.test/a", pageTitle: "Example" },
      selector: "#submit",
      tagName: "button",
      role: "button",
      name: "Submit",
      text: "Submit",
      fingerprint: "button|submit",
      comment: "Clarify this action",
      capturedAt: "2026-07-23T12:00:00.000Z",
    },
    ...overrides,
  };
}

describe("browser annotation projection", () => {
  it("converts only the validated committed payload into the canonical draft shape", () => {
    expect(browserAnnotationDraftFromCommittedEvent(committedEvent())).toEqual({
      id: "annotation-a",
      tabId: "tab-a",
      documentKey: DOCUMENT_KEY,
      source: { url: "https://example.test/a", pageTitle: "Example" },
      selector: "#submit",
      tagName: "button",
      role: "button",
      name: "Submit",
      text: "Submit",
      fingerprint: "button|submit",
      comment: "Clarify this action",
      capturedAt: "2026-07-23T12:00:00.000Z",
    });
  });

  it("projects stable ordinals for only the active logical tab", () => {
    const annotation = browserAnnotationDraftFromCommittedEvent(committedEvent());
    const annotations: BrowserAnnotationDraft[] = [
      { ...annotation, ordinal: 3 },
      {
        ...annotation,
        id: "annotation-other-tab",
        tabId: "tab-b",
        ordinal: 8,
      },
      {
        ...annotation,
        id: "annotation-other-page",
        source: { url: "https://example.test/other", pageTitle: "Other" },
        ordinal: 9,
      },
    ];

    expect(browserAnnotationMarkers(annotations, "tab-a")).toEqual([
      {
        id: "annotation-a",
        ordinal: 3,
        documentKey: DOCUMENT_KEY,
        source: { url: "https://example.test/a", pageTitle: "Example" },
        selector: "#submit",
        fingerprint: "button|submit",
      },
      {
        id: "annotation-other-page",
        ordinal: 9,
        documentKey: DOCUMENT_KEY,
        source: { url: "https://example.test/other", pageTitle: "Other" },
        selector: "#submit",
        fingerprint: "button|submit",
      },
    ]);
  });

  it("rejects stale thread, tab, session, and document events", () => {
    const event = committedEvent();
    expect(
      isBrowserAnnotationEventInScope(event, {
        threadId: THREAD_A,
        tabId: "tab-a",
        sessionId: "session-a",
        documentToken: "document-a",
      }),
    ).toBe(true);
    expect(
      isBrowserAnnotationEventInScope(event, {
        threadId: ThreadId.makeUnsafe("thread-b"),
        tabId: "tab-a",
      }),
    ).toBe(false);
    expect(
      isBrowserAnnotationEventInScope(event, {
        threadId: THREAD_A,
        tabId: "tab-b",
      }),
    ).toBe(false);
    expect(
      isBrowserAnnotationEventInScope(event, {
        threadId: THREAD_A,
        tabId: "tab-a",
        sessionId: "session-b",
      }),
    ).toBe(false);
    expect(
      isBrowserAnnotationEventInScope(event, {
        threadId: THREAD_A,
        tabId: "tab-a",
        documentToken: "document-b",
      }),
    ).toBe(false);
  });
});

describe("browser annotation presentation", () => {
  it("uses the current chrome theme and readable action errors", () => {
    const root = (dark: boolean) =>
      ({
        classList: {
          contains: (token: string) => dark && token === "dark",
        } as DOMTokenList,
      }) as Pick<HTMLElement, "classList">;
    expect(browserAnnotationTheme(root(false))).toMatchObject({
      mode: "light",
      surface: "rgb(255, 255, 255)",
      primaryText: "rgb(255, 255, 255)",
    });
    expect(browserAnnotationTheme(root(true))).toMatchObject({
      mode: "dark",
      surface: "rgb(27, 27, 29)",
      primaryText: "rgb(24, 24, 27)",
    });
    expect(
      formatBrowserAnnotationActionError(
        new Error("Browser annotation document is not ready"),
        "start",
      ),
    ).toBe("This page is still loading. Try annotating again in a moment.");
  });
});

describe("createBrowserRendererLossHandler", () => {
  it("recovers the same logical tab on the next renderer generation exactly once", () => {
    const oldRenderer = { webContentsId: 17 };
    let currentRenderer = oldRenderer;
    const detach = vi.fn();
    const recover = vi.fn((recovery: { tabId: string; generation: number }) => {
      currentRenderer = { webContentsId: 18 };
      return recovery;
    });
    const onRendererLoss = createBrowserRendererLossHandler({
      renderer: oldRenderer,
      rendererGeneration: 4,
      tabId: "tab-a",
      isCurrent: (renderer) => currentRenderer === renderer,
      detach,
      recover,
    });

    // Electron can surface both `render-process-gone` and `destroyed` for the
    // same physical guest. Both events share this one-shot handler.
    onRendererLoss();
    onRendererLoss();

    expect(detach).toHaveBeenCalledOnce();
    expect(detach).toHaveBeenCalledWith(oldRenderer);
    expect(recover).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledWith({ tabId: "tab-a", generation: 5 });
    expect(currentRenderer.webContentsId).toBe(18);
    expect(currentRenderer.webContentsId).not.toBe(oldRenderer.webContentsId);
  });

  it("cannot let a stale renderer-loss handler evict its replacement", () => {
    const oldRenderer = { webContentsId: 17 };
    const currentRenderer = { webContentsId: 18 };
    const detach = vi.fn();
    const recover = vi.fn();
    const onRendererLoss = createBrowserRendererLossHandler({
      renderer: oldRenderer,
      rendererGeneration: 4,
      tabId: "tab-a",
      isCurrent: (renderer) => currentRenderer === renderer,
      detach,
      recover,
    });

    onRendererLoss();

    expect(detach).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });
});

describe("createBrowserPanelHideScheduler", () => {
  it("cancels a passive StrictMode cleanup when the same panel remounts", () => {
    vi.useFakeTimers();
    try {
      const hide = vi.fn();
      const scheduler = createBrowserPanelHideScheduler();

      scheduler.schedule("thread-a", hide);
      scheduler.cancel("thread-a");
      vi.runAllTimers();

      expect(hide).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still hides after a real unmount without a matching remount", () => {
    vi.useFakeTimers();
    try {
      const hide = vi.fn();
      const scheduler = createBrowserPanelHideScheduler();

      scheduler.schedule("thread-a", hide);
      vi.runAllTimers();

      expect(hide).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("browserAddressDisplayValue", () => {
  it("hides about:blank for new tabs", () => {
    expect(browserAddressDisplayValue({ url: "about:blank" })).toBe("");
  });

  it("keeps real urls visible", () => {
    expect(browserAddressDisplayValue({ url: "https://x.com/" })).toBe("https://x.com/");
  });
});

describe("resolveBrowserAddressSync", () => {
  it("restores a saved draft when switching to another tab", () => {
    expect(
      resolveBrowserAddressSync({
        activeTabId: "tab-2",
        previousActiveTabId: "tab-1",
        savedDraft: "x.com",
        nextDisplayValue: "",
        lastSyncedValue: "",
        isEditing: false,
      }),
    ).toEqual({
      type: "replace",
      value: "x.com",
      syncedValue: "",
    });
  });

  it("keeps the typed value while the active tab is still being edited", () => {
    expect(
      resolveBrowserAddressSync({
        activeTabId: "tab-2",
        previousActiveTabId: "tab-2",
        savedDraft: "x.com",
        nextDisplayValue: "",
        lastSyncedValue: "",
        isEditing: true,
      }),
    ).toEqual({
      type: "keep",
    });
  });

  it("updates the input when a submitted navigation resolves to a new url", () => {
    expect(
      resolveBrowserAddressSync({
        activeTabId: "tab-2",
        previousActiveTabId: "tab-2",
        savedDraft: "x.com",
        nextDisplayValue: "https://x.com/",
        lastSyncedValue: "",
        isEditing: false,
      }),
    ).toEqual({
      type: "replace",
      value: "https://x.com/",
      syncedValue: "https://x.com/",
    });
  });
});

describe("normalizeBrowserAddressInput", () => {
  it("adds https to naked domains", () => {
    expect(normalizeBrowserAddressInput("phodex.app")).toBe("https://phodex.app/");
  });

  it("turns spaced text into a search url", () => {
    expect(normalizeBrowserAddressInput("how to bake bread")).toContain(
      "https://www.google.com/search?q=how%20to%20bake%20bread",
    );
  });

  it("preserves local file URLs", () => {
    expect(normalizeBrowserAddressInput("file:///Users/example/project/index.html")).toBe(
      "file:///Users/example/project/index.html",
    );
  });
});

describe("browserWebviewInitialUrl", () => {
  it("defers local files to the desktop preview protocol", () => {
    expect(browserWebviewInitialUrl("file:///Users/example/project/index.html")).toBe(
      "about:blank",
    );
    expect(browserWebviewInitialUrl("https://example.test/")).toBe("https://example.test/");
  });
});

describe("buildBrowserAddressSuggestions", () => {
  it("hides blank tabs and surfaces direct navigation", () => {
    const suggestions = buildBrowserAddressSuggestions({
      query: "open",
      activeTabId: "tab-1",
      tabs: [
        {
          id: "tab-1",
          title: "New tab",
          url: "about:blank",
          faviconUrl: null,
          lastCommittedUrl: null,
        },
        {
          id: "tab-2",
          title: "OpenAI",
          url: "https://openai.com/",
          faviconUrl: null,
          lastCommittedUrl: "https://openai.com/",
        },
      ],
      recentHistory: [
        {
          url: "about:blank",
          title: "Blank",
          tabId: "tab-1",
        },
        {
          url: "https://news.ycombinator.com/",
          title: "Hacker News",
          tabId: "tab-3",
        },
      ],
    });

    expect(suggestions[0]).toMatchObject({
      kind: "navigate",
      url: "https://www.google.com/search?q=open",
    });
    expect(suggestions.some((suggestion) => suggestion.url === "about:blank")).toBe(false);
    expect(suggestions.some((suggestion) => suggestion.url === "https://openai.com/")).toBe(true);
  });
});

describe("resolveBrowserChromeStatus", () => {
  it("surfaces recoverable browser errors ahead of idle state", () => {
    expect(
      resolveBrowserChromeStatus({
        localError: "Couldn't complete that browser action.",
        threadLastError: null,
        activeTabStatus: "ready",
        hasActiveTab: true,
        workspaceReady: true,
      }),
    ).toEqual({
      tone: "error",
      label: "Couldn't complete that browser action.",
    });
  });

  it("does not duplicate the current url when a page is loaded", () => {
    expect(
      resolveBrowserChromeStatus({
        localError: null,
        threadLastError: null,
        activeTabStatus: "ready",
        hasActiveTab: true,
        workspaceReady: true,
      }),
    ).toBeNull();
  });

  it("keeps onboarding copy for empty browser states", () => {
    expect(
      resolveBrowserChromeStatus({
        localError: null,
        threadLastError: null,
        activeTabStatus: "suspended",
        hasActiveTab: false,
        workspaceReady: false,
      }),
    ).toEqual({
      tone: "default",
      label: "Starting browser...",
    });
  });
});
