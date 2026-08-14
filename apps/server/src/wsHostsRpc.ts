// FILE: wsHostsRpc.ts
// Purpose: The remote-host RPC handlers, as one owner-guarded unit.
// Layer: server RPC handlers
//
// Kept separate for the same enumerable owner boundary as wsAccountRpc.ts:
// every handler built here runs behind `requireOwnerRole`, and the tests
// iterate this module's keys. Hosts, registered devices, grants, and local
// enrollment are all machine account state; a paired client-role session must
// neither read nor mutate any of them. The guard runs before the handler
// effect is built, so a refused session touches no account or credential state.

import { WS_METHODS } from "@synara/contracts";
import { Effect } from "effect";

import { toAccountWsRpcError, toSensitiveWsRpcError } from "./accountRpcErrors";
import type { HostsAccountSession } from "./accountSession";
import { requireOwnerRole } from "./wsOwnerOnly";

export interface HostsRpcHandlerDeps {
  readonly accountSession: HostsAccountSession;
}

const ownerHostsRpc = <A, E, R>(make: () => Effect.Effect<A, E, R>, fallbackMessage: string) =>
  requireOwnerRole.pipe(
    Effect.flatMap(() =>
      make().pipe(Effect.mapError((cause) => toAccountWsRpcError(cause, fallbackMessage))),
    ),
  );

const ownerSensitiveHostsRpc = <A, E, R>(
  make: () => Effect.Effect<A, E, R>,
  fallbackMessage: string,
) =>
  requireOwnerRole.pipe(
    Effect.flatMap(() =>
      make().pipe(Effect.mapError((cause) => toSensitiveWsRpcError(cause, fallbackMessage))),
    ),
  );

export function makeHostsRpcHandlers({ accountSession }: HostsRpcHandlerDeps) {
  return {
    [WS_METHODS.hostsList]: () =>
      ownerHostsRpc(
        () => Effect.tryPromise(() => accountSession.listHosts()),
        "Failed to list hosts",
      ),
    [WS_METHODS.hostsUpdate]: (input: Parameters<HostsAccountSession["updateHost"]>[0]) =>
      ownerHostsRpc(
        () => Effect.tryPromise(() => accountSession.updateHost(input)),
        "Failed to update the host",
      ),
    [WS_METHODS.hostsDelete]: (input: Parameters<HostsAccountSession["deleteHost"]>[0]) =>
      ownerHostsRpc(
        () => Effect.tryPromise(() => accountSession.deleteHost(input)),
        "Failed to delete the host",
      ),
    [WS_METHODS.hostsListDevices]: () =>
      ownerHostsRpc(
        () => Effect.tryPromise(() => accountSession.listDevices()),
        "Failed to list devices",
      ),
    [WS_METHODS.hostsRevokeDevice]: (input: Parameters<HostsAccountSession["revokeDevice"]>[0]) =>
      ownerHostsRpc(
        () => Effect.tryPromise(() => accountSession.revokeDevice(input)),
        "Failed to revoke the device",
      ),
    // The user code is a short-lived approval credential. Drop upstream
    // causes so neither a fetch error nor a serialized log can echo it.
    [WS_METHODS.hostsApproveDeviceLink]: (
      input: Parameters<HostsAccountSession["approveDeviceLink"]>[0],
    ) =>
      ownerSensitiveHostsRpc(
        () => Effect.tryPromise(() => accountSession.approveDeviceLink(input)),
        "Failed to approve the device link",
      ),
    [WS_METHODS.hostsRequestGrant]: (input: Parameters<HostsAccountSession["requestGrant"]>[0]) =>
      ownerHostsRpc(
        () => Effect.tryPromise(() => accountSession.requestGrant(input)),
        "Failed to request a host grant",
      ),
    [WS_METHODS.hostsEnrollment]: () =>
      ownerHostsRpc(
        () => Effect.tryPromise(() => accountSession.enrollment()),
        "Failed to read local host enrollment",
      ),
    [WS_METHODS.hostsUnlinkLocalHost]: () =>
      ownerHostsRpc(
        () => Effect.tryPromise(() => accountSession.unlinkLocalHost()),
        "Failed to unlink the local host",
      ),
  };
}
