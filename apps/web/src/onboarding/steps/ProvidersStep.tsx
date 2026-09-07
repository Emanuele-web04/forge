// FILE: ProvidersStep.tsx
// Purpose: Provider checklist for the welcome tour: detection status per runtime, an
//          enable/disable checkbox bound to the server-backed `disabledProviders` setting,
//          inline sign-in for detected-but-unauthenticated CLIs, and a setup-guide link.
// Layer: Web UI component

import type { ProviderKind, ServerProviderStatus } from "@synara/contracts";
import { PROVIDER_DESCRIPTORS } from "@synara/shared/providerMetadata";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { getCustomBinaryPathForProvider, useAppSettings } from "~/appSettings";
import { ProviderIcon } from "~/components/ProviderIcon";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import { RefreshCwIcon } from "~/lib/icons";
import {
  findProviderStatus,
  normalizeProviderStatusForLocalConfig,
} from "~/lib/providerAvailability";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { useWorkspacePathsStore } from "~/workspacePathsStore";
import { classifyProviderSetup, summarizeProviderSetup, type ProviderSetupState } from "../logic";
import { ProviderConnectTerminal } from "./ProviderConnectTerminal";

const EMPTY_STATUSES: readonly ServerProviderStatus[] = [];

const STATE_BADGE: Record<
  ProviderSetupState,
  { label: string; variant: "success" | "warning" | "outline" | "secondary" }
> = {
  connected: { label: "Connected", variant: "success" },
  "needs-sign-in": { label: "Needs sign-in", variant: "warning" },
  "not-installed": { label: "Not installed", variant: "outline" },
  disabled: { label: "Disabled", variant: "secondary" },
};

/**
 * Raw detection statuses with custom-binary overrides applied but *without* folding the
 * disabled flag in: this step must keep showing "installed" for a provider the user just
 * unchecked, otherwise the row appears to lose its CLI.
 */
function useDetectedProviderStatuses(): readonly ServerProviderStatus[] {
  const { settings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const providers = serverConfigQuery.data?.providers ?? EMPTY_STATUSES;
  return useMemo(
    () =>
      providers.flatMap((status) => {
        const normalized = normalizeProviderStatusForLocalConfig({
          provider: status.provider,
          status,
          customBinaryPath: getCustomBinaryPathForProvider(settings, status.provider),
        });
        return normalized ? [normalized] : [];
      }),
    [providers, settings],
  );
}

function setDisabled(
  current: ReadonlyArray<ProviderKind>,
  provider: ProviderKind,
  disabled: boolean,
): ProviderKind[] {
  const without = current.filter((entry) => entry !== provider);
  return disabled ? [...without, provider] : without;
}

export function ProvidersStep() {
  const { settings, updateSettings } = useAppSettings();
  const statuses = useDetectedProviderStatuses();
  const refreshProviderStatuses = useRefreshProviderStatusesNow();
  const homeDir = useWorkspacePathsStore((store) => store.homeDir);
  const [connectingProvider, setConnectingProvider] = useState<ProviderKind | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const disabledSet = useMemo(
    () => new Set<ProviderKind>(settings.disabledProviders),
    [settings.disabledProviders],
  );

  const refresh = async () => {
    setRefreshing(true);
    try {
      await refreshProviderStatuses({ silent: true });
    } finally {
      setRefreshing(false);
    }
  };

  // Probe once on entry so a CLI installed while the intro was open shows up.
  const refreshedOnEntryRef = useRef(false);
  useEffect(() => {
    if (refreshedOnEntryRef.current) return;
    refreshedOnEntryRef.current = true;
    void refreshProviderStatuses({ silent: true });
  }, [refreshProviderStatuses]);

  const rows = PROVIDER_DESCRIPTORS.map((descriptor) => {
    const status = findProviderStatus(statuses, descriptor.kind);
    const state = classifyProviderSetup({
      status,
      disabled: disabledSet.has(descriptor.kind),
    });
    return { descriptor, status, state };
  });
  const summary = summarizeProviderSetup(
    rows.map((row) => ({ provider: row.descriptor.kind, state: row.state })),
  );

  const toggleConnect = (provider: ProviderKind) => {
    if (connectingProvider === provider) {
      setConnectingProvider(null);
      void refresh();
      return;
    }
    setConnectingProvider(provider);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {summary.connected} connected · {summary.needsSignIn} need sign-in ·{" "}
          {summary.notInstalled} not installed · {summary.enabled} of {rows.length} enabled
        </p>
        <Button size="sm" variant="ghost" disabled={refreshing} onClick={() => void refresh()}>
          <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} aria-hidden />
          Re-detect
        </Button>
      </div>

      <div className="max-h-[22rem] space-y-0.5 overflow-y-auto pr-1">
        {rows.map(({ descriptor, status, state }) => {
          const badge = STATE_BADGE[state];
          const enabled = state !== "disabled";
          const signInCommand = descriptor.usage?.signInCommand;
          const canConnectInline =
            state === "needs-sign-in" && signInCommand !== undefined && homeDir !== null;
          const isConnecting = connectingProvider === descriptor.kind;
          return (
            <div key={descriptor.kind} className="rounded-lg">
              <div className="flex items-center gap-3 px-2 py-2">
                <Checkbox
                  checked={enabled}
                  aria-label={`${enabled ? "Disable" : "Enable"} ${descriptor.displayName}`}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      disabledProviders: setDisabled(
                        settings.disabledProviders,
                        descriptor.kind,
                        !Boolean(checked),
                      ),
                    })
                  }
                />
                <ProviderIcon
                  provider={descriptor.kind}
                  className={cn("size-5 shrink-0", !enabled && "opacity-50")}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span
                    className={cn("text-sm", enabled ? "text-foreground" : "text-muted-foreground")}
                  >
                    {descriptor.displayName}
                  </span>
                  {status?.version ? (
                    <span className="text-xs text-muted-foreground">v{status.version}</span>
                  ) : null}
                </span>
                <Badge variant={badge.variant}>{badge.label}</Badge>
                {canConnectInline ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => toggleConnect(descriptor.kind)}
                  >
                    {isConnecting ? "Done" : "Sign in"}
                  </Button>
                ) : null}
                {state === "not-installed" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    render={<a href={descriptor.setupDocsHref} target="_blank" rel="noreferrer" />}
                  >
                    Setup guide
                  </Button>
                ) : null}
              </div>
              {canConnectInline ? (
                <DisclosureRegion open={isConnecting} contentClassName="px-2 pb-2">
                  {isConnecting && signInCommand !== undefined && homeDir !== null ? (
                    <ProviderConnectTerminal
                      provider={descriptor.kind}
                      signInCommand={signInCommand}
                      cwd={homeDir}
                    />
                  ) : null}
                </DisclosureRegion>
              ) : null}
            </div>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        Unchecked providers are disabled on the server: no discovery, health checks, or new turns
        until you re-enable them in Settings → Providers. Install a missing CLI, sign in from a
        fresh terminal, then re-detect.
      </p>
    </div>
  );
}
