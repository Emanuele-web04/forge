import "../index.css";

import {
  ThreadId,
  type BrowserSetPanelBoundsInput,
  type ThreadBrowserState,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useBrowserStateStore } from "../browserStateStore";
import { BrowserPanel } from "./BrowserPanel";
import { RightDock } from "./chat/RightDock";
import {
  Menu,
  MenuItem,
  MenuPopupBase,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "./ui/menu";

const api = vi.hoisted(() => ({
  browser: {
    open: vi.fn<() => Promise<ThreadBrowserState>>(),
    hide: vi.fn(async () => {}),
    setPanelBounds: vi.fn<(input: BrowserSetPanelBoundsInput) => Promise<void>>(async () => {}),
    onState: vi.fn(() => () => {}),
    onCopyLink: vi.fn(() => () => {}),
    detachWebview: vi.fn(async () => {}),
  },
}));

vi.mock("../nativeApi", () => ({ readNativeApi: () => api, ensureNativeApi: () => api }));

const threadId = ThreadId.makeUnsafe("menu-occlusion-fixture");
const state: ThreadBrowserState = {
  threadId,
  version: 1,
  open: true,
  activeTabId: "synthetic-tab",
  lastError: null,
  tabs: [
    {
      id: "synthetic-tab",
      url: "https://example.test/fixture",
      title: "Synthetic page",
      lastCommittedUrl: "https://example.test/fixture",
      runtimeSurface: "native",
      status: "live",
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      faviconUrl: null,
      lastError: null,
    },
  ],
};

function lastBounds() {
  return api.browser.setPanelBounds.mock.lastCall?.[0].bounds;
}

function DockFixture({ onAdd }: { onAdd: (kind: string) => void }) {
  return (
    <div className="flex h-screen w-screen">
      <button className="flex-1" type="button">
        Outside menu
      </button>
      <RightDock
        state={{
          open: true,
          activePaneId: "browser",
          panes: [
            {
              id: "browser",
              kind: "browser",
              threadId,
              diffTurnId: null,
              diffFilePath: null,
              filePath: null,
              pullRequestProjectId: null,
              pullRequestRepository: null,
              pullRequestNumber: null,
              pullRequestInitialTab: null,
            },
          ],
        }}
        minWidth={320}
        defaultWidth="50vw"
        shouldAcceptWidth={() => true}
        addMenuKinds={["terminal", "browser", "explorer", "sidechat"]}
        onClosePane={() => {}}
        onCollapse={() => {}}
        onOpenChange={() => {}}
        onAddPane={onAdd}
        renderPane={() => (
          <BrowserPanel mode="sidebar" threadId={threadId} onClosePanel={() => {}} />
        )}
      />
    </div>
  );
}

function FloatingFixture({ showMenu = true }: { showMenu?: boolean }) {
  const [selected, setSelected] = useState(false);
  return (
    <>
      <div style={{ position: "fixed", left: 240, top: 120, width: 420, height: 380 }}>
        <BrowserPanel mode="floating" threadId={threadId} onClosePanel={() => {}} />
      </div>
      {showMenu && (
        <div style={{ position: "fixed", left: 560, top: 170 }}>
          <Menu modal={false}>
            <MenuTrigger>Panel menu</MenuTrigger>
            <MenuPopupBase align="end">
              <MenuItem>Primary action</MenuItem>
              <MenuSub>
                <MenuSubTrigger>More panels</MenuSubTrigger>
                <MenuSubPopup>
                  <MenuItem onClick={() => setSelected(true)}>Explorer</MenuItem>
                </MenuSubPopup>
              </MenuSub>
            </MenuPopupBase>
          </Menu>
        </div>
      )}
      <output>{selected ? "Selected explorer" : "No selection"}</output>
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.browser.open.mockResolvedValue(state);
  useBrowserStateStore.setState({
    threadStatesByThreadId: { [threadId]: state },
    recentHistoryByThreadId: {},
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("native browser menu occlusion", () => {
  it("retains a renderer opener while its native popup is active and restores the same webview", async () => {
    await page.viewport(1280, 900);
    const openerState: ThreadBrowserState = {
      ...state,
      tabs: [{ ...state.tabs[0]!, runtimeSurface: "renderer" }],
    };
    api.browser.open.mockResolvedValue(openerState);
    useBrowserStateStore.setState({ threadStatesByThreadId: { [threadId]: openerState } });
    const mounted = await render(
      <QueryClientProvider client={new QueryClient()}>
        <DockFixture onAdd={() => {}} />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(document.querySelector("webview")).not.toBeNull());
    const webview = document.querySelector("webview")!;
    const stage = webview.parentElement!;
    const sourceUrl = webview.getAttribute("src");
    useBrowserStateStore.getState().upsertThreadState({
      ...openerState,
      version: 2,
      activeTabId: "popup",
      tabs: [
        ...openerState.tabs,
        {
          ...state.tabs[0]!,
          id: "popup",
          openerTabId: state.activeTabId!,
          title: "Synthetic sign-in",
        },
      ],
    });
    await vi.waitFor(() => expect(stage.style.visibility).toBe("hidden"));
    expect(webview.isConnected).toBe(true);
    expect(webview.getAttribute("src")).toBe(sourceUrl);
    expect(api.browser.detachWebview).not.toHaveBeenCalled();
    useBrowserStateStore.getState().upsertThreadState({ ...openerState, version: 3 });
    await vi.waitFor(() => expect(stage.style.visibility).toBe("visible"));
    expect(document.querySelector("webview")).toBe(webview);
    expect(webview.getAttribute("src")).toBe(sourceUrl);
    expect(api.browser.detachWebview).not.toHaveBeenCalled();
    await mounted.unmount();
  });

  it.each([1280, 800])(
    "restores the same docked tab after every Add panel dismissal at %ipx",
    async (width) => {
      await page.viewport(width, 900);
      const onAdd = vi.fn();
      const mounted = await render(
        <QueryClientProvider client={new QueryClient()}>
          <DockFixture onAdd={onAdd} />
        </QueryClientProvider>,
      );
      await vi.waitFor(() => expect(lastBounds()?.width).toBeGreaterThan(0));
      const original = lastBounds();
      const trigger = page.getByRole("button", { name: "Add panel", exact: true });
      for (const dismissal of ["escape", "outside", "trigger", "selection"]) {
        await trigger.click();
        await expect
          .element(page.getByRole("menuitem", { name: "Explorer", exact: true }))
          .toBeVisible();
        await vi.waitFor(() => expect(lastBounds()).toBeNull());
        expect(api.browser.setPanelBounds.mock.lastCall?.[0].occluded).toBe(true);
        if (dismissal === "escape") await userEvent.keyboard("{Escape}");
        if (dismissal === "outside")
          await page.getByRole("button", { name: "Outside menu" }).click();
        if (dismissal === "trigger") await trigger.click();
        if (dismissal === "selection")
          await page.getByRole("menuitem", { name: "Explorer", exact: true }).click();
        await vi.waitFor(() => expect(lastBounds()).toEqual(original));
        expect(api.browser.setPanelBounds.mock.lastCall?.[0].occluded).toBe(false);
      }
      expect(onAdd).toHaveBeenCalledExactlyOnceWith("explorer");
      expect(api.browser.open).toHaveBeenCalledOnce();
      expect(api.browser.hide).not.toHaveBeenCalled();
      expect(api.browser.detachWebview).not.toHaveBeenCalled();
      expect(useBrowserStateStore.getState().threadStatesByThreadId[threadId]).toEqual(state);
      await mounted.unmount();
    },
  );

  it("keeps floating native content hidden through submenu interaction and restores on unmount", async () => {
    await page.viewport(1000, 800);
    const client = new QueryClient();
    const mounted = await render(
      <QueryClientProvider client={client}>
        <FloatingFixture />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(lastBounds()?.width).toBeGreaterThan(0));
    const original = lastBounds();
    await page.getByRole("button", { name: "Panel menu" }).click();
    await vi.waitFor(() => expect(lastBounds()).toBeNull());
    await page.getByText("More panels", { exact: true }).hover();
    await expect
      .element(page.getByRole("menuitem", { name: "Explorer", exact: true }))
      .toBeVisible();
    await page.getByRole("menuitem", { name: "Explorer", exact: true }).hover();
    expect(lastBounds()).toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(lastBounds()).toBeNull();
    await page.getByText("More panels", { exact: true }).hover();
    await page.getByRole("menuitem", { name: "Explorer", exact: true }).click();
    await expect.element(page.getByText("Selected explorer", { exact: true })).toBeVisible();
    await vi.waitFor(() => expect(lastBounds()).toEqual(original));
    await page.getByRole("button", { name: "Panel menu" }).click();
    await vi.waitFor(() => expect(lastBounds()).toBeNull());
    await mounted.rerender(
      <QueryClientProvider client={client}>
        <FloatingFixture showMenu={false} />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(lastBounds()).toEqual(original));
    expect(api.browser.open).toHaveBeenCalledOnce();
    expect(api.browser.detachWebview).not.toHaveBeenCalled();
    await mounted.unmount();
  });
});
