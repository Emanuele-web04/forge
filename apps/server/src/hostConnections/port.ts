// FILE: port.ts
// Purpose: The `hosts.connect` / `disconnect` / `listConnections` behaviour
//          behind the RPC handlers: look the host up in the directory, dial it
//          with this shell's device key, keep the session in the registry.
// Layer: server host connections

import type { HostConnection } from "@synara/contracts";

import type { HostsAccountSession } from "../accountSession";
import { toAccountWsRpcError } from "../accountRpcErrors";
import { dialHost, HostDialError } from "./dialer";
import type { HostConnectionRegistry } from "./registry";

/** The outbound side: sessions THIS shell holds to other hosts. */
export interface HostConnectionsPort {
  connect(input: { readonly hostId: string }): Promise<HostConnection>;
  disconnect(input: { readonly hostId: string }): Promise<void>;
  list(): Promise<{ readonly connections: readonly HostConnection[] }>;
}

export interface HostConnectionsPortDeps {
  readonly accountSession: Pick<HostsAccountSession, "listHosts" | "requestGrant" | "dialIdentity">;
  readonly registry: HostConnectionRegistry;
  /** Relay root URL, from `SYNARA_RELAY_URL`; absent means direct paths only. */
  readonly relayUrl: string | undefined;
}

/** Turns a dial failure into the one sentence the row can show. */
function describeDialFailure(error: unknown): string {
  if (error instanceof HostDialError) {
    switch (error.detail.stage) {
      case "no-route":
        return error.message;
      case "grant":
        return `Could not get permission to connect: ${toAccountWsRpcError(error.cause, "the account service refused").message}`;
      case "unreachable": {
        const attempts = error.detail.race?.attempts ?? [];
        const tried = attempts.map((attempt) => `${attempt.candidate.kind}: ${attempt.status}`);
        return `${error.message}${tried.length > 0 ? ` (${tried.join(", ")})` : ""}`;
      }
      case "handshake":
        return `The host refused the session${error.detail.closeCode ? ` (close ${error.detail.closeCode})` : ""}: ${error.message}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export function makeHostConnectionsPort(deps: HostConnectionsPortDeps): HostConnectionsPort {
  return {
    async connect({ hostId }) {
      const existing = deps.registry.get(hostId);
      if (existing) return existing;
      const { hosts } = await deps.accountSession.listHosts();
      const host = hosts.find((candidate) => candidate.id === hostId);
      if (!host) throw new Error("That host is not on your account");
      if (!host.linked) throw new Error("That host has not completed its key exchange yet");
      const identity = await deps.accountSession.dialIdentity();
      let session;
      try {
        session = await dialHost({
          host,
          identity,
          relayUrl: deps.relayUrl,
          requestGrant: async () => (await deps.accountSession.requestGrant({ hostId })).grant,
        });
      } catch (error) {
        throw new Error(describeDialFailure(error), { cause: error });
      }
      return deps.registry.add({ hostId, hostName: host.name, session });
    },
    async disconnect({ hostId }) {
      deps.registry.remove(hostId);
    },
    async list() {
      return { connections: deps.registry.list() };
    },
  };
}
