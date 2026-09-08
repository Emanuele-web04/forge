/**
 * AgentGatewayCredentialsLive - Live layer for agent gateway credentials.
 *
 * Issues opaque in-memory credentials. Tokens live for the provider session,
 * can be revoked independently, and intentionally do not survive a Synara
 * restart.
 *
 * @module agentGateway/Layers/AgentGatewayCredentials
 */
import { randomUUID } from "node:crypto";

import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import { formatHostForUrl, isWildcardHost } from "../../startupAccess.ts";
import {
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "../Services/AgentGatewayCredentials.ts";
import { AgentGatewaySessionRegistry } from "../Services/AgentGatewaySessionRegistry.ts";
import { makeAgentGatewayInFlightRequestRegistry } from "../inFlightRequestRegistry.ts";
import { ensureAgentGatewayStdioProxyScript } from "../stdioProxyScript.ts";
import { AgentGatewaySessionRegistryLive } from "./AgentGatewaySessionRegistry.ts";

export const AGENT_GATEWAY_MCP_PATH = "/mcp";

interface AgentGatewayEndpoint {
  readonly url: string;
  readonly setListeningPort: (listeningPort: number) => void;
}

interface AgentGatewayStdioBootstrapRegistry {
  readonly issue: (sessionToken: string) => string | null;
  readonly exchange: (bootstrapToken: string) => string | null;
  readonly revokeSession: (sessionToken: string) => void;
}

const AGENT_GATEWAY_STDIO_BOOTSTRAP_TTL_MS = 30_000;

export function makeAgentGatewayStdioBootstrapRegistry(input: {
  readonly sessionIsActive: (sessionToken: string) => boolean;
  readonly randomId?: () => string;
  readonly now?: () => number;
  readonly ttlMs?: number;
}): AgentGatewayStdioBootstrapRegistry {
  const randomId = input.randomId ?? randomUUID;
  const now = input.now ?? Date.now;
  const ttlMs = Math.max(1, input.ttlMs ?? AGENT_GATEWAY_STDIO_BOOTSTRAP_TTL_MS);
  const tokens = new Map<string, { readonly sessionToken: string; readonly expiresAt: number }>();
  return {
    issue: (sessionToken) => {
      if (!input.sessionIsActive(sessionToken)) return null;
      const bootstrapToken = `sagw_bootstrap_${randomId()}`;
      tokens.set(bootstrapToken, { sessionToken, expiresAt: now() + ttlMs });
      return bootstrapToken;
    },
    exchange: (bootstrapToken) => {
      const bootstrap = tokens.get(bootstrapToken);
      if (bootstrap === undefined) return null;
      tokens.delete(bootstrapToken);
      if (bootstrap.expiresAt <= now()) return null;
      return input.sessionIsActive(bootstrap.sessionToken) ? bootstrap.sessionToken : null;
    },
    revokeSession: (sessionToken) => {
      for (const [bootstrapToken, owner] of tokens) {
        if (owner.sessionToken === sessionToken) tokens.delete(bootstrapToken);
      }
    },
  };
}

// Providers run as local child processes, so they must target a host the HTTP
// server actually listens on. Wildcard binds cover loopback; an explicit host
// (e.g. `::1` or a LAN address) does not, so reuse it verbatim.
export function resolveAgentGatewayEndpointHost(configHost: string | undefined): string {
  if (configHost === undefined || isWildcardHost(configHost)) {
    return "127.0.0.1";
  }
  return formatHostForUrl(configHost);
}

export function makeAgentGatewayEndpoint(
  configHost: string | undefined,
  initialPort: number,
): AgentGatewayEndpoint {
  const endpointHost = resolveAgentGatewayEndpointHost(configHost);
  let port = initialPort;
  return {
    get url() {
      return `http://${endpointHost}:${port}${AGENT_GATEWAY_MCP_PATH}`;
    },
    setListeningPort: (listeningPort: number) => {
      port = listeningPort;
    },
  };
}

export const makeAgentGatewayCredentials = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const sessionRegistry = yield* AgentGatewaySessionRegistry;
  const inFlightRequests = makeAgentGatewayInFlightRequestRegistry();

  const endpoint = makeAgentGatewayEndpoint(config.host, config.port);
  const stdioProxyScriptPath = yield* ensureAgentGatewayStdioProxyScript(config.stateDir);
  const stdioBootstraps = makeAgentGatewayStdioBootstrapRegistry({
    sessionIsActive: (token) => sessionRegistry.verify(token) !== null,
  });

  const issueSessionToken: AgentGatewayCredentialsShape["issueSessionToken"] = (
    threadId,
    provider,
    options,
  ) => sessionRegistry.issue(threadId, provider, options).token;

  const verifySessionToken: AgentGatewayCredentialsShape["verifySessionToken"] = (token) =>
    sessionRegistry.verify(token)?.threadId ?? null;

  const revokeSessionToken = (token: string): void => {
    const session = sessionRegistry.verify(token);
    sessionRegistry.revoke(token);
    stdioBootstraps.revokeSession(token);
    if (session) inFlightRequests.revokeSession(session.sessionKey);
  };

  const issueStdioBootstrapToken: AgentGatewayCredentialsShape["issueStdioBootstrapToken"] = (
    sessionToken,
  ) => {
    return stdioBootstraps.issue(sessionToken);
  };

  const exchangeStdioBootstrapToken: AgentGatewayCredentialsShape["exchangeStdioBootstrapToken"] = (
    bootstrapToken,
  ) => {
    return stdioBootstraps.exchange(bootstrapToken);
  };

  const cancelSessionTurnRequests: AgentGatewayCredentialsShape["cancelSessionTurnRequests"] = (
    token,
    turnId,
  ) => {
    const session = sessionRegistry.verify(token);
    if (!session) return Promise.resolve();
    return inFlightRequests.cancelTurn(session.sessionKey, turnId).settled;
  };

  const retireSessionTurn: AgentGatewayCredentialsShape["retireSessionTurn"] = (token, turnId) => {
    const session = sessionRegistry.verify(token);
    if (!session) return Promise.resolve();
    // Retire synchronously before exposing the asynchronous drain barrier.
    // Requests racing the terminal event can no longer bind this bearer to B.
    sessionRegistry.retireWriteAuthority(token, turnId);
    return inFlightRequests.cancelTurn(session.sessionKey, turnId).settled;
  };

  return {
    get mcpEndpointUrl() {
      return endpoint.url;
    },
    setListeningPort: endpoint.setListeningPort,
    issueSessionToken,
    verifySessionToken,
    verifySession: sessionRegistry.verify,
    issueStdioBootstrapToken,
    exchangeStdioBootstrapToken,
    bindWriteAuthority: sessionRegistry.bindWriteAuthority,
    verifyWriteAuthority: sessionRegistry.verifyWriteAuthority,
    registerInFlightRequest: inFlightRequests.register,
    cancelInFlightRequests: inFlightRequests.cancel,
    cancelSessionTurnRequests,
    retireSessionTurn,
    revokeSessionToken,
    connectionForThread: (threadId, provider, options) => ({
      url: endpoint.url,
      bearerToken: issueSessionToken(threadId, provider, options),
    }),
    stdioProxy: {
      command: process.execPath,
      args: [stdioProxyScriptPath],
    },
  } satisfies AgentGatewayCredentialsShape;
});

export const AgentGatewayCredentialsLive = Layer.effect(
  AgentGatewayCredentials,
  makeAgentGatewayCredentials,
).pipe(Layer.provide(AgentGatewaySessionRegistryLive));

// Single shared composition so every consumer (HTTP gateway, provider
// adapters) reuses the same memoized in-memory session registry.
export const AgentGatewayCredentialsWithSecretsLive = AgentGatewayCredentialsLive.pipe(Layer.orDie);
