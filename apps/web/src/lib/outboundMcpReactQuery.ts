// FILE: outboundMcpReactQuery.ts
// Purpose: React Query keys and lifecycle helpers for Synara-owned outbound MCP services.
// Layer: Web data fetching helpers
// Depends on: native API bridge and React Query.

import type {
  OutboundMcpBeginAuthorizationInput,
  OutboundMcpDisconnectInput,
} from "@synara/contracts";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";

import { ensureNativeApi } from "~/nativeApi";

export const OUTBOUND_MCP_AUTHORIZING_REFETCH_INTERVAL_MS = 1_000;
export const OUTBOUND_MCP_CONNECTIONS_STALE_TIME_MS = 5_000;

export const outboundMcpQueryKeys = {
  all: ["outbound-mcp"] as const,
  connections: () => [...outboundMcpQueryKeys.all, "connections"] as const,
};

export const outboundMcpMutationKeys = {
  beginAuthorization: () =>
    [...outboundMcpQueryKeys.all, "mutation", "begin-authorization"] as const,
  disconnect: () => [...outboundMcpQueryKeys.all, "mutation", "disconnect"] as const,
};

export function outboundMcpConnectionsQueryOptions(input?: { readonly enabled?: boolean }) {
  return queryOptions({
    queryKey: outboundMcpQueryKeys.connections(),
    queryFn: () => ensureNativeApi().server.listOutboundMcpConnections(),
    enabled: input?.enabled ?? true,
    staleTime: OUTBOUND_MCP_CONNECTIONS_STALE_TIME_MS,
    placeholderData: (previous) => previous,
    refetchInterval: (query) => {
      const connections = query.state.data?.connections ?? [];
      const hasAuthorizingConnection = connections.some(
        (connection) => connection.status === "authorizing",
      );
      return hasAuthorizingConnection ? OUTBOUND_MCP_AUTHORIZING_REFETCH_INTERVAL_MS : false;
    },
  });
}

export function invalidateOutboundMcpConnections(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: outboundMcpQueryKeys.connections() });
}

export function outboundMcpBeginAuthorizationMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: outboundMcpMutationKeys.beginAuthorization(),
    mutationFn: (input: OutboundMcpBeginAuthorizationInput) =>
      ensureNativeApi().server.beginOutboundMcpAuthorization(input),
    onSuccess: () => invalidateOutboundMcpConnections(queryClient),
  });
}

export function outboundMcpDisconnectMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: outboundMcpMutationKeys.disconnect(),
    mutationFn: (input: OutboundMcpDisconnectInput) =>
      ensureNativeApi().server.disconnectOutboundMcpConnection(input),
    onSuccess: () => invalidateOutboundMcpConnections(queryClient),
  });
}

export async function openOutboundMcpAuthorizationFromUserGesture(input: {
  readonly presetId: string;
  readonly queryClient: QueryClient;
}): Promise<{ readonly opened: boolean }> {
  const api = ensureNativeApi();
  const authorization = await api.server.beginOutboundMcpAuthorization({
    presetId: input.presetId,
  });
  try {
    await api.shell.openExternal(authorization.authorizationUrl);
    return { opened: true };
  } catch {
    return { opened: false };
  } finally {
    await invalidateOutboundMcpConnections(input.queryClient);
  }
}
