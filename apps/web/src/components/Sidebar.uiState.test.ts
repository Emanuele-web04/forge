import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  normalizeSidebarProjectThreadListCwd,
  persistSidebarUiState,
  readSidebarUiState,
} from "./Sidebar.uiState";

describe("Sidebar.uiState", () => {
  let storage = new Map<string, string>();

  beforeEach(() => {
    storage = new Map<string, string>();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          clear: () => {
            storage.clear();
          },
          getItem: (key: string) => storage.get(key) ?? null,
          removeItem: (key: string) => {
            storage.delete(key);
          },
          setItem: (key: string, value: string) => {
            storage.set(key, value);
          },
        },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
  });

  it("defaults collapsed sidebar UI state with no thread list paging", () => {
    expect(readSidebarUiState()).toEqual({
      chatSectionExpanded: false,
      chatThreadListExtraPages: 0,
      projectThreadListExtraPagesByCwd: {},
      dismissedThreadStatusKeyByThreadId: {},
      lastThreadRoute: null,
      activityViewEnabled: false,
    });
  });

  it("persists project thread list paging by normalized cwd", () => {
    persistSidebarUiState({
      chatSectionExpanded: true,
      chatThreadListExtraPages: 2,
      projectThreadListExtraPagesByCwd: {
        "/Users/tester/Code/demo": 1,
        "/Users/tester/Code/demo/": 3,
        "/Users/tester/Code/other": 2,
      },
      dismissedThreadStatusKeyByThreadId: {
        "thread-123": "Plan Ready:turn-1",
      },
      lastThreadRoute: {
        threadId: "thread-123",
        splitViewId: "split-456",
      },
      activityViewEnabled: true,
    });

    expect(readSidebarUiState()).toEqual({
      chatSectionExpanded: true,
      chatThreadListExtraPages: 2,
      projectThreadListExtraPagesByCwd: {
        // Duplicate cwds that normalize to the same key keep the deepest paging.
        [normalizeSidebarProjectThreadListCwd("/Users/tester/Code/demo")]: 3,
        [normalizeSidebarProjectThreadListCwd("/Users/tester/Code/other")]: 2,
      },
      dismissedThreadStatusKeyByThreadId: {
        "thread-123": "Plan Ready:turn-1",
      },
      lastThreadRoute: {
        threadId: "thread-123",
        splitViewId: "split-456",
      },
      activityViewEnabled: true,
    });
  });

  it("ignores malformed persisted thread list paging entries", () => {
    window.localStorage.setItem(
      "synara:sidebar-ui:v1",
      JSON.stringify({
        chatSectionExpanded: true,
        chatThreadListExtraPages: -4,
        projectThreadListExtraPagesByCwd: {
          "/Users/tester/Code/demo": 2,
          "/Users/tester/Code/zero": 0,
          "/Users/tester/Code/negative": -1,
          "/Users/tester/Code/bad": "nope",
          "": 3,
        },
        dismissedThreadStatusKeyByThreadId: {
          "thread-123": "Awaiting Input:turn-2",
          "": "bad",
          "thread-456": 42,
        },
        lastThreadRoute: {
          threadId: "thread-123",
          splitViewId: 42,
        },
      }),
    );

    expect(readSidebarUiState()).toEqual({
      chatSectionExpanded: true,
      chatThreadListExtraPages: 0,
      projectThreadListExtraPagesByCwd: {
        [normalizeSidebarProjectThreadListCwd("/Users/tester/Code/demo")]: 2,
      },
      dismissedThreadStatusKeyByThreadId: {
        "thread-123": "Awaiting Input:turn-2",
      },
      lastThreadRoute: {
        threadId: "thread-123",
      },
      activityViewEnabled: false,
    });
  });

  it("migrates legacy all-or-nothing show-more state to one extra page", () => {
    window.localStorage.setItem(
      "synara:sidebar-ui:v1",
      JSON.stringify({
        chatSectionExpanded: false,
        chatThreadListExpanded: true,
        expandedProjectThreadListCwds: ["/Users/tester/Code/demo", "/Users/tester/Code/other"],
      }),
    );

    expect(readSidebarUiState()).toMatchObject({
      chatThreadListExtraPages: 1,
      projectThreadListExtraPagesByCwd: {
        [normalizeSidebarProjectThreadListCwd("/Users/tester/Code/demo")]: 1,
        [normalizeSidebarProjectThreadListCwd("/Users/tester/Code/other")]: 1,
      },
    });
  });

  it("drops malformed persisted last thread routes", () => {
    window.localStorage.setItem(
      "synara:sidebar-ui:v1",
      JSON.stringify({
        lastThreadRoute: {
          threadId: 42,
          splitViewId: "split-123",
        },
      }),
    );

    expect(readSidebarUiState()).toEqual({
      chatSectionExpanded: false,
      chatThreadListExtraPages: 0,
      projectThreadListExtraPagesByCwd: {},
      dismissedThreadStatusKeyByThreadId: {},
      lastThreadRoute: null,
      activityViewEnabled: false,
    });
  });
});
