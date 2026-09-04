// FILE: OutboundMcpSettingsPanel.browser.tsx
// Purpose: Interactive browser coverage for outbound MCP Settings lifecycle controls.
// Layer: Browser UI test

import "../../index.css";

import type { NativeApi, OutboundMcpConnection } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { ReactNode } from "react";

const harness = vi.hoisted(() => ({
  ensureNativeApi: vi.fn(),
  toastAdd: vi.fn(),
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: harness.ensureNativeApi,
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: harness.toastAdd },
}));

vi.mock("./ExternalMcpSettingsPanel", () => ({
  ExternalMcpSettingsPanel: (props: { readonly active: boolean }) => (
    <div data-active={String(props.active)}>External agent MCP panel</div>
  ),
}));

import { outboundMcpQueryKeys } from "~/lib/outboundMcpReactQuery";
import { OutboundMcpSettingsPanel } from "./OutboundMcpSettingsPanel";

const paratyConnection: OutboundMcpConnection = {
  id: "paraty",
  presetId: "paraty",
  displayName: "Paraty MCP",
  endpoint: "https://mcp-paraty.example/mcp",
  status: "disconnected",
  lastValidatedAt: null,
  errorCategory: null,
};

const nativeApiDescriptor = Object.getOwnPropertyDescriptor(window, "nativeApi");
const desktopBridgeDescriptor = Object.getOwnPropertyDescriptor(window, "desktopBridge");

function restoreWindowDesktopBindings(): void {
  if (nativeApiDescriptor) {
    Object.defineProperty(window, "nativeApi", nativeApiDescriptor);
  } else {
    Reflect.deleteProperty(window, "nativeApi");
  }
  if (desktopBridgeDescriptor) {
    Object.defineProperty(window, "desktopBridge", desktopBridgeDescriptor);
  } else {
    Reflect.deleteProperty(window, "desktopBridge");
  }
}

function connection(input: Partial<OutboundMcpConnection>): OutboundMcpConnection {
  return { ...paratyConnection, ...input };
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function mockNativeApi(input?: {
  readonly listConnections?: () => Promise<{
    readonly connections: readonly OutboundMcpConnection[];
  }>;
  readonly beginAuthorization?: NativeApi["server"]["beginOutboundMcpAuthorization"];
  readonly disconnectConnection?: NativeApi["server"]["disconnectOutboundMcpConnection"];
  readonly openExternal?: NativeApi["shell"]["openExternal"];
}) {
  const api = {
    server: {
      listOutboundMcpConnections:
        input?.listConnections ?? vi.fn().mockResolvedValue({ connections: [] }),
      beginOutboundMcpAuthorization:
        input?.beginAuthorization ??
        vi.fn().mockResolvedValue({
          attemptId: "attempt-paraty",
          authorizationUrl: "https://auth.paraty.example/authorize",
        }),
      disconnectOutboundMcpConnection:
        input?.disconnectConnection ?? vi.fn().mockResolvedValue(undefined),
    },
    shell: {
      openExternal: input?.openExternal ?? vi.fn().mockResolvedValue(undefined),
    },
  };
  harness.ensureNativeApi.mockReturnValue(api as unknown as NativeApi);
  return api;
}

function Providers(props: { readonly children: ReactNode; readonly client: QueryClient }) {
  return <QueryClientProvider client={props.client}>{props.children}</QueryClientProvider>;
}

async function renderPanel(input?: {
  readonly active?: boolean;
  readonly connections?: readonly OutboundMcpConnection[];
  readonly client?: QueryClient;
}) {
  const client = input?.client ?? createQueryClient();
  if (input?.connections) {
    client.setQueryData(outboundMcpQueryKeys.connections(), { connections: input.connections });
  }
  await render(
    <Providers client={client}>
      <OutboundMcpSettingsPanel active={input?.active ?? true} />
    </Providers>,
  );
  return client;
}

function createPopupWindow() {
  const assign = vi.fn();
  const close = vi.fn();
  const popup = {
    closed: false,
    close,
    location: { assign },
  } as unknown as Window;
  return { popup, assign, close };
}

afterEach(() => {
  harness.ensureNativeApi.mockReset();
  harness.toastAdd.mockReset();
  restoreWindowDesktopBindings();
  vi.restoreAllMocks();
});

describe("OutboundMcpSettingsPanel browser interactions", () => {
  it("reserves a browser popup synchronously on Connect and navigates it after authorization starts", async () => {
    const calls: string[] = [];
    const { popup, assign } = createPopupWindow();
    let resolveBegin:
      | ((value: { readonly attemptId: string; readonly authorizationUrl: string }) => void)
      | undefined;
    const beginPromise = new Promise<{
      readonly attemptId: string;
      readonly authorizationUrl: string;
    }>((resolve) => {
      resolveBegin = resolve;
    });
    const beginAuthorization = vi.fn(() => {
      calls.push("begin");
      return beginPromise;
    });
    const openExternal = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(window, "open").mockImplementation((url) => {
      calls.push(String(url));
      return popup;
    });
    mockNativeApi({ beginAuthorization, openExternal });
    await renderPanel({ connections: [connection({ status: "disconnected" })] });

    await page.getByRole("button", { name: "Connect Paraty MCP" }).click();
    await vi.waitFor(() => expect(beginAuthorization).toHaveBeenCalledOnce());
    expect(calls).toEqual(["about:blank", "begin"]);

    resolveBegin?.({
      attemptId: "attempt-paraty",
      authorizationUrl: "https://auth.paraty.example/authorize",
    });

    await vi.waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://auth.paraty.example/authorize"),
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("recovers when the browser blocks Connect popup reservation", async () => {
    const beginAuthorization = vi.fn();
    vi.spyOn(window, "open").mockReturnValue(null);
    mockNativeApi({ beginAuthorization });
    await renderPanel({ connections: [connection({ status: "disconnected" })] });

    const connectButton = page.getByRole("button", { name: "Connect Paraty MCP" });
    await connectButton.click();

    await vi.waitFor(() =>
      expect(harness.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "warning",
          title: "Authorization window was blocked",
        }),
      ),
    );
    expect(beginAuthorization).not.toHaveBeenCalled();
    expect((connectButton.element() as HTMLButtonElement).disabled).toBe(false);
  });

  it("closes the reserved browser window and re-enables Connect after authorization setup fails", async () => {
    const { popup, close } = createPopupWindow();
    vi.spyOn(window, "open").mockReturnValue(popup);
    mockNativeApi({
      beginAuthorization: vi.fn().mockRejectedValue(new Error("authorization setup failed")),
    });
    await renderPanel({ connections: [connection({ status: "disconnected" })] });

    const connectButton = page.getByRole("button", { name: "Connect Paraty MCP" });
    await connectButton.click();

    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(harness.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          title: "Could not start authorization",
        }),
      ),
    );
    expect((connectButton.element() as HTMLButtonElement).disabled).toBe(false);
  });

  it("opens, cancels, and confirms the destructive Disconnect dialog", async () => {
    const disconnectConnection = vi.fn().mockResolvedValue(undefined);
    mockNativeApi({ disconnectConnection });
    await renderPanel({ connections: [connection({ status: "connected" })] });

    await page.getByRole("button", { name: "Disconnect Paraty MCP" }).click();
    await expect
      .element(page.getByRole("heading", { name: "Disconnect Paraty MCP?" }))
      .toBeVisible();
    expect(document.body.textContent).toContain("Projects and pull request pins stay in Synara.");

    await page.getByRole("button", { name: "Cancel" }).click();
    await vi.waitFor(() =>
      expect(document.body.textContent).not.toContain("Disconnect Paraty MCP?"),
    );
    expect(disconnectConnection).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Disconnect Paraty MCP" }).click();
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();

    await vi.waitFor(() =>
      expect(disconnectConnection).toHaveBeenCalledWith({ connectionId: "paraty" }),
    );
    await vi.waitFor(() =>
      expect(document.body.textContent).not.toContain("Disconnect Paraty MCP?"),
    );
  });

  it("uses atomic polite status semantics and an accessible authorizing button name", async () => {
    mockNativeApi();
    await renderPanel({ connections: [connection({ status: "authorizing" })] });

    const authorizingButton = page.getByRole("button", { name: "Authorizing Paraty MCP" });
    expect((authorizingButton.element() as HTMLButtonElement).disabled).toBe(true);
    const retryButton = page.getByRole("button", { name: "Retry Paraty MCP" });
    expect((retryButton.element() as HTMLButtonElement).disabled).toBe(false);

    const status = page.getByRole("status", { name: "Paraty MCP connection status" });
    await expect.element(status).toBeVisible();
    expect(status.element().getAttribute("aria-live")).toBe("polite");
    expect(status.element().getAttribute("aria-atomic")).toBe("true");
    expect(status.element().textContent).toContain("Authorizing");
  });

  it("shows a busy loading status instead of disconnected before initial data arrives", async () => {
    let resolveList:
      | ((value: { readonly connections: readonly OutboundMcpConnection[] }) => void)
      | undefined;
    mockNativeApi({
      listConnections: vi.fn(
        () =>
          new Promise<{ readonly connections: readonly OutboundMcpConnection[] }>((resolve) => {
            resolveList = resolve;
          }),
      ),
    });

    await renderPanel();

    const status = page.getByRole("status", { name: "Loading Paraty MCP connection" });
    await expect.element(status).toBeVisible();
    expect(status.element().getAttribute("aria-busy")).toBe("true");
    expect(document.body.textContent).not.toContain("Connect Synara to Paraty MCP");
    resolveList?.({ connections: [connection({ status: "disconnected" })] });
  });

  it("closes the disconnect dialog when the integrations panel deactivates", async () => {
    mockNativeApi();
    const client = createQueryClient();
    client.setQueryData(outboundMcpQueryKeys.connections(), {
      connections: [connection({ status: "connected" })],
    });

    const mounted = await render(
      <Providers client={client}>
        <OutboundMcpSettingsPanel active />
      </Providers>,
    );
    await page.getByRole("button", { name: "Disconnect Paraty MCP" }).click();
    await expect
      .element(page.getByRole("heading", { name: "Disconnect Paraty MCP?" }))
      .toBeVisible();

    await mounted.rerender(
      <Providers client={client}>
        <OutboundMcpSettingsPanel active={false} />
      </Providers>,
    );

    await vi.waitFor(() =>
      expect(document.body.textContent).not.toContain("Disconnect Paraty MCP?"),
    );
    expect(document.body.textContent).toContain("External agent MCP panel");
  });
});
