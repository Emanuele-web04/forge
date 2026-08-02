// FILE: environmentScope.tsx
// Purpose: React scope naming the environment a subtree's HTTP-backed asset
//          requests belong to, so a remote thread's file previews are fetched
//          from the host that actually holds those files.
// Layer: Web transport routing
// Exports: EnvironmentScopeProvider, useEnvironmentHttpUrlResolver

import { createContext, use, useMemo, type ReactNode } from "react";
import type { EnvironmentId, ThreadId } from "@synara/contracts";

import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";
import { EnvironmentUnavailableError, resolveThreadEnvironmentId } from "./environmentRouting";
import { resolveEnvironmentHttpUrl } from "./lib/wsHttpUrl";
import { getWsEnvironmentClient } from "./wsEnvironmentRegistry";

/**
 * Defaults to the local environment because that is what every existing surface
 * is: the single-server app is byte-identical until a provider names a remote
 * environment.
 */
const EnvironmentScopeContext = createContext<EnvironmentId>(LOCAL_ENVIRONMENT_ID);

export function EnvironmentScopeProvider(props: {
  /** Scope resolved from a thread's owner. Omit for a genuinely local subtree. */
  readonly threadId?: ThreadId | undefined;
  readonly children: ReactNode;
}) {
  const environmentId = props.threadId
    ? resolveThreadEnvironmentId(props.threadId)
    : LOCAL_ENVIRONMENT_ID;
  return (
    <EnvironmentScopeContext.Provider value={environmentId}>
      {props.children}
    </EnvironmentScopeContext.Provider>
  );
}

export function useEnvironmentScopeId(): EnvironmentId {
  return use(EnvironmentScopeContext);
}

/**
 * Resolves an asset path against the scope's own server.
 *
 * Returns `null` — never a local URL — when a remote scope is not connected.
 * A local fallback here would render the LOCAL machine's file at the same path,
 * which is worse than showing nothing: it looks like it worked.
 */
export function useEnvironmentHttpUrlResolver(): (rawPath: string) => string | null {
  const environmentId = use(EnvironmentScopeContext);
  return useMemo(() => {
    if (environmentId === LOCAL_ENVIRONMENT_ID) {
      return (rawPath: string) => resolveEnvironmentHttpUrl(null, rawPath);
    }
    return (rawPath: string) => {
      const client = getWsEnvironmentClient(environmentId);
      if (!client) return null;
      return resolveEnvironmentHttpUrl(client.wsUrl, rawPath);
    };
  }, [environmentId]);
}

/** Non-hook form for code paths outside render. Throws when a remote scope is down. */
export function resolveEnvironmentAssetUrl(environmentId: EnvironmentId, rawPath: string): string {
  if (environmentId === LOCAL_ENVIRONMENT_ID) return resolveEnvironmentHttpUrl(null, rawPath);
  const client = getWsEnvironmentClient(environmentId);
  if (!client) throw new EnvironmentUnavailableError(environmentId);
  return resolveEnvironmentHttpUrl(client.wsUrl, rawPath);
}
