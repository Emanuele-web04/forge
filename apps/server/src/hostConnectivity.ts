import http from "node:http";

import { createAccountClient } from "@synara/shared/account";
import { WebSocketServer } from "ws";

import {
  accountApiIssuer,
  readAccountFile,
  refreshHostRegistration,
  resolveEnvironmentId,
} from "./accountAuth";
import type { SessionCredentialServiceShape } from "./auth/Services/SessionCredentialService";
import type { ServerConfigShape } from "./config";
import { startEndpointReporter } from "./endpointReporter";
import { ApiJwksCache, HostMintService } from "./hostAuth";
import { mintHostProof, readHostIdentity } from "./hostIdentity";
import { MAX_WEBSOCKET_MESSAGE_BYTES } from "./nodeHttpServer";
import { RelayDialSupervisor } from "./relayDial";
import {
  bridgeRemoteSocketToLocalRpc,
  RemoteConnectionGateway,
  RemoteSessionRegistry,
  registerHostRemoteSocketAcceptor,
} from "./remoteSessions";

export interface HostConnectivityOptions {
  readonly config: ServerConfigShape;
  readonly listeningPort: number;
  readonly localSessions: SessionCredentialServiceShape;
}

export async function startHostConnectivity(options: HostConnectivityOptions): Promise<() => void> {
  const credentials = await readAccountFile(options.config.baseDir);
  if (
    !credentials?.hostId ||
    !credentials.hostOwnerUserId ||
    credentials.hostKeyGeneration === undefined
  ) {
    return () => {};
  }
  const identity = await readHostIdentity(options.config.hostIdentityPath);
  if (!identity) return () => {};
  const environmentId = await resolveEnvironmentId(options.config.baseDir, options.config.devUrl);
  const client = createAccountClient({ baseUrl: credentials.accountUrl });
  const hostProof = () =>
    mintHostProof({
      identity,
      apiIssuer: accountApiIssuer(credentials.accountUrl),
      environmentId,
      hostId: credentials.hostId!,
      keyGeneration: credentials.hostKeyGeneration!,
    });
  let authorization = {
    discoverable: false,
    ownerUserId: credentials.hostOwnerUserId,
    orgId: credentials.organizationId ?? "unknown",
    ownerInOrg: false,
  };
  const refreshAuthorization = async () => {
    authorization = await client.getHostAuthorization(await hostProof(), credentials.hostId!);
    return authorization;
  };
  const remoteSessions = new RemoteSessionRegistry();
  const apiJwks = new ApiJwksCache(() => client.getApiJwks());
  const mintService = new HostMintService({
    identity,
    apiIssuer: accountApiIssuer(credentials.accountUrl),
    environmentId,
    hostId: credentials.hostId,
    keyGeneration: credentials.hostKeyGeneration,
    getApiJwks: () => apiJwks.get(),
    refreshApiJwksForUnknownKid: () => apiJwks.refreshForUnknownKid(),
    getAuthorization: refreshAuthorization,
  });
  const gateway = new RemoteConnectionGateway({
    mintService,
    identity,
    environmentId,
    keyGeneration: credentials.hostKeyGeneration,
    sessions: remoteSessions,
    bridgeToLocal: (socket, peer) =>
      bridgeRemoteSocketToLocalRpc(socket, peer, {
        listeningPort: options.listeningPort,
        sessions: options.localSessions,
      }),
  });
  const controller = new AbortController();
  const stops: Array<() => void> = [];
  stops.push(registerHostRemoteSocketAcceptor((socket) => gateway.accept(socket)));
  const expirySweep = setInterval(() => remoteSessions.dropExpired(), 30_000);
  expirySweep.unref();
  stops.push(() => clearInterval(expirySweep));

  stops.push(
    startEndpointReporter({
      report: () =>
        refreshHostRegistration({
          baseDir: options.config.baseDir,
          ...(options.config.devUrl ? { devUrl: options.config.devUrl } : {}),
          client,
        }),
    }),
  );

  if (options.config.relayUrl) {
    const supervisor = new RelayDialSupervisor({
      relayUrl: options.config.relayUrl.toString(),
      hostId: credentials.hostId,
      requestTicket: async () =>
        (await client.requestRelayTicket(await hostProof(), credentials.hostId!)).ticket,
      reverifySessions: async (event) => {
        if (event?.kind === "host_unlinked") {
          await remoteSessions.reverify(authorization, event);
          return;
        }
        const current = await refreshAuthorization();
        await remoteSessions.reverify(current, event);
      },
      acceptSplice: (socket, splice) =>
        gateway.accept(socket, { userId: splice.userId, deviceJkt: splice.deviceJkt }, "relay"),
    });
    void supervisor.run(controller.signal);
  }

  if (options.config.sshForwardPort !== undefined) {
    const server = http.createServer((_request, response) => {
      response.writeHead(426).end("WebSocket upgrade required");
    });
    const websocket = new WebSocketServer({
      server,
      maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    websocket.on("connection", (socket) => void gateway.accept(socket, undefined, "ssh-forward"));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.config.sshForwardPort, "127.0.0.1", resolve);
    });
    stops.push(() => {
      for (const socket of websocket.clients) socket.terminate();
      websocket.close();
      server.close();
    });
  }

  return () => {
    controller.abort();
    for (const stop of stops.splice(0)) stop();
  };
}
