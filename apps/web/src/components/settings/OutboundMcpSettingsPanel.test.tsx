// FILE: OutboundMcpSettingsPanel.test.tsx
// Purpose: Guards the Settings UI for Synara-owned outbound MCP service connections.
// Layer: Settings component tests
// Depends on: React server rendering, React Query, and the native API bridge mock.

import type { NativeApi, OutboundMcpConnection } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  openOutboundMcpAuthorizationFromUserGesture,
  outboundMcpBeginAuthorizationMutationOptions,
  outboundMcpConnectionsQueryOptions,
  outboundMcpDisconnectMutationOptions,
  outboundMcpQueryKeys,
} from "~/lib/outboundMcpReactQuery";
import * as nativeApi from "~/nativeApi";
import {
  buildOutboundMcpDisconnectConfirmation,
  OutboundMcpSettingsPanel,
} from "./OutboundMcpSettingsPanel";

const paratyConnection: OutboundMcpConnection = {
  id: "paraty",
  presetId: "paraty",
  displayName: "Paraty MCP",
  endpoint: "https://mcp-paraty-224371693889.europe-west1.run.app/mcp",
  status: "disconnected",
  lastValidatedAt: null,
  errorCategory: null,
};

function connection(input: Partial<OutboundMcpConnection>): OutboundMcpConnection {
  return { ...paratyConnection, ...input };
}

function renderPanel(connections: readonly OutboundMcpConnection[]): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(outboundMcpQueryKeys.connections(), { connections });

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <OutboundMcpSettingsPanel active />
    </QueryClientProvider>,
  );
}

function buttonTag(markup: string, label: string): string {
  const match = markup.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`, "u"));
  expect(match?.[0]).toBeDefined();
  return match![0]!;
}

function hasDisabledAttribute(markup: string): boolean {
  return /\sdisabled(?:=|>|\s)/u.test(markup);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OutboundMcpSettingsPanel", () => {
  it("separates outbound services from inbound agents and offers Paraty MCP connection", () => {
    const markup = renderPanel([connection({ status: "disconnected" })]);

    expect(markup).toContain("Services Synara uses");
    expect(markup).toContain("Agents connected to Synara");
    expect(markup).toContain("Paraty MCP");
    expect(hasDisabledAttribute(buttonTag(markup, "Connect Paraty MCP"))).toBe(false);
  });

  it("uses reconnect copy without exposing token-like error categories or endpoints", () => {
    const markup = renderPanel([
      connection({
        status: "reconnect-required",
        errorCategory: "access_token_revoked",
      }),
    ]);
    const lowerMarkup = markup.toLowerCase();

    expect(hasDisabledAttribute(buttonTag(markup, "Reconnect Paraty MCP"))).toBe(false);
    expect(markup).toContain("Reconnect to restore access.");
    expect(lowerMarkup).not.toContain("access_token");
    expect(lowerMarkup).not.toContain("access-token");
    expect(lowerMarkup).not.toContain("mcp-paraty-224371693889");
    expect(lowerMarkup).not.toContain("https://");
  });

  it("disables service controls while authorization is in progress", () => {
    const markup = renderPanel([connection({ status: "authorizing" })]);

    expect(hasDisabledAttribute(buttonTag(markup, "Authorizing Paraty MCP"))).toBe(true);
    expect(markup).toContain("Finish authorization in the browser.");
  });

  it("explains incompatible and transient states with category-only copy", () => {
    const incompatible = renderPanel([
      connection({ status: "incompatible", errorCategory: "incompatible-tools" }),
    ]);
    const transient = renderPanel([
      connection({ status: "temporarily-unavailable", errorCategory: "timeout" }),
    ]);

    expect(incompatible).toContain("Bitbucket pull request capability");
    expect(incompatible).toContain("Disconnect Paraty MCP");
    expect(transient).toContain("Retry when the service is reachable.");
    expect(hasDisabledAttribute(buttonTag(transient, "Retry Paraty MCP"))).toBe(false);
    expect(`${incompatible}${transient}`).not.toContain("incompatible-tools");
    expect(`${incompatible}${transient}`).not.toContain("timeout");
  });

  it("shows last validation time as machine-readable metadata", () => {
    const markup = renderPanel([
      connection({
        status: "connected",
        lastValidatedAt: "2026-08-31T10:05:00.000Z",
      }),
    ]);

    expect(markup).toContain("Last validated");
    expect(markup).toContain('dateTime="2026-08-31T10:05:00.000Z"');
    expect(markup).toContain("Disconnect Paraty MCP");
  });

  it("uses confirmation copy that preserves local projects and pull request pins", () => {
    const confirmation = buildOutboundMcpDisconnectConfirmation("Paraty MCP");

    expect(confirmation.title).toBe("Disconnect Paraty MCP?");
    expect(confirmation.description).toContain("Projects and pull request pins stay in Synara.");
    expect(confirmation.confirmLabel).toBe("Disconnect");
  });
});

describe("outbound MCP React Query helpers", () => {
  it("polls only while an outbound MCP service is authorizing", () => {
    const options = outboundMcpConnectionsQueryOptions();

    expect(options.queryKey).toEqual(["outbound-mcp", "connections"]);
    expect(
      options.refetchInterval?.({
        state: { data: { connections: [connection({ status: "authorizing" })] } },
      } as never),
    ).toBe(1_000);
    expect(
      options.refetchInterval?.({
        state: { data: { connections: [connection({ status: "connected" })] } },
      } as never),
    ).toBe(false);
  });

  it("uses the desktop shell path and safely invalidates after shell failure", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(outboundMcpQueryKeys.connections(), {
      connections: [connection({ status: "disconnected" })],
    });
    const beginOutboundMcpAuthorization = vi.fn().mockResolvedValue({
      attemptId: "attempt-paraty",
      authorizationUrl: "https://auth.paraty.example/authorize",
    });
    const openExternal = vi.fn().mockRejectedValue(new Error("user cancelled external opening"));
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      server: { beginOutboundMcpAuthorization },
      shell: { openExternal },
    } as unknown as NativeApi);

    const result = await openOutboundMcpAuthorizationFromUserGesture({
      presetId: "paraty",
      queryClient,
    });

    expect(beginOutboundMcpAuthorization).toHaveBeenCalledWith({ presetId: "paraty" });
    expect(openExternal).toHaveBeenCalledWith("https://auth.paraty.example/authorize");
    expect(result).toEqual({ status: "failed" });
    expect(queryClient.getQueryState(outboundMcpQueryKeys.connections())?.isInvalidated).toBe(true);
  });

  it("invalidates connection data after successful lifecycle mutations", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const beginOutboundMcpAuthorization = vi.fn().mockResolvedValue({
      attemptId: "attempt-paraty",
      authorizationUrl: "https://auth.paraty.example/authorize",
    });
    const disconnectOutboundMcpConnection = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      server: { beginOutboundMcpAuthorization, disconnectOutboundMcpConnection },
    } as unknown as NativeApi);

    queryClient.setQueryData(outboundMcpQueryKeys.connections(), {
      connections: [connection({ status: "disconnected" })],
    });
    const beginMutation = queryClient
      .getMutationCache()
      .build(queryClient, outboundMcpBeginAuthorizationMutationOptions(queryClient));
    await beginMutation.execute({ presetId: "paraty" });

    expect(beginOutboundMcpAuthorization).toHaveBeenCalledWith({ presetId: "paraty" });
    expect(queryClient.getQueryState(outboundMcpQueryKeys.connections())?.isInvalidated).toBe(true);

    queryClient.setQueryData(outboundMcpQueryKeys.connections(), {
      connections: [connection({ status: "connected" })],
    });
    const disconnectMutation = queryClient
      .getMutationCache()
      .build(queryClient, outboundMcpDisconnectMutationOptions(queryClient));
    await disconnectMutation.execute({ connectionId: "paraty" });

    expect(disconnectOutboundMcpConnection).toHaveBeenCalledWith({ connectionId: "paraty" });
    expect(queryClient.getQueryState(outboundMcpQueryKeys.connections())?.isInvalidated).toBe(true);
  });
});
