import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { outboundHttp, OutboundHttpError } from "@synara/shared/outboundHttp";
import { assertPublicIpAddress, OutboundPolicyError } from "@synara/shared/outboundHttpPolicy";
import { Schema } from "effect";

export const OUTBOUND_MCP_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
export const OUTBOUND_MCP_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const OUTBOUND_MCP_REQUEST_TIMEOUT_MS = 30_000;

const OUTBOUND_MCP_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type OutboundMcpUrlPurpose = "resource" | "authorization";

export class OutboundMcpNetworkPolicyError extends Schema.TaggedErrorClass<OutboundMcpNetworkPolicyError>()(
  "OutboundMcpNetworkPolicyError",
  {
    category: Schema.String,
    origin: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Outbound MCP network policy rejected the request (${this.category}).`;
  }
}

function redactedOrigin(url: URL): string | undefined {
  return url.origin === "null" ? undefined : url.origin;
}

function policyError(category: string, url: URL): OutboundMcpNetworkPolicyError {
  const origin = redactedOrigin(url);
  return new OutboundMcpNetworkPolicyError({
    category,
    ...(origin === undefined ? {} : { origin }),
  });
}

function invalidUrlError(): OutboundMcpNetworkPolicyError {
  return new OutboundMcpNetworkPolicyError({ category: "invalid-url" });
}

function parseOutboundMcpUrl(input: string | URL): URL {
  try {
    return new URL(input);
  } catch {
    throw invalidUrlError();
  }
}

export function validateOutboundMcpUrl(url: URL, _purpose: OutboundMcpUrlPurpose): URL {
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw policyError("invalid-url", url);
  }
  return url;
}

export type OutboundMcpNetworkPolicy = {
  readonly resourceUrl: URL;
  readonly fetch?: FetchLike;
  readonly resolveAddresses?: OutboundMcpAddressResolver;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
};

export type OutboundMcpAddressResolver = (
  hostname: string,
  signal: AbortSignal,
) => Promise<ReadonlyArray<string>>;

function isBearerAuthorization(headers: Headers): boolean {
  return /^\s*Bearer\s+/i.test(headers.get("authorization") ?? "");
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

type RequestLifecycle = {
  readonly signal: AbortSignal;
  readonly abortError: (url: URL) => unknown;
  readonly finish: () => void;
};

async function fetchWithTimeout(
  fetchFn: FetchLike,
  url: URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ readonly response: Response; readonly lifecycle: RequestLifecycle }> {
  const callerSignal = init.signal;
  const controller = new AbortController();
  let timedOut = false;
  let finished = false;
  const forwardCallerAbort = () => controller.abort(abortReason(callerSignal!));

  if (callerSignal?.aborted) {
    forwardCallerAbort();
  } else {
    callerSignal?.addEventListener("abort", forwardCallerAbort, { once: true });
  }

  const timeout = setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort(new DOMException("Outbound MCP request timed out.", "TimeoutError"));
  }, timeoutMs);

  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", forwardCallerAbort);
  };
  const lifecycle: RequestLifecycle = {
    signal: controller.signal,
    abortError: (currentUrl) => {
      if (timedOut) return policyError("timeout", currentUrl);
      if (callerSignal?.aborted) return abortReason(callerSignal);
      return policyError("network", currentUrl);
    },
    finish,
  };

  try {
    const response = await fetchFn(url, { ...init, redirect: "manual", signal: controller.signal });
    return { response, lifecycle };
  } catch (error) {
    finish();
    if (timedOut) throw policyError("timeout", url);
    if (callerSignal?.aborted) throw abortReason(callerSignal);
    if (error instanceof OutboundMcpNetworkPolicyError) throw error;
    throw policyError("network", url);
  }
}

function stripBodyHeaders(headers: Headers): void {
  headers.delete("content-length");
  headers.delete("content-type");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (body !== null) void body.cancel().catch(() => undefined);
}

function requestBodySize(body: BodyInit | null | undefined): number {
  if (body === undefined || body === null) return 0;
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  if (body instanceof URLSearchParams) {
    return new TextEncoder().encode(body.toString()).byteLength;
  }
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof Blob) return body.size;
  throw new OutboundMcpNetworkPolicyError({ category: "unsupported-request-body" });
}

async function sharedRequestBody(
  body: BodyInit | null | undefined,
): Promise<string | Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  throw new OutboundMcpNetworkPolicyError({ category: "unsupported-request-body" });
}

function sharedError(error: unknown, url: URL): OutboundMcpNetworkPolicyError {
  if (error instanceof OutboundMcpNetworkPolicyError) return error;
  if (error instanceof OutboundPolicyError) return policyError(error.code, url);
  if (error instanceof OutboundHttpError) {
    const category =
      error.code === "request" ? "network" : error.code === "aborted" ? "network" : error.code;
    return policyError(category, url);
  }
  return policyError("network", url);
}

function makeSharedOutboundFetch(input: {
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
}): FetchLike {
  return async (urlInput, init = {}) => {
    const url = parseOutboundMcpUrl(urlInput);
    const method = (init.method ?? "GET").toUpperCase();
    if (!new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).has(method)) {
      throw policyError("invalid-method", url);
    }
    try {
      const result = await outboundHttp.request({
        policy: {
          service: "outbound-mcp",
          allowedOrigins: [url.origin],
          timeoutMs: input.timeoutMs,
          maxRequestBytes: input.maxRequestBytes,
          maxResponseBytes: input.maxResponseBytes,
          maxRedirects: input.maxRedirects,
          maxConcurrent: 6,
          maxQueued: 24,
          requirePublicAddress: true,
        },
        url,
        method: method as "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE",
        headers: init.headers,
        body: await sharedRequestBody(init.body),
        ...(init.signal === undefined || init.signal === null ? {} : { signal: init.signal }),
      });
      return new Response(result.body, {
        status: result.status,
        headers: result.headers,
      });
    } catch (error) {
      throw sharedError(error, url);
    }
  };
}

function makeInjectedOutboundFetch(
  fetchFn: FetchLike,
  resolveAddresses: OutboundMcpAddressResolver,
): FetchLike {
  return async (urlInput, init = {}) => {
    const url = parseOutboundMcpUrl(urlInput);
    const signal = init.signal;
    if (signal === undefined || signal === null) {
      throw policyError("missing-signal", url);
    }
    let addresses: ReadonlyArray<string>;
    try {
      if (signal.aborted) throw abortReason(signal);
      addresses = await new Promise<ReadonlyArray<string>>((resolve, reject) => {
        const onAbort = () => {
          signal.removeEventListener("abort", onAbort);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        let resolution: Promise<ReadonlyArray<string>>;
        try {
          resolution = resolveAddresses(url.hostname, signal);
        } catch (error) {
          signal.removeEventListener("abort", onAbort);
          reject(error);
          return;
        }
        resolution.then(
          (resolved) => {
            signal.removeEventListener("abort", onAbort);
            resolve(resolved);
          },
          (error) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
      });
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      if (error instanceof OutboundMcpNetworkPolicyError) throw error;
      throw policyError("dns", url);
    }
    if (addresses.length === 0) throw policyError("dns", url);
    try {
      for (const address of addresses) assertPublicIpAddress(address);
    } catch {
      throw policyError("private-address", url);
    }
    if (signal.aborted) throw abortReason(signal);
    return fetchFn(url, init);
  };
}

function discardResponse(response: Response, lifecycle: RequestLifecycle): void {
  cancelBody(response.body);
  lifecycle.finish();
}

function redirectedInit(init: RequestInit, status: number, from: URL, to: URL): RequestInit {
  const headers = new Headers(init.headers);
  const method = (init.method ?? "GET").toUpperCase();
  const changesToGet = status === 303 || ((status === 301 || status === 302) && method === "POST");
  const hasBody = init.body !== undefined && init.body !== null;

  if (from.origin !== to.origin && (hasBody || headers.has("authorization"))) {
    throw policyError(isBearerAuthorization(headers) ? "token-origin" : "redirect-origin", to);
  }
  if (from.origin !== to.origin) {
    headers.delete("authorization");
    headers.delete("cookie");
  }

  if (changesToGet && method !== "HEAD") {
    stripBodyHeaders(headers);
    return { ...init, method: "GET", body: undefined, headers };
  }
  return { ...init, headers };
}

async function boundedResponse(
  response: Response,
  url: URL,
  maxResponseBytes: number,
  lifecycle: RequestLifecycle,
): Promise<Response> {
  const contentEncoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  if (contentEncoding !== undefined && contentEncoding !== "" && contentEncoding !== "identity") {
    discardResponse(response, lifecycle);
    throw policyError("compressed-response", url);
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxResponseBytes) {
      discardResponse(response, lifecycle);
      throw policyError("response-too-large", url);
    }
  }
  if (response.body === null) {
    lifecycle.finish();
    return response;
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    lifecycle.finish();
    throw policyError("body", url);
  }
  let received = 0;
  let settled = false;
  let onAbort: (() => void) | undefined;
  const finish = () => {
    if (onAbort !== undefined) lifecycle.signal.removeEventListener("abort", onAbort);
    lifecycle.finish();
  };
  const boundedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => {
        if (settled) return;
        settled = true;
        void reader.cancel(lifecycle.signal.reason).catch(() => undefined);
        controller.error(lifecycle.abortError(url));
        finish();
      };
      if (lifecycle.signal.aborted) onAbort();
      else lifecycle.signal.addEventListener("abort", onAbort, { once: true });
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (settled) return;
        if (next.done) {
          settled = true;
          controller.close();
          finish();
          return;
        }
        received += next.value.byteLength;
        if (received > maxResponseBytes) {
          settled = true;
          void reader.cancel().catch(() => undefined);
          controller.error(policyError("response-too-large", url));
          finish();
          return;
        }
        controller.enqueue(next.value);
      } catch {
        if (settled) return;
        settled = true;
        controller.error(
          lifecycle.signal.aborted ? lifecycle.abortError(url) : policyError("body", url),
        );
        finish();
      }
    },
    cancel(reason) {
      if (settled) return;
      settled = true;
      void reader.cancel(reason).catch(() => undefined);
      finish();
    },
  });

  return new Response(boundedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function makeBoundedMcpFetch(policy: OutboundMcpNetworkPolicy): FetchLike {
  const resourceUrl = validateOutboundMcpUrl(new URL(policy.resourceUrl), "resource");
  const resourceOrigin = resourceUrl.origin;
  const maxRequestBytes = policy.maxRequestBytes ?? OUTBOUND_MCP_MAX_REQUEST_BYTES;
  const maxResponseBytes = policy.maxResponseBytes ?? OUTBOUND_MCP_MAX_RESPONSE_BYTES;
  const timeoutMs = policy.timeoutMs ?? OUTBOUND_MCP_REQUEST_TIMEOUT_MS;
  const maxRedirects = policy.maxRedirects ?? OUTBOUND_MCP_MAX_REDIRECTS;

  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0) {
    throw new RangeError("Outbound MCP request byte limit must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new RangeError("Outbound MCP response byte limit must be a positive safe integer.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Outbound MCP timeout must be a positive finite number.");
  }
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
    throw new RangeError("Outbound MCP redirect limit must be a non-negative safe integer.");
  }
  if ((policy.fetch === undefined) !== (policy.resolveAddresses === undefined)) {
    throw new RangeError("Injected outbound MCP fetch requires an explicit address resolver.");
  }

  const fetchFn =
    policy.fetch === undefined || policy.resolveAddresses === undefined
      ? makeSharedOutboundFetch({ maxRequestBytes, maxResponseBytes, timeoutMs, maxRedirects })
      : makeInjectedOutboundFetch(policy.fetch, policy.resolveAddresses);

  return async (input, requestInit = {}) => {
    let currentUrl = parseOutboundMcpUrl(input);
    let currentInit: RequestInit = { ...requestInit };
    const deadline = Date.now() + timeoutMs;

    if (requestBodySize(currentInit.body) > maxRequestBytes) {
      throw policyError("request-too-large", currentUrl);
    }

    for (let redirects = 0; ; redirects += 1) {
      const purpose: OutboundMcpUrlPurpose =
        currentUrl.origin === resourceOrigin ? "resource" : "authorization";
      validateOutboundMcpUrl(currentUrl, purpose);

      const requestHeaders = new Headers(currentInit.headers);
      if (isBearerAuthorization(requestHeaders) && currentUrl.origin !== resourceOrigin) {
        throw policyError("token-origin", currentUrl);
      }

      const remainingTimeoutMs = deadline - Date.now();
      if (remainingTimeoutMs <= 0) throw policyError("timeout", currentUrl);

      const { response, lifecycle } = await fetchWithTimeout(
        fetchFn,
        currentUrl,
        { ...currentInit, headers: requestHeaders },
        remainingTimeoutMs,
      );
      if (!REDIRECT_STATUSES.has(response.status)) {
        return boundedResponse(response, currentUrl, maxResponseBytes, lifecycle);
      }

      const location = response.headers.get("location");
      if (location === null) {
        return boundedResponse(response, currentUrl, maxResponseBytes, lifecycle);
      }
      if (redirects >= maxRedirects) {
        discardResponse(response, lifecycle);
        throw policyError("too-many-redirects", currentUrl);
      }

      let target: URL;
      try {
        target = new URL(location, currentUrl);
      } catch {
        discardResponse(response, lifecycle);
        throw policyError("invalid-url", currentUrl);
      }
      discardResponse(response, lifecycle);
      const targetPurpose: OutboundMcpUrlPurpose =
        target.origin === resourceOrigin ? "resource" : "authorization";
      validateOutboundMcpUrl(target, targetPurpose);
      currentInit = redirectedInit(currentInit, response.status, currentUrl, target);
      currentUrl = target;
    }
  };
}

type BufferedResponse = {
  readonly body: Uint8Array;
  readonly status: number;
  readonly statusText: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
};

export function isOAuthRefreshRequest(init: RequestInit | undefined): boolean {
  if ((init?.method ?? "GET").toUpperCase() !== "POST") return false;
  const body = init?.body;
  if (body instanceof URLSearchParams) return body.get("grant_type") === "refresh_token";
  if (typeof body === "string") {
    try {
      return new URLSearchParams(body).get("grant_type") === "refresh_token";
    } catch {
      return false;
    }
  }
  return false;
}

async function bufferResponse(response: Response): Promise<BufferedResponse> {
  return {
    body: new Uint8Array(await response.arrayBuffer()),
    status: response.status,
    statusText: response.statusText,
    headers: Array.from(response.headers.entries()),
  };
}

function responseFromBuffer(buffered: BufferedResponse): Response {
  return new Response(buffered.body.slice(), {
    status: buffered.status,
    statusText: buffered.statusText,
    headers: buffered.headers,
  });
}

/** Coalesce refreshes for one connection without retaining token values as map keys. */
export function makeSingleFlightRefreshFetch(fetchFn: FetchLike): FetchLike {
  let refreshFlight: Promise<BufferedResponse> | null = null;

  return async (url, init) => {
    if (!isOAuthRefreshRequest(init)) return fetchFn(url, init);

    let flight = refreshFlight;
    if (flight === null) {
      flight = fetchFn(url, init).then(bufferResponse);
      refreshFlight = flight;
      void flight.then(
        () => {
          if (refreshFlight === flight) refreshFlight = null;
        },
        () => {
          if (refreshFlight === flight) refreshFlight = null;
        },
      );
    }
    return responseFromBuffer(await flight);
  };
}
