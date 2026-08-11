import type { ProviderEvent } from "@synara/contracts";

import { boundActivityData } from "../activityData.ts";
import { redactDiagnosticData, redactDiagnosticText } from "../diagnosticRedaction.ts";

const MAX_UNMAPPED_PROVIDER_DETAIL_CHARS = 500;
const BURST_METHOD_SUFFIX = /(?:delta|progress|partial|chunk|update|updated)$/iu;
const TURN_TERMINAL_METHODS = new Set(["turn/completed", "turn/aborted"]);
const SESSION_TERMINAL_METHODS = new Set(["session/exited", "session/closed", "thread/closed"]);
const DEFAULT_MAX_TRACKED_BURST_SCOPES = 512;
const DEFAULT_MAX_BURST_METHODS_PER_SCOPE = 32;

export function sanitizeUnmappedProviderData(value: unknown): unknown {
  return boundActivityData(redactDiagnosticData(value));
}

export function sanitizeUnmappedProviderDetail(value: string | undefined): string | undefined {
  if (value === undefined) {
    return value;
  }
  const redacted = redactDiagnosticText(value);
  return redacted.length <= MAX_UNMAPPED_PROVIDER_DETAIL_CHARS
    ? redacted
    : `${redacted.slice(0, MAX_UNMAPPED_PROVIDER_DETAIL_CHARS - 3)}...`;
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
  readonly releaseThread: (threadId: ProviderEvent["threadId"]) => void;
  readonly clear: () => void;
};

type UnmappedProviderEventGateOptions = {
  readonly maxTrackedScopes?: number;
  readonly maxMethodsPerScope?: number;
};

function positiveIntegerOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function removeOldest<T>(collection: Map<T, unknown> | Set<T>): void {
  const oldest = collection.keys().next().value;
  if (oldest !== undefined) {
    collection.delete(oldest);
  }
}

export function makeUnmappedProviderEventGate(
  options: UnmappedProviderEventGateOptions = {},
): UnmappedProviderEventGate {
  const maxTrackedScopes = positiveIntegerOr(
    options.maxTrackedScopes,
    DEFAULT_MAX_TRACKED_BURST_SCOPES,
  );
  const maxMethodsPerScope = positiveIntegerOr(
    options.maxMethodsPerScope,
    DEFAULT_MAX_BURST_METHODS_PER_SCOPE,
  );
  const surfacedBurstMethods = new Map<string, Set<string>>();

  const shouldSurface = (event: ProviderEvent): boolean => {
    if (!isBurstStyleMethod(event.method)) {
      return true;
    }
    const scope = eventScope(event);
    let methods = surfacedBurstMethods.get(scope);
    if (methods === undefined) {
      if (surfacedBurstMethods.size >= maxTrackedScopes) {
        removeOldest(surfacedBurstMethods);
      }
      methods = new Set<string>();
      surfacedBurstMethods.set(scope, methods);
    }
    if (methods.has(event.method)) {
      return false;
    }
    if (methods.size >= maxMethodsPerScope) {
      removeOldest(methods);
    }
    methods.add(event.method);
    return true;
  };

  const releaseThread = (threadId: ProviderEvent["threadId"]): void => {
    const threadPrefix = `${threadId}\u0000`;
    for (const scope of surfacedBurstMethods.keys()) {
      if (scope.startsWith(threadPrefix)) {
        surfacedBurstMethods.delete(scope);
      }
    }
  };

  const release = (event: ProviderEvent): void => {
    if (TURN_TERMINAL_METHODS.has(event.method) && event.turnId !== undefined) {
      surfacedBurstMethods.delete(eventScope(event));
      return;
    }
    if (!SESSION_TERMINAL_METHODS.has(event.method)) {
      return;
    }
    releaseThread(event.threadId);
  };

  return {
    shouldSurface,
    release,
    releaseThread,
    clear: () => surfacedBurstMethods.clear(),
  };
}
