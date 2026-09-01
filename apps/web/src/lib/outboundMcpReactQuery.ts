// FILE: outboundMcpReactQuery.ts
// Purpose: React Query keys and lifecycle helpers for Synara-owned outbound MCP services.
// Layer: Web data fetching helpers
// Depends on: native API bridge and React Query.

import type {
  OutboundMcpBeginAuthorizationInput,
  OutboundMcpDisconnectInput,
} from "@synara/contracts";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";

import { requireHttpExternalUrl } from "~/lib/externalUrl";
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

type OutboundMcpAuthorizationOpenResult =
  | { readonly status: "opened" }
  | { readonly status: "blocked" }
  | { readonly status: "failed" };

type AuthorizationWindowReservation =
  | { readonly kind: "native-shell" }
  | { readonly kind: "blocked" }
  | { readonly kind: "browser"; readonly popup: Window };

function shouldReserveBrowserWindow(): boolean {
  if (typeof window === "undefined") return false;
  if (window.nativeApi || window.desktopBridge) return false;
  return true;
}

function reserveAuthorizationWindow(): AuthorizationWindowReservation {
  if (!shouldReserveBrowserWindow()) return { kind: "native-shell" };

  const popup = window.open("about:blank", "_blank");
  if (!popup) return { kind: "blocked" };

  try {
    popup.opener = null;
  } catch {
    // Opener isolation is best-effort for browser reservation handles.
  }

  return { kind: "browser", popup };
}

function closeAuthorizationWindowReservation(reservation: AuthorizationWindowReservation): void {
  if (reservation.kind !== "browser") return;
  try {
    if (!reservation.popup.closed) reservation.popup.close();
  } catch {
    // A failed cleanup must not mask the authorization failure path.
  }
}

async function openAuthorizationUrl(input: {
  readonly reservation: AuthorizationWindowReservation;
  readonly authorizationUrl: string;
  readonly openExternal: (authorizationUrl: string) => Promise<void>;
}): Promise<void> {
  const authorizationUrl = requireHttpExternalUrl(input.authorizationUrl);
  if (input.reservation.kind === "native-shell") {
    await input.openExternal(authorizationUrl);
    return;
  }
  if (input.reservation.kind === "blocked") return;
  if (input.reservation.popup.closed) {
    throw new Error("Authorization window is no longer available.");
  }
  input.reservation.popup.location.assign(authorizationUrl);
}

export async function openOutboundMcpAuthorizationFromUserGesture(input: {
  readonly presetId: string;
  readonly queryClient: QueryClient;
}): Promise<OutboundMcpAuthorizationOpenResult> {
  const api = ensureNativeApi();
  const reservation = reserveAuthorizationWindow();
  if (reservation.kind === "blocked") return { status: "blocked" };

  let lifecycleStarted = false;
  try {
    const authorization = await api.server.beginOutboundMcpAuthorization({
      presetId: input.presetId,
    });
    lifecycleStarted = true;
    await openAuthorizationUrl({
      reservation,
      authorizationUrl: authorization.authorizationUrl,
      openExternal: api.shell.openExternal,
    });
    return { status: "opened" };
  } catch {
    closeAuthorizationWindowReservation(reservation);
    if (!lifecycleStarted) throw new Error("Outbound MCP authorization could not be started.");
    return { status: "failed" };
  } finally {
    if (lifecycleStarted) {
      await invalidateOutboundMcpConnections(input.queryClient);
    }
  }
}
