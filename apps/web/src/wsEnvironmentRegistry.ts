// FILE: wsEnvironmentRegistry.ts
// Purpose: Environment-keyed registry of WebSocket clients; the local server is the default entry.
// Layer: Web transport
// Exports: registry accessors plus the local-environment push subscription helpers.

import {
  WS_CHANNELS,
  type EnvironmentId,
  type ServerLifecycleStreamEvent,
  type ServerProviderStatusesUpdatedPayload,
  type ServerSettingsUpdatedPayload,
  type ServerConfigUpdatedPayload,
  type WsWelcomePayload,
} from "@synara/contracts";

import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";
import { createListenerRegistry, subscribeWithReplay } from "./listenerRegistry";
import { discardEnvironmentResumeCursors } from "./threadDetailResumeCursors";
import {
  createWsEnvironmentClient,
  type WsEnvironmentClient,
  type WsThreadStreamFailure,
} from "./wsNativeApi";

export type { WsEnvironmentClient } from "./wsNativeApi";

/**
 * One entry per connected server. Every entry owns its socket, backoff,
 * negotiation cache, sequence space, resume cursors and subscription state;
 * nothing is shared across entries because event sequences are per-server
 * SQLite autoincrement values with no cross-server ordering.
 */
const clientsByEnvironmentId = new Map<EnvironmentId, WsEnvironmentClient>();

/**
 * Notifies when the set of registered environments changes. Consumers that
 * aggregate across environments (the sidebar's shell merge) re-derive from
 * `listWsEnvironmentClients` rather than tracking registrations themselves.
 * This is the hook issue #7's settings UI drives by adding/removing servers.
 */
const registryListeners = createListenerRegistry<void>();

export function onWsEnvironmentRegistryChange(listener: () => void): () => void {
  return registryListeners.subscribe(listener);
}

export interface RegisterEnvironmentInput {
  readonly environmentId: EnvironmentId;
  /** Absolute WS URL for the environment; omit for the page's own origin. */
  readonly url?: string | null;
}

/**
 * Returns the environment's client, connecting on first use. A disposed entry
 * is replaced rather than handed out, so a logout or hot reload cannot strand
 * callers on a dead socket.
 */
export function ensureWsEnvironmentClient(
  input: RegisterEnvironmentInput = { environmentId: LOCAL_ENVIRONMENT_ID },
): WsEnvironmentClient {
  const existing = clientsByEnvironmentId.get(input.environmentId);
  if (existing) {
    if (existing.transport.getState() !== "disposed") return existing;
    clientsByEnvironmentId.delete(input.environmentId);
    // The replacement transport starts with no observed server instance, so its
    // first negotiation cannot tell that a surviving cursor came from an earlier
    // one. Dropping the scope here keeps the "a cursor is only valid against the
    // journal that issued it" invariant across a dispose/recreate cycle.
    discardEnvironmentResumeCursors(input.environmentId);
  }
  const created = createWsEnvironmentClient({
    environmentId: input.environmentId,
    ...(input.url === undefined ? {} : { url: input.url }),
  });
  clientsByEnvironmentId.set(input.environmentId, created);
  registryListeners.emit();
  return created;
}

/** Connected environments, in registration order. Callers aggregate client-side. */
export function listWsEnvironmentClients(): readonly WsEnvironmentClient[] {
  return [...clientsByEnvironmentId.values()];
}

export function getWsEnvironmentClient(
  environmentId: EnvironmentId,
): WsEnvironmentClient | undefined {
  return clientsByEnvironmentId.get(environmentId);
}

/**
 * Drops the environment's projected rows and snapshot fence.
 *
 * The store is resolved lazily rather than imported at module scope: this
 * module sits underneath the store in the import graph (the store's own
 * transport reaches back here), and it is exercised by node-environment tests
 * that a top-level store import would break on its `window` side effects.
 */
function discardEnvironmentProjectionState(environmentId: EnvironmentId): void {
  void import("./store").then(({ useStore }) => {
    useStore.getState().discardEnvironmentProjection(environmentId);
  });
}

/** Tears down one environment. The remaining environments are untouched. */
export async function removeWsEnvironmentClient(environmentId: EnvironmentId): Promise<void> {
  const client = clientsByEnvironmentId.get(environmentId);
  if (!client) return;
  clientsByEnvironmentId.delete(environmentId);
  // Cursors outlive the transport that collected them, so they must be dropped
  // with it: a re-registered environment may be served by a different instance
  // whose journal has an unrelated sequence space, and the fresh transport has
  // no memory of the old instance id with which to detect that.
  discardEnvironmentResumeCursors(environmentId);
  // The projected rows and the snapshot fence outlive it too, and unlike a
  // generation change no snapshot is coming to supersede them: the sidebar
  // would keep listing threads owned by a server that is gone, and a stale
  // fence would reject the first snapshot if it were ever re-registered.
  discardEnvironmentProjectionState(environmentId);
  registryListeners.emit();
  await client.dispose();
}

/**
 * Drops every environment. Browser-mode tests mount full app roots repeatedly
 * in one page, so each test needs fresh sockets and cached push state.
 */
export async function resetWsEnvironmentRegistry(): Promise<void> {
  const clients = [...clientsByEnvironmentId.values()];
  clientsByEnvironmentId.clear();
  for (const client of clients) {
    discardEnvironmentResumeCursors(client.environmentId);
  }
  // Every registry-change subscriber is itself torn down by this reset, so
  // notifying here would only let a listener from the outgoing generation
  // re-attach against clients that are already being disposed.
  registryListeners.clear();
  await Promise.all(clients.map((client) => client.dispose()));
}

/** The page's own server. UI that is not yet multi-environment reads through here. */
export function localWsEnvironmentClient(): WsEnvironmentClient {
  return ensureWsEnvironmentClient({ environmentId: LOCAL_ENVIRONMENT_ID });
}

export interface WsEnvironmentSubscriptionOptions {
  readonly environmentId?: EnvironmentId;
}

/**
 * The local environment connects on demand so a subscription registered before
 * the first RPC still receives pushes — the singleton it replaced was reachable
 * without an explicit connect. A remote environment is never auto-connected:
 * its URL is only known once it has been registered, so an unknown id yields an
 * inert subscription instead of a connection to the wrong server.
 */
function scopedClient(
  options: WsEnvironmentSubscriptionOptions | undefined,
): WsEnvironmentClient | undefined {
  const environmentId = options?.environmentId ?? LOCAL_ENVIRONMENT_ID;
  if (environmentId === LOCAL_ENVIRONMENT_ID) return localWsEnvironmentClient();
  return clientsByEnvironmentId.get(environmentId);
}

/**
 * Subscribe to one environment's server welcome. If a welcome was already
 * received before this call, the listener fires synchronously with the cached
 * payload — closing the race between connect and React effect registration.
 * The cached payload is read from that environment's transport, so a second
 * server's welcome can never replay here.
 */
export function onServerWelcome(
  listener: (payload: WsWelcomePayload) => void,
  options?: WsEnvironmentSubscriptionOptions,
): () => void {
  const client = scopedClient(options);
  if (!client) return () => undefined;
  return subscribeWithReplay({
    registry: client.channels.welcome,
    listener,
    latest: client.getLatestPush(WS_CHANNELS.serverWelcome)?.data ?? null,
  });
}

/**
 * Subscribe to server config update events. Replays the latest update for late
 * subscribers to avoid missing config validation feedback.
 */
export function onServerConfigUpdated(
  listener: (payload: ServerConfigUpdatedPayload) => void,
  options?: WsEnvironmentSubscriptionOptions,
): () => void {
  const client = scopedClient(options);
  if (!client) return () => undefined;
  return subscribeWithReplay({
    registry: client.channels.serverConfigUpdated,
    listener,
    latest: client.getLatestPush(WS_CHANNELS.serverConfigUpdated)?.data ?? null,
  });
}

/** Subscribe to provider status updates without forcing a full config reload. */
export function onServerProviderStatusesUpdated(
  listener: (payload: ServerProviderStatusesUpdatedPayload) => void,
  options?: WsEnvironmentSubscriptionOptions,
): () => void {
  const client = scopedClient(options);
  if (!client) return () => undefined;
  return subscribeWithReplay({
    registry: client.channels.serverProviderStatusesUpdated,
    listener,
    latest: client.getLatestPush(WS_CHANNELS.serverProviderStatusesUpdated)?.data ?? null,
  });
}

export function onServerMaintenanceUpdated(
  listener: (payload: ServerLifecycleStreamEvent) => void,
  options?: WsEnvironmentSubscriptionOptions,
): () => void {
  const client = scopedClient(options);
  if (!client) return () => undefined;
  return subscribeWithReplay({
    registry: client.channels.serverMaintenanceUpdated,
    listener,
    latest: client.getLatestPush(WS_CHANNELS.serverMaintenanceUpdated)?.data ?? null,
  });
}

export function onServerSettingsUpdated(
  listener: (payload: ServerSettingsUpdatedPayload) => void,
  options?: WsEnvironmentSubscriptionOptions,
): () => void {
  const client = scopedClient(options);
  if (!client) return () => undefined;
  return subscribeWithReplay({
    registry: client.channels.serverSettingsUpdated,
    listener,
    latest: client.getLatestPush(WS_CHANNELS.serverSettingsUpdated)?.data ?? null,
  });
}

/**
 * Subscribe to unrecoverable per-thread stream failures (retries and reconnect
 * exhausted). Lets thread-detail consumers surface a failed hydration state
 * instead of rendering an empty conversation.
 */
export function onThreadStreamFailure(
  listener: (failure: WsThreadStreamFailure) => void,
  options?: WsEnvironmentSubscriptionOptions,
): () => void {
  const client = scopedClient(options);
  if (!client) return () => undefined;
  return client.channels.threadStreamFailure.subscribe(listener);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void resetWsEnvironmentRegistry();
  });
}
