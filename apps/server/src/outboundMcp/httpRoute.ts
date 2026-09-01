import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  OUTBOUND_MCP_OAUTH_CALLBACK_PATH,
  OutboundMcpCallbackEndpoint,
} from "./callbackEndpoint.ts";
import {
  McpConnectionService,
  type McpCompleteAuthorizationInput,
} from "./Services/McpConnectionService.ts";

export { OUTBOUND_MCP_OAUTH_CALLBACK_PATH } from "./callbackEndpoint.ts";

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'",
  "Content-Type": "text/html; charset=utf-8",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

function callbackResponse(ok: boolean) {
  const title = ok ? "Connection complete" : "Connection not completed";
  const message = ok
    ? "Authorization completed. You may close this window."
    : "Authorization could not be completed. Return to Synara and try again.";
  return HttpServerResponse.text(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`,
    { status: ok ? 200 : 400, headers: RESPONSE_HEADERS },
  );
}

function disabledResponse() {
  return HttpServerResponse.text("Not Found", {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });
}

export function isOutboundMcpCallbackAuthority(
  authority: string | undefined,
  callbackUrl: URL,
): boolean {
  if (authority === undefined || authority.length === 0) return false;

  let parsed: URL;
  try {
    parsed = new URL(`http://${authority}/`);
  } catch {
    return false;
  }

  return (
    parsed.username.length === 0 &&
    parsed.password.length === 0 &&
    parsed.host === callbackUrl.host &&
    authority === parsed.host
  );
}

function requestHostAuthorities(
  request: HttpServerRequest.HttpServerRequest,
): ReadonlyArray<string> {
  const source = request.source;
  if (!("rawHeaders" in source) || !Array.isArray(source.rawHeaders)) return [];

  const authorities: string[] = [];
  for (let index = 0; index < source.rawHeaders.length; index += 2) {
    const name = source.rawHeaders[index];
    const value = source.rawHeaders[index + 1];
    if (typeof name !== "string" || typeof value !== "string") return [];
    if (name.toLowerCase() === "host") authorities.push(value);
  }
  return authorities;
}

function readCallback(url: URL): McpCompleteAuthorizationInput | null {
  const state = url.searchParams.getAll("state");
  const code = url.searchParams.getAll("code");
  const error = url.searchParams.getAll("error");
  const hasCode = code.length > 0;
  const hasError = error.length > 0;
  if (
    state.length !== 1 ||
    state[0] === undefined ||
    state[0].length === 0 ||
    hasCode === hasError
  ) {
    return null;
  }
  const selected = hasCode ? code : error;
  if (selected.length !== 1 || selected[0] === undefined || selected[0].length === 0) return null;
  return { state: state[0], ...(hasCode ? { code: selected[0] } : { error: selected[0] }) };
}

const oauthCallback = HttpRouter.add(
  "GET",
  OUTBOUND_MCP_OAUTH_CALLBACK_PATH,
  Effect.gen(function* () {
    const callbackEndpoint = yield* OutboundMcpCallbackEndpoint;
    const callbackUrl = yield* callbackEndpoint.currentUrl;
    if (callbackUrl === null) return disabledResponse();

    const request = yield* HttpServerRequest.HttpServerRequest;
    const authorities = requestHostAuthorities(request);
    if (authorities.length !== 1 || !isOutboundMcpCallbackAuthority(authorities[0], callbackUrl)) {
      return disabledResponse();
    }
    const url = HttpServerRequest.toURL(request);
    const callback = url === null ? null : readCallback(url);
    if (callback === null) return callbackResponse(false);

    const service = yield* McpConnectionService;
    const result = yield* service.completeAuthorization(callback);
    return callbackResponse(result.ok);
  }).pipe(Effect.catchCause(() => Effect.succeed(callbackResponse(false)))),
);

export const outboundMcpRouteLayer = Layer.mergeAll(oauthCallback);
