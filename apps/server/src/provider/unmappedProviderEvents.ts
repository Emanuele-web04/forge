import type { ProviderEvent } from "@synara/contracts";

import { boundActivityData } from "../activityData.ts";

const REDACTED_VALUE = "[REDACTED]";
const MAX_UNMAPPED_PROVIDER_DETAIL_CHARS = 500;
const BURST_METHOD_SUFFIX = /(?:delta|progress|partial|chunk|update|updated)$/iu;
const TURN_TERMINAL_METHODS = new Set(["turn/completed", "turn/aborted"]);
const SESSION_TERMINAL_METHODS = new Set(["session/exited", "session/closed", "thread/closed"]);

const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "apikey",
  "password",
  "passphrase",
  "cookie",
  "setcookie",
  "credential",
  "credentials",
  "privatekey",
]);

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    SENSITIVE_KEYS.has(normalized) ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("password") ||
    normalized.endsWith("privatekey")
  );
}

function redactSensitiveFields(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveFields(entry, seen));
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = isSensitiveKey(key) ? REDACTED_VALUE : redactSensitiveFields(entry, seen);
  }
  return redacted;
}

export function sanitizeUnmappedProviderData(value: unknown): unknown {
  return boundActivityData(redactSensitiveFields(value));
}

export function sanitizeUnmappedProviderDetail(value: string | undefined): string | undefined {
  if (value === undefined || value.length <= MAX_UNMAPPED_PROVIDER_DETAIL_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_UNMAPPED_PROVIDER_DETAIL_CHARS - 3)}...`;
}

export function sanitizeUnmappedProviderEvent(event: ProviderEvent): ProviderEvent {
  return event.payload === undefined
    ? event
    : { ...event, payload: sanitizeUnmappedProviderData(event.payload) };
}

function eventScope(event: ProviderEvent): string {
  return `${event.threadId}\u0000${event.turnId ?? event.lifecycleGeneration ?? "session"}`;
}

function isBurstStyleMethod(method: string): boolean {
  return BURST_METHOD_SUFFIX.test(method);
}

export type UnmappedProviderEventGate = {
  readonly shouldSurface: (event: ProviderEvent) => boolean;
  readonly release: (event: ProviderEvent) => void;
};

export function makeUnmappedProviderEventGate(): UnmappedProviderEventGate {
  const surfacedBurstMethods = new Map<string, Set<string>>();

  const shouldSurface = (event: ProviderEvent): boolean => {
    if (!isBurstStyleMethod(event.method)) {
      return true;
    }
    const scope = eventScope(event);
    const methods = surfacedBurstMethods.get(scope) ?? new Set<string>();
    if (methods.has(event.method)) {
      return false;
    }
    methods.add(event.method);
    surfacedBurstMethods.set(scope, methods);
    return true;
  };

  const release = (event: ProviderEvent): void => {
    if (TURN_TERMINAL_METHODS.has(event.method) && event.turnId !== undefined) {
      surfacedBurstMethods.delete(eventScope(event));
      return;
    }
    if (!SESSION_TERMINAL_METHODS.has(event.method)) {
      return;
    }
    const threadPrefix = `${event.threadId}\u0000`;
    for (const scope of surfacedBurstMethods.keys()) {
      if (scope.startsWith(threadPrefix)) {
        surfacedBurstMethods.delete(scope);
      }
    }
  };

  return { shouldSurface, release };
}
