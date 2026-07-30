// FILE: wsTransportEvents.ts
// Purpose: Publish renderer-local WebSocket transport state changes per environment.
// Layer: Web transport utility
// Exports: event helpers used by the transport registry and terminal runtime recovery.

import type { EnvironmentId, WsCompatibilityError } from "@synara/contracts";

import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";

export type WsTransportState = "connecting" | "open" | "closed" | "incompatible" | "disposed";

export const SYNARA_WS_TRANSPORT_STATE_EVENT = "synara:ws-transport-state";
export const SYNARA_WS_COMPATIBILITY_ISSUE_EVENT = "synara:ws-compatibility-issue";
export const SYNARA_WS_BUILD_SKEW_EVENT = "synara:ws-build-skew";

/**
 * Degraded read-only session: client and server run mismatched builds. Present
 * means the UI must suppress writes; null means the builds match.
 */
export interface WsBuildSkewState {
  readonly clientBuild: string;
  readonly serverBuild: string;
}

// Per-environment: a remote environment going offline must not make the local
// server's UI claim it is disconnected, and vice versa. Build skew is scoped
// the same way — one server running an older build says nothing about another.
const latestCompatibilityIssueByEnvironmentId = new Map<EnvironmentId, WsCompatibilityError | null>(
  [],
);
const latestTransportStateByEnvironmentId = new Map<EnvironmentId, WsTransportState>();
const latestBuildSkewByEnvironmentId = new Map<EnvironmentId, WsBuildSkewState | null>();

export interface WsTransportStateEventDetail {
  environmentId: EnvironmentId;
  state: WsTransportState;
}

export interface WsCompatibilityIssueEventDetail {
  environmentId: EnvironmentId;
  issue: WsCompatibilityError | null;
}

export interface WsTransportEventScopeOptions {
  /** Defaults to the local server, so existing single-server UI is unaffected. */
  readonly environmentId?: EnvironmentId;
}

// Emits a browser-local event without leaking transport internals into UI code.
export function emitWsTransportState(
  state: WsTransportState,
  options?: WsTransportEventScopeOptions,
): void {
  const environmentId = options?.environmentId ?? LOCAL_ENVIRONMENT_ID;
  latestTransportStateByEnvironmentId.set(environmentId, state);
  if (
    typeof window === "undefined" ||
    typeof window.dispatchEvent !== "function" ||
    typeof CustomEvent === "undefined"
  ) {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<WsTransportStateEventDetail>(SYNARA_WS_TRANSPORT_STATE_EVENT, {
      detail: { environmentId, state },
    }),
  );
}

// Subscribes to one environment's transport state. Returns an idempotent cleanup.
export function addWsTransportStateListener(
  listener: (state: WsTransportState) => void,
  options?: WsTransportEventScopeOptions & { readonly replayCurrent?: boolean },
): () => void {
  const environmentId = options?.environmentId ?? LOCAL_ENVIRONMENT_ID;
  const latestTransportState = latestTransportStateByEnvironmentId.get(environmentId);
  if (options?.replayCurrent && latestTransportState) {
    listener(latestTransportState);
  }
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
    return () => undefined;
  }

  const handleStateChange = (event: Event) => {
    const detail = (event as CustomEvent<WsTransportStateEventDetail>).detail;
    if (!detail || detail.environmentId !== environmentId) return;
    listener(detail.state);
  };

  window.addEventListener(SYNARA_WS_TRANSPORT_STATE_EVENT, handleStateChange);
  return () => {
    window.removeEventListener(SYNARA_WS_TRANSPORT_STATE_EVENT, handleStateChange);
  };
}

export function readLatestWsCompatibilityIssue(
  options?: WsTransportEventScopeOptions,
): WsCompatibilityError | null {
  return (
    latestCompatibilityIssueByEnvironmentId.get(options?.environmentId ?? LOCAL_ENVIRONMENT_ID) ??
    null
  );
}

export function emitWsCompatibilityIssue(
  issue: WsCompatibilityError | null,
  options?: WsTransportEventScopeOptions,
): void {
  const environmentId = options?.environmentId ?? LOCAL_ENVIRONMENT_ID;
  latestCompatibilityIssueByEnvironmentId.set(environmentId, issue);
  if (
    typeof window === "undefined" ||
    typeof window.dispatchEvent !== "function" ||
    typeof CustomEvent === "undefined"
  ) {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<WsCompatibilityIssueEventDetail>(SYNARA_WS_COMPATIBILITY_ISSUE_EVENT, {
      detail: { environmentId, issue },
    }),
  );
}

export function addWsCompatibilityIssueListener(
  listener: (issue: WsCompatibilityError | null) => void,
  options?: WsTransportEventScopeOptions & { readonly replayCurrent?: boolean },
): () => void {
  const environmentId = options?.environmentId ?? LOCAL_ENVIRONMENT_ID;
  if (options?.replayCurrent) listener(readLatestWsCompatibilityIssue({ environmentId }));
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
    return () => undefined;
  }
  const handleIssue = (event: Event) => {
    const detail = (event as CustomEvent<WsCompatibilityIssueEventDetail>).detail;
    if (!detail || detail.environmentId !== environmentId) return;
    listener(detail.issue);
  };
  window.addEventListener(SYNARA_WS_COMPATIBILITY_ISSUE_EVENT, handleIssue);
  return () => {
    window.removeEventListener(SYNARA_WS_COMPATIBILITY_ISSUE_EVENT, handleIssue);
  };
}

export interface WsBuildSkewEventDetail {
  environmentId: EnvironmentId;
  skew: WsBuildSkewState | null;
}

export function readLatestWsBuildSkew(environmentId: EnvironmentId): WsBuildSkewState | null {
  return latestBuildSkewByEnvironmentId.get(environmentId) ?? null;
}

export function emitWsBuildSkew(environmentId: EnvironmentId, skew: WsBuildSkewState | null): void {
  latestBuildSkewByEnvironmentId.set(environmentId, skew);
  if (
    typeof window === "undefined" ||
    typeof window.dispatchEvent !== "function" ||
    typeof CustomEvent === "undefined"
  ) {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<WsBuildSkewEventDetail>(SYNARA_WS_BUILD_SKEW_EVENT, {
      detail: { environmentId, skew },
    }),
  );
}

export function addWsBuildSkewListener(
  environmentId: EnvironmentId,
  listener: (skew: WsBuildSkewState | null) => void,
  options?: { readonly replayCurrent?: boolean },
): () => void {
  if (options?.replayCurrent) listener(readLatestWsBuildSkew(environmentId));
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
    return () => undefined;
  }
  const handleSkew = (event: Event) => {
    const detail = (event as CustomEvent<WsBuildSkewEventDetail>).detail;
    if (!detail || detail.environmentId !== environmentId) return;
    listener(detail.skew);
  };
  window.addEventListener(SYNARA_WS_BUILD_SKEW_EVENT, handleSkew);
  return () => {
    window.removeEventListener(SYNARA_WS_BUILD_SKEW_EVENT, handleSkew);
  };
}

export function resetWsTransportEventsForTests(): void {
  latestTransportStateByEnvironmentId.clear();
  latestCompatibilityIssueByEnvironmentId.clear();
  latestBuildSkewByEnvironmentId.clear();
}
