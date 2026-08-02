// FILE: PairDevicesSettingsPanel.tsx
// Purpose: One screen that pairs a phone to ANY connected host — local or remote
//          — with the reachability path and its fallback stated in-product.
// Layer: Settings UI
// Depends on: pairingModel for every decision (kept pure and tested).

import { useCallback, useEffect, useState } from "react";
import type { EnvironmentId, ServerPhoneReachabilityResult } from "@synara/contracts";

import { useEnvironmentDirectory } from "~/environmentDirectory";
import { environmentNativeApi } from "~/environmentRouting";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { QrCode } from "./QrCode";
import { SettingsCard, SettingsSection } from "./SettingsPanelPrimitives";
import { resolvePairingHostState, type PairingHostState } from "./pairingModel";

interface HostPairing {
  readonly state: PairingHostState;
  readonly error: string | null;
}

/**
 * Loads one host's pairing material from THAT host.
 *
 * The credential and the reachability report both come from the host being
 * paired — issuing them locally would hand a phone a credential the remote
 * server has never heard of.
 */
async function loadHostPairing(input: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly reachable: boolean;
  readonly browserOrigin: string | null;
}): Promise<HostPairing> {
  const api = environmentNativeApi(input.environmentId);
  if (!api) {
    return {
      state: resolvePairingHostState({
        ...input,
        reachable: false,
        reachability: null,
        credential: null,
      }),
      error: null,
    };
  }

  let reachability: ServerPhoneReachabilityResult | null = null;
  let credential: string | null = null;
  let error: string | null = null;
  try {
    // Reachability is best-effort: without it the fallback path is still
    // correct, so a failure here must not block issuing a credential.
    reachability = await api.server.getPhoneReachability();
  } catch {
    reachability = null;
  }
  try {
    const issued = await api.server.createAuthPairingToken({ label: `Phone · ${input.label}` });
    credential = issued.credential;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Could not create a pairing link.";
  }

  return {
    state: resolvePairingHostState({ ...input, reachability, credential }),
    error,
  };
}

export function PairDevicesSettingsPanel() {
  const environments = useEnvironmentDirectory();
  const [pairingByEnvironmentId, setPairingByEnvironmentId] = useState<
    Readonly<Record<string, HostPairing>>
  >({});
  const [loading, setLoading] = useState(false);
  const [generation, setGeneration] = useState(0);

  const browserOrigin = typeof window === "undefined" ? null : window.location.origin;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all(
      environments.map(async (environment) => {
        const pairing = await loadHostPairing({
          environmentId: environment.environmentId,
          label: environment.label,
          reachable: environment.reachability === "reachable",
          browserOrigin,
        });
        return [environment.environmentId, pairing] as const;
      }),
    )
      .then((entries) => {
        if (cancelled) return;
        setPairingByEnvironmentId(Object.fromEntries(entries));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [environments, browserOrigin, generation]);

  const handleRefresh = useCallback(() => {
    setGeneration((current) => current + 1);
  }, []);

  return (
    <SettingsSection title="Pair a phone">
      <SettingsCard divided>
        <div className="px-3 py-2.5 text-muted-foreground text-xs">
          Scan a code with your phone's camera to open Synara there, signed in. Each code is
          single-use and expires; generate a new one any time.
          <Button
            type="button"
            variant="chrome"
            size="sm"
            className="ml-2 h-6"
            onClick={handleRefresh}
            disabled={loading}
          >
            {loading ? "Generating…" : "New codes"}
          </Button>
        </div>
        {environments.map((environment) => {
          const pairing = pairingByEnvironmentId[environment.environmentId];
          const state = pairing?.state ?? null;
          return (
            <div
              key={environment.environmentId}
              className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-start"
              data-testid={`pairing-host-${environment.environmentId}`}
            >
              <div className="shrink-0">
                {state?.pairingUrl ? (
                  <QrCode
                    value={state.pairingUrl}
                    size={160}
                    title={`Pairing code for ${environment.label}`}
                  />
                ) : (
                  <div className="grid size-40 place-items-center rounded-md border border-dashed border-[var(--color-border-subtle)] text-center text-muted-foreground/70 text-xs">
                    {loading ? "Generating…" : "No code"}
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1 space-y-1.5">
                <p className="font-medium text-[var(--color-text-foreground)] text-sm">
                  {environment.label}
                  {environment.isLocal ? (
                    <span className="ml-1.5 font-normal text-muted-foreground/70">
                      (this computer)
                    </span>
                  ) : null}
                </p>
                {state?.reachability ? (
                  <p
                    className={cn(
                      "text-xs",
                      state.reachability.kind === "tailscale-serve"
                        ? "text-muted-foreground"
                        : "text-muted-foreground/80",
                    )}
                  >
                    {state.reachability.summary}
                  </p>
                ) : null}
                {state?.blockedReason ? (
                  <p className="text-destructive text-xs" role="alert">
                    {state.blockedReason}
                  </p>
                ) : null}
                {pairing?.error ? (
                  <p className="text-destructive text-xs" role="alert">
                    {pairing.error}
                  </p>
                ) : null}
                {state?.reachability?.setupHint ? (
                  <p className="text-muted-foreground/80 text-xs">{state.reachability.setupHint}</p>
                ) : null}
                {state?.fallbackCommand ? (
                  <div className="pt-0.5">
                    {/* Documented on every host, including the Tailscale path: the
                        fallback is what a user needs the moment the tailnet is down. */}
                    <p className="text-muted-foreground/70 text-xs">
                      Always-works fallback — run this on the machine holding your phone's network,
                      then open <span className="font-mono">http://&lt;that machine&gt;:port</span>:
                    </p>
                    <code className="mt-1 block overflow-x-auto rounded bg-[var(--color-background-elevated-secondary)] px-2 py-1 font-mono text-[11px]">
                      {state.fallbackCommand}
                    </code>
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </SettingsCard>
    </SettingsSection>
  );
}
