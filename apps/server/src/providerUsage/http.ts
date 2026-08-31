// FILE: providerUsage/http.ts
// Purpose: Bounded JSON helper for provider usage, backed by the pinned outbound authority.

import { decodeOutboundJson, outboundHttp } from "@synara/shared/outboundHttp";

export interface FetchJsonResult {
  readonly status: number;
  readonly ok: boolean;
  readonly json: unknown;
  readonly headers: Headers;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function fetchJson(input: {
  service: string;
  url: string;
  allowedOrigins: ReadonlyArray<string>;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  /** How to encode `body`: JSON (default) or application/x-www-form-urlencoded (OAuth endpoints). */
  bodyFormat?: "json" | "form";
  timeoutMs?: number;
}): Promise<FetchJsonResult> {
  const encodedBody =
    input.body === undefined
      ? undefined
      : input.bodyFormat === "form"
        ? new URLSearchParams(input.body as Record<string, string>).toString()
        : JSON.stringify(input.body);
  const response = await outboundHttp.request({
    policy: {
      service: input.service,
      allowedOrigins: input.allowedOrigins,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRequestBytes: 64 * 1024,
      maxResponseBytes: 1024 * 1024,
      maxRedirects: 0,
      maxConcurrent: 4,
      maxQueued: 8,
      requirePublicAddress: true,
    },
    url: input.url,
    method: input.method ?? "GET",
    headers: input.headers,
    ...(encodedBody === undefined ? {} : { body: encodedBody }),
  });

  let json: unknown = null;
  try {
    json = decodeOutboundJson(response, { maxDepth: 32, maxNodes: 100_000 });
  } catch {
    json = null;
  }

  return {
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    json,
    headers: response.headers,
  };
}

/** Provider backends reject the access token once it is stale; treat that as "needs re-auth". */
export function isAuthFailureStatus(status: number): boolean {
  return status === 401 || status === 403;
}

/** The backend is throttling requests; callers should back off rather than blank the usage panel. */
export function isRateLimitStatus(status: number): boolean {
  return status === 429;
}

/**
 * Parse an HTTP `Retry-After` header into a positive delay in ms, honoring both the delta-seconds
 * (`"120"`) and HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`) forms. Returns undefined when the
 * header is absent, malformed, or already in the past so callers can fall back to a default backoff.
 */
export function parseRetryAfterMs(headers: Headers, nowMs: number): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (/^\d+$/u.test(trimmed)) {
    const milliseconds = Number(trimmed) * 1000;
    return milliseconds > 0 && Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  // HTTP-date values begin with a weekday name. Reject alternate JavaScript number spellings
  // before Date.parse can reinterpret values such as `1.5` or `+10` as implementation-defined dates.
  if (/^[+\-.\d]/u.test(trimmed)) {
    return undefined;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - nowMs;
    return delta > 0 ? delta : undefined;
  }
  return undefined;
}
