import { Effect, Layer, ServiceMap } from "effect";

import type { ServerConfigShape } from "../config.ts";
import { formatHostForUrl, isLoopbackHost } from "../startupAccess.ts";
import {
  McpConnectionServiceError,
  type McpConnectionServiceShape,
} from "./Services/McpConnectionService.ts";

export const OUTBOUND_MCP_OAUTH_CALLBACK_PATH = "/api/mcp/outbound/oauth/callback";

const INACTIVE_CALLBACK_URL = new URL(OUTBOUND_MCP_OAUTH_CALLBACK_PATH, "http://127.0.0.1:1");

type CallbackConfig = Pick<ServerConfigShape, "host" | "publicUrl">;

type ListenerAddress = {
  readonly address: string;
  readonly port: number;
};

export interface OutboundMcpCallbackEndpointShape {
  readonly callbackUrl: URL;
  readonly currentUrl: Effect.Effect<URL | null>;
  readonly configure: (input: {
    readonly config: CallbackConfig;
    readonly serverAddress: unknown;
  }) => Effect.Effect<void>;
  readonly clear: Effect.Effect<void>;
}

export class OutboundMcpCallbackEndpoint extends ServiceMap.Service<
  OutboundMcpCallbackEndpoint,
  OutboundMcpCallbackEndpointShape
>()("synara/outboundMcp/OutboundMcpCallbackEndpoint") {}

function listenerAddress(value: unknown): ListenerAddress | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("address" in value) ||
    typeof value.address !== "string" ||
    !("port" in value) ||
    typeof value.port !== "number" ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65_535
  ) {
    return null;
  }
  return { address: value.address, port: value.port };
}

export function makeOutboundMcpCallbackEndpoint(): OutboundMcpCallbackEndpointShape {
  const callbackUrl = new URL(INACTIVE_CALLBACK_URL);
  let currentUrl: URL | null = null;

  const clear = Effect.sync(() => {
    currentUrl = null;
    callbackUrl.href = INACTIVE_CALLBACK_URL.href;
  });

  const configure: OutboundMcpCallbackEndpointShape["configure"] = (input) =>
    Effect.sync(() => {
      currentUrl = null;
      callbackUrl.href = INACTIVE_CALLBACK_URL.href;
      const address = listenerAddress(input.serverAddress);
      if (
        address === null ||
        !isLoopbackHost(input.config.host) ||
        input.config.publicUrl !== undefined ||
        !isLoopbackHost(address.address)
      ) {
        return;
      }
      const resolved = new URL(
        OUTBOUND_MCP_OAUTH_CALLBACK_PATH,
        `http://${formatHostForUrl(address.address)}:${address.port}`,
      );
      callbackUrl.href = resolved.href;
      currentUrl = resolved;
    });

  return {
    callbackUrl,
    currentUrl: Effect.sync(() => (currentUrl === null ? null : new URL(currentUrl))),
    configure,
    clear,
  };
}

export const OutboundMcpCallbackEndpointLive = Layer.sync(
  OutboundMcpCallbackEndpoint,
  makeOutboundMcpCallbackEndpoint,
);

export function withOutboundMcpCallbackCapability(
  service: McpConnectionServiceShape,
  endpoint: OutboundMcpCallbackEndpointShape,
): McpConnectionServiceShape {
  return {
    ...service,
    beginAuthorization: (input) =>
      endpoint.currentUrl.pipe(
        Effect.flatMap((callbackUrl) =>
          callbackUrl === null
            ? Effect.fail(new McpConnectionServiceError({ category: "callback-unavailable" }))
            : service.beginAuthorization(input),
        ),
      ),
  };
}

export function bindOutboundMcpCallbackEndpoint(
  makeService: (callbackUrl: URL) => McpConnectionServiceShape,
  endpoint: OutboundMcpCallbackEndpointShape,
): McpConnectionServiceShape {
  return withOutboundMcpCallbackCapability(makeService(endpoint.callbackUrl), endpoint);
}
